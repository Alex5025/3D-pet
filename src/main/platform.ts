import { app, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import { join } from 'node:path';

export interface PlatformCapabilities {
  platform: NodeJS.Platform;
  globalFileDrag: boolean;
  visibleOnAllWorkspaces: boolean;
}

export const platformCapabilities: PlatformCapabilities = {
  platform: process.platform,
  globalFileDrag: process.platform === 'darwin',
  visibleOnAllWorkspaces: process.platform === 'darwin',
};

/** 外部 Node/CLI 必須讀實體檔，不能指向 packaged app 的 asar 內部。 */
export function helperScriptPath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'agent-helpers', file)
    : join(app.getAppPath(), 'src/main/agent', file);
}

/** node:net 在 Windows 使用 named pipe；Unix 平台使用一般 socket 檔。 */
export function localSocketPath(name: string, unixDirectory: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\vrm-pet-${name}`
    : join(unixDirectory, 's');
}

export function overlayPlatformOptions(): Partial<BrowserWindowConstructorOptions> {
  return process.platform === 'darwin' ? { type: 'panel' } : {};
}

export function configureOverlayWindow(window: BrowserWindow): void {
  // 桌寵只需高於一般視窗；不可使用 screen-saver 層干擾其他應用程式的彈出選單。
  window.setAlwaysOnTop(true, 'floating');
  if (platformCapabilities.visibleOnAllWorkspaces) {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  window.setIgnoreMouseEvents(true, { forward: true });
}
