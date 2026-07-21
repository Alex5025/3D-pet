import { contextBridge, ipcRenderer } from 'electron';

export interface PetState {
  x: number;
  y: number;
  z: number;
  rotY: number;
  camZ: number;
}

export interface Lighting {
  ambient: number;
  directional: number;
  x: number;
  y: number;
  z: number;
  shade: number;
}

export interface Sway {
  hair: number;
  cloth: number;
  chest: number;
}

export interface WardrobeItem {
  key: string; // 材質名(唯一鍵)
  label: string; // 顯示名
}

const api = {
  setInteractive: (v: boolean) => ipcRenderer.send('set-interactive', v),
  onCursor: (cb: (p: { x: number; y: number }) => void) =>
    ipcRenderer.on('cursor', (_e, p) => cb(p)),

  /** 主行程讀好的 VRM 檔內容(使用者經 Tray/選單/dialog 選的) */
  onVrm: (cb: (buf: ArrayBuffer) => void) =>
    ipcRenderer.on('vrm-buffer', (_e, u8: Uint8Array) =>
      cb(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)
    ),

  /* 位置/角度/縮放的持久化 */
  getState: (): Promise<Partial<PetState> | null> => ipcRenderer.invoke('get-state'),
  saveState: (s: PetState) => ipcRenderer.send('save-state', s),
  onState: (cb: (s: Partial<PetState>) => void) =>
    ipcRenderer.on('apply-state', (_e, s) => cb(s)),
  /** 設定面板改角色位置:main 存檔 + 轉發疊層即時套用 */
  setPetState: (s: PetState) => ipcRenderer.send('set-state', s),

  /** 右鍵選單(原生 Menu 由主行程彈出) */
  showMenu: () => ipcRenderer.send('show-menu'),

  /* 角色:晃動強度(設定面板 ↔ main ↔ 疊層) */
  getSway: (): Promise<Partial<Sway> | null> => ipcRenderer.invoke('get-sway'),
  setSway: (s: Sway) => ipcRenderer.send('set-sway', s),
  onSway: (cb: (s: Partial<Sway>) => void) => ipcRenderer.on('apply-sway', (_e, s) => cb(s)),

  /* 服裝顯示:疊層送清單,面板開關,狀態存 config */
  sendWardrobeList: (list: WardrobeItem[]) => ipcRenderer.send('wardrobe-list', list),
  getWardrobe: (): Promise<{ list: WardrobeItem[]; states: Record<string, boolean> }> =>
    ipcRenderer.invoke('get-wardrobe'),
  setWardrobe: (key: string, visible: boolean) => ipcRenderer.send('set-wardrobe', key, visible),
  onWardrobe: (cb: (states: Record<string, boolean>) => void) =>
    ipcRenderer.on('apply-wardrobe', (_e, s) => cb(s)),
  onWardrobeList: (cb: (list: WardrobeItem[]) => void) =>
    ipcRenderer.on('wardrobe-list-apply', (_e, l) => cb(l)),

  /* 角色小圖:疊層拍好送 main,設定面板拿來當原點小人 */
  sendAvatarIcons: (icons: { front: string; side: string }) =>
    ipcRenderer.send('avatar-icons', icons),
  onAvatarIcons: (cb: (icons: { front: string; side: string }) => void) =>
    ipcRenderer.on('avatar-icons-apply', (_e, icons) => cb(icons)),

  /* 燈光:設定面板 ↔ main ↔ 疊層 */
  getLighting: (): Promise<Partial<Lighting> | null> => ipcRenderer.invoke('get-lighting'),
  setLighting: (l: Lighting) => ipcRenderer.send('set-lighting', l),
  onLighting: (cb: (l: Partial<Lighting>) => void) =>
    ipcRenderer.on('apply-lighting', (_e, l) => cb(l))
};

contextBridge.exposeInMainWorld('pet', api);

export type PetApi = typeof api;
declare global {
  interface Window {
    pet: PetApi;
  }
}
