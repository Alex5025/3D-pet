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
  sway: number;
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
