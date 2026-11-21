import { app } from 'electron';
import { constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CharacterStore } from './characterStore';
import { createResourceScope } from './resourceScope';
import { runtimeLayout, installRuntimeLogging } from './runtimeStorage';
import { HistoryStore } from './historyStore';
import { legacyDataDir, prepareStorage, pruneLogs } from '../../scripts/storage-layout.mjs';
import type { PetProfile } from './runtimeTypes';

export interface PathsDeps {
  readonly characters: CharacterStore;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
}

/** paths 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createPaths(deps: PathsDeps) {
  const scope = createResourceScope();
  const layout = runtimeLayout();
  const history = new HistoryStore(layout.database);

  const productDataDir = (): string => join(app.getPath('appData'), 'VRM Pet');

  const sharedAssetRoot = (): string => resolve(deps.characters.filePath) === resolve(productDataDir(), 'runtime-data', 'characters.sqlite')
    ? productDataDir() : dirname(deps.characters.filePath);

  const modelsDir = (): string => join(sharedAssetRoot(), 'models');

  const motionsDir = (): string => join(sharedAssetRoot(), 'motions');

  const defaultVrmPath = (): string => join(modelsDir(), 'AvatarSample_A.vrm');

  const runtimeDataDir = (): string => layout.runtime;
  const systemPidPath = (): string => layout.pid;

  /** 兩種版本首次啟動都初始化預設模型；已有檔案時不覆寫。 */
  async function ensureDefaultVrm(): Promise<void> {
    await mkdir(modelsDir(), { recursive: true });
    await mkdir(motionsDir(), { recursive: true });
    // 保留既有模型及角色引用；舊範例只複製，不搬移或覆寫。
    const legacy = join(dirname(deps.characters.filePath), 'assets', 'AvatarSample_A.vrm');
    const bundled = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'models', 'AvatarSample_A.vrm');
    try {
      await copyFile(existsSync(legacy) ? legacy : bundled, defaultVrmPath(), constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /** 地端重啟腳本只需要這份 PID 紀錄；啟動命令固定寫在腳本內。 */
  function writeSystemPidRecord(): void {
    mkdirSync(layout.instance, { recursive: true });
    writeFileSync(systemPidPath(), `${process.pid}\n`);
  }
  function start() {
    if (!scope.start()) return;
    history.initialize();
    scope.add(installRuntimeLogging());
    scope.interval(() => {
      try { history.prune(); pruneLogs(layout.logs); } catch (error) { console.error('[storage] 清理失敗', error); }
    }, 86400000);
    scope.add(() => history.close());
  }
  return {
    get runtimeDataDir() { return runtimeDataDir; },
    get writeSystemPidRecord() { return writeSystemPidRecord; },
    get ensureDefaultVrm() { return ensureDefaultVrm; },
    get defaultVrmPath() { return defaultVrmPath; },
    get modelsDir() { return modelsDir; },
    get history() { return history; },
    get motionsDir() { return motionsDir; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Paths = ReturnType<typeof createPaths>;

export function configureDataPaths(): void {
  const layout = runtimeLayout();
  prepareStorage(layout, app.isPackaged && !process.env['VRM_PET_DATA_DIR'] ? layout.base : legacyDataDir(app.getAppPath()));
  // Chromium 的 userData 也屬於可重建資料，不能與 app.yaml 混在一起。
  mkdirSync(layout.cache, { recursive: true });
  app.setPath('userData', layout.instance);
  app.setPath('sessionData', layout.cache);
}
