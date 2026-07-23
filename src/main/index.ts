import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, watch } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';

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

/* config 以記憶體為單一真相:啟動同步讀一次,之後 setter 只改記憶體、debounce 非同步落盤。
 * 設定面板滑桿的 input 事件每秒數十發,原本每發都 readFileSync+writeFileSync,
 * 會與 30ms 游標輪詢、所有 IPC 搶同一條主執行緒(拖滑桿時輪詢卡頓)。 */
let config: Config = {};
let configFlush: NodeJS.Timeout | null = null;

function loadConfigSync(): void {
  try {
    config = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    config = {};
  }
}

function writeConfig(patch: Partial<Config>): void {
  Object.assign(config, patch);
  if (configFlush) clearTimeout(configFlush);
  configFlush = setTimeout(() => {
    configFlush = null;
    writeFile(configPath(), JSON.stringify(config)).catch((e) =>
      console.log('[main] config flush failed', e)
    );
  }, 500);
}

/** 退出前保底落盤:Tray「結束」走 app.exit,不觸發 before-quit,要自己先呼叫 */
function flushConfigSync(): void {
  if (configFlush) {
    clearTimeout(configFlush);
    configFlush = null;
  }
  try {
    writeFileSync(configPath(), JSON.stringify(config));
  } catch (e) {
    console.log('[main] flushConfig failed', e);
  }
}

/** 把一個 .vrm 檔讀進來推給 renderer(renderer 用官方 parse 路徑載入)。
 *  非同步讀:14MB 的檔用 readFileSync 會凍結整個主行程(游標輪詢、IPC 全停)。 */
