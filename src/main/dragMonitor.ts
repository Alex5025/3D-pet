import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * 全域「檔案拖曳」偵測(macOS):長駐一個 osascript(JXA)子行程,
 * 輪詢拖曳剪貼簿的 changeCount(拖曳開始時遞增)與左鍵按壓狀態(放開 = 拖曳結束),
 * 且只認內容含 file-url 的拖曳(拖文字/拖視窗不觸發)。
 *
 * 為什麼需要它:疊層視窗(透明+panel+不可聚焦+screen-saver 層)實測收不到任何
 * 拖放事件——連「從啟動就永遠可互動」都收不到(2026-07 實驗,詳 DEVLOG)。
 * 唯一可行解是仿 Finder 彈簧資料夾:拖曳開始的瞬間亮出一般屬性的接收窗。
 */

const JXA_SCRIPT = `
ObjC.import('AppKit');
const out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(s) {
  out.writeData($.NSString.alloc.initWithUTF8String(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
let lastCount = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag).changeCount;
let dragging = false;
while (true) {
  const pb = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);
  const count = pb.changeCount;
  const leftDown = ($.NSEvent.pressedMouseButtons & 1) === 1;
  if (!dragging && count !== lastCount) {
    lastCount = count;
    if (leftDown) {
      let isFile = false;
      const types = pb.types;
      if (!types.isNil()) {
        for (let i = 0; i < types.count; i++) {
          if (String(ObjC.unwrap(types.objectAtIndex(i))).indexOf('file-url') >= 0) { isFile = true; break; }
        }
      }
      if (isFile) { dragging = true; emit('drag-start'); }
    }
  }
  if (dragging && !leftDown) { dragging = false; emit('drag-end'); }
  delay(dragging ? 0.05 : 0.12);
}
`;

export interface DragMonitor {
  /** false = 暫停輪詢(鎖屏/睡眠/全寵休息時省 helper 的常駐 CPU);true = 恢復。 */
  setActive(active: boolean): void;
  dispose(): void;
}

export function createDragMonitor(handlers: { onStart: () => void; onEnd: () => void }): DragMonitor {
  let child: ChildProcess | null = null;
  let disposed = false;
  let wanted = true;
  let failures = 0;

  function start(): void {
    if (disposed || !wanted || child || process.platform !== 'darwin') return;
    const proc = spawn('osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    proc.stderr?.on('data', () => undefined);
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      if (line === 'drag-start') handlers.onStart();
      else if (line === 'drag-end') handlers.onEnd();
    });
    proc.on('exit', () => {
      if (disposed || child !== proc) return;
      child = null;
      if (!wanted) return; // setActive(false) 主動停的,不是 crash
      // 連續掛掉就放棄(拖放接收窗失效,其他功能不受影響),偶發掛掉 5 秒後重啟
      failures += 1;
      if (failures <= 5) setTimeout(start, 5_000);
      else console.log('[drag] 拖曳偵測 helper 連續失敗,已停用(拖放參考檔案需重啟 app)');
    });
  }
  start();

  return {
    setActive(active) {
      if (active === wanted) return;
      wanted = active;
      if (!active) {
        const proc = child;
        child = null;
        proc?.kill('SIGTERM');
      } else {
        failures = 0; // 手動恢復重算失敗次數
        start();
      }
    },
    dispose() {
      disposed = true;
      wanted = false;
      child?.kill('SIGTERM');
      child = null;
    }
  };
}
