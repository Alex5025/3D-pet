import { app } from 'electron';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { storageLayout, pruneLogs } from '../../scripts/storage-layout.mjs';

export const runtimeLayout = () => storageLayout(app.getAppPath(), process.env, app.isPackaged);

export function agentTempDirectory(prefix: string, socket = false): string {
  let root = runtimeLayout().temp;
  // macOS 的 Unix socket 路徑最多約 104 bytes，長 worktree 路徑只將通訊暫存改用短目錄。
  if (socket && process.platform !== 'win32' && Buffer.byteLength(join(root, `${prefix}XXXXXX`, 's')) > 100) root = '/tmp/3D-pet/instances';
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

/** 主程序日誌按 UTC 日期分檔；console 原輸出仍保留，寫檔失敗不遞迴呼叫 console。 */
export function installRuntimeLogging(): () => void {
  const { logs } = runtimeLayout();
  mkdirSync(logs, { recursive: true });
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      originals[level](...args);
      try { appendFileSync(join(logs, `main-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} [${level}] ${format(...args)}\n`, 'utf8'); }
      catch (error) { originals.error('[storage] 日誌寫入失敗', error); }
    };
  }
  pruneLogs(logs);
  return () => { Object.assign(console, originals); };
}
