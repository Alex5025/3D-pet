import { app } from 'electron';
import { constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CharacterStore, modelHash } from './characterStore';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface PathsDeps {
  readonly characters: CharacterStore;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
}

/** paths 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createPaths(deps: PathsDeps) {
  const scope = createResourceScope();

  /* 開發版與安裝版共用使用者資料；測試可用 VRM_PET_DATA_DIR 隔離。 */
  const dataDir = (): string => app.getPath('userData');

  const productDataDir = (): string => join(app.getPath('appData'), 'VRM Pet');

  const sharedAssetRoot = (): string => resolve(deps.characters.filePath) === resolve(productDataDir(), 'runtime-data', 'characters.yaml')
    ? productDataDir() : dirname(deps.characters.filePath);

  const modelsDir = (): string => join(sharedAssetRoot(), 'models');

  const motionsDir = (): string => join(sharedAssetRoot(), 'motions');

  const defaultVrmPath = (): string => join(modelsDir(), 'AvatarSample_A.vrm');

  const runtimeDataDir = (): string => join(dataDir(), 'runtime-data');

  const transcriptsDir = (): string => join(runtimeDataDir(), 'transcripts');

  const transcriptPath = (id: string, workspace = deps.getPet(id)?.workspacePath ?? ''): string => join(transcriptsDir(), `${modelHash(Buffer.from(JSON.stringify([id, workspace])))}.json`);

  const systemPidPath = (): string => join(runtimeDataDir(), 'pet-system.pid');

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
    mkdirSync(runtimeDataDir(), { recursive: true });
    writeFileSync(systemPidPath(), `${process.pid}\n`);
  }
  function start() {
    if (!scope.start()) return;

  }
  return {
    get dataDir() { return dataDir; },
    get runtimeDataDir() { return runtimeDataDir; },
    get writeSystemPidRecord() { return writeSystemPidRecord; },
    get ensureDefaultVrm() { return ensureDefaultVrm; },
    get defaultVrmPath() { return defaultVrmPath; },
    get modelsDir() { return modelsDir; },
    get transcriptsDir() { return transcriptsDir; },
    get transcriptPath() { return transcriptPath; },
    get motionsDir() { return motionsDir; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Paths = ReturnType<typeof createPaths>;

export function configureDataPaths(): void {
  // 固定產品目錄，避免開發版套件名稱與安裝版產品名稱造成兩份資料。
  const userDataDir = process.env['VRM_PET_DATA_DIR']
    ? resolve(process.env['VRM_PET_DATA_DIR'])
    : join(app.getPath('appData'), 'VRM Pet');
  mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  // Chromium 快取與使用者設定分開；開發實例的快取仍保持隔離。
  const sessionDataDir = process.env['VRM_PET_DATA_DIR']
    ? join(userDataDir, 'Cache')
    : process.platform === 'win32'
      ? join(process.env['LOCALAPPDATA'] || join(app.getPath('home'), 'AppData', 'Local'), 'VRM Pet', 'Cache')
      : join(userDataDir, 'Cache');
  mkdirSync(sessionDataDir, { recursive: true });
  app.setPath('sessionData', sessionDataDir);

}
