#!/usr/bin/env bash
#
# 提供封面擷取用的測試頁（http://127.0.0.1:8899/）。
#
# 這個頁面刻意沒有任何 og:image / JSON-LD，用來驗證「頁面上找最像封面的那張圖」
# 這條啟發式能挑對 —— 真實的漫畫站與影音站常常就是這種情況。
#
# scripts/test-headless.sh 的種子書籤裡有一筆指向這個位址，
# 所以擷取管線會把它當成已加入書籤的頁面而觸發封面擷取。
#
# 用法：
#   ./scripts/serve-fixture.sh          # 前景執行，Ctrl-C 結束
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="$ROOT/tests/fixtures/site"
PORT="${FIXTURE_PORT:-8899}"

# 圖片是產生出來的而不是簽入版本庫的：二進位檔對 diff 沒有意義，
# 而這幾張只是有顏色的方塊。
if ! command -v convert > /dev/null; then
  echo "需要 ImageMagick 的 convert 來產生測試圖片：sudo apt-get install imagemagick" >&2
  exit 1
fi

if [[ ! -f "$SITE/cover.png" ]]; then
  echo "產生測試圖片…"
  # 直式封面，比例 2:3（漫畫與書籍封面的典型比例）
  convert -size 400x600 gradient:'#2b1055-#7597de' \
    -gravity center -pointsize 54 -fill white -annotate +0-60 'COVER' \
    -pointsize 28 -annotate +0+20 '400 x 600' \
    -pointsize 20 -annotate +0+70 'portrait 2:3' \
    "$SITE/cover.png"
  # 橫式影片封面
  convert -size 640x360 gradient:'#0f3d3e-#2a9d8f' \
    -gravity center -pointsize 44 -fill white -annotate +0-30 'VIDEO POSTER' \
    -pointsize 24 -annotate +0+30 '640 x 360' "$SITE/poster.png"
  # 干擾項：全寬 hero、橫幅廣告、小圖示
  convert -size 1200x500 gradient:'#5a189a-#e0aaff' \
    -gravity center -pointsize 48 -fill white -annotate 0 'HERO 1200x500' "$SITE/hero.png"
  convert -size 900x90 xc:'#cc4444' -gravity center -pointsize 24 -fill white \
    -annotate 0 'BANNER AD 900x90' "$SITE/banner.png"
  convert -size 32x32 xc:'#44cc44' "$SITE/icon.png"
  # 全站共用 og:image 的測試素材：一張假 logo 與兩張各自的內容圖
  convert -size 600x315 xc:'#1b263b' -gravity center -pointsize 40 -fill white \
    -annotate 0 'SITE LOGO (og:image)' "$SITE/logo.png"
  convert -size 400x600 gradient:'#7f1d1d-#fca5a5' -gravity center -pointsize 44 -fill white \
    -annotate +0-30 'CONTENT A' -pointsize 24 -annotate +0+30 'portrait' "$SITE/content-a.png"
  convert -size 400x600 gradient:'#134e4a-#5eead4' -gravity center -pointsize 44 -fill white \
    -annotate +0-30 'CONTENT B' -pointsize 24 -annotate +0+30 'portrait' "$SITE/content-b.png"
fi

cat <<INFO
測試頁（每一頁對應封面擷取的一種情況）：
  http://127.0.0.1:$PORT/             無中介資料的直式封面（要勝過橫幅與圖示）
  http://127.0.0.1:$PORT/video        橫式 video poster（要勝過更大的全寬 hero）
  http://127.0.0.1:$PORT/background   封面是 CSS background-image
  http://127.0.0.1:$PORT/lazy         封面在頁面載入後才指定 src
  http://127.0.0.1:$PORT/declared     宣告的 og:image 要勝過更大的無關圖片
  http://127.0.0.1:$PORT/shared-a     兩頁共用同一張 og:image（造訪兩頁後應降級）
  http://127.0.0.1:$PORT/shared-b     同上
  http://127.0.0.1:$PORT/embed        封面只在 iframe 的 ?poster= 參數裡（要勝過 og:image logo）
  http://127.0.0.1:$PORT/embed-spa    同上，但 iframe 的 src 是框架綁定 —— 封面只在序列化的初始資料裡
  http://127.0.0.1:$PORT/deep-thumbs  頂端的背景封面要勝過頁面深處的推薦縮圖
INFO

exec node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
http
  .createServer((req, res) => {
    let requested = req.url.split('?')[0];
    if (requested === '/') {
      requested = '/index.html';
    } else if (!path.extname(requested)) {
      // /video → /video.html，讓測試頁有乾淨的網址
      requested += '.html';
    }
    const file = path.join(root, path.basename(requested));
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(${PORT}, '127.0.0.1');
" "$SITE"
