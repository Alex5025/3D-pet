import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 啟動腳本與 Electron 主程序使用相同的產品目錄。 */
export const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function linkedWorktree() {
  try { return statSync(join(projectDir, '.git')).isFile(); } catch { return false; }
}

export function dataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.VRM_PET_DATA_DIR) return resolve(env.VRM_PET_DATA_DIR);
  if (linkedWorktree()) {
    const key = createHash('sha256').update(realpathSync(projectDir)).digest('hex');
    return join('/tmp/3D-pet/instances', key);
  }
  return productionDataDir(env, platform, home);
}

export function productionDataDir(env = process.env, platform = process.platform, home = homedir()) {
  const appData = platform === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config');
  return join(appData, 'VRM Pet');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // 相對覆寫路徑一律以專案為基準，和 npm run dev 的工作目錄一致。
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(dataDir());
}
