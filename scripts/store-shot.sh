#!/usr/bin/env bash
#
# 把 .test-shots/ 裡的整窗截圖整理成 AMO 商店頁要的尺寸（1280x800）。
#
# 做兩件事：
#   1. 去掉「已停用安全沙盒」那條提示列。那是**容器環境專屬**的產物
#      （容器裡建不了 user namespace，所以測試時關掉沙盒），與擴充套件無關，
#      一般使用者不會看到它。做法是把它上下兩段接起來，不動其他任何像素。
#   2. 裁到瀏覽器視窗範圍（1280 寬）並縮到 1280x800。
#
# 用法：
#   ./scripts/store-shot.sh <來源名稱> <輸出名稱>
#   # 例：./scripts/store-shot.sh shot-sidebar 01-sidebar
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.test-shots/${1:?請給來源截圖名稱}.png"
OUT_DIR="$ROOT/amo/screenshots"
OUT="$OUT_DIR/${2:?請給輸出名稱}.png"

# 視窗是 1500x950 的畫面裡的左上 1280x855；提示列佔 y=89..139，內容從 140 開始。
#
# 這兩個值是**量出來的**，不要憑目測調：提示列最左邊有一條橘色的強調直條，
# CHROME_H 只要多算幾個像素就會把它留在接縫上（原本 95 就是這樣，成品左上角
# 有一小截橘色）。量法是沿著一個空白的欄（例如 x=1200）往下取樣找那兩條
# 234,234,234 的分隔線：
#   for y in $(seq 84 1 146); do convert shot.png -format "%[pixel:p{1200,$y}]" info:; echo; done
CHROME_H=89      # 分頁列 + 網址列（含底部那條分隔線）
BAR_H=51         # 沙盒提示列的高度（89 + 51 = 140，正好是內容的第一列）
WIN_W=1280
WIN_H=855

mkdir -p "$OUT_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

convert "$SRC" -crop "${WIN_W}x${CHROME_H}+0+0" +repage "$tmp/top.png"
convert "$SRC" -crop "${WIN_W}x$((WIN_H - CHROME_H - BAR_H))+0+$((CHROME_H + BAR_H))" +repage "$tmp/bottom.png"
convert "$tmp/top.png" "$tmp/bottom.png" -append \
  -resize 1280x800^ -gravity north -extent 1280x800 "$OUT"

echo "$OUT"
