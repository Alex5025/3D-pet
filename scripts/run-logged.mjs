import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { layout, projectDir } from './data-dir.mjs';
import { pruneLogs } from './storage-layout.mjs';
const paths = layout();
mkdirSync(paths.logs, { recursive: true });
const write = chunk => {
  try { appendFileSync(join(paths.logs, `launcher-${new Date().toISOString().slice(0, 10)}.log`), chunk); }
  catch (error) { process.stderr.write(`日誌寫入失敗：${String(error)}\n`); }
};
pruneLogs(paths.logs);
const cleanup = setInterval(() => { try { pruneLogs(paths.logs); } catch (error) { write(String(error)); } }, 86400000);
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
  cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
child.stdout.on('data', write);
child.stderr.on('data', write);
child.on('error', error => { write(String(error)); clearInterval(cleanup); process.exitCode = 1; });
child.on('exit', code => { clearInterval(cleanup); process.exitCode = code ?? 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
