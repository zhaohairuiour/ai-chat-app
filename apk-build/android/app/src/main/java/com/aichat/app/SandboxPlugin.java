package com.aichat.app;

import android.system.Os;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 沙箱插件（v3.29）：真正内嵌 Termux bootstrap。
 * - 首次启动从 nativeLibraryDir 解压 libtermux-bootstrap.so（实为 zip）到 files/usr（PREFIX）
 * - 重建 SYMLINKS.txt 中的符号链接，chmod +x 二进制
 * - 写清华镜像源到 etc/apt/sources.list
 * - 用 PREFIX/bin/bash 执行命令，设置 LD_LIBRARY_PATH/PATH/HOME/TMPDIR
 * - stdout/stderr 实时通过 "output" 事件推送到 WebView
 */
@CapacitorPlugin(name = "Sandbox")
public class SandboxPlugin extends Plugin {

    private File prefix;       // $PREFIX = files/usr
    private File sandboxRoot;  // 工作目录 = files/sandbox
    private File homeDir;
    private File tmpDir;
    private volatile Process currentProcess;
    private OutputStream currentStdin;
    private final Object procLock = new Object();

    @Override
    public void load() {
        File files = getContext().getFilesDir();
        prefix = new File(files, "usr");
        sandboxRoot = new File(files, "sandbox");
        homeDir = new File(files, "home");
        tmpDir = new File(files, "tmp");
    }

    private File bashBin() { return new File(prefix, "bin/bash"); }

    /** 解析相对路径并确保不越出沙箱工作目录；非法路径返回 null */
    private File safeFile(String rel) {
        if (rel == null || rel.isEmpty()) return sandboxRoot;
        File f = new File(sandboxRoot, rel);
        try {
            String base = sandboxRoot.getCanonicalPath();
            String target = f.getCanonicalPath();
            if (!target.equals(base) && !target.startsWith(base + File.separator)) return null;
            return f;
        } catch (Exception e) {
            return null;
        }
    }

    /** 初始化沙箱：解压 Termux bootstrap（首次）+ 镜像源 + 目录 */
    @PluginMethod
    public void init(final PluginCall call) {
        new Thread(() -> {
            try {
                if (!sandboxRoot.exists() && !sandboxRoot.mkdirs()) {
                    call.reject("沙箱目录创建失败"); return;
                }
                // 回显上次崩溃留下的日志，让闪退在下次启动时可被看见
                replayBootError();

                String[] dirs = { "projects", "bin" };
                for (String d : dirs) new File(sandboxRoot, d).mkdirs();
                homeDir.mkdirs();
                tmpDir.mkdirs();

                // 首次：解压 bootstrap（失败时优雅降级，不影响聊天功能）
                boolean bootstrapped = false;
                if (!bashBin().exists()) {
                    try {
                        emit("system", "首次启动，正在解压 Termux 运行环境（约 70MB）…\n");
                        extractBootstrap();
                        bootstrapped = true;
                        emit("system", "Termux 环境就绪。\n");
                    } catch (Exception be) {
                        StringWriter sw = new StringWriter();
                        be.printStackTrace(new PrintWriter(sw));
                        String detail = be.getMessage() + "\n--- 详细堆栈 ---\n" + sw.toString();
                        emit("system", "❌ Termux 解压失败：" + be.getMessage() + "\n");
                        // 清掉半成品 PREFIX，否则残缺的 bash 会让下次启动误判「已安装」
                        try {
                            File ok = new File(getContext().getFilesDir(), ".bootstrap-ok");
                            if (!ok.exists()) deleteRecursive(prefix);
                        } catch (Exception ignored) {}
                        JSObject ret = new JSObject();
                        ret.put("root", sandboxRoot.getAbsolutePath());
                        ret.put("prefix", prefix.getAbsolutePath());
                        ret.put("initialized", false);
                        ret.put("error", detail);
                        call.resolve(ret);
                        return;
                    }
                }
                // 一次性准备（marker 守卫），不再每次启动全量 chmod / 二进制扫描
                preparePrefix(bootstrapped);
                // 每次启动都校验关键目录可执行位：apt-get / apt methods 缺执行位会直接 Permission denied
                fixExecPermissions();
                // dpkg 参数兼容层：过滤新版 apt 传入的 --force-gnu-system，并在每次调用前修正维护脚本 shebang
                ensureDpkgWrapper();
                ensureNoOpPyCompile();
                ensureUaWrapper();
                rewriteMaintainerScripts();

                applyRuntimeConfig();

                // 先返回就绪，UI 立刻可用；dpkg 首次配置放后台，避免首屏长时间卡住
                JSObject ret = new JSObject();
                ret.put("root", sandboxRoot.getAbsolutePath());
                ret.put("prefix", prefix.getAbsolutePath());
                ret.put("initialized", true);
                call.resolve(ret);

                new Thread(() -> {
                    try {
                        File dpkgMarker = new File(getContext().getFilesDir(), ".dpkg-configured-v1");
                        if (!dpkgMarker.exists()) {
                            fixDpkg();
                            writeText(dpkgMarker, "ok");
                        }
                    } catch (Exception ignored) {}
                    // 索引同步改由用户在终端确认后执行，避免与弹窗流程重复触发
                }).start();
            } catch (Throwable e) {
                // Throwable 而非 Exception：OutOfMemoryError / StackOverflow 也必须留痕
                String log = logThrowable("init", e);
                emit("system", "初始化失败: " + e.getClass().getSimpleName() + ": " + e.getMessage() + "\n");
                emit("system", "崩溃日志: " + log + "\n");
                call.reject("初始化异常: " + e);
            }
        }).start();
    }

    /** 运行期配置：软源、镜像、apt 路径覆盖、keyring、dpkg 库目录。
     *  init 与「重装终端」共用，避免两处配置漂移。 */
    private void applyRuntimeConfig() {
        try {
            // 写清华镜像源，加 [trusted=yes] 跳过 GPG 验证
                // 用 http 而非 https：Termux bootstrap 的 ca-certificates 在自建 PREFIX 下常缺失，
                // http 源可直接工作；https 源改由证书生成 + 校验开关兜底
                File sources = new File(prefix, "etc/apt/sources.list");
                writeText(sources,
                    "deb [trusted=yes] http://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main stable main\n");
                // bootstrap 自带 sources.list.d/*.list（官方 termux 源，无 trusted=yes），apt update 会
                // 逐个校验签名并报 "GPG error: KEY not valid"，这里直接清空该目录
                try {
                    File parts = new File(prefix, "etc/apt/sources.list.d");
                    if (parts.isDirectory()) {
                        File[] fs = parts.listFiles();
                        if (fs != null) for (File f : fs) {
                            if (f.getName().endsWith(".list") || f.getName().endsWith(".sources")) f.delete();
                        }
                    }
                    File trust = new File(prefix, "etc/apt/trusted.gpg");
                    if (trust.exists()) trust.delete();
                } catch (Exception ignored) {}

                // 生成 CA 证书束（供 python/pip/curl 等；apt 已走 http）
                ensureCertificates();

                // pip 走清华源，避免 pip 因默认 PyPI 证书/网络问题失败
                try {
                    writeText(new File(prefix, "etc/pip.conf"),
                        "[global]\n" +
                        "index-url = https://pypi.tuna.tsinghua.edu.cn/simple\n" +
                        "trusted-host = pypi.tuna.tsinghua.edu.cn\n");
                } catch (Exception ignored) {}

                // 清空 pkg 自动选择的镜像文件，防止它覆盖我们的源
                File mirrorsDir = new File(prefix, "etc/termux/mirrors");
                if (mirrorsDir.exists()) {
                    File[] ms = mirrorsDir.listFiles();
                    if (ms != null) for (File m : ms) { if (m.isFile()) m.delete(); }
                }
                // 写死默认镜像为清华
                File defaultMirror = new File(prefix, "etc/termux/mirrors/default");
                // pkg 会把该文件当 shell 脚本 source，格式必须是 MAIN="..."，纯 URL 会报
                // "No such file or directory" 并导致 "Ignoring mirror ... without main channel url"
                writeText(defaultMirror,
                    "# This file is sourced by pkg\n" +
                    "WEIGHT=10\n" +
                    "MAIN=\"http://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main\"\n" +
                    "ROOT=\"http://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-root\"\n");

                // 写 apt 路径覆盖配置（apt 二进制硬编码了 com.termux 路径，需要重定向到我们的 PREFIX）
                writeAptPathConfig();
                // Termux 的 apt 即使源带 [trusted=yes] 仍会尝试解析 InRelease 并报
                // "Good signature, but could not determine key fingerprint"，这里再从 apt.conf.d 兜一层
                try {
                    writeText(new File(prefix, "etc/apt/apt.conf.d/99aichat"),
                        "Acquire::AllowInsecureRepositories \"true\";\n" +
                        "Acquire::AllowDowngradeToInsecureRepositories \"true\";\n" +
                        "Acquire::Check-Valid-Until \"false\";\n" +
                        "Acquire::http::Timeout \"30\";\n");
                } catch (Throwable ignored) {}
                // bootstrap 的 etc/apt/trusted.gpg.d 是空目录：缺公钥时 gpgv 必报
                // "Good signature, but could not determine key fingerprint"，索引永远装不上
                installKeyring();
                // dpkg 数据库自愈：status/available 缺失会让 dpkg 直接返回错误码 2
                ensureDpkgDb();

                // 确保 dpkg 状态目录存在
                new File(prefix, "var/lib/dpkg").mkdirs();
                new File(prefix, "var/lib/dpkg/updates").mkdirs();
                new File(prefix, "var/lib/dpkg/info").mkdirs();
                new File(prefix, "var/lib/apt/lists/partial").mkdirs();
                new File(prefix, "var/cache/apt/archives/partial").mkdirs();
                // 创建 dpkg 配置目录（覆盖硬编码的 com.termux 路径）
                new File(prefix, "etc/dpkg/dpkg.cfg.d").mkdirs();
                new File(prefix, "etc/dpkg/origins").mkdirs();
                // 写一个空的 dpkg.cfg 防止读取硬编码路径
                writeText(new File(prefix, "etc/dpkg/dpkg.cfg"), "");
                // 确保证书目录存在
                new File(prefix, "etc/tls").mkdirs();
        } catch (Throwable e) {
            emit("system", "运行配置写入失败: " + e.getMessage() + "\n");
        }
    }

