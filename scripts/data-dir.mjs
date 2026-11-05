import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageLayout, isWorktree, productionDataDir } from './storage-layout.mjs';
export { productionDataDir };
export const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const linkedWorktree = () => isWorktree(projectDir);
export const layout = (env = process.env) => storageLayout(projectDir, env);
export const dataDir = (env = process.env, platform = process.platform, home) => storageLayout(projectDir, env, false, platform, home).base;
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const paths = layout();
  const field = process.argv[2] || 'base';
  if (!(field in paths)) throw new Error(`未知路徑：${field}`);
  console.log(paths[field]);
}
