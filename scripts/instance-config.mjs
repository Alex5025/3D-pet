import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { dataDir, linkedWorktree, productionDataDir, projectDir, layout } from './data-dir.mjs';

import { legacyDataDir, prepareStorage } from './storage-layout.mjs';

/** 在 Vite 綁定 port 前建立可編輯的啟動設定；此處不讀角色檔。 */
export function configureInstance() {
  const explicitDirectory = !!process.env.VRM_PET_DATA_DIR;
  const directory = dataDir();
  const paths = layout();
  prepareStorage(paths, legacyDataDir(projectDir));
  if (explicitDirectory || linkedWorktree()) process.env.VRM_PET_DATA_DIR = directory;
  if (linkedWorktree() && !explicitDirectory && directory !== productionDataDir()) {
    process.env.VRM_PET_BASELINE_DIR = productionDataDir();
  }
  const runtime = paths.runtime;
  mkdirSync(runtime, { recursive: true });
  const path = join(runtime, 'app.yaml');
  if (!existsSync(path)) {
    try {
      writeFileSync(path, stringify({ schemaVersion: 1, port: 5173, initialized: false, pets: [] }), { encoding: 'utf8', flag: 'wx' });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`啟動設定格式錯誤：${path}`);
  const config = document.toJS({ maxAliasCount: 0 });
  if (!config || ![1, 2, 3].includes(config.schemaVersion) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error(`port 必須是 1024–65535 的整數：${path}`);
  }
  console.log(`[instance] worktree=${projectDir}\ndata=${directory}\nport=${config.port}\nconfig=${path}`);
  return config.port;
}
