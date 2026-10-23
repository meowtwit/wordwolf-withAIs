#!/bin/bash
# start.command / admin.command から読み込む共通処理: 同梱の Node でゲームサーバーを起動する
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

# ダウンロードしたファイルに付く「隔離」の印を外す（同梱の node を実行できるように）
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true

case "$(uname -m)" in
  arm64) NODE="$DIR/node/darwin-arm64/node" ;;
  *)     NODE="$DIR/node/darwin-x64/node" ;;
esac
if [ ! -x "$NODE" ]; then NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ]; then
  echo "Node が見つかりませんでした。ZIP をすべて展開してから、もう一度ためしてください。"
  read -r -n 1 -p "何かキーを押すと閉じます"
  exit 1
fi

URL="http://localhost:3000"
alive() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:3000/api/health"; }

if ! alive; then
  mkdir -p "$DIR/data"
  echo "ゲームを起動しています…"
  nohup "$NODE" "$DIR/server.js" > "$DIR/data/server.log" 2>&1 &
  echo $! > "$DIR/data/server.pid"
  for _ in $(seq 1 40); do alive && break; sleep 0.5; done
  if ! alive; then
    echo "ゲームを起動できませんでした。くわしくは data/server.log を見てください。"
    tail -n 20 "$DIR/data/server.log"
    read -r -n 1 -p "何かキーを押すと閉じます"
    exit 1
  fi
fi
