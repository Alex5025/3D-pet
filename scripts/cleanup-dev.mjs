import { readFile, rm } from 'node:fs/promises';
import { layout, projectDir } from './data-dir.mjs';
import { legacyDataDir, prepareStorage } from './storage-layout.mjs';

const paths = layout();
prepareStorage(paths, legacyDataDir(projectDir));
const pidFile = paths.pid;

try {
  const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
  if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
      console.error('此實例已在執行；請先結束或使用重啟功能。', pidFile);
      process.exit(1);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  await rm(pidFile, { force: true });
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.warn('[predev] 無法清理舊的 Electron 行程:', error);
  }
}
