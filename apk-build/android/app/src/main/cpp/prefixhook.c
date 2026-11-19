/*
 * prefixhook —— Termux 二进制路径重定向（LD_PRELOAD）
 *
 * 背景：Termux 官方 bootstrap 里的 dpkg / apt / python / pip 等二进制在编译期
 * 把 prefix 写死为 /data/data/com.termux/files/usr。在包名不同的 App 内运行时，
 * dpkg 会去读别的应用私有目录（Permission denied），apt 也找不到自己的配置。
 *
 * 做法：拦截 libc 文件系统入口，把任何以 com.termux prefix 开头的路径改写成
 * 本应用的 PREFIX（环境变量 AICHAT_PREFIX）。只改写该前缀，其余路径原样透传。
 * 编译：aarch64-linux-android21-clang -shared -fPIC -O2
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <limits.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/ucontext.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/syscall.h>

#define TP1 "/data/data/com.termux/files/usr"
#define TP2 "/data/user/0/com.termux/files/usr"

static char g_prefix[PATH_MAX];
static char g_approot[PATH_MAX];

__attribute__((constructor))
static void prefixhook_init(void) {
    const char *p = getenv("AICHAT_PREFIX");
    if (!p || !*p) p = "/data/user/0/com.aichat.app/files/usr";
    snprintf(g_prefix, sizeof(g_prefix), "%s", p);
    const char *r = getenv("AICHAT_APP_ROOT");
    if (r && *r) {
        snprintf(g_approot, sizeof(g_approot), "%s", r);
    } else {
        /* 由 prefix 反推：<approot>/files/usr */
        snprintf(g_approot, sizeof(g_approot), "%s", g_prefix);
        char *tail = strstr(g_approot, "/files/usr");
        if (tail) *tail = '\0';
    }
}

/* 线程内轮转缓冲：rename/renameat 这类双路径调用不会互相覆盖 */
static __thread char tbuf[4][PATH_MAX];
static __thread int tbi = 0;

/* 路径前缀映射表：先匹配更长的 /files/usr，再退回 termux 根目录。
 * 后者是 dpkg 解包必需的：deb 成员以 ./data/data/com.termux/files/usr/... 形式给出，
 * tar 会先 mekdir 逐级父目录（./data/data/com.termux 等），只映射 /files/usr 会让它去写
 * /data/data/com.termux —— 应用对该路径没有权限，直接 EACCES。 */
struct chmap { const char *from; const char *to; };

static const char *rw(const char *path) {
    if (!path) return path;
    if (!g_prefix[0]) prefixhook_init();
    static const char *roots[] = { TP1, TP2, "/data/data/com.termux", "/data/user/0/com.termux",
                                   "./data/data/com.termux", "./data/user/0/com.termux",
                                   "data/data/com.termux", "data/user/0/com.termux" };
    /* 长前缀优先：files/usr 的映射目标不同，必须排在根之前 */
    static const char *filespfx[] = { TP1, TP2, "./data/data/com.termux/files/usr",
                                      "./data/user/0/com.termux/files/usr",
                                      "data/data/com.termux/files/usr",
                                      "data/user/0/com.termux/files/usr" };
    for (size_t i = 0; i < sizeof(filespfx) / sizeof(*filespfx); i++) {
        size_t n = strlen(filespfx[i]);
        if (strncmp(path, filespfx[i], n) == 0 && (path[n] == '\0' || path[n] == '/')) {
            char *b = tbuf[tbi++ & 3];
            snprintf(b, PATH_MAX, "%s%s", g_prefix, path + n);
            return b;
        }
    }
    for (size_t i = 0; i < sizeof(roots) / sizeof(*roots); i++) {
        size_t n = strlen(roots[i]);
        if (strncmp(path, roots[i], n) == 0 && (path[n] == '\0' || path[n] == '/')) {
            char *b = tbuf[tbi++ & 3];
            snprintf(b, PATH_MAX, "%s%s", g_approot, path + n);
            return b;
        }
    }
    return path;
}

#define REAL(name) static __typeof__(name) *real_##name
typedef int (*fn_open2)(const char *, int);
typedef int (*fn_openat2)(int, const char *, int);
typedef FILE *(*fn_fopen64)(const char *, const char *);
REAL(open); REAL(open64);
static fn_open2 real___open_2;
REAL(openat); REAL(openat64);
static fn_openat2 real___openat_2;
REAL(fopen);
static fn_fopen64 real_fopen64;
REAL(freopen); REAL(opendir);
REAL(stat); REAL(lstat); REAL(fstatat); REAL(access); REAL(faccessat);
REAL(mkdir); REAL(mkdirat); REAL(rmdir); REAL(unlink); REAL(unlinkat);
REAL(rename); REAL(renameat); REAL(symlink); REAL(link); REAL(readlink);
REAL(chmod); REAL(fchmodat); REAL(chown); REAL(lchown); REAL(realpath);
/* 时间戳与链接族：dpkg 解包在 rename 之后要为每个 .dpkg-new 设置 utime，
 * 这几个入口漏掉就会出现 "setting timestamps of /data/data/com.termux/...: No such file" */
