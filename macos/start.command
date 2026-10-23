#!/bin/bash
# 月夜のワードウルフ: ゲームを全画面で開く（ダブルクリックで起動）
source "$(cd "$(dirname "$0")" && pwd)/_server.sh"

# Google Chrome か Microsoft Edge があれば、全画面のキオスクモードで開く（終了は command + Q）
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --kiosk --no-first-run --user-data-dir="$DIR/data/chrome-kiosk" "$URL/"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -na "Microsoft Edge" --args --kiosk --no-first-run --user-data-dir="$DIR/data/edge-kiosk" "$URL/"
else
  open -a Safari "$URL/"
  echo "Safari で開きました。全画面にするには control + command + F を押してください。"
fi
echo "ゲームを開きました。このウィンドウは閉じてかまいません。"
