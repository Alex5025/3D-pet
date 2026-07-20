import { contextBridge, ipcRenderer } from 'electron';

export interface PetState {
  x: number;
  y: number;
  rotY: number;
  camZ: number;
}

export interface Lighting {
  ambient: number;
  directional: number;
  dirX: number;
  dirY: number;
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

  /** 右鍵選單(原生 Menu 由主行程彈出) */
  showMenu: () => ipcRenderer.send('show-menu'),

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
