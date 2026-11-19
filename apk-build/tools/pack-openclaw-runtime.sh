#!/usr/bin/env bash
# 重建 assets/openclaw-runtime.zip（内置 OpenClaw + Termux node 24）
# 依赖：node 24、npm、curl、unzip、zip：全程 ~15 分钟，产物约 240MB
set -euo pipefail
WORK=${WORK:-/tmp/ocbuild}
MIRROR=https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main
NODE_VER=24.22.3

mkdir -p "$WORK/deb" "$WORK/pkg/prefix/bin" "$WORK/pkg/prefix/lib" "$WORK/pkg/prefix/opt/openclaw"

# 1) Termux node + 运行时库
for f in \
  pool/main/n/nodejs-lts/nodejs-lts_${NODE_VER}_aarch64.deb \
  pool/main/libc/libc++/libc++_30_aarch64.deb \
  pool/main/o/openssl/openssl_1:3.6.5_aarch64.deb \
  pool/main/libi/libicu/libicu_79.1_aarch64.deb \
  pool/main/libs/libsqlite/libsqlite_3.54.1-1_aarch64.deb \
  pool/main/c/c-ares/c-ares_1.34.9_aarch64.deb \
  pool/main/z/zlib/zlib_1.4_aarch64.deb \
  pool/main/libf/libffi/libffi_3.8.0_aarch64.deb ; do
  n=$(basename "$f"); [ -f "$WORK/deb/$n" ] || curl -sL -o "$WORK/deb/$n" "$MIRROR/$f"
done
for d in "$WORK"/deb/*.deb; do
  mkdir -p "$WORK/x/$(basename "$d")" && dpkg-deb -x "$d" "$WORK/x/$(basename "$d")"
done
cp "$WORK/x/nodejs-lts_${NODE_VER}_aarch64.deb/data/data/com.termux/files/usr/bin/node" "$WORK/pkg/prefix/bin/node"
chmod 755 "$WORK/pkg/prefix/bin/node"
find "$WORK/x" -path "*/usr/lib/*" -maxdepth 6 -name "*.so*" -exec cp -P {} "$WORK/pkg/prefix/lib/" \;

# 2) OpenClaw 本体（裁剪 docs/tests/*.map）
mkdir -p "$WORK/npm" && cd "$WORK/npm"
[ -f package.json ] || printf '{"name":"oc-bundle","private":true}\n' > package.json
npm install openclaw@2026.11.4 --omit=dev --no-audit --no-fund
find node_modules -name "*.map" -delete
find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name examples \) -prune -exec rm -rf {} +
rm -rf node_modules/.cache
cp -a node_modules "$WORK/pkg/prefix/opt/openclaw/node_modules"

# 3) 入口 wrapper
cat > "$WORK/pkg/prefix/opt/openclaw/openclaw.mjs" <<'JS'
#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, 'node_modules', 'openclaw', 'openclaw.mjs'));
JS
printf '{"name":"aichat-openclaw-runtime","version":"2026.11.4","private":true,"type":"module"}\n' \
  > "$WORK/pkg/prefix/opt/openclaw/package.json"

# 4) 打包到 assets
rm -f "$WORK/openclaw-runtime.zip"
cd "$WORK/pkg" && zip -qr -9 "$WORK/openclaw-runtime.zip" prefix
cp "$WORK/openclaw-runtime.zip" "$(dirname "$0")/../../android/app/src/main/assets/openclaw-runtime.zip"
echo "done: $WORK/openclaw-runtime.zip"