REAL(utimensat);
REAL(linkat); REAL(symlinkat); REAL(readlinkat);
REAL(mknod); REAL(mknodat);
REAL(truncate);

#define BIND(name) real_##name = (__typeof__(name) *)dlsym(RTLD_NEXT, #name)

/*
 * 内核 seccomp 降级。
 * 部分设备对 app 域的系统调用白名单用 SECCOMP_RET_TRAP，较新工具链调用 clone3 /
 * futex_waitv 等会被内核直接投递 SIGSYS，进程以 "Bad system call" 被杀，dpkg 侧只能
 * 看到 postinst 被信号终止。策略在内核层无法移除，但信号可以在进程内接住：把该系统
 * 调用的返回值改成 -ENOSYS，调用方的兼容分支会回退到旧实现，进程继续运行。
 */
static void sigsys_degrade(int sig, siginfo_t *si, void *ctx) {
    (void)sig;
    if (!ctx) return;
    ucontext_t *uc = (ucontext_t *)ctx;
    if (si && si->si_code == SYS_SECCOMP) {
        /* 明确由 seccomp 触发：按 ENOSYS 返回 */
#if defined(__aarch64__)
        uc->uc_mcontext.regs[0] = (unsigned long)(-ENOSYS);
#elif defined(__arm__)
        uc->uc_mcontext.arm_r0 = (unsigned long)(-ENOSYS);
#endif
    }
}

__attribute__((constructor))
static void install_sigsys_degrade(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = sigsys_degrade;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGSYS, &sa, NULL);
}

__attribute__((constructor))
static void prefixhook_bind(void) {
    BIND(open); BIND(open64); BIND(openat); BIND(openat64);
    real___open_2 = (fn_open2)dlsym(RTLD_NEXT, "__open_2");
    real___openat_2 = (fn_openat2)dlsym(RTLD_NEXT, "__openat_2");
    real_fopen64 = (fn_fopen64)dlsym(RTLD_NEXT, "fopen64");
    BIND(fopen); BIND(freopen); BIND(opendir);
    BIND(stat); BIND(lstat); BIND(fstatat); BIND(access); BIND(faccessat);
    BIND(mkdir); BIND(mkdirat); BIND(rmdir); BIND(unlink); BIND(unlinkat);
    BIND(rename); BIND(renameat); BIND(symlink); BIND(link); BIND(readlink);
    BIND(chmod); BIND(fchmodat); BIND(chown); BIND(lchown); BIND(realpath);
    BIND(utimensat);
    BIND(linkat); BIND(symlinkat); BIND(readlinkat);
    BIND(mknod); BIND(mknodat);
    BIND(truncate);
}

/* ---------- open / fopen ---------- */
int open(const char *path, int flags, ...) {
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); m = va_arg(ap, mode_t); va_end(ap); }
    if (real_open) return real_open(rw(path), flags, m);
    return syscall(SYS_openat, AT_FDCWD, path, flags, m);
}
int open64(const char *path, int flags, ...) {
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); m = va_arg(ap, mode_t); va_end(ap); }
    if (real_open64) return real_open64(rw(path), flags, m);
    if (real_open) return real_open(rw(path), flags, m);
    return -1;
}
int __open_2(const char *path, int flags) {
    if (real___open_2) return real___open_2(rw(path), flags);
    return open(path, flags);
}
int openat(int dirfd, const char *path, int flags, ...) {
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); m = va_arg(ap, mode_t); va_end(ap); }
    if (real_openat) return real_openat(dirfd, rw(path), flags, m);
    return -1;
}
int openat64(int dirfd, const char *path, int flags, ...) {
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); m = va_arg(ap, mode_t); va_end(ap); }
    if (real_openat64) return real_openat64(dirfd, rw(path), flags, m);
    if (real_openat) return real_openat(dirfd, rw(path), flags, m);
    return -1;
}
int __openat_2(int dirfd, const char *path, int flags) {
    if (real___openat_2) return real___openat_2(dirfd, rw(path), flags);
    return openat(dirfd, path, flags);
}
FILE *fopen(const char *path, const char *mode) {
    return real_fopen ? real_fopen(rw(path), mode) : NULL;
}
FILE *fopen64(const char *path, const char *mode) {
    if (real_fopen64) return real_fopen64(rw(path), mode);
    if (real_fopen) return real_fopen(rw(path), mode);
    return NULL;
}
FILE *freopen(const char *path, const char *mode, FILE *f) {
    return real_freopen ? real_freopen(rw(path), mode, f) : NULL;
}
DIR *opendir(const char *path) {
    return real_opendir ? real_opendir(rw(path)) : NULL;
}

