#!/usr/bin/env bash
# macOS 用の配布 ZIP を作る（Apple シリコン / Intel 両方の Node.js を同梱。start.command をダブルクリックするだけで動く）。
#   使い方: tools/package-macos.sh <node-vXX-darwin-arm64.tar.gz> <node-vXX-darwin-x64.tar.gz> <出力.zip> [settings.json]
#   Node は https://nodejs.org/dist/ の darwin-*.tar.gz（SHASUMS256.txt で確認したもの）を渡す。
set -euo pipefail
ARM=$(realpath "$1")
X64=$(realpath "$2")
OUT=$(realpath -m "$3")
SETTINGS=${4:+$(realpath "$4")}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

APP="$WORK/wordwolf"
mkdir -p "$APP"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$APP"
mv "$APP"/macos/* "$APP"/
rm -rf "$APP/macos" "$APP/windows" "$APP/tools" "$APP/.gitignore"

for pair in "darwin-arm64:$ARM" "darwin-x64:$X64"; do
  name=${pair%%:*}; tgz=${pair#*:}
  mkdir -p "$WORK/$name" "$APP/node/$name"
  tar -xzf "$tgz" -C "$WORK/$name" --wildcards '*/bin/node' '*/LICENSE'
  cp "$WORK/$name"/*/bin/node "$APP/node/$name/node"
  cp "$WORK/$name"/*/LICENSE "$APP/node/LICENSE"
  chmod 755 "$APP/node/$name/node"
done
chmod 755 "$APP"/*.command "$APP"/_server.sh

if [ -n "${SETTINGS:-}" ]; then
  mkdir -p "$APP/data"
  cp "$SETTINGS" "$APP/data/settings.json"
fi

rm -f "$OUT"
# -y: シンボリックリンクはそのまま。zip は実行権限も記録するので、Mac で展開しても .command が動く
(cd "$WORK" && zip -qry -9 "$OUT" wordwolf)
echo "作成: $OUT ($(du -h "$OUT" | cut -f1))"
