#!/usr/bin/env bash
# 本地一键打包 macOS (x64)：Python 后端 + React 前端 + Electron 安装包
set -euo pipefail
cd "$(dirname "$0")/.."

# electron-builder 26.x 需要 Node >= 20.19（require ESM）
NODE22="$HOME/.local/node-v22/bin"
if [ -x "$NODE22/node" ]; then
  export PATH="$NODE22:$PATH"
fi
echo "Node: $(node -v)"

# 国内镜像加速 Electron / electron-builder 二进制下载
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

if [ -x server/.venv/bin/pyinstaller ]; then
  echo "==> 构建 Python 后端"
  (cd server && .venv/bin/pyinstaller main.spec --noconfirm)
else
  echo "!! 跳过 Python 后端：server/.venv 不存在"
fi

echo "==> 构建 React 前端"
(cd react && npx vite build)

echo "==> 打包 Electron"
npx electron-builder --mac

echo "==> 完成，产物在 dist/"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null || true
