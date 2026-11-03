import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 可自動跑的測試一律放 scripts/test-*.mjs；本檔依檔名執行，新增測試只要加同名前綴即可。 */
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..');
const tests = readdirSync(scriptsDir).filter((name) => /^test-.*\.mjs$/.test(name)).sort();

if (tests.length === 0) {
  console.error('scripts/ 沒有 test-*.mjs');
  process.exit(1);
}

for (const file of tests) {
  console.log(`執行 ${file}...`);
  const result = spawnSync(process.execPath, [join(scriptsDir, file)], { cwd: root, stdio: 'inherit' });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}
