#!/usr/bin/env bash
# Windows 用の配布 ZIP を作る（Node.js 同梱。展開して start.bat をダブルクリックするだけで動く）。
#   使い方: tools/package-windows.sh <node-vXX-win-x64.zip> <出力.zip> [settings.json]
#   Node は https://nodejs.org/dist/ の win-x64.zip（SHASUMS256.txt で確認したもの）を渡す。
set -euo pipefail
NODE_ZIP=$(realpath "$1")
OUT=$(realpath -m "$2")
SETTINGS=${3:+$(realpath "$3")}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

APP="$WORK/wordwolf"
mkdir -p "$APP"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$APP"
mv "$APP"/windows/* "$APP"/
rmdir "$APP/windows"
rm -rf "$APP/tools" "$APP/macos" "$APP/.gitignore"

mkdir -p "$WORK/nodezip" "$APP/node"
unzip -q "$NODE_ZIP" '*/node.exe' '*/LICENSE' -d "$WORK/nodezip"
cp "$WORK"/nodezip/*/node.exe "$WORK"/nodezip/*/LICENSE "$APP/node/"

if [ -n "${SETTINGS:-}" ]; then
  mkdir -p "$APP/data"
  cp "$SETTINGS" "$APP/data/settings.json"
fi

rm -f "$OUT"
(cd "$WORK" && zip -qr -9 "$OUT" wordwolf)
echo "作成: $OUT ($(du -h "$OUT" | cut -f1))"
