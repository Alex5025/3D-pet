import { ipcMain, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

/* 外觀相關的 IPC 註冊(位置/光影/晃動/服裝/頭像/預設姿勢/模型讀檔)。
 * 從 index.ts 的 whenReady 巨型閉包抽出來:這組的依賴最單純——
 * 只要「讀寫某寵的設定」與「推播給哪個視窗」,不碰 agent/佇列/中控那些狀態。
 * 依賴以 deps 傳入而非 import,避免把 index.ts 的模組狀態變成隱性全域。 */

export interface AppearanceIpcDeps<TProfile> {
  /** 目前的疊層視窗(可能尚未建立/已銷毀)。 */
  overlay: () => BrowserWindow | null;
  /** 設定面板視窗。 */
  settings: () => BrowserWindow | null;
  getPet: (id: string) => TProfile | null;
  updatePet: (id: string, patch: Partial<TProfile>) => TProfile | null;
  hasPet: (id: string) => boolean;
  /** 各寵的頭像小圖(renderer 拍好回報,設定面板顯示);記憶體暫存不落盤。 */
  avatarIcons: Map<string, { front: string; side: string }>;
  /** 各寵的服裝材質清單(renderer 解析模型後回報)。 */
  wardrobeLists: Map<string, { key: string; label: string }[]>;
  /** 運行資料根目錄(motions/ 在其下)。 */
  dataDir: () => string;
}

/** 註冊外觀 IPC;回傳 dispose 供測試或熱重載清理(正式流程 app 結束即釋放)。 */
export function registerAppearanceIpc<
  TProfile extends {
    state?: unknown; lighting?: unknown; sway?: unknown;
    wardrobe?: Record<string, boolean>; vrmPath?: string; defaultPose?: string;
  }
>(deps: AppearanceIpcDeps<TProfile>): () => void {
  const { overlay, settings, getPet, updatePet, hasPet, avatarIcons, wardrobeLists, dataDir } = deps;

  ipcMain.handle('get-state', (_event, id: string) => getPet(id)?.state ?? null);
  ipcMain.on('save-state', (event, id: string, state: unknown) => {
    const win = overlay();
    if (!win || event.sender !== win.webContents) return;
    updatePet(id, { state } as Partial<TProfile>);
    settings()?.webContents.send('apply-state', id, state);
  });
  ipcMain.on('set-state', (_event, id: string, state: unknown) => {
    updatePet(id, { state } as Partial<TProfile>);
    overlay()?.webContents.send('apply-state', id, state);
  });

  ipcMain.on('avatar-icons', (event, id: string, icons: { front: string; side: string }) => {
    const win = overlay();
    if (!win || event.sender !== win.webContents || !hasPet(id)) return;
    avatarIcons.set(id, icons);
    settings()?.webContents.send('avatar-icons-apply', id, icons);
  });

  ipcMain.handle('get-lighting', (_event, id: string) => getPet(id)?.lighting ?? null);
  ipcMain.on('set-lighting', (_event, id: string, lighting: unknown) => {
    updatePet(id, { lighting } as Partial<TProfile>);
    overlay()?.webContents.send('apply-lighting', id, lighting);
  });

  ipcMain.handle('get-sway', (_event, id: string) => getPet(id)?.sway ?? null);
  ipcMain.on('set-sway', (_event, id: string, sway: unknown) => {
    updatePet(id, { sway } as Partial<TProfile>);
    overlay()?.webContents.send('apply-sway', id, sway);
  });

  ipcMain.on('wardrobe-list', (event, id: string, list: { key: string; label: string }[]) => {
    const win = overlay();
    if (!win || event.sender !== win.webContents || !hasPet(id)) return;
    wardrobeLists.set(id, list);
    settings()?.webContents.send('wardrobe-list-apply', id, list);
  });
  ipcMain.handle('get-wardrobe', (_event, id: string) => ({
    list: wardrobeLists.get(id) ?? [],
    states: getPet(id)?.wardrobe ?? {}
  }));
  ipcMain.on('set-wardrobe', (_event, id: string, key: string, visible: boolean) => {
    const profile = getPet(id);
    if (!profile) return;
    const states = { ...(profile.wardrobe ?? {}), [key]: visible };
    updatePet(id, { wardrobe: states } as Partial<TProfile>);
    overlay()?.webContents.send('apply-wardrobe', id, states);
  });

  /* VRM 讀檔快取:N 隻寵物用同一個模型檔時開機只讀一次磁碟(VRM 可達十幾 MB)。
   * mtime 變了就重讀;開機潮過後(30s 無新請求)整批釋放,不長駐大 buffer。 */
  const vrmReadCache = new Map<string, { mtimeMs: number; data: Promise<Buffer> }>();
  let vrmCacheSweep: NodeJS.Timeout | null = null;
  ipcMain.handle('get-boot-vrm', async (_event, id: string) => {
    const path = getPet(id)?.vrmPath;
    if (!path) return null;
    try {
      const mtimeMs = (await stat(path)).mtimeMs;
      const hit = vrmReadCache.get(path);
      const entry = hit && hit.mtimeMs === mtimeMs ? hit : { mtimeMs, data: readFile(path) };
      vrmReadCache.set(path, entry);
      if (vrmCacheSweep) clearTimeout(vrmCacheSweep);
      vrmCacheSweep = setTimeout(() => vrmReadCache.clear(), 30_000);
      return await entry.data;
    } catch {
      vrmReadCache.delete(path);
      return null;
    }
  });

  ipcMain.handle('get-default-pose', async (_event, id: string) => {
    const file = getPet(id)?.defaultPose;
    if (!file) return null;
    try {
      return await readFile(join(dataDir(), 'motions', file));
    } catch {
      return null;
    }
  });

  const channels = [
    'get-state', 'save-state', 'set-state', 'avatar-icons',
    'get-lighting', 'set-lighting', 'get-sway', 'set-sway',
    'wardrobe-list', 'get-wardrobe', 'set-wardrobe', 'get-boot-vrm', 'get-default-pose',
  ];
  return () => {
    if (vrmCacheSweep) clearTimeout(vrmCacheSweep);
    vrmReadCache.clear();
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
  };
}
