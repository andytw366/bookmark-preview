#!/usr/bin/env bash
#
# Stop hook：回答結束前確認 TypeScript 還編得過。
#
# 為什麼掛在 Stop 而不是每次編輯之後：重構途中檔案本來就會有一段編不過的狀態，
# 每編輯一次就報一次只會製造噪音。掛在 Stop 抓的是真正要緊的那種情況 ——
# 「說完成了，但其實編不過」。
#
# 只跑 typecheck（約 3 秒）。完整的四項驗證是 `npm run verify`，那個太慢，
# 不適合每回合跑。
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
payload="$(cat)"

# 這個 hook 自己造成的重跑不要再攔一次，否則會沒完沒了
if grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' <<< "$payload"; then
  exit 0
fi

cd "$ROOT" || exit 0
if ! output="$(npx tsc --noEmit 2>&1)"; then
  {
    echo "typecheck 失敗（scripts/hook-typecheck.sh）："
    echo "$output" | head -40
  } >&2
  exit 2
fi

exit 0
