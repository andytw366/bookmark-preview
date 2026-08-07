#!/usr/bin/env bash
#
# 由 assets/icon.svg 產生 AMO 與 about:addons 用的 PNG（48 / 96 / 128）。
#
# 為什麼要有 PNG：Firefox 與 AMO 都吃得下 SVG，但商店頁與擴充套件管理員各自
# 會把圖示縮到不同尺寸，交給它們縮放的結果不如先給好對應尺寸的點陣圖。
# **SVG 仍然是唯一的來源**，PNG 是產生物 —— 要改圖示就改 SVG 再跑這支。
#
# 需要 librsvg（ImageMagick 的內建 SVG 轉譯器畫不好這張圖）：
#   sudo apt-get install -y librsvg2-bin
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets/icon.svg"

if ! command -v rsvg-convert > /dev/null; then
  echo "找不到 rsvg-convert，請先安裝：sudo apt-get install -y librsvg2-bin" >&2
  exit 1
fi

for size in 48 96 128; do
  rsvg-convert -w "$size" -h "$size" -o "$ROOT/public/icons/icon-$size.png" "$SRC"
  echo "產生 public/icons/icon-$size.png"
done

# AMO 商店頁的圖示欄另外給一張 512：那一欄會在高解析度螢幕上放大顯示，
# 交給它從 128 拉大會糊。**刻意不放進 public/icons/** —— 那個目錄整個會被複製到
# dist/，而 manifest 沒有引用 512，等於讓每個使用者多下載一張用不到的圖。
rsvg-convert -w 512 -h 512 -o "$ROOT/amo/icon-512.png" "$SRC"
echo "產生 amo/icon-512.png（AMO 商店頁用，不進 dist/）"
