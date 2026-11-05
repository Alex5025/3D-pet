import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { storageLayout, prepareStorage, legacyDataDir, pruneLogs } from './storage-layout.mjs';
const require = createRequire(import.meta.url);
mkdirSync('/tmp/3D-pet', { recursive: true });
const root = mkdtempSync('/tmp/3D-pet/storage-layout-');
try {
  const worktree = join(root, 'worktree'); mkdirSync(worktree); writeFileSync(join(worktree, '.git'), 'gitdir: dummy');
  const paths = storageLayout(worktree, {});
  assert.equal(paths.config, join(worktree, 'runtime_data/app.yaml'));
  assert.equal(paths.logs, join(worktree, '3D-pet/instances/logs'));
  const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, '.git'), 'gitdir: other');
  assert.notEqual(storageLayout(other, {}).database, paths.database);
  const override = storageLayout(worktree, { VRM_PET_DATA_DIR: join(root, 'override') });
  assert.equal(override.config, join(root, 'override/runtime_data/app.yaml'));
  assert.equal(storageLayout(worktree, {}, true, 'darwin', root).config, join(root, 'Library/Application Support/VRM Pet/runtime-data/app.yaml'));
  assert.ok(legacyDataDir(worktree, {}).startsWith('/tmp/3D-pet/instances/'));
  assert.equal(storageLayout(worktree, { VRM_PET_DATA_DIR: legacyDataDir(worktree, {}) }).config, paths.config, '舊 Tray 繼承的預設 /tmp 路徑也遷到工作樹');
  const legacy = join(root, 'old'); mkdirSync(join(legacy, 'runtime-data'), { recursive: true });
  const source = join(legacy, 'runtime-data/app.yaml');
  writeFileSync(source, 'schemaVersion: 2\nport: 7083\npets: []\n');
  const oldPid = join(legacy, 'runtime-data/pet-system.pid'); writeFileSync(oldPid, String(process.pid));
  assert.throws(() => prepareStorage(paths, legacy), /仍在執行/);
  assert.equal(existsSync(paths.config), false);
  rmSync(oldPid);
  prepareStorage(paths, legacy);
  assert.equal(readFileSync(paths.config, 'utf8'), readFileSync(source, 'utf8'));
  assert.equal(existsSync(source), true);
  writeFileSync(paths.config, '新的設定'); prepareStorage(paths, legacy);
  assert.equal(readFileSync(paths.config, 'utf8'), '新的設定', '不覆蓋新設定');
  rmSync(paths.config); prepareStorage(paths, legacy);
  assert.equal(readFileSync(paths.config, 'utf8'), readFileSync(source, 'utf8'), '有來源標記的中斷可重試');
  const invalid = storageLayout(join(root, 'invalid'), { VRM_PET_DATA_DIR: join(root, 'invalid') });
  writeFileSync(source, 'port: bad');
  assert.throws(() => prepareStorage(invalid, legacy), /無效/);
  const now = Date.UTC(2026, 10, 4, 12);
  writeFileSync(join(paths.logs, 'main-2026-10-01.log'), 'old');
  writeFileSync(join(paths.logs, 'main-2026-11-04.log'), 'new');
  writeFileSync(join(paths.logs, 'unrelated.log'), 'keep');
  pruneLogs(paths.logs, now);
  assert.deepEqual(readdirSync(paths.logs).sort(), ['main-2026-11-04.log', 'unrelated.log']);
  const output = join(root, 'history-tests.cjs');
  await build({ entryPoints: ['src/main/historyStore.test.ts'], bundle: true, platform: 'node', outfile: output,
    plugins: [{ name: 'native-sqlite', setup(b) { b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }],
  });
  execFileSync(require('electron'), [output], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  const integration = join(root, 'chat-tests.cjs');
  await build({ entryPoints: ['src/main/chatStorage.test.ts'], bundle: true, platform: 'node', outfile: integration, external: ['electron'],
    plugins: [{ name: 'native-sqlite', setup(b) { b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }],
  });
  const electronEnv = { ...process.env }; delete electronEnv.ELECTRON_RUN_AS_NODE;
  execFileSync(require('electron'), [integration], { env: electronEnv, stdio: 'inherit', timeout: 20000 });
  console.log('通過：worktree／安裝版／覆寫路徑、停止檢查、遷移與重試、保留來源及日誌清理');
} finally { rmSync(root, { recursive: true, force: true }); }
