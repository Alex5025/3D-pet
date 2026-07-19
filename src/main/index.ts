import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

const configPath = (): string => join(app.getPath('userData'), 'config.json');

function savedVrmPath(): string | null {
  try {
    const c = JSON.parse(readFileSync(configPath(), 'utf8'));
    return typeof c.vrmPath === 'string' && existsSync(c.vrmPath) ? c.vrmPath : null;
  } catch {
    return null;
  }
}

/** 把一個 .vrm 檔讀進來推給 renderer(renderer 用官方 parse 路徑載入) */
function pushVrm(path: string): void {
  try {
    win?.webContents.send('vrm-buffer', readFileSync(path));
    writeFileSync(configPath(), JSON.stringify({ vrmPath: path }));
  } catch (e) {
    console.log('[main] pushVrm failed', e);
  }
}

async function chooseVrm(): Promise<void> {
  app.focus({ steal: true }); // 背景 app 的 dialog 會被壓在底下,先帶到前景
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'VRM', extensions: ['vrm'] }]
  });
  if (!r.canceled && r.filePaths[0]) pushVrm(r.filePaths[0]);
}

function createOverlay(): BrowserWindow {
  const d = screen.getPrimaryDisplay();
  const w = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    focusable: false, // 不搶焦點;要打字的功能日後再議
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setIgnoreMouseEvents(true, { forward: true }); // 預設整片穿透

  // renderer console 轉發到終端機,疊層開不了 DevTools 也看得到
  w.webContents.on('console-message', (_e, _l, m) => console.log('[overlay]', m));

  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev) w.loadURL(`${dev}/index.html`);
  else w.loadFile(join(__dirname, '../renderer/index.html'));

  // 開機時若之前選過 VRM,載入完成後推過去
  w.webContents.on('did-finish-load', () => {
    const p = savedVrmPath();
    if (p) pushVrm(p);
  });
  return w;
}

/** 16x16 圓角方塊剪影;沒有圖的 Tray 在選單列上是隱形的 */
const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZklEQVR4nGNgoAFQAOIEIJ4PxPeheD5UTAGfRpiG/wQwzEAMQIxmZEMwnE2sZhhG8U4CGQYkoPufVANQwoEU/2MNB4oNoNgLFAeiAhkGKDCgAYoSEiwciDHkPrr/0YECA5mZiSwAANJTnOH5R44LAAAAAElFTkSuQmCC';

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();

  win = createOverlay();

  ipcMain.on('set-interactive', (_e, v: boolean) =>
    win?.setIgnoreMouseEvents(!v, { forward: true })
  );

  // click-through 視窗在 macOS 收不到被動 mousemove(實證),主行程輪詢游標推給 renderer
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 30);

  const icon = nativeImage.createFromDataURL(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('VRM 桌寵');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '選擇 VRM 檔…', click: () => void chooseVrm() },
      { type: 'separator' },
      { label: '結束', click: () => app.exit(0) }
    ])
  );
});

app.on('window-all-closed', () => {
  /* 常駐 */
});
