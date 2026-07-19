import { contextBridge, ipcRenderer } from 'electron';

const api = {
  setInteractive: (v: boolean) => ipcRenderer.send('set-interactive', v),
  onCursor: (cb: (p: { x: number; y: number }) => void) =>
    ipcRenderer.on('cursor', (_e, p) => cb(p)),
  /** 主行程讀好的 VRM 檔內容(使用者經 Tray/dialog 選的) */
  onVrm: (cb: (buf: ArrayBuffer) => void) =>
    ipcRenderer.on('vrm-buffer', (_e, u8: Uint8Array) =>
      cb(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)
    )
};

contextBridge.exposeInMainWorld('pet', api);

export type PetApi = typeof api;
declare global {
  interface Window {
    pet: PetApi;
  }
}
