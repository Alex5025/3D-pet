import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { layout, projectDir } from './data-dir.mjs';
import { legacyDataDir, prepareStorage } from './storage-layout.mjs';

const paths = layout();
prepareStorage(paths, legacyDataDir(projectDir));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function ownsDevProcess(pid) {
  const executable = await realpath(createRequire(import.meta.url)('electron'));
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  if (process.platform === 'win32') {
    const path = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).Path`]);
    return path.toLowerCase() === executable.toLowerCase();
  }
  if (process.platform === 'linux') {
    return await realpath(`/proc/${pid}/exe`) === executable
      && await realpath(`/proc/${pid}/cwd`) === await realpath(projectDir);
  }
  return run('ps', ['-p', String(pid), '-o', 'comm=']) === executable
    && run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').includes(`n${await realpath(projectDir)}`);
}

async function stopPrevious() {
  let record;
  try { record = await readFile(paths.pid, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const pid = Number(record.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) return;
  try {
    if (!await ownsDevProcess(pid)) throw new Error('PID 對應其他程序，已停止啟動以避免誤關。');
    console.log(`[predev] 重新啟動目前專案的 Electron（PID ${pid}）`);
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 30 && alive(pid); i++) await delay(100);
    if (!alive(pid)) return;
    // 舊版的離開確認可能卡在已關閉的 Vite，強制結束前再核對身分。
    if (!await ownsDevProcess(pid)) throw new Error('原程序已變更，已取消強制結束。');
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 50 && alive(pid); i++) await delay(100);
    if (alive(pid)) throw new Error('舊 Electron 未能退出。');
  } catch (error) {
    if (alive(pid)) throw error;
  }
}
await stopPrevious();
