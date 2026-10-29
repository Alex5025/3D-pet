import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { AppDialogOptions } from '../renderer/appDialog';

/** 主程序提示框使用同一套 HTML 元件,回覆僅接受該提示視窗。 */
export function appPrompt(options: AppDialogOptions): Promise<{ response: number }> {
  return new Promise((resolve) => {
    const prompt = new BrowserWindow({
      width: 480, height: 320, frame: false, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    let response = options.cancelId;
    const onResponse = (event: Electron.IpcMainEvent, value: unknown): void => {
      if (event.sender !== prompt.webContents || typeof value !== 'number'
        || !Number.isInteger(value) || value < 0 || value >= options.buttons.length) return;
      response = value;
      prompt.close();
    };
    ipcMain.on('app-prompt-response', onResponse);
    prompt.once('closed', () => {
      ipcMain.removeListener('app-prompt-response', onResponse);
      resolve({ response });
    });
    prompt.once('ready-to-show', () => { app.focus({ steal: true }); prompt.show(); prompt.focus(); });
    const query = { options: JSON.stringify(options) };
    const dev = process.env['ELECTRON_RENDERER_URL'];
    const loading = dev
      ? prompt.loadURL(`${dev}/prompt.html?${new URLSearchParams(query)}`)
      : prompt.loadFile(join(__dirname, '../renderer/prompt.html'), { query });
    void loading.catch(() => { if (!prompt.isDestroyed()) prompt.close(); });
  });
}
