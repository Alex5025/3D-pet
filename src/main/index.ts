import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

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
    type: 'directional' | 'point';
    ambient: number;
    directional: number;
    x: number;
    y: number;
    z: number;
    shade: number;
  };
  sway?: { hair: number; cloth: number; chest: number; tail: number };
  wardrobe?: Record<string, boolean>; // 材質名 → 顯示與否(缺 = 顯示)
  defaultPose?: string; // motions/ 內的 .vrma 檔名:模型載入後自動播一次
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

/** Tray 的選單是建構時的快照,狀態變了要重建才會反映(popup 版每次重建、無此問題) */
function refreshTray(): void {
  tray?.setContextMenu(petMenu());
}

/** motions/ 資料夾裡的 .vrma 動態生成子選單(每次開選單都重掃,丟新檔進去就會出現) */
function motionMenuItems(): Electron.MenuItemConstructorOptions[] {
  const dir = join(dataDir(), 'motions');
  try {
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.vrma'))
      .sort();
    if (!files.length) return [{ label: '(motions 資料夾裡沒有 .vrma 檔)', enabled: false }];
    return files.map((f) => ({
      label: f.replace(/\.vrma$/i, ''),
      click: () => {
        try {
          win?.webContents.send('vrma-play', readFileSync(join(dir, f)));
        } catch (e) {
          console.log('[main] vrma read failed', e);
        }
      }
    }));
  } catch {
    return [{ label: '(找不到 motions 資料夾)', enabled: false }];
  }
}

/** 預設姿勢子選單:radio 標記目前選擇;點選即存檔並立刻示範播放 */
function defaultPoseMenuItems(): Electron.MenuItemConstructorOptions[] {
  const dir = join(dataDir(), 'motions');
  const current = readConfig().defaultPose;
  const none: Electron.MenuItemConstructorOptions = {
    label: '(無)',
    type: 'radio',
    checked: !current,
    click: () => {
      writeConfig({ defaultPose: undefined });
      refreshTray();
    }
  };
  try {
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.vrma'))
      .sort();
    return [
      none,
      ...files.map((f): Electron.MenuItemConstructorOptions => ({
        label: f.replace(/\.vrma$/i, ''),
        type: 'radio',
        checked: f === current,
        click: () => {
          writeConfig({ defaultPose: f });
          refreshTray();
          try {
            win?.webContents.send('vrma-play', readFileSync(join(dir, f))); // 立刻示範
          } catch (e) {
            console.log('[main] default pose read failed', e);
          }
        }
      }))
    ];
  } catch {
    return [none];
  }
}

function petMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '選擇 VRM 檔…', click: () => void chooseVrm() },
    { label: '播放動作', submenu: motionMenuItems() },
    { label: '預設姿勢', submenu: defaultPoseMenuItems() },
    { label: '停止動作', click: () => win?.webContents.send('vrma-stop') },
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
    width: 460,
    height: 770,
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

  // 開機模型由 renderer 主動來要(get-boot-vrm),不在這裡推——
  // 「先載預設再被推播蓋掉」曾造成雙載入與完成順序競態(code review R1)。
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

  // 開機模型:config 指定且存在 → 回它的 buffer;否則 null = 用內建預設。
  // 單一載入路徑,杜絕「預設與推播並行」的完成順序競態(code review R1)。
  ipcMain.handle('get-boot-vrm', () => {
    const p = readConfig().vrmPath;
    try {
      return p && existsSync(p) ? readFileSync(p) : null;
    } catch {
      return null;
    }
  });

  // 預設姿勢:renderer 每次模型載入完來要,存在才回 buffer
  ipcMain.handle('get-default-pose', () => {
    const f = readConfig().defaultPose;
    if (!f) return null;
    const p = join(dataDir(), 'motions', f);
    try {
      return existsSync(p) ? readFileSync(p) : null;
    } catch {
      return null;
    }
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
