import { BrowserWindow, app, screen } from 'electron';
import { join } from 'node:path';
import { t } from '../shared/i18n';
import { configureOverlayWindow, overlayPlatformOptions } from './platform';
import { createResourceScope } from './resourceScope';
import type { AppRegistry, PetProfile } from './runtimeTypes';

export interface WindowsDeps {
  readonly selectPet: (id: string) => PetProfile | null;
  readonly registry: AppRegistry;
}

/** windows 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createWindows(deps: WindowsDeps) {
  const scope = createResourceScope();

  let win: BrowserWindow | null = null;

  let settingsWin: BrowserWindow | null = null;

  let controlWin: BrowserWindow | null = null;

  let overlayInteractive = false;

  let overlayInputMode = false;

  function syncOverlayMouseEvents(): void {
    win?.setIgnoreMouseEvents(!(overlayInteractive || overlayInputMode), { forward: true });
  }

  function openSettings(tab: 'light' | 'char' | 'motion' | 'project' = 'light', petId?: string): void {
    if (petId) deps.selectPet(petId);
    // 設定與中控共用管理用途；切換時關閉另一扇，避免兩邊同時佔用桌面。
    if (controlWin && !controlWin.isDestroyed()) controlWin.close();
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('switch-tab', tab);
      settingsWin.webContents.send('selected-pet-apply', deps.registry.selectedPetId);
      settingsWin.show();
      settingsWin.focus();
      return;
    }
    settingsWin = new BrowserWindow({
      width: 480,
      height: 820,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: t('window.settings'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    settingsWin.on('closed', () => (settingsWin = null));
    const dev = process.env['ELECTRON_RENDERER_URL'];
    if (dev) settingsWin.loadURL(`${dev}/settings.html?tab=${tab}`);
    else settingsWin.loadFile(join(__dirname, '../renderer/settings.html'), { query: { tab } });
    app.focus({ steal: true });
  }

  /** 中控面板:多寵狀態總覽、指派任務(綁定/公用池)、佇列撤單、審批代答、沙盒設定分頁、系統操作。
   *  (獨立沙盒視窗已廢棄:沙盒設定併入中控的「沙盒設定」分頁,高風險讀寫通道仍限中控 sender。) */
  function openControlPanel(tab: 'overview' | 'sandbox' = 'overview'): void {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('switch-tab', tab);
      controlWin.show();
      controlWin.focus();
      return;
    }
    controlWin = new BrowserWindow({
      width: 760,
      height: 620,
      minWidth: 560,
      minHeight: 420,
      title: t('window.control'), // 常駐工作視窗:可縮放、不置頂；疊層使用浮動置頂與點擊穿透。
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    controlWin.on('closed', () => (controlWin = null));
    const dev = process.env['ELECTRON_RENDERER_URL'];
    if (dev) controlWin.loadURL(`${dev}/control.html?tab=${tab}`);
    else controlWin.loadFile(join(__dirname, '../renderer/control.html'), { query: { tab } });
    app.focus({ steal: true });
  }

  function createOverlay(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    const display = screen.getPrimaryDisplay();
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      focusable: false,
      ...overlayPlatformOptions(),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    configureOverlayWindow(overlay);
    overlay.webContents.on('console-message', (_event, _level, message) => console.log('[overlay]', message));
    overlay.webContents.on('render-process-gone', (_event, details) => {
      console.log('[main] renderer gone:', details.reason, '→ 強制恢復穿透並重載');
      overlayInteractive = false;
      overlayInputMode = false;
      overlay.setFocusable(false);
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.webContents.reload();
    });
    overlay.on('unresponsive', () => {
      overlayInteractive = false;
      overlayInputMode = false;
      overlay.setFocusable(false);
      overlay.setIgnoreMouseEvents(true, { forward: true });
    });
    const dev = process.env['ELECTRON_RENDERER_URL'];
    if (dev) overlay.loadURL(`${dev}/index.html`);
    else overlay.loadFile(join(__dirname, '../renderer/index.html'));
    win = overlay;
    overlay.on('closed', () => { if (win === overlay) win = null; });
    return overlay;
  }
  function start() {
    if (!scope.start()) return;

  }
  scope.add(() => {
    for (const window of [win, settingsWin, controlWin]) {
      if (window && !window.isDestroyed()) window.destroy();
    }
    win = settingsWin = controlWin = null;
  });
  return {
    get createOverlay() { return createOverlay; },
    get openControlPanel() { return openControlPanel; },
    get openSettings() { return openSettings; },
    get win() { return win; },
    get settingsWin() { return settingsWin; },
    get controlWin() { return controlWin; },
    setInteractive(value: boolean) { overlayInteractive = value; },
    get syncOverlayMouseEvents() { return syncOverlayMouseEvents; },
    setInputMode(value: boolean) { overlayInputMode = value; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Windows = ReturnType<typeof createWindows>;
