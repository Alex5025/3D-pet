#!/bin/zsh
# 脫離終端機啟動寵物系統。
#
# 直接在 IDE/終端機裡跑 `npm run dev`,整個 process group 會掛在那個終端機下:
# 關掉分頁、結束 shell、或對 IDE 按 ⌘Q,都會送 SIGHUP 把寵物一起帶走
# ——而且是外部訊號,Electron 的 before-quit(結束前確認)根本不會執行。
# 這支用 nohup 忽略 SIGHUP、setsid(有的話)另開 session,再 disown 脫離 job control,
# 讓寵物系統活得比啟動它的終端機久。要結束請用 Tray 選單或中控面板的「結束」。

set -u
unsetopt BG_NICE

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$PROJECT_DIR/runtime-data/pet-system.log"
PID_FILE="$PROJECT_DIR/runtime-data/pet-system.pid"

mkdir -p "$PROJECT_DIR/runtime-data"

# 已在運行就不重複啟動(predev 的 pkill 會把舊的殺掉,重複啟動等於無聲重啟)
if [[ -f "$PID_FILE" ]]; then
  RUNNING_PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$RUNNING_PID" =~ '^[0-9]+$' ]] && kill -0 "$RUNNING_PID" 2>/dev/null; then
    print -r -- "寵物系統已在運行(PID $RUNNING_PID)。要重啟請用 Tray 選單的「重啟寵物系統」。"
    exit 0
  fi
fi

cd "$PROJECT_DIR" || exit 1
print -r -- "$(date '+%Y-%m-%dT%H:%M:%S%z') 啟動寵物系統(脫離終端機)" >> "$LOG_FILE"

# setsid 在 macOS 不是內建指令,有裝才用;沒有時 nohup + disown 已足以擋掉 SIGHUP
if command -v setsid > /dev/null 2>&1; then
  setsid nohup npm run dev >> "$LOG_FILE" 2>&1 &
else
  nohup npm run dev >> "$LOG_FILE" 2>&1 &
fi
LAUNCHER_PID=$!
disown 2>/dev/null

print -r -- "已啟動,launcher PID $LAUNCHER_PID;紀錄:$LOG_FILE"
print -r -- "這個終端機關掉也不會影響寵物;要結束請用 Tray 選單或中控面板的「結束」。"
