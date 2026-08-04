#!/bin/zsh

set -u
unsetopt BG_NICE

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/runtime-data/pet-system.pid"
LOG_FILE="$PROJECT_DIR/runtime-data/pet-system-restart.log"

log() {
  print -r -- "$(date '+%Y-%m-%dT%H:%M:%S%z') $1" >> "$LOG_FILE"
}

if [[ ! -f "$PID_FILE" ]]; then
  log "重啟失敗：找不到 PID 檔 $PID_FILE"
  exit 1
fi

PET_PID="$(tr -d '[:space:]' < "$PID_FILE")"
if [[ ! "$PET_PID" =~ '^[0-9]+$' ]] || (( PET_PID <= 1 )); then
  log "重啟失敗：PID 無效 ($PET_PID)"
  exit 1
fi

log "準備終止寵物系統 PID $PET_PID"
kill -TERM "$PET_PID" 2>/dev/null || true

for _ in {1..50}; do
  kill -0 "$PET_PID" 2>/dev/null || break
  sleep 0.1
done

if kill -0 "$PET_PID" 2>/dev/null; then
  log "PID $PET_PID 未退出，改送 SIGKILL"
  kill -KILL "$PET_PID" 2>/dev/null || true
fi

# electron-vite 父程序會在 Electron 結束後關閉 renderer server，留一點時間釋放連接埠。
sleep 0.5
log "從 $PROJECT_DIR 重新執行 npm run dev"
cd "$PROJECT_DIR" || exit 1
nohup npm run dev >> "$LOG_FILE" 2>&1 &
log "重啟指令已送出，launcher PID $!"
