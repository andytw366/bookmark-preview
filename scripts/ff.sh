#!/usr/bin/env bash
#
# 無頭 Firefox 的操作前端：把「一步一個 xdotool 指令、一步一張截圖」濃縮成一行。
#
# 為什麼要有這支腳本：互動式驗證的成本幾乎都花在「重複打同樣的 xdotool /
# import / convert」上。指令可以串接，所以一整段操作（點、輸入、等、截圖）
# 寫成一行就好：
#
#   ./scripts/ff.sh click 120 220 type '###' wait 2 sidebar gate
#
# 每個子指令消耗固定數量的參數，處理完就換下一個。點擊類子指令後面會自動等
# FF_WAIT 秒（預設 1.2），要另外等就用 wait。
#
# 截圖一律存到 .test-shots/<名稱>.png 並在最後印出路徑。
#
# 子指令：
#   start              背景啟動 Xvfb + Firefox（會等到視窗出現）
#   stop               收掉 Firefox 與 Xvfb
#   alive              印出 Firefox 是否活著
#   click X Y          左鍵
#   rclick X Y         右鍵
#   move X Y           只移動游標
#   drag X1 Y1 X2 Y2   HTML5 拖拽：按住 → 分段移過去 → 停 0.6 秒 → 放開
#   press X Y          只按住（拖拽的前半；之後用 glide 移動、release 放開，中間可以截圖）
#   glide X Y          按住狀態下分段移到 X Y
#   release            放開滑鼠左鍵
#   scroll N           往下滾 N 格（負數往上）
#   type TEXT          輸入文字
#   key KEY            送按鍵（例如 Return、ctrl+a、F5）
#   wait S             等 S 秒
#   shot NAME          整個畫面
#   sidebar NAME       只裁側邊欄（FF_SIDEBAR 可覆寫，預設 250x700+0+150）
#   crop NAME X Y W H  自訂區域
#   zoom NAME X Y W H  自訂區域放大兩倍（找小按鈕座標用）
#   trigger            點側邊欄搜尋框並輸入觸發字串（FF_TRIGGER，預設 ###）
#   unlock [PW]        trigger + 輸入主密碼 + Enter（PW 預設 FF_PASSWORD）
#
# 環境變數：DISPLAY_NUM(:99)、FF_WAIT(1.2)、FF_PASSWORD(testpass1234)、
#           FF_TRIGGER(###)、FF_SHOT_DIR(.test-shots)、FF_SIDEBAR、
#           FF_SEARCH_XY（側邊欄搜尋框座標，預設 "120 220"）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DISPLAY="${DISPLAY_NUM:-:99}"
WAIT="${FF_WAIT:-1.2}"
SHOT_DIR="${FF_SHOT_DIR:-$ROOT/.test-shots}"
SIDEBAR_REGION="${FF_SIDEBAR:-250x700+0+150}"
TRIGGER="${FF_TRIGGER:-###}"
PASSWORD="${FF_PASSWORD:-testpass1234}"

mkdir -p "$SHOT_DIR"
written=()

shot_path() {
  printf '%s/%s.png' "$SHOT_DIR" "$1"
}

capture() {
  # $1=輸出檔 $2=可選的 crop 幾何
  local out="$1" geometry="${2:-}"
  import -window root "$out"
  if [[ -n "$geometry" ]]; then
    convert "$out" -crop "$geometry" +repage "$out"
  fi
  written+=("$out")
}

require_display() {
  if ! xdotool search --name "Mozilla Firefox" > /dev/null 2>&1; then
    echo "Firefox 沒在跑（$DISPLAY）。先執行：./scripts/ff.sh start" >&2
    exit 1
  fi
}

cmd_start() {
  if xdotool search --name "Mozilla Firefox" > /dev/null 2>&1; then
    echo "Firefox 已經在跑了"
    return
  fi
  if [[ ! -f "$ROOT/dist/manifest.json" ]]; then
    echo "dist/ 還沒建置，請先 npm run build" >&2
    exit 1
  fi
  # 用 setsid 脫離這個 shell：Firefox 才不會隨著呼叫端的指令一起被回收
  setsid nohup "$ROOT/scripts/test-headless.sh" > "$ROOT/.test-headless.log" 2>&1 &
  local waited=0
  until xdotool search --name "Mozilla Firefox" > /dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if (( waited > 60 )); then
      echo "等了 60 秒還是沒看到 Firefox 視窗，看 .test-headless.log" >&2
      exit 1
    fi
  done
  sleep 3
  echo "Firefox 已啟動（DISPLAY=$DISPLAY）"
}