/* ---------- 元数据 ---------- */
int stat(const char *path, struct stat *st) {
    return real_stat ? real_stat(rw(path), st) : -1;
}
int lstat(const char *path, struct stat *st) {
    return real_lstat ? real_lstat(rw(path), st) : -1;
}
int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    return real_fstatat ? real_fstatat(dirfd, rw(path), st, flags) : -1;
}
int access(const char *path, int mode) {
    return real_access ? real_access(rw(path), mode) : -1;
}
int faccessat(int dirfd, const char *path, int mode, int flags) {
    return real_faccessat ? real_faccessat(dirfd, rw(path), mode, flags) : -1;
}
char *realpath(const char *path, char *resolved) {
    return real_realpath ? real_realpath(rw(path), resolved) : NULL;
}

/* ---------- 变更 ---------- */
int mkdir(const char *path, mode_t m) {
    return real_mkdir ? real_mkdir(rw(path), m) : -1;
}
int mkdirat(int dirfd, const char *path, mode_t m) {
    return real_mkdirat ? real_mkdirat(dirfd, rw(path), m) : -1;
}
int rmdir(const char *path) { return real_rmdir ? real_rmdir(rw(path)) : -1; }
int unlink(const char *path) { return real_unlink ? real_unlink(rw(path)) : -1; }
int unlinkat(int dirfd, const char *path, int flags) {
    return real_unlinkat ? real_unlinkat(dirfd, rw(path), flags) : -1;
}
int rename(const char *a, const char *b) {
    return real_rename ? real_rename(rw(a), rw(b)) : -1;
}
int renameat(int fa, const char *a, int fb, const char *b) {
    return real_renameat ? real_renameat(fa, rw(a), fb, rw(b)) : -1;
}
int symlink(const char *target, const char *linkpath) {
    return real_symlink ? real_symlink(rw(target), rw(linkpath)) : -1;
}
int link(const char *a, const char *b) {
    return real_link ? real_link(rw(a), rw(b)) : -1;
}
ssize_t readlink(const char *path, char *buf, size_t len) {
    return real_readlink ? real_readlink(rw(path), buf, len) : -1;
}
int chmod(const char *path, mode_t m) {
    return real_chmod ? real_chmod(rw(path), m) : -1;
}
int fchmodat(int dirfd, const char *path, mode_t m, int flags) {
    return real_fchmodat ? real_fchmodat(dirfd, rw(path), m, flags) : -1;
}
int chown(const char *path, uid_t u, gid_t g) {
    return real_chown ? real_chown(rw(path), u, g) : -1;
}
int lchown(const char *path, uid_t u, gid_t g) {
    return real_lchown ? real_lchown(rw(path), u, g) : -1;
}
int truncate(const char *path, off_t len) {
    return real_truncate ? real_truncate(rw(path), len) : -1;
}

/* ---------- 时间戳 ---------- */
int utimensat(int dirfd, const char *path, const struct timespec ts[2], int flags) {
    if (real_utimensat) return real_utimensat(dirfd, rw(path), ts, flags);
    return syscall(SYS_utimensat, dirfd, rw(path), ts, flags, 0);
}

/* ---------- 链接 / 重命名族 ---------- */
int linkat(int oldfd, const char *oldp, int newfd, const char *newp, int flags) {
    if (real_linkat) return real_linkat(oldfd, rw(oldp), newfd, rw(newp), flags);
    return syscall(SYS_linkat, oldfd, rw(oldp), newfd, rw(newp), flags);
}
int symlinkat(const char *target, int dirfd, const char *linkp) {
    if (real_symlinkat) return real_symlinkat(target, dirfd, rw(linkp));
    return syscall(SYS_symlinkat, target, dirfd, rw(linkp));
}
ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t len) {
    if (real_readlinkat) return real_readlinkat(dirfd, rw(path), buf, len);
    return syscall(SYS_readlinkat, dirfd, rw(path), buf, len);
}
int mknod(const char *path, mode_t m, dev_t dev) {
    if (real_mknod) return real_mknod(rw(path), m, dev);
    return syscall(SYS_mknodat, AT_FDCWD, rw(path), m, dev);
}
int mknodat(int dirfd, const char *path, mode_t m, dev_t dev) {
    if (real_mknodat) return real_mknodat(dirfd, rw(path), m, dev);
    return syscall(SYS_mknodat, dirfd, rw(path), m, dev);
}
