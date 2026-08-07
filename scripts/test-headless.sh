#!/usr/bin/env bash
#
# 在無圖形介面的容器裡以 Xvfb 虛擬顯示器啟動 Firefox 並載入 dist/。
# 會建立一個含種子書籤的乾淨 profile，方便測試資料夾巡覽與搜尋。
#
# 用法：
#   ./scripts/test-headless.sh              # 啟動並保持前景執行
#
# 另開一個 shell 截圖／操作（DISPLAY 要一致）：
#   DISPLAY=:99 import -window root shot.png
#   DISPLAY=:99 xdotool mousemove 100 332 click 1
#
# 首次使用需安裝相依套件（Ubuntu/Debian）：
#   sudo apt-get install -y xvfb x11-utils xdotool imagemagick fonts-noto-cjk \
#     libgtk-3-0t64 libdbus-glib-1-2 libasound2t64 libxt6t64 libx11-xcb1 \
#     libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libatk1.0-0t64 \
#     libatk-bridge2.0-0t64 libcups2t64 libnss3 libnspr4 libgbm1 libdrm2
#
# Firefox 用官方 tarball，不要用 Ubuntu 24.04 的 apt 版（那是 snap 轉接包，容器裡跑不起來）：
#   curl -sSL -o ff.tar.xz "https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64&lang=zh-TW"
#   sudo tar -xJf ff.tar.xz -C /opt
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="$ROOT/.test-profile"
FIREFOX="${FIREFOX_BIN:-/opt/firefox/firefox}"
SCREEN="${SCREEN_SIZE:-1500x950x24}"
DISPLAY_NUM="${DISPLAY_NUM:-:99}"

if [[ ! -x "$FIREFOX" ]]; then
  echo "找不到 Firefox：$FIREFOX（可用 FIREFOX_BIN 指定）" >&2
  exit 1
fi

if [[ ! -f "$ROOT/dist/manifest.json" ]]; then
  echo "dist/ 還沒建置，請先執行 npm run build" >&2
  exit 1
fi

# 用 -x 比對進程名，不能用 -f：本腳本路徑含 "firefox"，-f 會讓它自殺
pkill -x Xvfb 2>/dev/null || true
pkill -x firefox 2>/dev/null || true

# KEEP_PROFILE=1 保留既有 profile（已授予的選用權限、已擷取的縮圖都會留著），
# 用於測試「權限在背景頁啟動前就已存在」這類需要跨工作階段的情境
if [[ "${KEEP_PROFILE:-0}" != "1" ]]; then
  rm -rf "$PROFILE"
fi
mkdir -p "$PROFILE"

# SEED_SHOWCASE=1 改用一組「像真實使用者的收藏」的書籤，用於拍商店截圖。
#
# 為什麼要另外一組：預設那組是為了**測試**而挑的，最上層塞著九筆
# 「測試漫畫頁（本地）」之類的 127.0.0.1 項目 —— 那些是封面判定的素材，
# 對商店頁的讀者只是雜訊。這一組全部是知名網站，補抓之後多數拿得到
# og:image，畫面接近使用者實際會看到的樣子。
#
# 刻意留一兩個沒有 og:image 的（Google 首頁、Hacker News）：那正是色卡退路
# 的實際樣子，截圖不該假裝每一筆都有圖。
if [[ "${SEED_SHOWCASE:-0}" == "1" ]]; then
cat > "$PROFILE/bookmarks.html" <<'HTML'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">書籤工具列</H3>
    <DL><p>
        <DT><A HREF="https://github.com/">GitHub</A>
        <DT><A HREF="https://chatgpt.com/">ChatGPT</A>
        <DT><A HREF="https://www.youtube.com/">YouTube</A>
        <DT><A HREF="https://developer.mozilla.org/">MDN Web Docs</A>
        <DT><A HREF="https://stackoverflow.com/">Stack Overflow</A>
        <DT><A HREF="https://www.wikipedia.org/">Wikipedia</A>
        <DT><A HREF="https://www.google.com/">Google</A>
        <DT><A HREF="https://news.ycombinator.com/">Hacker News</A>
        <DT><H3>開發</H3>
        <DL><p>
            <DT><A HREF="https://react.dev/">React</A>
            <DT><A HREF="https://vite.dev/">Vite</A>
            <DT><A HREF="https://www.typescriptlang.org/">TypeScript</A>
            <DT><A HREF="https://caniuse.com/">Can I use</A>
            <DT><A HREF="https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions">WebExtensions</A>
        </DL><p>
        <DT><H3>閱讀</H3>
        <DL><p>
            <DT><A HREF="https://www.bbc.com/news">BBC News</A>
            <DT><A HREF="https://www.theverge.com/">The Verge</A>
            <DT><A HREF="https://arxiv.org/">arXiv</A>
        </DL><p>
    </DL><p>
    <DT><H3>其他書籤</H3>
    <DL><p>
        <DT><A HREF="https://www.mozilla.org/">Mozilla</A>
    </DL><p>
