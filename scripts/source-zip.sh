#!/usr/bin/env bash
#
# 產生送審用的原始碼壓縮檔。
#
# AMO 規定：提交的 .zip 裡若有打包／壓縮過的程式碼（我們用 Vite），就必須一併附上
# 原始碼，且審查員要能照著說明重現出同一份 dist/。
#
# 用 `git archive` 而不是自己列檔案：輸出的內容剛好是版本庫追蹤中的檔案，
# 不會夾帶 node_modules/、dist/、.test-profile/ 這些東西，也不會**漏掉**某個
# 建置需要的檔案 —— 少一個 vite.config 之類的就會被退件，而那種疏漏自己列
# 清單時最容易發生。
#
# 代價是它也會帶上 NEXT.md、PLAN.md、docs/ 這些開發文件。那是刻意的：
# 對審查員只有幫助，而且原始碼本來就公開在 GitHub 上。
#
# 用法：
#   ./scripts/source-zip.sh    # → web-ext-artifacts/bookmark-preview-vault-<版本>-source.zip
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
OUT_DIR="$ROOT/web-ext-artifacts"
OUT="$OUT_DIR/bookmark-preview-vault-${VERSION}-source.zip"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "警告：工作區有未提交的改動，這些改動**不會**進到原始碼壓縮檔裡。" >&2
  echo "      （git archive 打包的是 HEAD，不是工作區）" >&2
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT"
git archive --format=zip -o "$OUT" HEAD

echo "$OUT"
