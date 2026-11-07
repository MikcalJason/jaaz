#!/usr/bin/env bash
# 本地一键打包 macOS：Python 后端 + React 前端 + Electron 安装包
# 用法:
#   npm run build:mac:local
#   BUMP=patch npm run build:mac:local   # 打包前自动递增版本号
set -euo pipefail
cd "$(dirname "$0")/.."

# electron-builder 26.x 需要 Node >= 20.19（require ESM）
NODE22="$HOME/.local/node-v22/bin"
if [ -x "$NODE22/node" ]; then
  export PATH="$NODE22:$PATH"
fi
echo "Node: $(node -v)"

# 可选版本号递增
if [ -n "${BUMP:-}" ]; then
  npm version "$BUMP" --no-git-tag-version
  echo "==> 版本号已递增为 $(node -p "require('./package.json').version")"
fi
VERSION=$(node -p "require('./package.json').version")
echo "==> 当前版本: $VERSION"

# 国内镜像加速 Electron / electron-builder 二进制下载
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

# 清理上一次的中间产物。某些受管环境会拦截批量删除，失败不中断本次构建。
echo "==> 清理中间产物 (dist/mac*)"
rm -rf dist/mac dist/mac-arm64 dist/mac.tmp 2>/dev/null || true

# 归档同名安装包，避免覆盖上一次的产物
if compgen -G "dist/Jaaz-$VERSION*.dmg" > /dev/null || compgen -G "dist/Jaaz-$VERSION*.zip" > /dev/null; then
  ARCHIVE="dist/_archive/$VERSION-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$ARCHIVE"
  mv dist/Jaaz-$VERSION* "$ARCHIVE"/ 2>/dev/null || true
  echo "==> 旧产物已归档到 $ARCHIVE"
fi

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
