import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, unlinkSync, constants, renameSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { parseDocument } from 'yaml';

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export function productionDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'VRM Pet');
  return join(platform === 'darwin' ? join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || join(home, '.config'), 'VRM Pet');
}
export function isWorktree(root) {
  try { return statSync(join(root, '.git')).isFile(); } catch { return false; }
}
export function storageLayout(root, env = process.env, packaged = false, platform = process.platform, home = homedir()) {
  const worktree = !packaged && isWorktree(root);
  // 舊版 Tray 重啟會繼承 Vite 自動設定的 /tmp 根目錄；辨識該預設值並遷到工作樹。
  const inheritedLegacy = worktree && env.VRM_PET_DATA_DIR
    && resolve(env.VRM_PET_DATA_DIR) === resolve(legacyDataDir(root, { ...env, VRM_PET_DATA_DIR: undefined }, platform));
  const local = !!env.VRM_PET_DATA_DIR || worktree;
  const base = env.VRM_PET_DATA_DIR && !inheritedLegacy ? resolve(env.VRM_PET_DATA_DIR) : local ? resolve(root) : productionDataDir(env, platform, home);
  const runtime = join(base, local ? 'runtime_data' : 'runtime-data');
  const instance = join(base, '3D-pet', 'instances');
  return { base, runtime, instance, config: join(runtime, 'app.yaml'), database: join(runtime, 'history.sqlite'),
    logs: join(instance, 'logs'), pid: join(instance, 'pet-system.pid'), cache: join(instance, 'Cache'), temp: join(instance, 'temp') };
}
export function legacyDataDir(root, env = process.env, platform = process.platform) {
  if (env.VRM_PET_DATA_DIR) return resolve(env.VRM_PET_DATA_DIR);
  if (!isWorktree(root)) return productionDataDir(env, platform);
  const key = createHash('sha256').update(realpathSync(root)).digest('hex');
  return platform === 'win32' ? win32.join(env.TEMP || env.TMP || tmpdir(), '3D-pet', 'instances', key) : join('/tmp/3D-pet/instances', key);
}
export function assertStopped(pidPath) {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw new Error(`實例仍在執行（PID ${pid}），請先結束：${pidPath}`);
}
function validateConfig(path) {
  const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`遷移來源 YAML 無效：${path}`);
  const value = document.toJS({ maxAliasCount: 0 });
  if (![1, 2].includes(value?.schemaVersion) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !Array.isArray(value.pets)) throw new Error(`遷移來源設定無效：${path}`);
}
/** 發布前先寫來源標記；重試不覆蓋新設定，對話匯入由 SQLite 記錄去重。 */
export function prepareStorage(layout, legacy, now = Date.now()) {
  mkdirSync(layout.runtime, { recursive: true });
  for (const dir of [layout.logs, layout.temp, layout.cache]) mkdirSync(dir, { recursive: true });
  const source = join(legacy, 'runtime-data');
  const oldConfig = join(source, 'app.yaml');
  const marker = join(layout.runtime, 'migration-source.json');
  if (resolve(source) !== resolve(layout.runtime) && !existsSync(layout.config) && existsSync(oldConfig)) {
    assertStopped(join(source, 'pet-system.pid'));
    validateConfig(oldConfig);
    // 已有 marker 必須與來源一致，避免重試時混用另一實例。
    if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).source !== source) throw new Error('遷移來源與既有紀錄不符');
    writeFileSync(marker, JSON.stringify({ source }), 'utf8');
    const staging = `${layout.config}.migration`;
    copyFileSync(oldConfig, staging);
    validateConfig(staging);
    renameSync(staging, layout.config);
  }
  if (existsSync(marker)) {
    const savedSource = JSON.parse(readFileSync(marker, 'utf8')).source;
    for (const file of existsSync(savedSource) ? readdirSync(savedSource) : []) {
      if (!/^pet-system(?:-restart)?\.log$/.test(file)) continue;
      const path = join(savedSource, file);
      const modified = statSync(path).mtimeMs;
      if (modified < now - RETENTION_MS) continue;
      const target = join(layout.logs, `legacy-${file.slice(0, -4)}-${new Date(modified).toISOString().slice(0, 10)}.log`);
      if (!existsSync(target)) copyFileSync(path, target, constants.COPYFILE_EXCL);
    }
  }
  pruneLogs(layout.logs, now);
}
export function pruneLogs(directory, now = Date.now()) {
  if (!existsSync(directory)) return;
  for (const file of readdirSync(directory)) {
    const match = /^(?:main|launcher|restart|legacy-pet-system(?:-restart)?)-(\d{4}-\d{2}-\d{2})\.log$/.exec(file);
    // 當日日誌以 UTC 日界判定；不碰未知檔案。
    if (match && Date.parse(`${match[1]}T00:00:00Z`) + 86400000 <= now - RETENTION_MS) unlinkSync(join(directory, file));
  }
}
