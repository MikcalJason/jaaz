#!/usr/bin/env bash
# 清理打包中间产物与历史归档，释放磁盘空间
# 用法: npm run clean:dist
set -uo pipefail
cd "$(dirname "$0")/.."

echo "==> 清理前 dist 占用: $(du -sh dist 2>/dev/null | cut -f1)"

rm -rf dist/mac dist/mac-arm64 dist/mac.tmp 2>/dev/null || true
rm -rf dist/.trash-* 2>/dev/null || true

# 历史归档目录（_archive、_old-xxxx 等），保留最新的安装包本体
if [ -d dist/_archive ]; then
  rm -rf dist/_archive 2>/dev/null || true
fi
for d in dist/_*; do
  [ -d "$d" ] && rm -rf "$d" 2>/dev/null || true
done

echo "==> 清理后 dist 占用: $(du -sh dist 2>/dev/null | cut -f1)"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null || echo "(暂无安装包)"
