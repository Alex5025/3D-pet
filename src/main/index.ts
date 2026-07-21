import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

/* ------------------------------------------------------------------ *
 * config.json:{ vrmPath, state: {x, y, rotY, camZ} }
 * ------------------------------------------------------------------ */
/* 開發階段(未打包)資料放專案根目錄,不佔用 ~/Library;
 * 將來真的打包成 .app 再改用系統的 userData 目錄。 */
const dataDir = (): string => (app.isPackaged ? app.getPath('userData') : app.getAppPath());
const configPath = (): string => join(dataDir(), 'config.json');

interface Config {
  vrmPath?: string;
  state?: { x: number; y: number; z: number; rotY: number; camZ: number };
  lighting?: {
    ambient: number;
    directional: number;
    x: number;
    y: number;
    z: number;
    shade: number;
  };
  sway?: { hair: number; cloth: number; chest: number };
  wardrobe?: Record<string, boolean>; // 材質名 → 顯示與否(缺 = 顯示)
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
  const s = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };
  writeConfig({ state: s });
  win?.webContents.send('apply-state', s);
  settingsWin?.webContents.send('apply-state', s);
}

function petMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '選擇 VRM 檔…', click: () => void chooseVrm() },
    { label: '調整燈光…', click: () => openSettings('light') },
    { label: '角色調整…', click: () => openSettings('char') },
    { label: '重置位置與大小', click: resetState },
    { type: 'separator' },
    { label: '結束', click: () => app.exit(0) }
  ]);
}

/* 燈光設定面板:一般可聚焦的小視窗(疊層 focusable:false 塞不了操作 UI),單例 */
let settingsWin: BrowserWindow | null = null;
let avatarIcons: { front: string; side: string } | null = null; // 疊層拍的角色小圖快取
let wardrobeList: { key: string; label: string }[] = []; // 目前模型的服裝材質清單快取

function openSettings(tab: 'light' | 'char' = 'light'): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('switch-tab', tab);
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 380,
    height: 680,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: '燈光設定',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.on('closed', () => (settingsWin = null));
  settingsWin.webContents.on('did-finish-load', () => {
    if (avatarIcons) settingsWin?.webContents.send('avatar-icons-apply', avatarIcons);
  });
  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev) settingsWin.loadURL(`${dev}/settings.html?tab=${tab}`);
  else settingsWin.loadFile(join(__dirname, '../renderer/settings.html'), { query: { tab } });
  app.focus({ steal: true }); // 背景 app 開的視窗會被壓在底下
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

  // 保險絲:renderer 掛掉/無回應時,視窗絕不能停留在「吃掉全螢幕點擊」的狀態
  w.webContents.on('render-process-gone', (_e, d) => {
    console.log('[main] renderer gone:', d.reason, '→ 強制恢復穿透並重載');
    w.setIgnoreMouseEvents(true, { forward: true });
    w.webContents.reload();
  });
  w.on('unresponsive', () => {
    console.log('[main] overlay unresponsive → 強制恢復穿透');
    w.setIgnoreMouseEvents(true, { forward: true });
  });

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
  // 疊層拖曳存檔 → 同步給設定面板(平面墊上的點跟著動)
  ipcMain.on('save-state', (_e, s: Config['state']) => {
    writeConfig({ state: s });
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-state', s);
  });
  // 設定面板改位置 → 存檔 + 疊層即時套用
  ipcMain.on('set-state', (_e, s: Config['state']) => {
    writeConfig({ state: s });
    win?.webContents.send('apply-state', s);
  });

  // 疊層拍的角色小圖:存著,設定面板開啟/重載時補發
  ipcMain.on('avatar-icons', (_e, icons: { front: string; side: string }) => {
    avatarIcons = icons;
    if (settingsWin && !settingsWin.isDestroyed())
      settingsWin.webContents.send('avatar-icons-apply', icons);
  });

  ipcMain.handle('get-lighting', () => readConfig().lighting ?? null);
  ipcMain.on('set-lighting', (_e, l: Config['lighting']) => {
    writeConfig({ lighting: l });
    win?.webContents.send('apply-lighting', l); // 疊層即時套用
  });

  ipcMain.handle('get-sway', () => readConfig().sway ?? null);
  ipcMain.on('set-sway', (_e, s: Config['sway']) => {
    writeConfig({ sway: s });
    win?.webContents.send('apply-sway', s);
  });

  // 服裝顯示:疊層在每次載入後送材質清單;開關狀態存 config、疊層即時套用
  ipcMain.on('wardrobe-list', (_e, list: { key: string; label: string }[]) => {
    wardrobeList = list;
    if (settingsWin && !settingsWin.isDestroyed())
      settingsWin.webContents.send('wardrobe-list-apply', list);
  });
  ipcMain.handle('get-wardrobe', () => ({ list: wardrobeList, states: readConfig().wardrobe ?? {} }));
  ipcMain.on('set-wardrobe', (_e, key: string, visible: boolean) => {
    const states = { ...(readConfig().wardrobe ?? {}), [key]: visible };
    writeConfig({ wardrobe: states });
    win?.webContents.send('apply-wardrobe', states);
  });
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
