import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const pidFile = resolve('runtime-data/pet-system.pid');

try {
  const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
  if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGKILL');
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