HTML
else
# 種子書籤：涵蓋巢狀資料夾、中文名稱，以及一個應被過濾掉的 place: 智慧書籤
cat > "$PROFILE/bookmarks.html" <<'HTML'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">書籤工具列</H3>
    <DL><p>
        <DT><A HREF="https://developer.mozilla.org/zh-TW/">MDN Web Docs</A>
        <DT><A HREF="https://news.ycombinator.com/">Hacker News</A>
        <DT><H3>開發工具</H3>
        <DL><p>
            <DT><A HREF="https://github.com/">GitHub</A>
            <DT><A HREF="https://stackoverflow.com/">Stack Overflow</A>
            <DT><A HREF="https://caniuse.com/">Can I use</A>
            <DT><H3>前端</H3>
            <DL><p>
                <DT><A HREF="https://react.dev/">React</A>
                <DT><A HREF="https://vite.dev/">Vite</A>
                <DT><A HREF="https://www.typescriptlang.org/">TypeScript</A>
            </DL><p>
        </DL><p>
        <DT><H3>研究資料</H3>
        <DL><p>
            <DT><A HREF="https://arxiv.org/">arXiv</A>
            <DT><A HREF="https://scholar.google.com/">Google 學術搜尋</A>
            <DT><A HREF="https://ieeexplore.ieee.org/">IEEE Xplore</A>
        </DL><p>
        <DT><A HREF="http://127.0.0.1:8899/">測試漫畫頁（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/video">測試影片頁（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/background">測試背景圖頁（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/lazy">測試延遲載入頁（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/declared">測試宣告優先頁（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/shared-a">共用 og 圖測試 A（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/shared-b">共用 og 圖測試 B（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/embed">嵌入式播放器測試（本地）</A>
        <DT><A HREF="http://127.0.0.1:8899/deep-thumbs">背景封面 vs 推薦縮圖（本地）</A>
        <DT><A HREF="place:type=6&sort=14&maxResults=10">最近的書籤</A>
    </DL><p>
    <DT><H3>其他書籤</H3>
    <DL><p>
        <DT><A HREF="https://www.nycu.edu.tw/">陽明交通大學</A>
        <DT><A HREF="https://bugzilla.mozilla.org/">Bugzilla</A>
    </DL><p>
HTML
fi

# SEED_BULK=3000 另外塞一個「大量書籤」資料夾，用於量測清單效能。
# 網域刻意輪替：色卡是依 hostname 取色的，全部同一個網域會讓畫面看不出
# 捲動到哪裡，也讓「每一列都不一樣」這個實際情境失真。
#
# 要接在最外層 <DL> 收尾**之前**，所以上面的 heredoc 刻意沒有寫最後那一行。
if [[ "${SEED_BULK:-0}" != "0" ]]; then
  {
    printf '    <DT><H3>大量書籤</H3>\n    <DL><p>\n'
    for ((i = 1; i <= ${SEED_BULK}; i++)); do
      printf '        <DT><A HREF="https://example-%d.test/page/%d">壓力測試書籤 %04d</A>\n' \
        $((i % 37)) "$i" "$i"
    done
    printf '    </DL><p>\n'
  } >> "$PROFILE/bookmarks.html"
  echo "已種入 ${SEED_BULK} 筆壓力測試書籤"
fi

printf '</DL><p>\n' >> "$PROFILE/bookmarks.html"

cat > "$PROFILE/user.js" <<'PREFS'
user_pref("browser.places.importBookmarksHTML", true);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("browser.uitour.enabled", false);
// 測試結束時 Firefox 是被強制結束的，會被判定為當機而顯示「想開啟先前的分頁？」
// 提示列。那條提示列會把側邊欄整體往下推，讓依座標點擊的自動化全部錯位。
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.max_resumed_crashes", 0);
PREFS

export DISPLAY="$DISPLAY_NUM"
# 容器內無法建立 user namespace，沙盒會失敗，測試環境下關閉
export MOZ_DISABLE_CONTENT_SANDBOX=1

Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" -nolisten tcp > "$PROFILE/../.test-xvfb.log" 2>&1 &
sleep 2

echo "Xvfb 已啟動於 $DISPLAY_NUM（$SCREEN）"
echo "截圖：DISPLAY=$DISPLAY_NUM import -window root shot.png"

cd "$ROOT"
exec npx web-ext run \
  --source-dir dist \
  --firefox "$FIREFOX" \
  --firefox-profile "$PROFILE" \
  --profile-create-if-missing \
  --keep-profile-changes \
  --no-reload \
  --start-url "about:blank"
