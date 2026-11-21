import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync('/tmp/3D-pet', { recursive: true });
const scratch = mkdtempSync('/tmp/3D-pet/cli-env-');
try {
  const output = join(scratch, 'environment.mjs');
  await build({ entryPoints: ['src/main/cliEnvironment.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const { configureCliEnvironment } = await import(pathToFileURL(output).href);
  const finder = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  configureCliEnvironment(finder, 'darwin', '/Users/test');
  assert.ok(finder.PATH.split(':').includes('/opt/homebrew/bin'));
  assert.ok(finder.PATH.split(':').includes('/Users/test/.local/bin'));
  const terminal = { PATH: '/custom/bin:/opt/homebrew/bin:/usr/bin' };
  configureCliEnvironment(terminal, 'darwin', '/Users/test');
  assert.ok(terminal.PATH.startsWith('/custom/bin:/opt/homebrew/bin:/usr/bin:'));
  assert.equal(terminal.PATH.split(':').filter(p => p === '/opt/homebrew/bin').length, 1);
  const first = terminal.PATH;
  configureCliEnvironment(terminal, 'darwin', '/Users/test');
  assert.equal(terminal.PATH, first);
  const windows = { Path: 'C:\\Windows' };
  configureCliEnvironment(windows, 'win32', 'C:\\Users\\test');
  assert.deepEqual(windows, { Path: 'C:\\Windows' });
  console.log('通過：Finder PATH 補齊、終端機優先順序、去重與非 macOS 環境保留');
} finally { rmSync(scratch, { recursive: true, force: true }); }
