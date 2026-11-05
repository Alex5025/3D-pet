import { spawn } from 'node:child_process';
import { join } from 'node:path';

const oldPid = Number.parseInt(process.argv[2] ?? '', 10);
const projectDir = process.argv[3];
if (!Number.isSafeInteger(oldPid) || oldPid <= 1 || !projectDir) process.exit(2);

const deadline = Date.now() + 10_000;
const waitForExit = () => new Promise((resolve) => {
  const poll = () => {
    try {
      process.kill(oldPid, 0);
      if (Date.now() < deadline) return setTimeout(poll, 100);
    } catch {
      // 行程已退出。
    }
    resolve();
  };
  poll();
});

await waitForExit();
const child = spawn('node', [join(projectDir, 'scripts/run-logged.mjs')], {
  cwd: projectDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