async function pushVrm(path: string): Promise<void> {
  try {
    const buf = await readFile(path);
    win?.webContents.send('vrm-buffer', buf);
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
  if (!r.canceled && r.filePaths[0]) await pushVrm(r.filePaths[0]);
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

/* motions/ 檔名快取:啟動掃一次 + fs.watch 監看變動,開選單不再每次同步掃磁碟兩輪。
 * show-menu 的 popup 前也會刷新一次(雙保險,丟新檔進去就會出現)。 */
let motionFiles: string[] = [];
let motionsDirMissing = false;

async function refreshMotions(): Promise<void> {
  try {
    motionFiles = (await readdir(join(dataDir(), 'motions')))
      .filter((f) => f.toLowerCase().endsWith('.vrma'))
      .sort();
    motionsDirMissing = false;
  } catch {
    motionFiles = [];
    motionsDirMissing = true;
  }
}

/** motions/ 裡的 .vrma 生成子選單(讀快取,純函式) */
function motionMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (motionsDirMissing) return [{ label: '(找不到 motions 資料夾)', enabled: false }];
  if (!motionFiles.length) return [{ label: '(motions 資料夾裡沒有 .vrma 檔)', enabled: false }];
  const dir = join(dataDir(), 'motions');
  return motionFiles.map((f) => ({
    label: f.replace(/\.vrma$/i, ''),
    click: async () => {
      try {
        win?.webContents.send('vrma-play', await readFile(join(dir, f)));
      } catch (e) {
        console.log('[main] vrma read failed', e);
      }
    }
  }));
}

/** 預設姿勢子選單:radio 標記目前選擇;點選即存檔並立刻示範播放 */
function defaultPoseMenuItems(): Electron.MenuItemConstructorOptions[] {
  const dir = join(dataDir(), 'motions');
  const current = config.defaultPose;
  const none: Electron.MenuItemConstructorOptions = {
    label: '(無)',
    type: 'radio',
    checked: !current,
    click: () => {
      writeConfig({ defaultPose: undefined });
      refreshTray();
    }
  };
  if (motionsDirMissing) return [none];
  return [
    none,
    ...motionFiles.map((f): Electron.MenuItemConstructorOptions => ({
      label: f.replace(/\.vrma$/i, ''),
      type: 'radio',
      checked: f === current,
      click: async () => {
        writeConfig({ defaultPose: f });
        refreshTray();
        try {
          win?.webContents.send('vrma-play', await readFile(join(dir, f))); // 立刻示範
        } catch (e) {
          console.log('[main] default pose read failed', e);
        }
      }
    }))
  ];
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
    { label: '結束', click: () => { flushConfigSync(); app.exit(0); } } // app.exit 不走 before-quit,先落盤
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

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();

  loadConfigSync(); // 之後 config 全在記憶體,IPC handler 不再碰磁碟
  await refreshMotions();
  try {
    // motions/ 變動時自動更新快取與 Tray 選單;資料夾不存在時 watch 會丟錯,清單維持空
    watch(join(dataDir(), 'motions'), () => {
      void refreshMotions().then(refreshTray);
    });
  } catch {
    /* 沒有 motions 資料夾:選單顯示「找不到」,丟了資料夾進來後靠 show-menu 前的刷新補上 */
  }

  win = createOverlay();

  ipcMain.on('set-interactive', (_e, v: boolean) =>
    win?.setIgnoreMouseEvents(!v, { forward: true })
  );

  ipcMain.handle('get-state', () => config.state ?? null);
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

  ipcMain.handle('get-lighting', () => config.lighting ?? null);
  ipcMain.on('set-lighting', (_e, l: Config['lighting']) => {
    writeConfig({ lighting: l });
    win?.webContents.send('apply-lighting', l); // 疊層即時套用
  });

  // 開機模型:config 指定且讀得到 → 回它的 buffer;否則 null = 用內建預設。
  // 單一載入路徑,杜絕「預設與推播並行」的完成順序競態(code review R1)。
  // 非同步讀:開機時輪詢已在跑,同步讀 14MB 會凍結主行程。
  ipcMain.handle('get-boot-vrm', async () => {
    const p = config.vrmPath;
    if (!p) return null;
    try {
      return await readFile(p); // 讀失敗(檔被移走等)= 回 null,免掉 existsSync 的多一次同步 stat
    } catch {
      return null;
    }
  });

  // 預設姿勢:renderer 每次模型載入完來要,讀得到才回 buffer
  ipcMain.handle('get-default-pose', async () => {
    const f = config.defaultPose;
    if (!f) return null;
    try {
      return await readFile(join(dataDir(), 'motions', f));
    } catch {
      return null;
    }
  });

  ipcMain.handle('get-sway', () => config.sway ?? null);
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
  ipcMain.handle('get-wardrobe', () => ({ list: wardrobeList, states: config.wardrobe ?? {} }));
  ipcMain.on('set-wardrobe', (_e, key: string, visible: boolean) => {
    const states = { ...(config.wardrobe ?? {}), [key]: visible };
    writeConfig({ wardrobe: states });
    win?.webContents.send('apply-wardrobe', states);
  });
  ipcMain.on('show-menu', () => {
    // popup 版每次重建選單:popup 前刷新 motions 快取,新丟進來的檔一定看得到
    void refreshMotions().then(() => {
      if (win) petMenu().popup({ window: win });
    });
  });

  /* click-through 視窗在 macOS 收不到被動 mousemove(實證),主行程輪詢游標推給 renderer。
   * 降本:
   *  - bounds 快取:疊層 movable:false,只在螢幕配置變更時會變,不必每 tick getBounds
   *  - 座標未變不 send(游標靜止時省掉 renderer 整條 raycast + 讀 alpha 命中鏈)——
   *    但每 ~1 秒仍送一次心跳:renderer 的拖曳看門狗靠 onCursor 觸發,完全去重會餓死它
   *    (旗標卡住 → 疊層吃掉全桌面點擊,實際發生過的事故)
   *  - did-finish-load 後才啟動,不對還沒掛好監聽的頁面白送 */
  let overlayBounds = win.getBounds();
  screen.on('display-metrics-changed', () => {
    if (win && !win.isDestroyed()) overlayBounds = win.getBounds();
  });
  let cursorTimer: NodeJS.Timeout | null = null;
  let lastCx = -1e9;
  let lastCy = -1e9;
  let sameCount = 0;
  const startCursorPolling = (): void => {
    if (cursorTimer) clearInterval(cursorTimer); // renderer 崩潰重載會再進 did-finish-load,防雙 timer
    cursorTimer = setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      if (p.x === lastCx && p.y === lastCy && ++sameCount < 33) return;
      sameCount = 0;
      lastCx = p.x;
      lastCy = p.y;
      win.webContents.send('cursor', { x: p.x - overlayBounds.x, y: p.y - overlayBounds.y });
    }, 30);
  };
  win.webContents.on('did-finish-load', startCursorPolling);

  const icon = nativeImage.createFromDataURL(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('VRM 桌寵');
  tray.setContextMenu(petMenu());
});

app.on('window-all-closed', () => {
  /* 常駐 */
});

app.on('before-quit', flushConfigSync); // cmd-Q 等其他退出路徑的落盤保底