# HTML5 拖拽要「按住 → 好幾段 mousemove（中間有停頓）」Firefox 才會開始拖拽並持續送
# dragover；一次跳到終點只會得到一個點擊。最後多晃一個像素，讓落點的 dragover 一定送到。
glide_to() {
  local to_x="$1" to_y="$2" from_x from_y
  eval "$(xdotool getmouselocation --shell | grep -E '^(X|Y)=')"
  from_x="$X"
  from_y="$Y"
  for step in 1 2 3 4 5 6 7 8 9 10; do
    xdotool mousemove $(( from_x + (to_x - from_x) * step / 10 )) $(( from_y + (to_y - from_y) * step / 10 ))
    sleep 0.08
  done
  sleep 0.2
  xdotool mousemove $(( to_x + 1 )) "$to_y"
  sleep 0.1
}

cmd_stop() {
  # 進程名是 firefox-bin 不是 firefox；-f 會誤殺路徑含 firefox 的腳本自己
  pkill -x firefox-bin 2> /dev/null || true
  pkill -x Xvfb 2> /dev/null || true
  echo "已收掉 Firefox 與 Xvfb"
}

while (($#)); do
  case "$1" in
    start) cmd_start; shift ;;
    stop) cmd_stop; shift ;;
    alive)
      if xdotool search --name "Mozilla Firefox" > /dev/null 2>&1; then
        echo "Firefox: 活著"
      else
        echo "Firefox: 沒在跑"
      fi
      shift
      ;;
    click)
      require_display
      xdotool mousemove "$2" "$3" click 1
      sleep "$WAIT"
      shift 3
      ;;
    rclick)
      require_display
      xdotool mousemove "$2" "$3" click 3
      sleep "$WAIT"
      shift 3
      ;;
    move)
      require_display
      xdotool mousemove "$2" "$3"
      shift 3
      ;;
    press)
      require_display
      xdotool mousemove "$2" "$3" mousedown 1
      sleep 0.3
      shift 3
      ;;
    glide)
      require_display
      glide_to "$2" "$3"
      shift 3
      ;;
    release)
      require_display
      xdotool mouseup 1
      sleep "$WAIT"
      shift
      ;;
    drag)
      require_display
      xdotool mousemove "$2" "$3" mousedown 1
      sleep 0.3
      glide_to "$4" "$5"
      sleep 0.6
      xdotool mouseup 1
      sleep "$WAIT"
      shift 5
      ;;
    scroll)
      require_display
      # 正數往下（button 5）、負數往上（button 4）
      if (( $2 < 0 )); then
        xdotool click --repeat $(( -$2 )) --delay 40 4
      else
        xdotool click --repeat "$2" --delay 40 5
      fi
      sleep "$WAIT"
      shift 2
      ;;
    type)
      require_display
      xdotool type --delay 60 "$2"
      sleep 0.4
      shift 2
      ;;
    key)
      require_display
      xdotool key "$2"
      sleep "$WAIT"
      shift 2
      ;;
    wait) sleep "$2"; shift 2 ;;
    shot) capture "$(shot_path "$2")"; shift 2 ;;
    sidebar) capture "$(shot_path "$2")" "$SIDEBAR_REGION"; shift 2 ;;
    # 參數順序是 NAME X Y W H，ImageMagick 的幾何字串是 WxH+X+Y —— 別搞混了
    crop) capture "$(shot_path "$2")" "${5}x${6}+${3}+${4}"; shift 6 ;;
    zoom)
      out="$(shot_path "$2")"
      import -window root "$out"
      convert "$out" -crop "${5}x${6}+${3}+${4}" +repage -resize 200% "$out"
      written+=("$out")
      shift 6
      ;;
    trigger)
      require_display
      # shellcheck disable=SC2086
      xdotool mousemove ${FF_SEARCH_XY:-120 220} click 1
      sleep 0.5
      xdotool type --delay 100 "$TRIGGER"
      sleep 2
      shift
      ;;
    unlock)
      require_display
      pw="$PASSWORD"
      if [[ ${2:-} != "" && ${2:-} != click && ${2:-} != shot && ${2:-} != sidebar \
            && ${2:-} != wait && ${2:-} != type && ${2:-} != key && ${2:-} != crop \
            && ${2:-} != zoom && ${2:-} != rclick && ${2:-} != scroll && ${2:-} != move ]]; then
        pw="$2"
        shift
      fi
      # shellcheck disable=SC2086
      xdotool mousemove ${FF_SEARCH_XY:-120 220} click 1
      sleep 0.5
      xdotool type --delay 100 "$TRIGGER"
      sleep 2
      # 密碼欄位在觸發字串跳出的畫面裡，位置固定
      xdotool mousemove 120 485 click 1
      sleep 0.3
      xdotool type --delay 40 "$pw"
      xdotool key Return
      sleep 3
      shift
      ;;
    *)
      echo "不認得的子指令：$1" >&2
      exit 1
      ;;
  esac
done

for file in "${written[@]:-}"; do
  if [[ -n "$file" ]]; then
    echo "$file"
  fi
done
