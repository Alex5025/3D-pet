import { ipcMain } from 'electron';

/** 每個模組只移除自己註冊的資源，清理可重複呼叫。 */
export function createResourceScope() {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let started = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const add = (cleanup: () => void): void => {
    if (disposed) cleanup();
    else cleanups.push(cleanup);
  };
  return {
    add,
    get disposed() { return disposed; },
    start(): boolean {
      if (disposed || started) return false;
      started = true;
      return true;
    },
    timeout(callback: () => void, delay: number) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!disposed) callback();
      }, delay);
      if (disposed) clearTimeout(timer);
      else timers.add(timer);
      return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>): void {
      clearTimeout(timer);
      timers.delete(timer);
    },
    interval(callback: () => void, delay: number) {
      const timer = setInterval(() => { if (!disposed) callback(); }, delay);
      if (disposed) clearInterval(timer);
      else intervals.add(timer);
      return timer;
    },
    clearInterval(timer: ReturnType<typeof setInterval>): void {
      clearInterval(timer);
      intervals.delete(timer);
    },
    listen(emitter: NodeJS.EventEmitter, event: string, listener: Parameters<NodeJS.EventEmitter['on']>[1]): void {
      emitter.on(event, listener);
      add(() => { emitter.removeListener(event, listener); });
    },
    ipc: {
      on(...args: Parameters<typeof ipcMain.on>): void {
        ipcMain.on(...args);
        add(() => { ipcMain.removeListener(...args); });
      },
      handle(...args: Parameters<typeof ipcMain.handle>): void {
        ipcMain.handle(...args);
        add(() => ipcMain.removeHandler(args[0]));
      },
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const timer of intervals) clearInterval(timer);
      timers.clear();
      intervals.clear();
      for (const cleanup of cleanups.reverse()) {
        try { cleanup(); } catch (error) { console.error('[main] 資源清理失敗', error); }
      }
      cleanups.length = 0;
    },
  };
}