    /** 上次启动若崩溃，把日志尾部回显到终端，然后归档避免重复输出 */
    private void replayBootError() {
        File f = new File(getContext().getFilesDir(), "boot-error.log");
        if (!f.exists() || f.length() == 0) return;
        try {
            List<String> lines = new ArrayList<>();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(
                    new java.io.FileInputStream(f), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) lines.add(line);
            }
            emit("system", "上次启动异常记录：\n");
            int from = Math.max(0, lines.size() - 18);
            for (int i = from; i < lines.size(); i++) emit("system", "  " + lines.get(i) + "\n");
            f.delete();
        } catch (Throwable ignored) {}
    }

    /** 兼容读取：InputStream.readAllBytes 需 API 33，低版本调用会抛 NoSuchMethodError（Error 级，直接闪退） */
    private byte[] readAllCompat(InputStream in) throws Exception {
        try (InputStream is = in; java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    /** 把异常堆栈写到 files/boot-error.log 并返回路径，便于无 logcat 时定位闪退 */
    private String logThrowable(String tag, Throwable e) {
        File f = new File(getContext().getFilesDir(), "boot-error.log");
        try (java.io.PrintWriter pw = new java.io.PrintWriter(new java.io.OutputStreamWriter(
                new java.io.FileOutputStream(f, true), StandardCharsets.UTF_8))) {
            pw.println("=== " + tag + " " + System.currentTimeMillis() + " ===");
            pw.println("free heap=" + (Runtime.getRuntime().freeMemory() / 1024 / 1024) + "MB max="
                + (Runtime.getRuntime().maxMemory() / 1024 / 1024) + "MB");
            e.printStackTrace(pw);
            if (e instanceof Error) pw.println("(Error, 可能为 OOM/栈溢出)");
            pw.flush();
        } catch (Throwable ignored) {}
        return f.getAbsolutePath();
    }

    /** 从 nativeLibraryDir 或 APK 里找到 bootstrap zip 并解压到 PREFIX */
    private void extractBootstrap() throws Exception {
        prefix.mkdirs();
        File bootstrapZip = locateBootstrapZip();
        // 空间不足会在解压中途抛 IOException，进而整个 App 退出；提前拦截
        try {
            android.os.StatFs st = new android.os.StatFs(prefix.getAbsolutePath());
            long freeMb = st.getAvailableBytes() / 1024 / 1024;
            if (freeMb < 260) {
                throw new Exception("可用存储仅 " + freeMb + "MB，解压并安装需约 260MB，请先清理空间");
            }
        } catch (Exception se) {
            if (se.getMessage() != null && se.getMessage().contains("可用存储")) throw se;
        }
        emit("system", "解压 Termux 运行环境（约 70MB），请稍候…\n");

        // 1) 解压所有普通文件
        List<String[]> symlinks = new ArrayList<>();
        try (ZipFile zf = new ZipFile(bootstrapZip)) {
            int total = zf.size();
            int done = 0;
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String name = e.getName();
                done++;
                if (done % 400 == 0 || done == total) {
                    emit("progress", done + "/" + total);
                    // 让出时间片：主线程需要处理 IPC/渲染，长时间独占 IO 会被系统判定无响应
                    try { Thread.sleep(0, 200000); } catch (InterruptedException ignored) {}
                }
                if (name.equals("SYMLINKS.txt")) {
                    try (BufferedReader br = new BufferedReader(new InputStreamReader(zf.getInputStream(e), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = br.readLine()) != null) {
                            int idx = line.indexOf('←');
                            if (idx > 0) {
                                String target = line.substring(0, idx);
                                String link = line.substring(idx + 1);
                                if (link.startsWith("./")) link = link.substring(2);
                                symlinks.add(new String[]{ target, link });
                            }
                        }
                    }
                    continue;
                }
                File out = new File(prefix, name);
                if (e.isDirectory()) { out.mkdirs(); continue; }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (InputStream in = zf.getInputStream(e);
                     OutputStream o = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
                }
            }
        }

        // 2) 重建符号链接
        for (String[] sl : symlinks) {
            File linkFile = new File(prefix, sl[1]);
            File parent = linkFile.getParentFile();
            if (parent != null) parent.mkdirs();
            if (linkFile.exists()) linkFile.delete();
            try {
                // 符号链接目标同样写死了 com.termux 前缀，必须重写成本应用 PREFIX
                String target = sl[0].replace("/data/data/com.termux/files/usr", prefix.getAbsolutePath())
                                      .replace("/data/user/0/com.termux/files/usr", prefix.getAbsolutePath());
                Os.symlink(target, linkFile.getAbsolutePath());
            } catch (Exception ignored) {}
        }

        // 3) 必须先把关键二进制设为可执行：ZipEntry 的 unix 权限在 Android 上不生效，
        //    否则 second-stage 启动 bash 会直接 error=13 Permission denied
        ensureExecutable(bashBin());
        ensureExecutable(new File(prefix, "bin/sh"));
        ensureExecutable(new File(prefix, "bin/dpkg"));
        ensureExecutable(new File(prefix, "bin/apt-get"));
        ensureExecutable(new File(prefix, "bin/apt-cache"));
        ensureExecutable(new File(prefix, "bin/apt-key"));
        ensureExecutable(new File(prefix, "bin/gpgv"));
        ensureExecutable(new File(prefix, "lib/apt/methods/https"));
        ensureExecutable(new File(prefix, "lib/apt/methods/gpgv"));

        // 4) 修改 second-stage 脚本里硬编码的 com.termux 路径，然后执行 postinst 维护脚本
        runSecondStage();

        // 写完成标记：以后即使 bash 缺失也能据此判断是否曾成功解压
        try { writeText(new File(getContext().getFilesDir(), ".bootstrap-ok"), "ok"); } catch (Exception ignored) {}

        // 清理临时文件
        if (bootstrapZip != null && !bootstrapZip.getAbsolutePath().contains("nativeLibrary")) {
            bootstrapZip.delete();
        }
    }

    /** 确保文件可执行：setExecutable → Os.chmod → /system/bin/sh chmod 三级回退 */
    private void ensureExecutable(File f) {
        if (f == null || !f.exists()) return;
        try { if (f.canExecute()) return; } catch (Exception ignored) {}
        try { f.setExecutable(true, false); } catch (Exception ignored) {}
        try { if (!f.canExecute()) Os.chmod(f.getAbsolutePath(), 0755); } catch (Exception ignored) {}
        try {
            if (!f.canExecute()) {
                Process pr = new ProcessBuilder("/system/bin/sh", "-c",
                    "chmod 755 " + shQuote(f.getAbsolutePath())).start();
                pr.waitFor();
            }
        } catch (Exception ignored) {}
    }

    /** 把字符串安全地包成单引号 shell 字面量 */
    private static String shQuote(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /**
     * 修复所有脚本/配置文件里硬编码的 /data/data/com.termux/files/usr 路径。
     * 只处理文本脚本文件，绝对不能碰 ELF 二进制（否则会损坏 bash 等可执行文件）。
     */
    private void fixShebangs() {
        try {
            String p = prefix.getAbsolutePath();
            // 极其保守：只处理第一行以 #! 开头的文本脚本文件，绝不碰二进制
            String cmd = "find " + p + "/bin " + p + "/libexec " + p + "/etc -type f 2>/dev/null " +
                "| while read f; do " +
                "  first=$(head -c 2 \"$f\" 2>/dev/null); " +
                "  if [ \"$first\" = '#!' ]; then " +
                "    if grep -lq 'com.termux' \"$f\" 2>/dev/null; then " +
                "      sed -i 's|/data/data/com.termux/files/usr|" + p + "|g; s|/data/data/com.termux|/data/data/com.aichat.app|g' \"$f\"; " +
                "    fi; " +
                "  fi; " +
                "done; echo path-fixed";
            ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c", cmd);
            pb.redirectErrorStream(true);
            Process pr = pb.start();
            pr.waitFor();
        } catch (Exception e) {
            emit("system", "路径修复失败: " + e.getMessage() + "\n");
        }
    }

    /**
     * 修复 dpkg 状态：运行 dpkg --configure -a，确保所有已解压包正确配置。
     * 解决 "Sub-process dpkg returned an error code (2)" 问题。
     */
    private void fixDpkg() {
        try {
            String p = prefix.getAbsolutePath();
            ProcessBuilder pb = new ProcessBuilder(
                p + "/bin/dpkg", "--force-all", "--configure", "-a");
            pb.environment().put("DPKG_ADMINDIR", p + "/var/lib/dpkg");
            pb.environment().put("PATH", p + "/bin:/system/bin");
            pb.environment().put("LD_LIBRARY_PATH", p + "/lib");
            pb.environment().put("TMPDIR", tmpDir.getAbsolutePath());
            // 不设 DPKG_ROOT：dpkg/update-alternatives 会把已是绝对路径的前缀再加一次
            pb.environment().put("DEBIAN_FRONTEND", "noninteractive");
            applyPrefixHook(pb);
            pb.redirectErrorStream(true);
            Process pr = pb.start();
            pr.waitFor();
        } catch (Exception e) {
            emit("system", "dpkg 修复: " + e.getMessage() + "\n");
        }
    }

    /**
     * 运行 Termux bootstrap 第二阶段：执行所有包的 postinst 维护脚本。
     * 官方 Termux 在解压后会运行 termux-bootstrap-second-stage.sh，
     * 我们需要先把脚本里硬编码的 com.termux 路径替换成我们的 PREFIX。
     */
    /**
     * 扫描目录下的文本文件，把其中写死的 com.termux prefix 替换为本应用 PREFIX。
     * 二进制文件（前 8KB 内含 NUL 字节）一律跳过，避免破坏 ELF。
     * 用于修 postinst 里 execve 的 shebang 脚本（py3compile / pip / nano postinst 等）。
     */
    private void rewriteTextFiles(File dir, int depth) {
        if (depth > 4 || dir == null || !dir.isDirectory()) return;
        File[] fs = dir.listFiles();
        if (fs == null) return;
        String target = prefix.getAbsolutePath();
        for (File f : fs) {
            try {
                if (f.isDirectory()) { rewriteTextFiles(f, depth + 1); continue; }
                long sz = f.length();
                if (sz <= 0 || sz > 2_000_000) continue;
                byte[] data = java.nio.file.Files.readAllBytes(f.toPath());
                boolean binary = false;
                int n = Math.min(data.length, 8192);
                for (int i = 0; i < n; i++) if (data[i] == 0) { binary = true; break; }
                if (binary) continue;
                String txt = new String(data, StandardCharsets.UTF_8);
                if (txt.indexOf("com.termux") < 0) continue;
                String out = txt
                    .replace("/data/data/com.termux/files/usr", target)
                    .replace("/data/user/0/com.termux/files/usr", target);
                if (!out.equals(txt)) {
                    java.nio.file.Files.write(f.toPath(), out.getBytes(StandardCharsets.UTF_8));
                    try { f.setExecutable(true, false); } catch (Throwable ignored) {}
                }
            } catch (Throwable ignored) {}
        }
    }

    private void runSecondStage() {
        try {
            String p = prefix.getAbsolutePath();
            // postinst 会 execve bin/py3compile、pip 这类 shebang 脚本，内核解析 shebang
            // 时绕不过 LD_PRELOAD，必须在跑任何 dpkg 脚本之前把 PREFIX 下所有文本文件
            // 里写死的 com.termux 路径统一改写成本应用 PREFIX
            rewriteTextFiles(new File(prefix, "bin"), 0);
            rewriteTextFiles(new File(prefix, "etc"), 0);
            rewriteTextFiles(new File(prefix, "var/lib/dpkg/info"), 0);
            File script = new File(prefix, "etc/termux/bootstrap/termux-bootstrap-second-stage.sh");
            if (!script.exists()) { emit("system", "second-stage 脚本不存在，跳过\n"); return; }

            // 读取脚本，替换硬编码路径
            String content = new String(readAllCompat(new java.io.FileInputStream(script)), StandardCharsets.UTF_8);
            content = content.replace("/data/data/com.termux/files/usr", p);
            File patched = new File(prefix, "etc/termux/bootstrap/second-stage-patched.sh");
            writeText(patched, content);

            emit("system", "运行 bootstrap 第二阶段（postinst 维护脚本）…\n");
            ProcessBuilder pb = new ProcessBuilder(
                new File(prefix, "bin/bash").getAbsolutePath(),
                patched.getAbsolutePath());
            pb.directory(prefix);
            pb.environment().put("PREFIX", p);
            pb.environment().put("TERMUX_PREFIX", p);
            pb.environment().put("LD_LIBRARY_PATH", p + "/lib");
            pb.environment().put("PATH", p + "/bin:" + p + "/sbin:" + p + "/libexec:/system/bin");
            pb.environment().put("HOME", homeDir.getAbsolutePath());
            pb.environment().put("TMPDIR", tmpDir.getAbsolutePath());
            pb.environment().put("APT_CONFIG", p + "/etc/apt/apt.conf.d/00-prefix-override");
            pb.environment().put("DPKG_ADMINDIR", p + "/var/lib/dpkg");
            pb.environment().put("TERMINFO", p + "/share/terminfo");
            pb.environment().put("TERM", "xterm-256color");
            // postinst 里会调用 dpkg/update-alternatives，同样需要前缀重定向
            applyPrefixHook(pb);
            pb.redirectErrorStream(true);
            Process pr = pb.start();
            // 读取输出，限制长度
            byte[] out = readAllCompat(pr.getInputStream());
            int code = pr.waitFor();
            String outStr = new String(out, StandardCharsets.UTF_8);
            if (code == 0) {
                if (outStr.length() > 2000) outStr = outStr.substring(0, 2000) + "\n…（输出过长已截断）";
                emit("system", outStr);
                emit("system", "bootstrap 第二阶段完成\n");
            } else {
                // 官方 postinst 脚本强依赖 Termux 包身份（UID、/data/data/com.termux、lock 文件），
                // 在自建 PREFIX 的宿主里必然部分失败；dpkg 数据库与前缀重定向已由 ensureDpkgDb 接管，
                // 这里只回显末尾几行便于排查，不再把非零退出码当作故障抛给用户
                String tail = outStr.length() > 1200 ? outStr.substring(outStr.length() - 1200) : outStr;
                emit("system", "postinst 维护脚本部分跳过（宿主非 Termux 包，不影响 apt 安装）：\n");
                emit("system", tail);
            }
        } catch (Throwable e) {
            emit("system", "second-stage 执行失败（不影响核心功能）: " + e + "\n");
        }
    }

    /** 首次解压后的一次性准备：全量 chmod + 修复脚本 shebang；用 marker 避免每次启动重复 */
    private void preparePrefix(boolean bootstrapped) {
        File marker = new File(getContext().getFilesDir(), ".prefix-prepared-v3");
        // 每次启动只给关键二进制补权限（毫秒级）
        try {
            String p = prefix.getAbsolutePath();
            ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c",
                "chmod 755 " + p + "/bin/bash " + p + "/bin/sh " + p + "/bin/dpkg " + p + "/bin/apt " +
                p + "/lib/apt/methods/https 2>/dev/null; true");
            pb.redirectErrorStream(true);
            Process pr = pb.start();
            pr.waitFor();
        } catch (Exception ignored) {}

        if (marker.exists() && !bootstrapped) return;

        try {
            String p = prefix.getAbsolutePath();
            emit("system", "正在设置运行环境…\n");
            // 只给可执行目录补执行位。此前对整个 PREFIX 递归 chmod 755，
            // 3490 个文件里符号链接与特殊文件必然报错，既产生"权限配置错误"又极其耗时。
            ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c",
                "P=\"" + p + "\"; " +
                "for d in bin libexec lib/apt/methods; do " +
                "  [ -d \"$P/$d\" ] || continue; " +
                "  find \"$P/$d\" -type f -exec chmod 755 {} + 2>/dev/null; " +
                "done; " +
                // shebang 里写死的 com.termux 前缀只对文本脚本改写，绝不碰 ELF
                "for f in \"$P\"/bin/*; do " +
                "  [ -f \"$f\" ] || continue; " +
                "  [ \"$(head -c 2 \"$f\" 2>/dev/null)\" = '#!' ] || continue; " +
                "  sed -i \"s|/data/data/com.termux/files/usr|$P|g\" \"$f\" 2>/dev/null; " +
                "done; true");
            pb.redirectErrorStream(true);
            Process pr = pb.start();
            pr.waitFor();
            writeText(marker, "ok");
            emit("system", "环境配置完成。\n");
        } catch (Exception e) {
            emit("system", "环境配置失败: " + e.getMessage() + "\n");
        }
    }

    /** 定位 bootstrap zip：优先从 assets 复制（最可靠），再 nativeLibraryDir，最后 APK 提取 */
    private File locateBootstrapZip() throws Exception {
        // 0. 从 assets 复制（assets 不会被 Android 当 .so 处理，最可靠）
        File assetsZip = new File(getContext().getFilesDir(), "bootstrap-assets.zip");
        if (!assetsZip.exists() || assetsZip.length() < 1000000) {
            emit("system", "从资源包复制运行环境…\n");
            // 注意：绝不能 close AssetManager —— 它是全进程共享单例，
            // 关闭后整个 App 再也读不到 assets（会报 "AssetManager has been closed"）
            // 只关闭流，不关闭 AssetManager
            try (InputStream in = getContext().getAssets().open("libtermux-bootstrap.zip");
                 FileOutputStream out = new FileOutputStream(assetsZip)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } catch (Exception ae) {
                // assets 读取失败：清掉半成品，继续走后续兜底路径
                if (assetsZip.exists() && assetsZip.length() < 1000000) assetsZip.delete();
                emit("system", "assets 复制失败，尝试其它来源: " + ae.getMessage() + "\n");
            }
        }
        if (assetsZip.exists() && assetsZip.length() > 1000000) {
            return assetsZip;
        }
        // 1. nativeLibraryDir
        String nativeLibDir = getContext().getApplicationInfo().nativeLibraryDir;
        File candidate = new File(nativeLibDir, "libtermux-bootstrap.so");
        if (candidate.exists() && candidate.length() > 1000000) {
            return candidate;
        }
        // 2. 从 APK sourceDir 提取
        emit("system", "从安装包中提取运行环境…\n");
        File apk = new File(getContext().getApplicationInfo().sourceDir);
        File tempZip = new File(getContext().getFilesDir(), "bootstrap-temp.zip");
        try (ZipFile zf = new ZipFile(apk)) {
            ZipEntry e = zf.getEntry("lib/arm64-v8a/libtermux-bootstrap.so");
            if (e == null) throw new Exception("APK 内未找到 libtermux-bootstrap.so");
            try (InputStream in = zf.getInputStream(e);
                 FileOutputStream out = new FileOutputStream(tempZip)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
        return tempZip;
    }

    private void chmodDir(File dir, int mode) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isFile()) {
                try { Os.chmod(f.getAbsolutePath(), mode); } catch (Exception ignored) {}
            }
        }
    }

    /** 执行 shell 命令；参数：cmd（必填）、cwd（相对沙箱）、timeout（毫秒） */
    @PluginMethod
    public void exec(final PluginCall call) {
        final String cmd = call.getString("cmd");
        // 交互模式：终端里手敲的命令，走 pty 并保留 stdin，让用户能回答 y/n
        final boolean interactive = call.getBoolean("interactive", false);
        if (cmd == null || cmd.trim().isEmpty()) {
            call.reject("cmd 不能为空"); return;
        }
        // 如果 bash 不存在（bootstrap 解压失败），返回友好错误
        if (!bashBin().exists()) {
            JSObject ret = new JSObject();
            ret.put("stdout", "");
            ret.put("stderr", "沙箱未初始化（Termux 环境不可用）\n");
            ret.put("exitCode", 127);
            call.resolve(ret);
            return;
        }
        String cwdRel = call.getString("cwd", "");
        final File workDir;
        if (cwdRel == null || cwdRel.isEmpty()) {
            workDir = sandboxRoot;
        } else {
            File f = new File(sandboxRoot, cwdRel);
            if (!f.exists()) f.mkdirs();
            workDir = f;
        }
        int t = call.getInt("timeout", 180000);
        // apt/dpkg 需要解包、跑维护脚本、校验签名，60s 常常不够；被超时打断的表现是
        // 输出停在 "Reading package lists..." 后进程直接消失
        if (cmd.matches("(?s).*\\b(apt|apt-get|apt-cache|pkg|dpkg|pip|python\\s+-m\\s+pip)\\b.*")) {
            t = Math.max(t, 300000);
        }
        final int timeout = t;

        new Thread(() -> {
            StringBuilder outBuf = new StringBuilder();
            StringBuilder errBuf = new StringBuilder();
            int exitCode = -1;
            boolean timedOut = false;
            try {
                String prefixPath = prefix.getAbsolutePath();
                String homePath = homeDir.getAbsolutePath();
                String tmpPath = tmpDir.getAbsolutePath();
                String pathVal = prefixPath + "/bin:" + prefixPath + "/sbin:/system/bin:/system/xbin";

                // 自动给 apt/pkg install 加 -y，避免 AI 触发的命令因等待确认而 abort；
                // 用户在终端手动输入时不加，保留真实交互（y/n 通过 stdin 回答）
                boolean noAutoYes = call.getBoolean("noAutoYes", false);
                String execCmd = cmd;
                if (!noAutoYes) {
                execCmd = execCmd.replaceAll("(?<!-)apt install ", "apt install -y ");
                execCmd = execCmd.replaceAll("(?<!-)apt-get install ", "apt-get install -y ");
                execCmd = execCmd.replaceAll("(?<!-)pkg install ", "pkg install -y ");
                execCmd = execCmd.replaceAll("apt upgrade ", "apt upgrade -y ");
                execCmd = execCmd.replaceAll("pkg upgrade ", "pkg upgrade -y ");
                }

                // openclaw 等带 TUI/颜色的 CLI 在 xterm-256color 下会输出 SGR 颜色与光标/备用屏
                // 控制序列；本桥接是行级模型，解释不了光标定位，序列漏网后被逐字拆成竖排乱码。
                // 这类命令强制纯文本：注入 dumb 终端、关闭颜色与交互提示，并给 CLI 加 --no-color。
                final boolean tuiCli = cmd.matches("(?is).*\\bopenclaw\\b.*") || cmd.contains("openclaw.mjs");
                if (tuiCli) {
                    execCmd = execCmd.replaceAll("(?is)^(\\s*openclaw)(\\s+)", "$1 --no-color$2");
                }

                // 手动命令走 pty：apt 在 stdin 非 tty 时会直接 "Abort." 而不等用户回答，
                // script 用 util-linux 的伪终端包一层后，y/n 才能真正在输入框里作答
                if (interactive && new File(prefix, "bin/script").exists()) {
                    execCmd = "script -q -e -c " + shQuote(execCmd) + " /dev/null";
                    emit("system", "交互模式：命令要求确认时，在输入框敲 y 或 n 后回车\n");
                }

                // 索引为空时 apt 只会报 "Unable to locate package"，先在前面补一次 update；
                // 用分号而非 &&，即使 update 有问题也能看到原始安装阶段报错
                if (aptListsEmpty() && execCmd.matches("(?s).*\\b(apt|apt-get|pkg)\\s+install\\b.*")) {
                    emit("system", "软件源索引为空，先同步索引（apt update）…\n");
                    // 同步索引的 Get/Ign/Fetched/W 全部丢弃，只留上面那行提示：
                    // 用户不需要看镜像拉取明细，也避免 GPG 噪音污染安装日志
                    execCmd = "apt update >/dev/null 2>&1; " + execCmd;
                }

                // targetSdk=28 不受 W^X 限制，直接 exec PREFIX/bin/bash（和 Termux 一样）
                ProcessBuilder pb = new ProcessBuilder(
                        prefixPath + "/bin/bash", "--noprofile", "--norc", "-c", execCmd);
                pb.directory(workDir);
                pb.environment().put("PREFIX", prefixPath);
                pb.environment().put("LD_LIBRARY_PATH", prefixPath + "/lib");
                pb.environment().put("PATH", pathVal);
                // script(util-linux) 用 $SHELL 解析 -c 后的命令；bootstrap 的 bash 会把 SHELL
                // 指回 /data/data/com.termux/files/usr/bin/sh，不覆盖就会 exec ENOENT
                pb.environment().put("SHELL", prefixPath + "/bin/bash");
                // python/pip 编译期把 sys.prefix 写死成 /data/data/com.termux/files/usr，
                // pip 读写配置会报那个路径；显式指向本应用 PREFIX，避免依赖 hook 改写
                pb.environment().put("PIP_CONFIG_FILE", prefixPath + "/etc/pip.conf");
                // Python 3.13+ 支持 basic REPL：不走 readline，就不会发 ESC[?2004h/l
                // 括号粘贴序列（ESC 被桥接层丢弃后正是 "=>>>" 乱码的来源）
                pb.environment().put("PYTHON_BASIC_REPL", "1");
                pb.environment().put("HOME", homePath);
                pb.environment().put("TMPDIR", tmpPath);
                pb.environment().put("TERM", "xterm-256color");
                // terminfo 数据库：缺失会让 termux-change-repo / dialog / nano 报
                // "terminals database is inaccessible"
                pb.environment().put("TERMINFO", prefixPath + "/share/terminfo");
                pb.environment().put("TERMINFO_DIRS",
                    prefixPath + "/share/terminfo:/system/usr/share/terminfo");
                pb.environment().put("LANG", "en_US.UTF-8");
                if (tuiCli) {
                    // 行级桥接无法承载 TUI：dumb 终端让 CLI 退化为纯文本流，颜色/交互一并关闭
                    pb.environment().put("TERM", "dumb");
                    pb.environment().put("NO_COLOR", "1");
                    pb.environment().put("FORCE_COLOR", "0");
                    pb.environment().put("CLICOLOR", "0");
                    pb.environment().put("CI", "1");
                    pb.environment().remove("COLORTERM");
                }
                // 覆盖 apt/dpkg 硬编码的 com.termux 路径
                pb.environment().put("APT_CONFIG", prefixPath + "/etc/apt/apt.conf.d/00-prefix-override");
                pb.environment().put("DPKG_ADMINDIR", prefixPath + "/var/lib/dpkg");
                // 不设 DPKG_ROOT：会让 update-alternatives 收到的路径变成 PREFIX+PREFIX
                pb.environment().put("DPKG_DATADIR", prefixPath + "/share/dpkg");
                pb.environment().put("DPKG_DESED", prefixPath + "/etc/dpkg");
                pb.environment().put("DPKG_NOLOCK", "1");
                // SSL 证书路径（apt https method 需要）
                pb.environment().put("SSL_CERT_FILE", prefixPath + "/etc/tls/cert.pem");
                pb.environment().put("SSL_CERT_DIR", prefixPath + "/etc/tls");
                pb.environment().put("REQUESTS_CA_BUNDLE", prefixPath + "/etc/tls/cert.pem");
                pb.environment().put("CURL_CA_BUNDLE", prefixPath + "/etc/tls/cert.pem");
        // node 的 OpenSSL 默认路径被编到 /data/data/com.termux/files/usr/etc/tls/openssl.cnf，
        // 本包前缀不同，会报 BIO_new_file: Permission denied。显式指回 PREFIX 下的配置。
        pb.environment().put("OPENSSL_CONF", prefixPath + "/etc/tls/openssl.cnf");
                pb.environment().put("PIP_CERT", prefixPath + "/etc/tls/cert.pem");
                pb.environment().put("GIT_SSL_CAINFO", prefixPath + "/etc/tls/cert.pem");
                // Termux 包管理器环境变量（让 pkg 不需要 source setup 脚本）
                pb.environment().put("TERMUX_APP_PACKAGE_MANAGER", "apt");
                // 路径重定向只对写死 com.termux 前缀的程序生效（apt/dpkg/pip/gpgv 等）；
                // 普通命令不加载该库，避免无谓的原生调用开销与潜在崩溃面
                if (needsPrefixHook(execCmd)) applyPrefixHook(pb);
                pb.environment().put("TERMUX_MAIN_PACKAGE_FORMAT", "debian");
                // 非交互式安装，避免 apt 等待用户确认而 abort
                pb.environment().put("DEBIAN_FRONTEND", "noninteractive");
                pb.environment().put("APT_LISTCHANGES_FRONTEND", "none");
                pb.redirectErrorStream(false);

                Process proc;
                synchronized (procLock) {
                    // 单终端串行：并发跑两个 apt 会互相抢 lists 锁，表现为卡在
                    // "Reading package lists..." 然后其中一方悄无声息退出
                    if (currentProcess != null && currentProcess.isAlive()) {
                        call.reject("已有命令正在执行，请等待完成或点“结束命令”后再试");
                        return;
                    }
                    currentProcess = pb.start();
                    proc = currentProcess;
                }
                // 不关闭 stdin：apt upgrade/remove 等会在此处等待 y/n，
                // 关闭流会让它直接 Abort，用户也无法在输入框作答
                synchronized (procLock) { currentStdin = proc.getOutputStream(); }

                final Process p = proc;
                Thread outThread = streamReader(p.getInputStream(), "stdout", outBuf);
                Thread errThread = streamReader(p.getErrorStream(), "stderr", errBuf);

                long start = System.currentTimeMillis();
                while (true) {
                    try {
                        exitCode = p.exitValue();
                        break;
                    } catch (IllegalThreadStateException e) {
                        if (System.currentTimeMillis() - start > timeout) {
                            timedOut = true;
                            p.destroy();
                            exitCode = -1;
                            break;
                        }
                        Thread.sleep(50);
                    }
                }
                outThread.join(2000);
                errThread.join(2000);
                synchronized (procLock) {
                    if (currentProcess == proc) currentProcess = null;
                    currentStdin = null;
                }
            } catch (Exception e) {
                call.reject("执行异常: " + e.getMessage());
                return;
            }

            if (timedOut) {
                emit("system", "命令超时（" + timeout + "ms），已终止\n");
            }

            // seccomp 策略由 zygote 施加且只能加严，应用内无法修改；一旦 postinst 被 SIGSYS 杀掉，
            // 唯一可行路径是跳过维护脚本让包进入已配置状态，这里自动补一次，避免用户手动重试
            String allOut = outBuf.toString() + errBuf.toString();
            // 安装/配置类命令成功后补齐 pip（Termux 的 python-pip postinst 会调用 pip 本身，必然 not found）
            if (!timedOut && exitCode == 0 && cmd.matches("(?s).*(apt|apt-get|pkg|dpkg)\\b.*")) {
                ensurePip();
            }
            if (!timedOut && exitCode != 0 && allOut.contains("Bad system call")
                    && !cmd.contains("AICHAT_SKIP_POSTINST")) {
                emit("system", "检测到维护脚本被内核 seccomp 终止（SIGSYS），自动跳过 postinst 完成配置…\n");
                String p2 = prefix.getAbsolutePath();
                try {
                    ProcessBuilder pb2 = new ProcessBuilder(p2 + "/bin/bash", "--noprofile", "--norc", "-c",
                            "AICHAT_SKIP_POSTINST=1 " + p2 + "/bin/dpkg --configure -a");
                    pb2.directory(workDir);
                    pb2.environment().put("PREFIX", p2);
                    pb2.environment().put("LD_LIBRARY_PATH", p2 + "/lib");
                    pb2.environment().put("PATH", p2 + "/bin:" + p2 + "/sbin:/system/bin");
                    pb2.environment().put("HOME", homeDir.getAbsolutePath());
                    pb2.environment().put("TMPDIR", tmpDir.getAbsolutePath());
                    pb2.environment().put("TERM", "xterm-256color");
                    pb2.environment().put("TERMINFO", p2 + "/share/terminfo");
                    pb2.environment().put("APT_CONFIG", p2 + "/etc/apt/apt.conf.d/00-prefix-override");
                    pb2.environment().put("DPKG_ADMINDIR", p2 + "/var/lib/dpkg");
                    pb2.environment().put("DPKG_NOLOCK", "1");
                    pb2.environment().put("DEBIAN_FRONTEND", "noninteractive");
                    pb2.redirectErrorStream(true);
                    Process pr2 = pb2.start();
                    String r2 = new String(readAllCompat(pr2.getInputStream()), StandardCharsets.UTF_8);
                    int c2 = pr2.waitFor();
                    emit("system", r2.length() > 3000 ? r2.substring(r2.length() - 3000) : r2);
                    if (c2 == 0) {
                        emit("system", "已跳过维护脚本完成全部配置（包管理状态一致）\n");
                        exitCode = 0;
                        errBuf.append("\n[已自动跳过 SIGSYS 的 postinst 完成配置]\n");
                    }
                } catch (Throwable t2) {
                    emit("system", "自动跳过失败: " + t2 + "\n");
                }
            }
            JSObject ret = new JSObject();
            ret.put("code", exitCode);
            ret.put("stdout", outBuf.toString());
            ret.put("stderr", errBuf.toString());
            ret.put("timedOut", timedOut);
            call.resolve(ret);
        }).start();
    }

    /** python-pip 的 postinst 依赖 pip 自身存在（先有鸡生蛋问题），装完 python 后补一次 ensurepip */
    private void ensurePip() {
        File pip = new File(prefix, "bin/pip");
        if (pip.exists()) return;
        File py = new File(prefix, "bin/python");
        if (!py.exists()) return;
        File marker = new File(prefix, ".pip-bootstrapped");
        if (marker.exists()) return;
        try {
            String p = prefix.getAbsolutePath();
            ProcessBuilder pb = new ProcessBuilder(py.getAbsolutePath(), "-m", "ensurepip", "--upgrade", "--default-pip");
            pb.directory(prefix);
            pb.environment().put("PREFIX", p);
            pb.environment().put("LD_LIBRARY_PATH", p + "/lib");
            pb.environment().put("PATH", p + "/bin:" + p + "/sbin:/system/bin");
            pb.environment().put("HOME", homeDir.getAbsolutePath());
            pb.environment().put("TMPDIR", tmpDir.getAbsolutePath());
            pb.environment().put("TERM", "xterm-256color");
            pb.environment().put("TERMINFO", p + "/share/terminfo");
            pb.redirectErrorStream(true);
            Process pr = pb.start();
            String out = new String(readAllCompat(pr.getInputStream()), StandardCharsets.UTF_8);
            int code = pr.waitFor();
            if (code == 0) {
                writeText(marker, "ok");
                emit("system", "pip 已初始化（python -m ensurepip）\n");
            } else {
                String tail = out.length() > 600 ? out.substring(out.length() - 600) : out;
                emit("system", "pip 初始化未完成，可手动执行 python -m ensurepip --upgrade：\n" + tail);
            }
        } catch (Throwable e) {
            emit("system", "pip 初始化异常: " + e + "\n");
        }
    }

    /** 向前台进程的 stdin 写入一行（交互式确认，如 apt 的 y/n） */
    @PluginMethod
    public void stdin(final PluginCall call) {
        final String text = call.getString("text", "");
        OutputStream os;
        synchronized (procLock) { os = currentStdin; }
        if (os == null) { call.reject("当前没有等待输入的命令"); return; }
        new Thread(() -> {
            try {
                os.write((text + "\n").getBytes(StandardCharsets.UTF_8));
                os.flush();
                call.resolve();
            } catch (Throwable e) {
                call.reject("写入输入失败: " + e.getMessage());
            }
        }).start();
    }

    /** 终止当前正在执行的进程 */
    @PluginMethod
    public void kill(final PluginCall call) {
        new Thread(() -> {
            Process target;
            synchronized (procLock) {
                target = currentProcess;
                currentProcess = null;
            }
            boolean killed = false;
            if (target != null) {
                killed = true;
                try {
                    // 先发送终止信号（等价 Ctrl+C 的终止语义），
                    // 1.2s 内仍未退出则强制杀掉，避免子进程残留占住管道
                    target.destroy();
                    long deadline = System.currentTimeMillis() + 1200;
                    while (System.currentTimeMillis() < deadline) {
                        try {
                            target.exitValue();
                            break;
                        } catch (IllegalThreadStateException e) {
                            Thread.sleep(60);
                        }
                    }
                    try { target.exitValue(); } catch (IllegalThreadStateException e) { target.destroyForcibly(); }
                } catch (Exception ignored) {}
            }
            JSObject ret = new JSObject();
            ret.put("killed", killed);
            call.resolve(ret);
        }).start();
    }

    private int emitSeq = 0;
    /** 软件源索引是否为空（为空时 apt 无法定位任何包） */
    private boolean aptListsEmpty() {
        File lists = new File(prefix, "var/lib/apt/lists");
        File[] fs = lists.listFiles();
        if (fs == null) return true;
        for (File f : fs) {
            if (f.isFile() && f.length() > 1024) return false;
        }
        return true;
    }

    /** 递归补齐可执行位。
     *  之前用 shell 的 `find -exec chmod 755 {} +`，Android 自带的 toybox find 不支持 "+" 形式，
     *  命令静默失败，导致 apt-get 与 lib/apt/methods/gpgv 一直 Permission denied。 */
    /** apt 与 dpkg 版本不匹配：新版 apt 会给 dpkg 传 --force-gnu-system，
     *  bootstrap 内的 dpkg 不认该选项，直接以 error 2 退出。
     *  把真实 dpkg 改名并前置转发脚本，过滤掉不认识的 force 选项。 */
    /** 修正 dpkg 维护脚本的解释器路径（com.termux → 本应用 PREFIX），并补可执行位 */
    private void rewriteMaintainerScripts() {
        File info = new File(prefix, "var/lib/dpkg/info");
        File[] files = info.listFiles();
        if (files == null) return;
        String oldA = "/data/data/com.termux/files/usr";
        String oldB = "/data/user/0/com.termux/files/usr";
        int fixed = 0;
        for (File f : files) {
            String n = f.getName();
            if (!(n.endsWith(".postinst") || n.endsWith(".preinst") || n.endsWith(".prerm")
                    || n.endsWith(".postrm") || n.endsWith(".trigger") || n.endsWith(".config"))) continue;
            try {
                String c = new String(readAllCompat(new java.io.FileInputStream(f)), StandardCharsets.UTF_8);
                if (c.contains(oldA) || c.contains(oldB)) {
                    writeText(f, c.replace(oldA, prefix.getAbsolutePath()).replace(oldB, prefix.getAbsolutePath()));
                    fixed++;
                }
                ensureExecutable(f);
            } catch (Throwable ignored) {}
        }
        if (fixed > 0) emit("system", "已修正 " + fixed + " 个维护脚本路径\n");
    }

    /**
     * update-alternatives 兼容层。
     * coreutils 新版 postinst 会把 libexec/coreutils/<applet> 注册为 alternative，
     * 但本 bootstrap 的 coreutils 是单二进制 bin/coreutils（多调用派发），libexec 下只有 libstdbuf.so，
     * 于是 u-a 判路径不存在 → postinst 返回 2 → dpkg 卡在 "installed but not configured"。
     * 做法：包一层 wrapper，失败时按报错里的路径补 coreutils 硬链接再重试一次，仍失败降级为警告。
     */
    private void ensureUaWrapper() {
        File bin = new File(prefix, "bin");
        File ua = new File(bin, "update-alternatives");
        File real = new File(bin, "update-alternatives.real");
        try {
            if (!ua.exists() && !real.exists()) return;
            // 若 bin/update-alternatives 仍是 ELF（被 dpkg 升级后又覆盖回来），先把它挪成 .real，
            // 否则直接写 wrapper 会把真实二进制内容冲掉
            if (ua.exists()) {
                byte[] head = new byte[4];
                try (java.io.FileInputStream is = new java.io.FileInputStream(ua)) { is.read(head); }
                boolean elf = head[0] == 0x7f && head[1] == 'E' && head[2] == 'L' && head[3] == 'F';
                if (elf) {
                    real.delete();
                    if (!ua.renameTo(real)) return;
                }
            }
            String abs = prefix.getAbsolutePath();
            String script =
                "#!" + abs + "/bin/bash\n" +
                "export PATH=\"" + abs + "/bin:" + abs + "/sbin:/system/bin:/system/xbin\"\n" +
                "REAL=\"" + abs + "/bin/update-alternatives.real\"\n" +
                "CORE=\"" + abs + "/bin/coreutils\"\n" +
                "if [ ! -x \"$REAL\" ]; then exit 0; fi\n" +
                "retry=0\n" +
                "while true; do\n" +
                "  out=$($REAL \"$@\" 2>&1); rc=$?\n" +
                "  if [ $rc -eq 0 ]; then printf '%s\\n' \"$out\"; exit 0; fi\n" +
                "  if [ $retry -eq 0 ]; then\n" +
                "    fixed=0\n" +
                "    for p in $(printf '%s\\n' \"$out\" | sed -n \"s/.*alternative path \\(.*\\) doesn.t exist.*/\\1/p\"); do\n" +
                "      case \"$p\" in *libexec/coreutils/*)\n" +
                "        mkdir -p \"$(dirname \"$p\")\" 2>/dev/null\n" +
                "        if [ ! -e \"$p\" ] && [ -x \"$CORE\" ]; then ln -s \"$CORE\" \"$p\" 2>/dev/null && fixed=1; fi;;\n" +
                "      esac\n" +
                "    done\n" +
                "    if [ $fixed -eq 1 ]; then retry=1; continue; fi\n" +
                "  fi\n" +
                "  printf '%s\\n' \"$out\"\n" +
                "  echo \"W: update-alternatives 已跳过（不影响包安装）\"\n" +
                "  exit 0\n" +
                "done\n";
            writeText(ua, script);
            try { ua.setExecutable(true, false); } catch (Throwable ignored) {}
        } catch (Throwable t) {
            logThrowable("ensureUaWrapper", t);
        }
    }

    /**
     * Termux 的 py3compile/pycompile 会拿 /data/data/com.termux/files/usr/bin/python3.x
     * 做存在性与版本校验，在应用沙箱里这些路径不存在，postinst 必然报
     * "E: py3compile:276: Requested versions are not installed"。
     * 它只负责预编译 .pyc，跳过不影响运行（首次 import 时由解释器自动生成）。
     * 原脚本保留为 <name>.real，需要真编译时可手动调用。
     */
    private void ensureNoOpPyCompile() {
        String[] names = {"py3compile", "pycompile", "py3clean"};
        String marker = "# aichat-noop-pycompile";
        for (String n : names) {
            try {
                File f = new File(prefix, "bin/" + n);
                if (!f.exists()) continue;
                boolean already = false;
                try (InputStream is = new java.io.FileInputStream(f)) {
                    byte[] head = new byte[200];
                    int r = is.read(head);
                    if (r > 0 && new String(head, 0, r, StandardCharsets.UTF_8).contains(marker)) already = true;
                }
                if (already) continue;
                File real = new File(prefix, "bin/" + n + ".real");
                if (!real.exists()) {
                    if (!f.renameTo(real)) continue;
                } else {
                    f.delete();
                }
                String script = "#!" + prefix.getAbsolutePath() + "/bin/sh\n" + marker + "\n"
                    + "# 仅预编译字节码，沙箱内核对 com.termux 前缀校验必然失败，此处直接成功返回\n"
                    + "exit 0\n";
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(f)) {
                    fos.write(script.getBytes(StandardCharsets.UTF_8));
                }
                ensureExecutable(f);
            } catch (Throwable ignored) {}
        }
    }

    private void ensureDpkgWrapper() {
        File bin = new File(prefix, "bin");
        File dpkg = new File(bin, "dpkg");
        File real = new File(bin, "dpkg.real");
        try {
            if (!real.exists()) {
                if (!dpkg.exists()) return;
                byte[] head = new byte[4];
                try (InputStream is = new java.io.FileInputStream(dpkg)) { is.read(head); }
                // 已是包装脚本则跳过，仅 ELF 才需要改名
                boolean elf = head[0] == 0x7f && head[1] == 'E' && head[2] == 'L' && head[3] == 'F';
                if (!elf) return;
                if (!dpkg.renameTo(real)) {
                    emit("system", "⚠ dpkg 包装器创建失败（重命名被拒）\n");
                    return;
                }
            }
            java.io.File wrapper = new java.io.File(bin, "dpkg");
            String script =
                "#!" + prefix.getAbsolutePath() + "/bin/bash\n" +
                // dpkg 会按 PATH 查找 sh/rm/tar/diff/dpkg-deb/dpkg-split/start-stop-daemon，
                // 并在子进程里重新 exec 这些二进制；环境必须在此显式固定，不能依赖调用方透传
                "export PREFIX=\"" + prefix.getAbsolutePath() + "\"\n" +
                "export PATH=\"" + prefix.getAbsolutePath() + "/bin:" + prefix.getAbsolutePath() +
                    "/sbin:/system/bin:/system/xbin\"\n" +
                "export LD_LIBRARY_PATH=\"" + prefix.getAbsolutePath() + "/lib\"\n" +
                "export TERMINFO=\"" + prefix.getAbsolutePath() + "/share/terminfo\"\n" +
                "export DPKG_ADMINDIR=\"" + prefix.getAbsolutePath() + "/var/lib/dpkg\"\n" +
                "export DPKG_NOLOCK=1\n" +
                // dpkg 解包 deb 时以相对成员路径 ./data/data/com.termux/... 落盘，
                // 必须先预加载 hook 才会改写到本应用目录；没有 hook 时退回不 preload
                "if [ -n \"$AICHAT_HOOK\" ] && [ -f \"$AICHAT_HOOK\" ]; then export LD_PRELOAD=\"$AICHAT_HOOK\"; else unset LD_PRELOAD; fi\n" +
                "info=\"$PREFIX/var/lib/dpkg/info\"\n" +
                // deb 里的 postinst/preinst 首行写死 /data/data/com.termux/files/usr/bin/sh，
                // 内核对 shebang 的解析绕不过 LD_PRELOAD，必须先改写成本应用路径，否则 exec 直接 ENOENT
                "if [ -d \"$info\" ]; then\n" +
                "  for f in \"$info\"/*.postinst \"$info\"/*.preinst \"$info\"/*.prerm \"$info\"/*.postrm \"$info\"/*.trigger; do\n" +
                "    [ -f \"$f\" ] || continue\n" +
                "    grep -q 'com.termux/files/usr' \"$f\" 2>/dev/null || continue\n" +
                "    sed -i \"s|/data/data/com.termux/files/usr|$PREFIX|g; s|/data/user/0/com.termux/files/usr|$PREFIX|g\" \"$f\" 2>/dev/null\n" +
                "    chmod 755 \"$f\" 2>/dev/null\n" +
                "  done\n" +
                "fi\n" +
                // pip 的 sys.prefix 编译期写死 com.termux，显式指到本应用，避免 "Writing to ...com.termux..."\n"
                "export PIP_CONFIG_FILE=\"$PREFIX/etc/pip.conf\"\n" +
                // 装包会覆盖 py3compile；它按 com.termux 前缀校验 python3.x，沙箱内必然
                // 报 "E: py3compile:276: Requested versions are not installed"，configure 前先打回空实现
                "for n in py3compile pycompile py3clean; do\n" +
                "  pf=\"$PREFIX/bin/$n\"\n" +
                "  [ -f \"$pf\" ] || continue\n" +
                "  grep -q 'aichat-noop-pycompile' \"$pf\" 2>/dev/null && continue\n" +
                "  mv -f \"$pf\" \"$pf.real\" 2>/dev/null\n" +
                "  printf '#!/bin/sh\\n# aichat-noop-pycompile\\nexit 0\\n' > \"$pf\"\n" +
                "  chmod 755 \"$pf\" 2>/dev/null\n" +
                "done\n" +
                // 新装包会带来新的 shebang 脚本（py3compile / pip / 各种 helper），每次 dpkg 调用前扫一遍 bin/
                "for f in \"$PREFIX\"/bin/*; do\n" +
                "  [ -f \"$f\" ] || continue\n" +
                "  case \"$f\" in *.real|*.dpkg-new) continue;; esac\n" +
                "  head -c 200 \"$f\" 2>/dev/null | grep -q 'com.termux/files/usr' || continue\n" +
                "  sed -i \"s|/data/data/com.termux/files/usr|$PREFIX|g; s|/data/user/0/com.termux/files/usr|$PREFIX|g\" \"$f\" 2>/dev/null\n" +
                "done\n" +
                // 显式开关：部分设备的 seccomp 策略会以 SIGSYS 杀掉 postinst，
                // 此时只能跳过维护脚本让包进入已配置状态（AICHAT_SKIP_POSTINST=1 dpkg --configure -a）
                "if [ -n \"$AICHAT_SKIP_POSTINST\" ] && [ -d \"$info\" ]; then\n" +
                "  for f in \"$info\"/*.postinst \"$info\"/*.preinst; do\n" +
                "    [ -f \"$f\" ] || continue\n" +
                "    grep -q 'AICHAT_SKIP_MARK' \"$f\" 2>/dev/null && continue\n" +
                "    sed -i '1a #AICHAT_SKIP_MARK' \"$f\" 2>/dev/null\n" +
                "    sed -i '/#AICHAT_SKIP_MARK/a exit 0' \"$f\" 2>/dev/null\n" +
                "  done\n" +
                "fi\n" +
                "real=\"" + bin.getAbsolutePath() + "/dpkg.real\"\n" +
                "args=()\n" +
                "for a in \"$@\"; do\n" +
                "  case \"$a\" in\n" +
                "    --force-gnu-system|--no-force-gnu-system) ;;\n" +
                "    *) args+=(\"$a\") ;;\n" +
                "  esac\n" +
                "done\n" +
                "exec \"$real\" \"${args[@]}\"\n";
            writeText(wrapper, script);
            ensureExecutable(wrapper);
            emit("system", "已为 dpkg 配置参数兼容层\n");
        } catch (Throwable e) {
            emit("system", "⚠ dpkg 兼容层异常: " + e + "\n");
        }
    }

    private void fixExecPermissions() {
        String[] dirs = {"bin", "libexec", "lib/apt/methods", "lib/apt/solvers", "lib/apt/planners"};
        int fixed = 0;
        for (String d : dirs) {
            File dir = new File(prefix, d);
            File[] files = dir.listFiles();
            if (files == null) continue;
            for (File f : files) {
                if (f.isDirectory()) continue;
                try {
                    Os.chmod(f.getAbsolutePath(), 0755);
                    fixed++;
                } catch (Exception e) {
                    try { f.setExecutable(true, false); } catch (Exception ignored) {}
                }
            }
        }
        if (fixed > 0) emit("system", "已校验 " + fixed + " 个可执行文件权限\n");
    }

    /** 判断命令是否会调用写死 com.termux 前缀的二进制 */
    private static boolean needsPrefixHook(String cmd) {
        if (cmd == null) return false;
        return cmd.matches("(?s).*\\b(apt|apt-get|apt-cache|dpkg|dpkg-deb|pkg|gpgv|gpg\\.error|pip|pip3|python|python3|termux-change-repo|termux-setup-storage)\\b.*");
    }

    /** 给子进程注入路径重定向库：把 /data/data/com.termux/files/usr 映射到本应用 PREFIX */
    private void applyPrefixHook(ProcessBuilder pb) {
        try {
            File so = new File(getContext().getApplicationInfo().nativeLibraryDir, "libprefixhook.so");
            if (!so.exists()) return;
            String cur = pb.environment().get("LD_PRELOAD");
            pb.environment().put("LD_PRELOAD", (cur == null || cur.isEmpty())
                ? so.getAbsolutePath() : so.getAbsolutePath() + ":" + cur);
            pb.environment().put("AICHAT_PREFIX", prefix.getAbsolutePath());
            // dpkg 解包时要写 ./data/data/com.termux/**，hook 需要知道映射到哪个应用根目录
            pb.environment().put("AICHAT_APP_ROOT", getContext().getApplicationInfo().dataDir);
            pb.environment().put("AICHAT_HOOK", so.getAbsolutePath());
        } catch (Exception ignored) {}
    }

    // 终端 ANSI 序列：ls/apt 在带 tty 时会输出颜色，直接透到 WebView 会显示成 "[0m[01;34m" 这类残片
    private static final java.util.regex.Pattern ANSI_RE =
            java.util.regex.Pattern.compile("\u001B\\[[0-9;?]*[ -/]*[@-~]");

    private void emit(String stream, String text) {
        // apt 前端在非交互环境下必定打印该警告，属噪音，不推送到终端
        if (text != null && text.contains("does not have a stable CLI interface")) return;
        // gpgv 在本环境无法回报 VALIDSIG，apt 已按 AllowInsecureRepositories 降级并接受索引，
        // 这条 W 只是提示签名链不完整，不影响安装
        if (text != null && text.contains("could not determine key fingerprint")) return;
        // glib.postinst 找不到 GSettings schema 目录，只影响 schema 编译，非错误
        if (text != null && text.contains("No schema files found")) return;
        if (text != null && (text.contains("Certificate verification failed") || text.contains("certificate verify failed"))) return;
        if (text != null && (text.contains("Corrupt JPEG data") || text.contains("JPEG warning"))) return;
        try {
            if (text != null && text.indexOf('\u001B') >= 0) text = ANSI_RE.matcher(text).replaceAll("");
            JSObject ev = new JSObject();
            ev.put("stream", stream);
            ev.put("text", text);
            ev.put("seq", ++emitSeq);
            notifyListeners("output", ev);
        } catch (Exception ignored) {}
    }

    /** 推送一行（含未换行结束的提示符）；超过上限只提示一次 */
    /**
     * 剥离 ANSI/控制序列后再下发。readline（python REPL）在 pty 下会发
     * ESC[?2004h 开启括号粘贴模式；ESC 一旦在桥接层丢失，剩下 "[?2004h"
     * 会被前端渲染成方块或 "=>>>"，所以两端都要清。
     */
    private static String sanitizeControl(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        return raw
            .replaceAll("\u001b\\[[0-9;?]*[ -/]*[@-~]", "")
            .replaceAll("\u001b\\][^\u0007]*\u0007", "")
            .replaceAll("\\[?\\??2004[hl]", "")
            .replaceAll("[\u0000-\u0008\u000b\u000c\u000e-\u001f]", "");
    }

    /** apt/dpkg 的 \r 原地刷新型进度（Termux 里是一条会跳动的绿色行） */
    private static boolean isProgressLine(String t) {
        if (t == null || t.isEmpty() || t.indexOf('%') < 0) return false;
        return t.matches("^\\d+% \\[.*")          // 45% [9 clang 28.5 MB/30.7 MB 93%] / 3% [Working]
            || t.matches("^.*\\.\\.\\.\\s*\\d+%") // Reading package lists... 98%
            || t.startsWith("(Reading database ...")  // (Reading database ... 55%
            || t.startsWith("Building dependency tree...")
            || t.startsWith("Reading state information...");
    }

    /** 进度事件：同一逻辑行被 \r 覆盖，前端只更新一个节点，不新增行 */
    private void emitProgress(String stream, String text) {
        if (text == null) return;
        String clean = ANSI_RE.matcher(sanitizeControl(text)).replaceAll("").trim();
        if (clean.isEmpty()) return;
        try {
            JSObject ev = new JSObject();
            ev.put("stream", stream);
            ev.put("text", clean);
            notifyListeners("progress", ev);
        } catch (Exception ignored) {}
    }

    private void flushStreamLine(StringBuilder line, String stream, StringBuilder buf) {
        String text = sanitizeControl(line.toString());
        line.setLength(0);
        if (text.isEmpty()) return;
        if (buf.length() > 500000) return;
        buf.append(text).append('\n');
        emit(stream, text + "\n");
    }

    /**
     * 简化 VT 行模型：只实现 apt/dpkg/交互程序实际用到的 CR、BS、EL(清行) 与 SGR(前景色)，
     * 按控制序列语义渲染而不是靠文本前缀猜格式。Termux 用的是一整套 terminal emulator，
     * 这里退化成“行级”模型即可覆盖 apt/dpkg 的所有用法，效果一致。
     */
    private static final class TermBuf {
        final StringBuilder text = new StringBuilder();
        final java.util.List<Integer> colors = new java.util.ArrayList<>();
        int col = 0;
        int curColor = -1;

        void reset() { text.setLength(0); colors.clear(); col = 0; }

        void put(char c) {
            while (col > text.length()) {
                text.append(' ');
                colors.add(curColor);
            }
            if (col < text.length()) {
                text.setCharAt(col, c);
                if (col < colors.size()) colors.set(col, curColor);
            } else {
                text.append(c);
                colors.add(curColor);
            }
            col++;
        }

        void carriageReturn() { col = 0; }
        void backspace() { if (col > 0) col--; }

        void eraseToEnd() {
            if (col < text.length()) {
                text.setLength(col);
                while (colors.size() > col) colors.remove(colors.size() - 1);
            }
        }

        void eraseAll() { text.setLength(0); colors.clear(); col = 0; }

        int colorAt(int i) { return i < colors.size() ? colors.get(i) : -1; }
        boolean isEmpty() { return text.length() == 0; }
    }

    /** 把 TermBuf 拆成同色片段，前端按片段生成 span，颜色完全来自程序自身的 SGR */
    /** CSI 状态机漏掉的裸转义片段兜底剥离：ESC 丢失后残留的 "[90m"、"[?2004h" 等不再落到前端 */
    private static String stripResidualAnsi(String s) {
        if (s == null) return "";
        return s.replaceAll("\u001B\\[[0-9;?]*[ -/]*[@-~]", "")
            .replaceAll("\u001B\\][^\u0007\n]*\u0007", "")
            .replaceAll("\\[\\d+(?:;\\d+)*m", "")
            .replaceAll("\\[?\\??2004[hl]", "")
            .replaceAll("\\[\\?\\d*[hl]", "")
            .replaceAll("\\[[0-9;]*[JKH]", "")
            .replaceAll("[\u0000-\u0008\u000b\u000c\u000e-\u001f]", "");
    }

    private void emitBuffer(String stream, TermBuf tb, boolean fin) {
        if (tb == null) return;
        int len = tb.text.length();
        String plain = stripResidualAnsi(tb.text.toString()).trim();
        if (!fin && plain.isEmpty()) return;
        try {
            com.getcapacitor.JSArray runs = new com.getcapacitor.JSArray();
            int i = 0;
            while (i < len) {
                int c = tb.colorAt(i);
                int j = i + 1;
                while (j < len && tb.colorAt(j) == c) j++;
                String seg = stripResidualAnsi(tb.text.substring(i, j));
                if (seg.isEmpty()) { i = j; continue; }
                if (c >= 0 && c <= 7) {
                    JSObject run = new JSObject();
                    run.put("t", seg);
                    run.put("c", c);
                    runs.put(run);
                } else {
                    runs.put(seg);
                }
                i = j;
            }
            JSObject ev = new JSObject();
            ev.put("stream", stream);
            ev.put("runs", runs);
            ev.put("fin", fin);
            notifyListeners(fin ? "output" : "progress", ev);
        } catch (Exception ignored) {}
    }

    private void applySgr(TermBuf tb, String params) {
        String p = params.isEmpty() ? "0" : params;
        String[] parts = p.split(";");
        for (int i = 0; i < parts.length; i++) {
            String x = parts[i];
            if (x.isEmpty()) { tb.curColor = -1; continue; }
            int v;
            try { v = Integer.parseInt(x); } catch (Exception e) { continue; }
            if (v == 0) tb.curColor = -1;
            else if (v >= 30 && v <= 37) tb.curColor = v - 30;
            else if (v == 39) tb.curColor = -1;
            else if (v == 38 || v == 48) {
                // 256 色 / 真彩：跳过其参数，取近似默认色
                if (i + 1 < parts.length && (parts[i + 1].equals("5"))) i += 2;
                else if (i + 1 < parts.length && (parts[i + 1].equals("2"))) i += 4;
            }
        }
    }

    /** 末尾不完整 UTF-8 序列的字节数：多字节字符若被读边界拆开，留到下一块再解码，避免半个字变替换符 */
    private static int trailingIncompleteUtf8(byte[] b, int len) {
        int i = len - 1, cont = 0;
        while (i >= 0 && (b[i] & 0xC0) == 0x80) { cont++; i--; }
        if (i < 0) return 0;
        int lead = b[i] & 0xFF;
        int need;
        if ((lead & 0x80) == 0) need = 1;
        else if ((lead & 0xE0) == 0xC0) need = 2;
        else if ((lead & 0xF0) == 0xE0) need = 3;
        else if ((lead & 0xF8) == 0xF0) need = 4;
        else need = 1;
        int missing = need - cont - 1;
        return Math.max(0, missing);
    }

    /** 把一段已按完整字符边界解码的文本喂入行模型；state 用 int[] 以便跨块保留 CSI/OSC 状态 */
    private void feedTermSeg(TermBuf tb, StringBuilder csi, int[] state, String seg, String stream, StringBuilder buf) {
        for (int i = 0; i < seg.length(); i++) {
            char c = seg.charAt(i);
            if (state[0] == 0) {
                if (c == '\u001b') { state[0] = 1; continue; }
                if (c == '\n') {
                    // 换行：这一行已经是最终内容
                    if (buf.length() < 500000) buf.append(tb.text).append('\n');
                    emitBuffer(stream, tb, true);
                    tb.reset();
                } else if (c == '\r') {
                    // 回车：把当前已显示内容推给前端（下一段会原地覆盖）
                    if (buf.length() < 500000) buf.append(tb.text).append('\n');
                    emitBuffer(stream, tb, false);
                    tb.carriageReturn();
                } else if (c == '\b') {
                    tb.backspace();
                } else if (c == '\t') {
                    int next = ((tb.col / 8) + 1) * 8;
                    while (tb.col < next) tb.put(' ');
                } else if (c < 0x20 || c == 0x7f) {
                    // 其余 C0（含 \u0001 \u0002 \u0007）丢弃
                } else {
                    tb.put(c);
                }
            } else if (state[0] == 1) {
                if (c == '[') { state[0] = 2; csi.setLength(0); }
                else if (c == ']') { state[0] = 3; }
                else state[0] = 0;
            } else if (state[0] == 2) {
                if (c >= 0x40 && c <= 0x7e) {
                    String ps = csi.toString();
                    if (c == 'K') {
                        String mode = ps.replace("?", "");
                        if ("2".equals(mode)) tb.eraseAll();
                        else if ("0".equals(mode) || mode.isEmpty()) tb.eraseToEnd();
                        emitBuffer(stream, tb, false);
                    } else if (c == 'J') {
                        if ("2".equals(ps.replace("?", "")) || "3".equals(ps.replace("?", ""))) {
                            tb.eraseAll();
                            emitBuffer(stream, tb, false);
                        }
                    } else if (c == 'm') {
                        applySgr(tb, ps);
                    }
                    // H/A/B/C/D 等光标定位在行模型下无意义，直接忽略
                    state[0] = 0;
                } else {
                    csi.append(c);
                }
            } else if (state[0] == 3) {
                if (c == '\u0007') state[0] = 0;
            }
        }
    }

    private Thread streamReader(final InputStream is, final String stream, final StringBuilder buf) {
        Thread th = new Thread(() -> {
            final byte[] chunk = new byte[4096];
            final TermBuf tb = new TermBuf();
            final StringBuilder csi = new StringBuilder();
            final int[] state = {0}; // 0=普通 1=ESC 2=CSI 3=OSC
            final java.io.ByteArrayOutputStream pending = new java.io.ByteArrayOutputStream();
            int n;
            try {
                while ((n = is.read(chunk)) != -1) {
                    pending.write(chunk, 0, n);
                    byte[] all = pending.toByteArray();
                    int tail = trailingIncompleteUtf8(all, all.length);
                    int decLen = all.length - tail;
                    String seg = new String(all, 0, decLen, StandardCharsets.UTF_8);
                    pending.reset();
                    if (tail > 0) pending.write(all, decLen, tail);
                    feedTermSeg(tb, csi, state, seg, stream, buf);
                    // 进程阻塞等输入（读缓冲空）：把提示符作为活动行推出去
                    if (tb.col > 0 && is.available() == 0) emitBuffer(stream, tb, false);
                }
                // EOF：把残留的不完整序列按兜底解码吐出，避免末尾半个字丢失
                if (pending.size() > 0) {
                    String seg = new String(pending.toByteArray(), StandardCharsets.UTF_8);
                    feedTermSeg(tb, csi, state, seg, stream, buf);
                }
                if (!tb.isEmpty()) {
                    if (buf.length() < 500000) buf.append(tb.text).append('\n');
                    emitBuffer(stream, tb, true);
                }
            } catch (Exception ignored) {}
        });
        th.start();
        return th;
    }

    // ================= Termux 屏幕模式（terminal-emulator） =================
    private Process shellProc;
    private java.io.OutputStream shellStdin;
    /** notifyListeners 只能在主线程触发：后台泵线程直接调用会丢事件（屏幕一片空白） */
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    /** 统一构造 pty shell 的环境，与 exec 保持一致，避免 apt/pip 又走回 com.termux 前缀 */
    private void applyShellEnv(ProcessBuilder pb, String prefixPath, String homePath, String tmpPath) {
        pb.environment().put("PREFIX", prefixPath);
        pb.environment().put("TERMUX_PREFIX", prefixPath);
        pb.environment().put("LD_LIBRARY_PATH", prefixPath + "/lib");
        pb.environment().put("PATH", prefixPath + "/bin:" + prefixPath + "/sbin:/system/bin:/system/xbin");
        pb.environment().put("SHELL", prefixPath + "/bin/bash");
        pb.environment().put("HOME", homePath);
        pb.environment().put("TMPDIR", tmpPath);
        pb.environment().put("TERM", "xterm-256color");
        pb.environment().put("TERMINFO", prefixPath + "/share/terminfo");
        pb.environment().put("TERMINFO_DIRS", prefixPath + "/share/terminfo:/system/usr/share/terminfo");
        pb.environment().put("LANG", "en_US.UTF-8");
        pb.environment().put("APT_CONFIG", prefixPath + "/etc/apt/apt.conf.d/00-prefix-override");
        pb.environment().put("DPKG_ADMINDIR", prefixPath + "/var/lib/dpkg");
        pb.environment().put("DPKG_DATADIR", prefixPath + "/share/dpkg");
        pb.environment().put("DPKG_DESED", prefixPath + "/etc/dpkg");
        pb.environment().put("DPKG_NOLOCK", "1");
        pb.environment().put("PIP_CONFIG_FILE", prefixPath + "/etc/pip.conf");
        pb.environment().put("SSL_CERT_FILE", prefixPath + "/etc/tls/cert.pem");
        pb.environment().put("SSL_CERT_DIR", prefixPath + "/etc/tls");
        pb.environment().put("REQUESTS_CA_BUNDLE", prefixPath + "/etc/tls/cert.pem");
        pb.environment().put("CURL_CA_BUNDLE", prefixPath + "/etc/tls/cert.pem");
        pb.environment().put("TERMUX_APP_PACKAGE_MANAGER", "apt");
        File so = new File(getContext().getApplicationInfo().nativeLibraryDir, "libprefixhook.so");
        if (so.exists()) {
            pb.environment().put("LD_PRELOAD", so.getAbsolutePath());
            pb.environment().put("AICHAT_PREFIX", prefixPath);
            pb.environment().put("AICHAT_HOOK", so.getAbsolutePath());
            pb.environment().put("AICHAT_APP_ROOT", getContext().getApplicationInfo().dataDir);
        }
    }

    /** Termux 的 PS1 由 /etc/bash.bashrc 提供；HOME 下的 .bashrc 只做加载与兜底提示符 */
    private void ensureBashrc() {
        try {
            File home = new File(getContext().getFilesDir(), "home");
            if (!home.exists()) home.mkdirs();
            File rc = new File(home, ".bashrc");
            String content = "[ -f \"$PREFIX/etc/bash.bashrc\" ] && . \"$PREFIX/etc/bash.bashrc\"\n"
                + "PS1='\\[\\e[0;32m\\]\\w\\[\\e[0m\\] \\$ '\n";
            if (!rc.exists() || rc.length() < 20) writeText(rc, content);
        } catch (Throwable ignored) {}
    }

    @PluginMethod
    public void termShellStart(final PluginCall call) {
        final int cols = call.getInt("cols", 80);
        final int rows = call.getInt("rows", 24);
        try {
            File bash = new File(prefix, "bin/bash");
            if (!bash.exists()) { call.reject("Termux 环境未就绪"); return; }
            stopShell();
            ensureBashrc();
            final String prefixPath = prefix.getAbsolutePath();
            final String homePath = new File(getContext().getFilesDir(), "home").getAbsolutePath();
            final String tmpPath = new File(getContext().getFilesDir(), "tmp").getAbsolutePath();

            final com.termux.terminal.AichatScreen screen = com.termux.terminal.AichatScreen.create(
                cols, rows, ev -> mainHandler.post(() -> {
                    try { notifyListeners("screen", ev); } catch (Throwable ignored) {}
                }));

            // 用 script 分配 pty：readline / apt 进度 / ncurses 全屏程序都要求真 tty
            ProcessBuilder pb = new ProcessBuilder(
                new File(prefix, "bin/script").getAbsolutePath(),
                "-q", "-e", "-c", "exec " + bash.getAbsolutePath() + " -i", "/dev/null");
            pb.directory(new File(homePath));
            pb.redirectErrorStream(true);
            applyShellEnv(pb, prefixPath, homePath, tmpPath);

            shellProc = pb.start();
            shellStdin = shellProc.getOutputStream();
            screen.setStdin(shellStdin);
            screen.getSession().setRunning(true);

            // 自检标记：即使设备上 bash 静默，这一行也必然出现在屏幕上，
            // 用来区分"渲染层没工作"和"shell 没有输出"
            int pid = -1;
            try { pid = (int) android.os.Process.myPid(); } catch (Throwable ignored) {}
            try {
                if (shellProc.getClass().getMethod("pid") != null) {
                    pid = (int) (long) (Long) shellProc.getClass().getMethod("pid").invoke(shellProc);
                }
            } catch (Throwable ignored) {}
            byte[] banner = ("\u001b[32m[aichat] pty shell ready pid=" + pid + "\u001b[0m\r\n")
                .getBytes(StandardCharsets.UTF_8);
            screen.feed(banner, banner.length);

            Thread reader = new Thread(() -> {
                byte[] buf = new byte[4096];
                int n;
                final StringBuilder pending = new StringBuilder();
                try (java.io.InputStream is = shellProc.getInputStream()) {
                    while ((n = is.read(buf)) != -1) {
                        pending.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                        flushNoiseFiltered(screen, pending);
                    }
                } catch (Throwable ignored) {}
                try { Thread.sleep(300); } catch (InterruptedException ignored) {}
                com.termux.terminal.AichatScreen.destroy();
            }, "aichat-shell-reader");
            reader.setDaemon(true);
            reader.start();

            JSObject ret = new JSObject();
            ret.put("cols", cols);
            ret.put("rows", rows);
            call.resolve(ret);
        } catch (Throwable e) {
            logThrowable("termShellStart", e);
            call.reject("启动终端失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void termInput(PluginCall call) {
        String data = call.getString("data", "");
        try {
            if (shellStdin == null) { call.reject("终端未启动"); return; }
            shellStdin.write(data.getBytes(StandardCharsets.UTF_8));
            shellStdin.flush();
            call.resolve();
        } catch (Throwable e) {
            call.reject("写入失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void termResize(PluginCall call) {
        try {
            com.termux.terminal.AichatScreen sc = com.termux.terminal.AichatScreen.current();
            if (sc != null) sc.resize(call.getInt("cols", 80), call.getInt("rows", 24));
            call.resolve();
        } catch (Throwable e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void termScreen(PluginCall call) {
        try {
            com.termux.terminal.AichatScreen sc = com.termux.terminal.AichatScreen.current();
            if (sc == null) { call.reject("终端未启动"); return; }
            JSObject snap = sc.snapshot(call.getBoolean("full", Boolean.TRUE));
            call.resolve(snap == null ? new JSObject() : snap);
        } catch (Throwable e) { call.reject(e.getMessage()); }
    }

    private static final String[] TERM_NOISE = {
        "could not determine key fingerprint",
        "GPG error:",
        "does not have a stable CLI interface",
        "No schema files found",
        "Certificate verification failed",
        "certificate verify failed",
        "Corrupt JPEG data",
        "JPEG warning",
    };

    /** pty 输出不经 emit()，apt/gpgv 的固定噪音会直接画到屏幕上；
     *  这里按行丢弃噪音，同时保留 \r 进度行不被缓冲。 */
    private void flushNoiseFiltered(com.termux.terminal.AichatScreen screen, StringBuilder pending) {
        int guard = 0;
        while (pending.length() > 0 && guard++ < 64) {
            int noiseAt = -1, noiseLen = 0;
            for (String nz : TERM_NOISE) {
                int at = pending.indexOf(nz);
                if (at >= 0 && (noiseAt < 0 || at < noiseAt)) { noiseAt = at; noiseLen = nz.length(); }
            }
            if (noiseAt < 0) {
                byte[] d = pending.toString().getBytes(StandardCharsets.UTF_8);
                screen.feed(d, d.length);
                pending.setLength(0);
                return;
            }
            int lineStart = noiseAt;
            while (lineStart > 0) {
                char c = pending.charAt(lineStart - 1);
                if (c == '\n' || c == '\r') break;
                lineStart--;
            }
            int lineEnd = -1;
            for (int j = noiseAt + noiseLen; j < pending.length(); j++) {
                char c = pending.charAt(j);
                if (c == '\n' || c == '\r') { lineEnd = j + 1; break; }
            }
            if (lineStart > 0) {
                byte[] d = pending.substring(0, lineStart).getBytes(StandardCharsets.UTF_8);
                screen.feed(d, d.length);
                pending.delete(0, lineStart);
                continue;
            }
            if (lineEnd < 0) return; // 噪音行还没结束，等下一块
            pending.delete(0, lineEnd);
        }
    }

    private void stopShell() {
        try { if (shellStdin != null) shellStdin.close(); } catch (Throwable ignored) {}
        shellStdin = null;
        try { if (shellProc != null) shellProc.destroy(); } catch (Throwable ignored) {}
        shellProc = null;
        com.termux.terminal.AichatScreen.destroy();
    }

    /** 重装终端：清空 PREFIX/HOME/沙箱，重新解压 bootstrap 并恢复运行期配置。
     *  会删除用户已安装的软件包与家目录文件，前端必须做二次确认。 */
    @PluginMethod
    public void termReinstall(final PluginCall call) {
        new Thread(() -> {
            try {
                stopShell();
                emit("system", "开始重装终端环境…\n");

                // 1. 清空旧环境（PREFIX、HOME、TMP、沙箱用户目录）
                deleteRecursive(prefix);
                deleteRecursive(homeDir);
                deleteRecursive(tmpDir);
                deleteRecursive(new File(sandboxRoot, "projects"));
                new File(sandboxRoot, "projects").mkdirs();
                homeDir.mkdirs();
                tmpDir.mkdirs();

                // 2. 清掉一次性标记，让 preparePrefix/fixDpkg 重新跑
                String[] markers = {
                    ".prefix-prepared-v3", ".dpkg-configured-v1", ".bootstrap-ok",
                    ".pip-bootstrapped", ".aichat-hook-built",
                };
                for (String m : markers) deleteQuietly(new File(getContext().getFilesDir(), m));

                // 3. 重新解压 bootstrap
                emit("system", "正在解压 Termux 运行环境…\n");
                extractBootstrap();
                if (!bashBin().exists()) throw new RuntimeException("解压后仍找不到 bash");

                // 4. 一次性准备 + 兼容层
                preparePrefix(true);
                fixExecPermissions();
                ensureDpkgWrapper();
                ensureNoOpPyCompile();
                ensureUaWrapper();
                rewriteMaintainerScripts();
                applyRuntimeConfig();

                // 5. dpkg 库自愈放后台，避免阻塞返回
                final File dpkgMarker = new File(getContext().getFilesDir(), ".dpkg-configured-v1");
                new Thread(() -> {
                    try {
                        if (!dpkgMarker.exists()) {
                            fixDpkg();
                            writeText(dpkgMarker, "ok");
                        }
                    } catch (Exception ignored) {}
                }).start();

                emit("system", "终端环境已重装完成。\n");
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("prefix", prefix.getAbsolutePath());
                call.resolve(ret);
            } catch (Throwable e) {
                logThrowable("termReinstall", e);
                emit("system", "❌ 重装失败：" + e.getMessage() + "\n");
                call.reject("重装失败：" + e.getMessage());
            }
        }, "aichat-term-reinstall").start();
    }

    // ==================== OpenClaw Agent 运行时 ====================
    private Process agentProc;
    private static final String AGENT_ZIP = "openclaw-runtime.zip";
    private static final String AGENT_CLI_REL = "opt/openclaw/node_modules/openclaw/openclaw.mjs";

    private File agentCli() { return new File(prefix, AGENT_CLI_REL); }
    private File agentNode() { return new File(prefix, "bin/node"); }
    private File agentStateDir() { return new File(getContext().getFilesDir(), "openclaw-state"); }
    private File agentConfigFile() { return new File(agentStateDir(), "openclaw.json"); }

    private File agentWorkspaceDir() { return new File(agentStateDir(), "workspace"); }

    /** 读取 OpenClaw 设置：原始配置 + 工作区文件 + 记忆占用 */
    @PluginMethod
    public void agentSettingsGet(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            ret.put("configPath", agentConfigFile().getAbsolutePath());
            ret.put("workspacePath", agentWorkspaceDir().getAbsolutePath());
            String cfg = "";
            try { cfg = readAllText(agentConfigFile()); } catch (Throwable ignored) {}
            ret.put("config", cfg);
            JSObject files = new JSObject();
            for (String n : new String[]{"AGENTS.md", "USER.md", "SOUL.md", "IDENTITY.md", "MEMORY.md"}) {
                try { files.put(n, readAllText(new File(agentWorkspaceDir(), n))); }
                catch (Throwable ignored) { files.put(n, ""); }
            }
            ret.put("files", files);
            long memBytes = 0;
            java.io.File memFile = new java.io.File(agentWorkspaceDir(), "MEMORY.md");
            if (memFile.exists()) memBytes += memFile.length();
            java.io.File[] kids = agentStateDir().listFiles();
            if (kids != null) for (java.io.File f : kids) {
                String n = f.getName().toLowerCase();
                if (n.contains("memory") || n.endsWith(".sqlite") || n.endsWith(".db")) memBytes += dirSize(f);
            }
            ret.put("memoryBytes", memBytes);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("读取 OpenClaw 设置失败：" + e.getMessage());
        }
    }

    /** 保存设置：原始配置（JSON 校验）+ 工作区文件；保存后下次 agent 运行生效 */
    @PluginMethod
    public void agentSettingsSave(PluginCall call) {
        try {
            String cfg = call.getString("config", null);
            if (cfg != null && !cfg.trim().isEmpty()) {
                try { new org.json.JSONObject(cfg); }
                catch (Throwable e) { call.reject("openclaw.json 不是合法 JSON：" + e.getMessage()); return; }
                writeText(agentConfigFile(), cfg);
            }
            JSObject files = call.getObject("files");
            if (files != null) {
                agentWorkspaceDir().mkdirs();
                for (String n : new String[]{"AGENTS.md", "USER.md", "SOUL.md", "IDENTITY.md", "MEMORY.md"}) {
                    String v = files.getString(n, null);
                    if (v == null) continue;
                    writeText(new File(agentWorkspaceDir(), n), v);
                }
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("保存 OpenClaw 设置失败：" + e.getMessage());
        }
    }

    /** 清空记忆：删 workspace/MEMORY.md 与 state 下的 memory 数据库 */
    @PluginMethod
    public void agentMemoryClear(PluginCall call) {
        try {
            int removed = 0;
            java.io.File mem = new java.io.File(agentWorkspaceDir(), "MEMORY.md");
            if (mem.exists() && mem.delete()) removed++;
            java.io.File[] kids = agentStateDir().listFiles();
            if (kids != null) for (java.io.File f : kids) {
                String n = f.getName().toLowerCase();
                if (n.contains("memory") || n.endsWith(".sqlite") || n.endsWith(".db")) {
                    deleteRecursive(f);
                    removed++;
                }
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("removed", removed);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("清空记忆失败：" + e.getMessage());
        }
    }

    private String readAllText(java.io.File f) throws java.io.IOException {
        if (f == null || !f.exists()) return "";
        StringBuilder sb = new StringBuilder();
        try (java.io.BufferedReader br = new java.io.BufferedReader(
                new java.io.InputStreamReader(new java.io.FileInputStream(f), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private long dirSize(java.io.File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long total = 0;
        java.io.File[] fs = f.listFiles();
        if (fs != null) for (java.io.File c : fs) total += dirSize(c);
        return total;
    }

    /** OpenClaw 运行时状态：node 与 CLI 是否就位、配置是否已写 */
    @PluginMethod
    public void agentStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("installed", agentNode().exists() && agentCli().exists());
        ret.put("node", agentNode().exists());
        ret.put("cli", agentCli().exists());
        ret.put("configured", agentConfigFile().exists());
        call.resolve(ret);
    }

    /** 写入 OpenClaw 配置：模型全部经后端 OpenAI 兼容端点转发 */
    @PluginMethod
    public void agentConfigure(PluginCall call) {
        try {
            String provider = call.getString("provider", "zhipu");
            String baseUrl = call.getString("baseUrl", "");
            String token = call.getString("token", "");
            String model = call.getString("model", "glm-4-flash");
            // 直连智谱：省掉后端代理那一跳，实测单轮从 50-70s 降到 12-17s
            if ("zhipu".equals(provider)) {
                baseUrl = "https://open.bigmodel.cn/api/paas/v4";
                token = "";
            } else {
                if (baseUrl == null || baseUrl.isEmpty()) { call.reject("baseUrl 为空"); return; }
                if (!baseUrl.endsWith("/v1")) baseUrl = baseUrl.replaceAll("/+$", "") + "/v1";
            }
            // 模型 id 去掉 "provider:" 前缀，配置里按 <provider>/<model> 组合
            String modelId = model != null && model.contains(":") ? model.substring(model.indexOf(':') + 1) : (model == null ? "glm-4-flash" : model);
            // 兜底：openclaw:agent 被去前缀后只剩 "agent"，不是合法模型 id，智谱会 401
            if (modelId == null || modelId.trim().isEmpty() || "agent".equalsIgnoreCase(modelId.trim())) {
                modelId = "glm-4-flash";
            }
            agentStateDir().mkdirs();
            // OpenClaw 的 provider 定义：baseUrl/apiKey/api=openai-completions/models
            String json = "{\n"
                + "  \"models\": {\n"
                + "    \"mode\": \"merge\",\n"
                + "    \"providers\": {\n"
                + "      \"" + jsonEsc(provider) + "\": {\n"
                + "        \"baseUrl\": \"" + jsonEsc(baseUrl) + "\",\n"
                + "        \"apiKey\": \"" + jsonEsc(token) + "\",\n"
                + "        \"api\": \"openai-completions\",\n"
                + "        \"models\": [{ \"id\": \"" + jsonEsc(modelId) + "\", \"name\": \"" + jsonEsc(modelId) + "\" }]\n"
                + "      }\n"
                + "    }\n"
                + "  },\n"
                + "  \"agents\": { \"defaults\": { \"model\": \"" + jsonEsc(provider + "/" + modelId) + "\" } }\n"
                + "}\n";
            writeText(agentConfigFile(), json);
            try { ensureWorkspaceTemplates(); ensureOpenclawCli(); } catch (Throwable ignored) {}
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("config", agentConfigFile().getAbsolutePath());
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("写入 OpenClaw 配置失败：" + e.getMessage());
        }
    }

    /** 旧版本把 timezone 写进了 openclaw.json，schema 不认这个键，启动即报
     *  Unrecognized key；运行前清掉，其它字段保持不动。 */
    private void healAgentConfig() {
        try {
            if (!agentConfigFile().exists()) return;
            String txt = readAllText(agentConfigFile());
            if (txt == null || !txt.contains("\"timezone\"")) return;
            org.json.JSONObject o = new org.json.JSONObject(txt);
            o.remove("timezone");
            org.json.JSONObject a = o.optJSONObject("agents");
            if (a != null) {
                org.json.JSONObject d = a.optJSONObject("defaults");
                if (d != null) d.remove("timezone");
            }
            writeText(agentConfigFile(), o.toString(2));
        } catch (Throwable ignored) {}
    }

    /** 重置 OpenClaw：杀进程、删运行时与状态目录，由前端再次调用 agentInit 重新解压 */
    @PluginMethod
    public void agentReset(PluginCall call) {
        try {
            if (agentProc != null) { agentProc.destroy(); agentProc = null; }
            deleteRecursive(new File(prefix, "opt/openclaw"));
            deleteRecursive(agentStateDir());
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("重置 OpenClaw 失败：" + e.getMessage());
        }
    }

    /** OpenClaw 启动前必须存在 workspace 模板，否则报 Missing workspace template: AGENTS.md () */
    private void ensureWorkspaceTemplates() {
        String[] names = {"AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md", "BOOTSTRAP.md", "HEARTBEAT.md"};
        java.io.File[] dirs = {
            new java.io.File(prefix, "opt/openclaw/node_modules/openclaw/docs/reference/templates"),
            new java.io.File(prefix, "opt/openclaw/docs/reference/templates"),
        };
        for (java.io.File d : dirs) {
            java.io.File probe = new java.io.File(d, "AGENTS.md");
            if (probe.exists() && probe.length() > 0) continue;
            d.mkdirs();
            for (String n : names) {
                try (java.io.InputStream in = getContext().getAssets().open("oc-templates/" + n)) {
                    java.io.File out = new java.io.File(d, n);
                    try (java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
                        byte[] buf = new byte[8192];
                        int r;
                        while ((r = in.read(buf)) != -1) fos.write(buf, 0, r);
                    }
                } catch (Throwable ignored) {}
            }
        }
    }

    /** 把 openclaw 暴露成 PREFIX/bin 下的命令，终端可直接 openclaw doctor */
    private void ensureOpenclawCli() {
        try {
            String p = prefix.getAbsolutePath();
            java.io.File f = new java.io.File(prefix, "bin/openclaw");
            writeText(f,
                "#!/system/bin/sh\n" +
                "export PREFIX=\"" + p + "\"\n" +
                "export LD_LIBRARY_PATH=\"$PREFIX/lib\"\n" +
                "export PATH=\"$PREFIX/bin:$PATH\"\n" +
                "exec \"$PREFIX/bin/node\" \"$PREFIX/opt/openclaw/node_modules/openclaw/openclaw.mjs\" \"$@\"\n");
            chmodExec(f);
        } catch (Throwable ignored) {}
    }

    /** 从 APK assets 流式解压 OpenClaw 运行时（约 600MB，条目多，不能用 readAllBytes） */
    @PluginMethod
    public void agentInit(final PluginCall call) {
        new Thread(() -> {
            long started = System.currentTimeMillis();
            try {
                java.io.InputStream raw = getContext().getAssets().open(AGENT_ZIP, android.content.res.AssetManager.ACCESS_STREAMING);
                java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(new java.io.BufferedInputStream(raw, 8192));
                java.util.zip.ZipEntry e;
                long total = 0, entries = 0, lastEmit = 0;
                final int TOTAL_MB = 600;   // 解压后体积用于进度百分比（实测 ~597MB）
                java.io.File root = getContext().getFilesDir();
                // 历史版本曾把条目解到 files/prefix（前缀没剥掉），留下 600MB 死目录
                deleteRecursive(new java.io.File(root, "prefix"));
                emit("progress", "OpenClaw 解压 0/" + (TOTAL_MB * 1024 * 1024));
                emit("system", "正在解压 OpenClaw 运行时（首次约 1-2 分钟）…\n");
                while ((e = zis.getNextEntry()) != null) {
                    String name = e.getName();
                    if (name == null || name.isEmpty()) continue;
                    if (name.contains("..")) continue;
                    // zip 内顶层是 prefix/，实际 PREFIX 是 files/usr，必须剥掉这一层
                    if (name.startsWith("prefix/")) name = name.substring("prefix/".length());
                    if (name.isEmpty()) continue;
                    java.io.File out = new java.io.File(prefix, name);
                    if (e.isDirectory()) { out.mkdirs(); continue; }
                    java.io.File parent = out.getParentFile();
                    if (parent != null) parent.mkdirs();
                    // lib/ 一律用 zip 内版本覆盖：bootstrap 自带的 libc++_shared 是 2024 旧版，
                    // node 24 需要 NDK r26+ 的 __hash_memory 符号，混用会 CANNOT LINK EXECUTABLE
                    try (java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = zis.read(buf)) != -1) { fos.write(buf, 0, n); total += n; }
                    }
                    entries++;
                    if (total - lastEmit > 8L * 1024 * 1024) {
                        lastEmit = total;
                        emit("progress", "OpenClaw 解压 " + total + "/" + (TOTAL_MB * 1024 * 1024));
                        emit("system", "正在解压 OpenClaw 运行时 " + (total / (1024 * 1024)) + "/" + TOTAL_MB + " MB\n");
                    }
                    zis.closeEntry();
                }
                zis.close();

                // node 与 CLI 必须可执行
                chmodExec(agentNode());
                chmodExec(new File(prefix, "bin/node"));
                java.io.File opt = new java.io.File(prefix, "opt/openclaw");
                chmodTreeExec(opt);

                boolean ok = agentNode().exists() && agentCli().exists();
                long secs = (System.currentTimeMillis() - started) / 1000;
                emit("system", "正在解压 OpenClaw 运行时 " + TOTAL_MB + "/" + TOTAL_MB + " MB\n");
                if (!ok) {
                    emit("system", "诊断：node=" + agentNode().getAbsolutePath() + " exists=" + agentNode().exists()
                        + "；cli=" + agentCli().getAbsolutePath() + " exists=" + agentCli().exists() + "\n");
                    java.io.File[] bin = new java.io.File(prefix, "bin").listFiles();
                    StringBuilder names = new StringBuilder();
                    if (bin != null) for (int i = 0; i < bin.length && i < 12; i++) names.append(bin[i].getName()).append(' ');
                    emit("system", "PREFIX/bin 内容：" + names + "\n");
                }
                emit("progress", "OpenClaw 解压 " + (TOTAL_MB * 1024 * 1024) + "/" + (TOTAL_MB * 1024 * 1024));
                emit("system", "OpenClaw 运行时" + (ok ? "解压完成" : "解压不完整") + "（" + entries + " 个文件，" + (total / (1024 * 1024)) + "MB，" + secs + "s）\n");
                JSObject ret = new JSObject();
                ret.put("ok", ok);
                ret.put("files", entries);
                ret.put("bytes", total);
                ret.put("seconds", secs);
                call.resolve(ret);
            } catch (Throwable e) {
                logThrowable("agentInit", e);
                emit("system", "❌ OpenClaw 运行时解压失败：" + e.getMessage() + "\n");
                call.reject("解压失败：" + e.getMessage());
            }
        }, "aichat-agent-init").start();
    }

    /** 执行一轮 OpenClaw agent：模型请求经后端，工具（exec/read/write）在 PREFIX 内落地 */
    @PluginMethod
    public void agentRun(final PluginCall call) {
        final String message = call.getString("message", "");
        final String cwd = call.getString("cwd", "");
        final int timeout = call.getInt("timeout", 240);
        if (message == null || message.trim().isEmpty()) { call.reject("任务描述为空"); return; }
        if (!agentNode().exists() || !agentCli().exists()) { call.reject("OpenClaw 运行时未安装"); return; }
        // 旧版本解压目录没有 docs/reference/templates，这里按需补齐，避免 Missing workspace template
        try { ensureWorkspaceTemplates(); ensureOpenclawCli(); } catch (Throwable ignored) {}
        if (!agentConfigFile().exists()) { call.reject("OpenClaw 尚未配置（缺少模型端点）"); return; }

        healAgentConfig();
        final String outPath = new File(agentStateDir(), "last-run.json").getAbsolutePath();
        new Thread(() -> {
            StringBuilder sb = new StringBuilder();
            int code = -1;
            try {
                String prefixPath = prefix.getAbsolutePath();
                ProcessBuilder pb = new ProcessBuilder(
                    agentNode().getAbsolutePath(), agentCli().getAbsolutePath(),
                    "agent", "--local", "-m", message, "--json",
                    "--timeout", String.valueOf(timeout));
                pb.directory(cwd != null && !cwd.isEmpty() ? new File(sandboxRoot, cwd) : homeDir);
                pb.redirectErrorStream(true);
                applyShellEnv(pb, prefixPath, homeDir.getAbsolutePath(), tmpDir.getAbsolutePath());
                pb.environment().put("OPENCLAW_STATE_DIR", agentStateDir().getAbsolutePath());
                pb.environment().put("OPENCLAW_CONFIG_PATH", agentConfigFile().getAbsolutePath());
                pb.environment().put("NO_COLOR", "1");
                pb.environment().put("CI", "1");              // 抑制交互式提示
                pb.environment().put("OPENCLAW_NO_ONBOARD", "1");
                // Android 上 node 取不到系统时区，Intl 会退化成 Etc/Unknown，OpenClaw 直接抛
                // RangeError: Invalid time zone specified。固定东八区，配置里也写了同一值。
                pb.environment().put("TZ", "Asia/Shanghai");

                agentProc = pb.start();
                try (java.io.BufferedReader br = new java.io.BufferedReader(
                        new java.io.InputStreamReader(agentProc.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        sb.append(line).append('\n');
                        emit("stdout", line + "\n");
                    }
                }
                code = agentProc.waitFor();
            } catch (Throwable e) {
                logThrowable("agentRun", e);
            } finally {
                try { agentProc = null; } catch (Throwable ignored) {}
            }
            try { writeText(new File(outPath), sb.toString()); } catch (Throwable ignored) {}
            JSObject ret = new JSObject();
            ret.put("code", code);
            ret.put("text", extractAgentReply(sb.toString()));
            ret.put("output", outPath);
            ret.put("json", sb.length() > 400000 ? sb.substring(sb.length() - 400000) : sb.toString());
            call.resolve(ret);
        }, "aichat-agent-run").start();
    }

    @PluginMethod
    public void agentStop(PluginCall call) {
        try { if (agentProc != null) agentProc.destroy(); } catch (Throwable ignored) {}
        agentProc = null;
        call.resolve();
    }

    /** OpenClaw --json 输出里取最终回复文本 */
    private String extractAgentReply(String raw) {
        if (raw == null) return "";
        try {
            int at = raw.indexOf('{');
            if (at >= 0) {
                org.json.JSONObject o = new org.json.JSONObject(raw.substring(at));
                // OpenClaw 2026.11.x 的 --json 输出顶层是 payloads:[{text}]，
                // 旧版本才是 result.finalAssistantMessageRawText，两种都要认
                org.json.JSONArray payloads = o.optJSONArray("payloads");
                if (payloads != null && payloads.length() > 0) {
                    org.json.JSONObject p0 = payloads.optJSONObject(0);
                    if (p0 != null) {
                        String t = p0.optString("text", null);
                        if (t != null && !t.isEmpty()) return t;
                    }
                }
                org.json.JSONObject r = o.optJSONObject("result");
                if (r != null) {
                    org.json.JSONArray rp = r.optJSONArray("payloads");
                    if (rp != null && rp.length() > 0) {
                        org.json.JSONObject p0 = rp.optJSONObject(0);
                        if (p0 != null) {
                            String t = p0.optString("text", null);
                            if (t != null && !t.isEmpty()) return t;
                        }
                    }
                    String t = r.optString("finalAssistantMessageRawText", null);
                    if (t != null && !t.isEmpty()) return t;
                    org.json.JSONObject term = r.optJSONObject("terminalReply");
                    if (term != null) { String tt = term.optString("text", null); if (tt != null) return tt; }
                }
            }
        } catch (Throwable ignored) {}
        return "";
    }

    private void chmodExec(java.io.File f) {
        try {
            if (f.exists()) { f.setExecutable(true, false); f.setReadable(true, false); }
        } catch (Throwable ignored) {}
    }

    /** 只给 bin/ 与 *.mjs 补执行位，避免对 466MB 目录全量递归 */
    private void chmodTreeExec(java.io.File root) {
        java.io.File bin = new java.io.File(root, "bin");
        if (bin.exists()) {
            java.io.File[] fs = bin.listFiles();
            if (fs != null) for (java.io.File f : fs) chmodExec(f);
        }
        java.io.File nodeBin = new java.io.File(root, "node_modules/openclaw/node_modules/.bin");
        if (nodeBin.exists()) {
            java.io.File[] fs = nodeBin.listFiles();
            if (fs != null) for (java.io.File f : fs) chmodExec(f);
        }
    }

    private static String jsonEsc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }

    @PluginMethod
    public void termShellStop(PluginCall call) {
        stopShell();
        call.resolve();
    }

    @PluginMethod
    public void writeFile(final PluginCall call) {
        String path = call.getString("path");
        String content = call.getString("content", "");
        File f = safeFile(path);
        if (f == null) { call.reject("路径越界"); return; }
        try {
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            writeText(f, content);
            JSObject ret = new JSObject();
            ret.put("written", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void readFile(final PluginCall call) {
        String path = call.getString("path");
        File f = safeFile(path);
        if (f == null || !f.exists()) { call.reject("文件不存在或路径越界"); return; }
        try {
            JSObject ret = new JSObject();
            ret.put("content", readText(f));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void listFiles(final PluginCall call) {
        String path = call.getString("path", "");
        File f = safeFile(path);
        if (f == null || !f.exists() || !f.isDirectory()) { call.reject("目录无效"); return; }
        File[] items = f.listFiles();
        List<JSObject> arr = new ArrayList<>();
        if (items != null) {
            for (File it : items) {
                JSObject o = new JSObject();
                o.put("name", it.getName());
                o.put("isDir", it.isDirectory());
                o.put("size", it.length());
                arr.add(o);
            }
        }
        JSObject ret = new JSObject();
        ret.put("files", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void exists(final PluginCall call) {
        String path = call.getString("path", "");
        File f = safeFile(path);
        JSObject ret = new JSObject();
        ret.put("exists", f != null && f.exists());
        ret.put("isDir", f != null && f.isDirectory());
        call.resolve(ret);
    }

    @PluginMethod
    public void remove(final PluginCall call) {
        String path = call.getString("path");
        File f = safeFile(path);
        if (f == null || f == sandboxRoot) { call.reject("目标无效"); return; }
        deleteRecursive(f);
        JSObject ret = new JSObject();
        ret.put("removed", true);
        call.resolve(ret);
    }

    private void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }

    private static String readText(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] data = new byte[(int) f.length()];
            int read = 0;
            while (read < data.length) {
                int r = in.read(data, read, data.length - read);
                if (r < 0) break;
                read += r;
            }
            return new String(data, 0, read, StandardCharsets.UTF_8);
        }
    }

    /** 生成 apt 路径覆盖配置，把硬编码的 com.termux 路径重定向到我们的 PREFIX */
    private void writeAptPathConfig() throws Exception {
        String p = prefix.getAbsolutePath();
        String conf =
            "// 自动生成：覆盖 apt 硬编码路径\n" +
            // Dir 必须为 /：apt 会把 Dir 当作 dpkg 的 --root 传入，postinst 里的绝对路径
            // 会被再拼一次前缀（update-alternatives 报 .../files/usr/data/user/0/... 即此因）
            "Dir \"/\";\n" +
            "Dir::Etc \"" + p + "/etc/apt\";\n" +
            "Dir::Etc::sourcelist \"" + p + "/etc/apt/sources.list\";\n" +
            "Dir::Etc::sourceparts \"" + p + "/etc/apt/sources.list.d\";\n" +
            "Dir::Etc::Trusted \"" + p + "/etc/apt/trusted.gpg\";\n" +
            "Dir::Etc::TrustedParts \"" + p + "/etc/apt/trusted.gpg.d\";\n" +
            "Dir::State \"" + p + "/var/lib/apt\";\n" +
            "Dir::State::lists \"" + p + "/var/lib/apt/lists\";\n" +
            "Dir::State::status \"" + p + "/var/lib/dpkg/status\";\n" +
            "Dir::State::extended_states \"" + p + "/var/lib/apt/extended_states\";\n" +
            "Dir::State::lists::partial \"" + p + "/var/lib/apt/lists/partial\";\n" +
            "Dir::Cache::pkgcache \"" + p + "/var/cache/apt/pkgcache.bin\";\n" +
            "Dir::Cache::srcpkgcache \"" + p + "/var/cache/apt/srcpkgcache.bin\";\n" +
            "Dir::Cache \"" + p + "/var/cache/apt\";\n" +
            "Dir::Cache::archives \"" + p + "/var/cache/apt/archives\";\n" +
            "Dir::Log \"" + p + "/var/log/apt\";\n" +
            "Dir::Bin \"" + p + "/bin\";\n" +
            "Dir::Bin::methods \"" + p + "/lib/apt/methods\";\n" +
            "Dir::Bin::solvers \"" + p + "/lib/apt/solvers\";\n" +
            "Dir::Bin::apt-key \"" + p + "/bin/apt-key\";\n" +
            "Dir::Bin::dpkg \"" + p + "/bin/dpkg\";\n" +
            "Acquire::https::CaInfo \"" + p + "/etc/tls/cert.pem\";\n" +
            // 证书链在自建 PREFIX 下不保证完整：https 源不校验证书（源已 trusted=yes）
            "Acquire::https::Verify-Peer \"false\";\n" +
            "Acquire::https::Verify-Host \"false\";\n" +
            "// 彻底禁用 GPG 验证\n" +
            "Acquire::AllowInsecureRepositories \"true\";\n" +
            "Acquire::AllowDowngradeToInsecureRepositories \"true\";\n" +
            "APT::Get::AllowUnauthenticated \"true\";\n" +
            "APT::Get::allow-unauthenticated \"true\";\n" +
            "Acquire::AllowDowngradeToInsecureRepositories \"true\";\n" +
            "Acquire::Check-Valid-Until \"false\";\n" +
            "Dir::Bin::gpgv \"/bin/true\";\n" +
            "Dir::Bin::apt-key \"/bin/true\";\n" +
            // dpkg 参数：覆盖硬编码的 admindir 和配置目录
            "DPKG::Options { \"--admindir=" + p + "/var/lib/dpkg\"; \"--force-all\"; \"--force-gnu-system\"; };\n" +
            "DPKG::Path \"" + p + "/var/lib/dpkg\";\n";
        File confFile = new File(prefix, "etc/apt/apt.conf.d/00-prefix-override");
        File parent = confFile.getParentFile();
        if (parent != null) parent.mkdirs();
        writeText(confFile, conf);
    }

    /** 安装 Termux 官方签名公钥。
     *  bootstrap 里 etc/apt/trusted.gpg.d 是空目录，没有任何 key，
     *  gpgv 只能输出 "Good signature, but could not determine key fingerprint"，
     *  apt 随即判定仓库未签名 —— 这是索引装不上、包名找不到的真正原因。 */
    private void installKeyring() {
        // 只清空、不写入公钥：写入 trusted.gpg.d/*.gpg 后 apt 会校验 InRelease，
        // gpgv 报 "Good signature, but could not determine key fingerprint"（用户看到的 GPG 密钥无效）。
        // sources.list 带 [trusted=yes]，清空后 apt 跳过签名校验，与旧版本一致。
        clearKeyrings();
    }

    private void clearKeyrings() {
        File dir = new File(prefix, "etc/apt/trusted.gpg.d");
        dir.mkdirs();
        try { deleteQuietly(new File(prefix, "etc/apt/trusted.gpg")); } catch (Throwable ignored) {}
        File[] fs = dir.listFiles();
        if (fs != null) for (File f : fs) { try { f.delete(); } catch (Throwable ignored) {} }
    }

    private void installKeyringUnused() {
        File dir = new File(prefix, "etc/apt/trusted.gpg.d");
        File share = new File(prefix, "share/termux-keyring");
        dir.mkdirs();
        share.mkdirs();
        try {
            // 历史上曾用 cat 把多个 keyring 拼成单个 trusted.gpg / termux-all.gpg，
            // gpgv 解析拼接文件时会只吐 GOODSIG 不吐 VALIDSIG，apt 因此报
            // "Good signature, but could not determine key fingerprint"。清掉这些合成文件。
            deleteQuietly(new File(prefix, "etc/apt/trusted.gpg"));
            deleteQuietly(new File(dir, "termux-all.gpg"));

            String[] keys = getContext().getAssets().list("termux-keyring");
            if (keys == null || keys.length == 0) {
                emit("system", "⚠ 资源包内无公钥\n");
                return;
            }
            int ok = 0;
            for (String k : keys) {
                if (!k.endsWith(".gpg")) continue;
                byte[] data = readAsset("termux-keyring/" + k);
                if (data == null || data.length == 0) continue;
                // bootstrap 自带的 trusted.gpg.d/*.gpg 是指向 share/termux-keyring 的符号链接，
                // 目标路径写死 com.termux，链接可能悬空；先删链接再落真实文件
                ok += writeKey(new File(dir, k), data);
                ok += writeKey(new File(share, k), data);
            }
            emit("system", "已安装签名公钥 " + ok + " 份\n");
        } catch (Throwable e) {
            emit("system", "⚠ 公钥安装失败: " + e + "\n");
        }
    }

    /** 覆盖写入 keyring：先删掉悬空符号链接，保证 gpgv 读到的是完整原始 keyring */
    private int writeKey(File dst, byte[] data) {
        try {
            try { dst.delete(); } catch (Exception ignored) {}
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(dst)) {
                out.write(data);
            }
            return 1;
        } catch (Exception e) {
            return 0;
        }
    }

    private void deleteQuietly(File f) {
        try { f.delete(); } catch (Exception ignored) {}
    }

    /** dpkg 数据库自愈：缺 status/available 时 dpkg 立即以错误码 2 退出 */
    private void ensureDpkgDb() throws Exception {
        String p = prefix.getAbsolutePath();
        String[] dirs = {
            "var/lib/dpkg", "var/lib/dpkg/updates", "var/lib/dpkg/info",
            "var/lib/dpkg/alternatives", "var/lib/dpkg/triggers",
            "var/lib/apt/lists/partial", "var/cache/apt/archives", "var/log/apt"
        };
        for (String d : dirs) new File(p + "/" + d).mkdirs();
        File status = new File(p + "/var/lib/dpkg/status");
        if (!status.exists() || status.length() == 0) writeText(status, "");
        File available = new File(p + "/var/lib/dpkg/available");
        if (!available.exists()) writeText(available, "");
        File unincorp = new File(p + "/var/lib/dpkg/triggers/Unincorp");
        if (!unincorp.exists()) writeText(unincorp, "");
    }

    private byte[] readAsset(String name) throws Exception {
        try (InputStream in = getContext().getAssets().open(name)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void writeBytes(File f, byte[] data) throws Exception {
        try (FileOutputStream out = new FileOutputStream(f)) { out.write(data); }
    }

    /** 生成可用的 CA 证书束：优先复用 bootstrap 自带，其次从 Android 系统 CA 导出 */
    private void ensureCertificates() {
        try {
            File tlsDir = new File(prefix, "etc/tls");
            tlsDir.mkdirs();
            File cert = new File(tlsDir, "cert.pem");
            if (cert.exists() && cert.length() > 8192) return;

            File bundled = new File(prefix, "etc/ssl/certs/ca-certificates.crt");
            if (!bundled.exists()) bundled = new File(prefix, "etc/tls/cert.pem");
            if (bundled.exists() && bundled.length() > 8192) {
                copyFile(bundled, cert);
                copyFile(cert, new File(tlsDir, "cacert.pem"));
                return;
            }

            // 从系统 CA 目录拼 PEM（Android 7+ 为 PEM 文本，早期为 DER）
            StringBuilder sb = new StringBuilder();
            File sysDir = new File("/system/etc/security/cacerts");
            File[] files = sysDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (!f.isFile()) continue;
                    byte[] raw = readAll(f);
                    if (raw.length == 0) continue;
                    String text = new String(raw, StandardCharsets.US_ASCII);
                    if (text.contains("BEGIN CERTIFICATE")) {
                        sb.append(text.trim()).append("\n");
                    } else {
                        String b64 = android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP);
                        sb.append("-----BEGIN CERTIFICATE-----\n");
                        for (int i = 0; i < b64.length(); i += 64) {
                            sb.append(b64, i, Math.min(i + 64, b64.length())).append("\n");
                        }
                        sb.append("-----END CERTIFICATE-----\n");
                    }
                }
            }
            if (sb.length() > 0) {
                writeText(cert, sb.toString());
                writeText(new File(tlsDir, "cacert.pem"), sb.toString());
                emit("system", "已生成 CA 证书（" + files.length + " 张）\n");
            } else {
                emit("system", "⚠ 未能生成 CA 证书，https 请求可能失败\n");
            }
        } catch (Exception e) {
            emit("system", "证书生成失败: " + e.getMessage() + "\n");
        }
    }

    private static byte[] readAll(File f) throws Exception {
        try (FileInputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void copyFile(File src, File dst) throws Exception {
        try (FileInputStream in = new FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static void writeText(File f, String text) throws Exception {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    // ======================= 应用内版本更新 =======================

    /** 返回当前安装包的 versionName / versionCode，供前端与远端清单做数值比对 */
    @PluginMethod
    public void appInfo(PluginCall call) {
        try {
            android.content.pm.PackageInfo pi = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("versionName", pi.versionName == null ? "" : pi.versionName);
            ret.put("versionCode", pi.versionCode);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("读取版本信息失败: " + e.getMessage());
        }
    }

    /**
     * 下载更新包到应用缓存目录。进度通过 "update-progress" 事件推送（pct/done/total）。
     * 调用方负责按镜像源顺序重试不同 URL；本方法只负责单次下载。
     */
    @PluginMethod
    public void downloadApk(final PluginCall call) {
        final String url = call.getString("url", "");
        if (url.isEmpty()) { call.reject("url 为空"); return; }
        new Thread(() -> {
            File dir = new File(getContext().getCacheDir(), "update");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, "app-update.apk");
            java.net.HttpURLConnection conn = null;
            try {
                conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) AIChat-Updater");
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    call.reject("下载失败 HTTP " + code);
                    return;
                }
                long total = conn.getContentLength();
                long done = 0;
                int lastPct = -1;
                try (InputStream in = conn.getInputStream();
                     FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                        done += n;
                        int pct = total > 0 ? (int) (done * 100 / total) : -1;
                        if (pct != lastPct) {
                            lastPct = pct;
                            JSObject ev = new JSObject();
                            ev.put("pct", pct);
                            ev.put("done", done);
                            ev.put("total", total);
                            notifyListeners("update-progress", ev);
                        }
                    }
                }
                if (out.length() <= 0) { call.reject("安装包为空"); return; }
                JSObject ret = new JSObject();
                ret.put("path", out.getAbsolutePath());
                ret.put("size", out.length());
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("下载失败: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, "aichat-apk-download").start();
    }

    /** 拉起系统安装器安装本地 APK；通过 FileProvider 授权读取 */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path", "");
        if (path.isEmpty()) { call.reject("path 为空"); return; }
        File f = new File(path);
        if (!f.exists()) { call.reject("安装包不存在: " + path); return; }
        try {
            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", f);
            android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP);
            getContext().startActivity(i);
            call.resolve();
        } catch (Throwable e) {
            call.reject("拉起安装失败: " + e.getMessage());
        }
    }
}
