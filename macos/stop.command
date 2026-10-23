#!/bin/bash
# 月夜のワードウルフ: ゲームサーバーを止める（ダブルクリックで実行）
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/data/server.pid" ]; then
  kill "$(cat "$DIR/data/server.pid")" 2>/dev/null || true
  rm -f "$DIR/data/server.pid"
fi
# PID ファイルがない場合も、このフォルダの server.js を止める
pkill -f "$DIR/server.js" 2>/dev/null || true
echo "ゲームを止めました。（全画面のゲーム画面が残っていたら command + Q で閉じてください）"
