import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

/* ------------------------------------------------------------------ *
 * config.json:{ vrmPath, state: {x, y, rotY, camZ} }
 * ------------------------------------------------------------------ */
const configPath = (): string => join(app.getPath('userData'), 'config.json');

interface Config {
  vrmPath?: string;
  state?: { x: number; y: number; rotY: number; camZ: number };
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch: Partial<Config>): void {
  try {
    writeFileSync(configPath(), JSON.stringify({ ...readConfig(), ...patch }));
  } catch (e) {
    console.log('[main] writeConfig failed', e);
  }
}

/** 把一個 .vrm 檔讀進來推給 renderer(renderer 用官方 parse 路徑載入) */
function pushVrm(path: string): void {
  try {
    win?.webContents.send('vrm-buffer', readFileSync(path));
    writeConfig({ vrmPath: path });
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

/** 重置位置/角度/縮放(不動已選的 VRM) */
function resetState(): void {
  const s = { x: 0, y: 0, rotY: 0, camZ: 5 };
  writeConfig({ state: s });
  win?.webContents.send('apply-state', s);
}

function petMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '選擇 VRM 檔…', click: () => void chooseVrm() },
    { label: '重置位置與大小', click: resetState },
    { type: 'separator' },
    { label: '結束', click: () => app.exit(0) }
  ]);
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
    focusable: false, // 不搶焦點
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

  // 開機:之前選過的 VRM 載完推過去(位置狀態由 renderer 主動 get-state)
  w.webContents.on('did-finish-load', () => {
    const p = readConfig().vrmPath;
    if (p && existsSync(p)) pushVrm(p);
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

  ipcMain.handle('get-state', () => readConfig().state ?? null);
  ipcMain.on('save-state', (_e, s: Config['state']) => writeConfig({ state: s }));
  ipcMain.on('show-menu', () => {
    if (win) petMenu().popup({ window: win });
  });

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
  tray.setContextMenu(petMenu());
});

app.on('window-all-closed', () => {
  /* 常駐 */
});
