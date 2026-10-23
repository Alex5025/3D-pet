import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 啟動腳本與 Electron 主程序使用相同的產品目錄。 */
export function dataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.VRM_PET_DATA_DIR) return resolve(env.VRM_PET_DATA_DIR);
  const appData = platform === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config');
  return join(appData, 'VRM Pet');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 相對覆寫路徑一律以專案為基準，和 npm run dev 的工作目錄一致。
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(dataDir());
}
