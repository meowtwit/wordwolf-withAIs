#!/bin/bash
# 月夜のワードウルフ: 管理画面を開く（ダブルクリックで起動）
source "$(cd "$(dirname "$0")" && pwd)/_server.sh"
open "$URL/admin.html"
echo "管理画面を開きました。このウィンドウは閉じてかまいません。"
