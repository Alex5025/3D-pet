import { app, BrowserWindow, ipcMain, powerMonitor, screen, Tray, Menu, nativeImage, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { AgentBinding, AgentEvent } from '../shared/agentEvents';
import type { AgentBridge } from './agent/bridge';
import { createAgentBridge } from './agent/bridge';
import { PET_EXPRESSIONS, createPetToolsHub } from './agent/petToolsHub';
import type { PetToolsHub } from './agent/petToolsHub';
import { createProviders } from './agent/providers';
import { runAgentSelftest, runClaudeE2E, runCodexE2E } from './agent/selftest';

interface PetState {
  x: number;
  y: number;
  z: number;
  rotY: number;
  camZ: number;
}

interface Lighting {
  type: 'directional' | 'point';
  ambient: number;
  directional: number;
  x: number;
  y: number;
  z: number;
  shade: number;
}

interface Sway {
  hair: number;
  cloth: number;
  chest: number;
  tail: number;
}

interface PetProfile {
  id: string;
  name: string;
  enabled: boolean;
  workspacePath?: string;
  /** 舊欄位,已遷移為 agent(保留不刪,循遷移慣例)。 */
  codexSessionId?: string;
  agent?: AgentBinding;
  /** 角色個性設定(自由文字):注入 agent 對話的 system prompt;v3 的表演風格也會用它。 */
  persona?: string;
  vrmPath?: string;
  state?: PetState;
  lighting?: Lighting;
  sway?: Sway;
  wardrobe?: Record<string, boolean>;
  defaultPose?: string;
  /** 待機動作(motions/ 檔名):以隨機間隔從中挑一個播放。 */
  idleMotions?: string[];
}

interface AppRegistry {
  schemaVersion: 2;
  selectedPetId: string;
  petIds: string[];
}

type LegacyConfig = Omit<PetProfile, 'id' | 'name' | 'enabled'> & {
  schemaVersion?: number;
  selectedPetId?: string;
  pets?: PetProfile[];
};

const DEFAULT_STATE: PetState = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;
let overlayInteractive = false;
let overlayInputMode = false;
let registry: AppRegistry;
const pets = new Map<string, PetProfile>();
const avatarIcons = new Map<string, { front: string; side: string }>();
const wardrobeLists = new Map<string, { key: string; label: string }[]>();
let configFlush: NodeJS.Timeout | null = null;
let bridge: AgentBridge | null = null;
let petToolsHub: PetToolsHub | null = null;
let motionsWatcher: FSWatcher | null = null;
/** 游標輪詢重算(功率檔位區塊注入):寵物啟用狀態變更時呼叫,全休息 = 停輪詢。 */
let refreshCursorPollHook: (() => void) | null = null;

function syncOverlayMouseEvents(): void {
  win?.setIgnoreMouseEvents(!(overlayInteractive || overlayInputMode), { forward: true });
}

/* 開發模式預設將運行資料放專案根目錄；測試可用 VRM_PET_DATA_DIR 隔離資料。 */
const dataDir = (): string =>
  process.env['VRM_PET_DATA_DIR'] || (app.isPackaged ? app.getPath('userData') : app.getAppPath());
const runtimeDataDir = (): string => join(dataDir(), 'runtime-data');
const petsDir = (): string => join(runtimeDataDir(), 'pets');
const registryPath = (): string => join(runtimeDataDir(), 'app.json');
const petPath = (id: string): string => join(petsDir(), `${id}.json`);
const legacyRuntimeConfigPath = (): string => join(runtimeDataDir(), 'config.json');
const legacyRootConfigPath = (): string => join(dataDir(), 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function normalizeProfile(value: Partial<PetProfile>, index: number): PetProfile {
  const id = typeof value.id === 'string' && value.id ? value.id : randomUUID();
  const profile: PetProfile = {
    ...value,
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `寵物 ${index + 1}`,
    enabled: value.enabled !== false
  };
  // 遷移:舊 codexSessionId → agent(舊欄位保留不刪,循遷移慣例)
  if (!profile.agent && profile.codexSessionId) {
    profile.agent = { kind: 'codex', sessionId: profile.codexSessionId };
  }
  return profile;
}

function createProfile(index = pets.size): PetProfile {
  const slot = pets.size;
  const offset = slot === 0 ? 0 : (Math.ceil(slot / 2) * 1.15) * (slot % 2 ? 1 : -1);
  return normalizeProfile(
    {
      id: randomUUID(),
      name: `寵物 ${index + 1}`,
      enabled: true,
      state: { ...DEFAULT_STATE, x: offset }
    },
    index
  );
}

/** 待落盤集合:updatePet 標寵物、selectPet 等標 registry;flush 只寫髒的檔案。 */
const dirtyPetIds = new Set<string>();
let registryDirty = false;
let configFlushInFlight = false;

/** 全量同步落盤——**只給退出路徑用**(before-quit 與 Tray 結束;app.exit 不觸發 before-quit,
 *  行程要死了必須同步寫完)。平時的 500ms debounce 走 persistConfigAsync,不佔 main event loop。 */
function persistConfigSync(): void {
  if (configFlush) {
    clearTimeout(configFlush);
    configFlush = null;
  }
  try {
    mkdirSync(petsDir(), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify(registry, null, 2));
    for (const profile of pets.values()) {
      writeFileSync(petPath(profile.id), JSON.stringify(profile, null, 2));
    }
    registryDirty = false;
    dirtyPetIds.clear();
  } catch (error) {
    console.log('[main] config flush failed', error);
  }
}

/** 非同步落盤:只寫髒檔;寫入期間新標髒的由迴圈或下一輪 debounce 撿走。 */
async function persistConfigAsync(): Promise<void> {
  if (configFlushInFlight) {
    scheduleConfigFlush(); // 上一輪還在寫,改期再來(不可交錯寫同一批檔案)
    return;
  }
  configFlushInFlight = true;
  try {
    await mkdir(petsDir(), { recursive: true });
    while (registryDirty || dirtyPetIds.size) {
      if (registryDirty) {
        registryDirty = false;
        await writeFile(registryPath(), JSON.stringify(registry, null, 2));
      }
      const ids = [...dirtyPetIds];
      dirtyPetIds.clear();
      for (const id of ids) {
        const profile = pets.get(id);
        if (profile) await writeFile(petPath(id), JSON.stringify(profile, null, 2));
      }
    }
  } catch (error) {
    console.log('[main] config flush failed', error);
  } finally {
    configFlushInFlight = false;
    // 迴圈結束到這裡之間若又標髒(await 空檔),補一輪 debounce 免得漏寫
    if (registryDirty || dirtyPetIds.size) scheduleConfigFlush();
  }
}

function scheduleConfigFlush(): void {
  if (configFlush) clearTimeout(configFlush);
  configFlush = setTimeout(() => void persistConfigAsync(), 500);
}

function loadConfigSync(): void {
  mkdirSync(petsDir(), { recursive: true });
  const rawRegistry = readJson(registryPath());
  if (isRecord(rawRegistry) && rawRegistry['schemaVersion'] === 2 && Array.isArray(rawRegistry['petIds'])) {
    const ids = rawRegistry['petIds'].filter((id): id is string => typeof id === 'string');
    ids.forEach((id, index) => {
      const raw = readJson(petPath(id));
      if (isRecord(raw)) {
        const profile = normalizeProfile(raw as Partial<PetProfile>, index);
        pets.set(profile.id, profile);
      }
    });
    if (pets.size) {
      const requested = typeof rawRegistry['selectedPetId'] === 'string' ? rawRegistry['selectedPetId'] : '';
      registry = {
        schemaVersion: 2,
        selectedPetId: pets.has(requested) ? requested : pets.keys().next().value!,
        petIds: [...pets.keys()]
      };
      persistConfigSync();
      return;
    }
  }

  // v1 runtime-data/config.json（或更早的根目錄 config.json）自動轉成第一隻寵物。
  const legacyRaw = readJson(legacyRuntimeConfigPath()) ?? readJson(legacyRootConfigPath());
  const legacy = isRecord(legacyRaw) ? (legacyRaw as LegacyConfig) : {};
  const legacyPets = Array.isArray(legacy.pets) ? legacy.pets : null;
  if (legacyPets?.length) {
    legacyPets.forEach((profile, index) => {
      const normalized = normalizeProfile(profile, index);
      pets.set(normalized.id, normalized);
    });
  } else {
    const {
      schemaVersion: _schemaVersion,
      selectedPetId: _selectedPetId,
      pets: _legacyPets,
      ...legacyProfile
    } = legacy;
    const profile = normalizeProfile({
      ...legacyProfile,
      id: randomUUID(),
      name: '我的寵物',
      enabled: true
    }, 0);
    pets.set(profile.id, profile);
  }
  const requested = typeof legacy.selectedPetId === 'string' ? legacy.selectedPetId : '';
  registry = {
    schemaVersion: 2,
    selectedPetId: pets.has(requested) ? requested : pets.keys().next().value!,
    petIds: [...pets.keys()]
  };
  persistConfigSync();
  console.log(`[main] migrated ${pets.size} pet profile(s) to:`, petsDir());
}

function getPet(id?: string): PetProfile | null {
  return pets.get(id ?? registry.selectedPetId) ?? null;
}

function updatePet(id: string, patch: Partial<PetProfile>): PetProfile | null {
  const profile = pets.get(id);
  if (!profile) return null;
  Object.assign(profile, patch, { id: profile.id });
  // 「休息 → 釋放快取 + 關 agent session」是 disable 的固有副作用:集中在這唯一變更點,
  // 不管來自選單、設定面板或未來任何路徑都一致(避免各處各記一份)。
  if (patch.enabled === false) {
    releasePetCaches(id);
    void bridge?.closePetSession(id);
  }
  if (patch.enabled !== undefined) refreshCursorPollHook?.();
  if (patch.enabled !== undefined || 'idleMotions' in patch) scheduleIdleMotion(id);
  dirtyPetIds.add(id);
  scheduleConfigFlush();
  return profile;
}

function releasePetCaches(id: string): void {
  avatarIcons.delete(id);
  wardrobeLists.delete(id);
}

function setPetEnabled(id: string, enabled: boolean): PetProfile | null {
  const profile = updatePet(id, { enabled }); // 快取釋放已內建於 updatePet
  if (!profile) return null;
  sendPetProfiles();
  return profile;
}

function sendPetProfiles(): void {
  const profiles = [...pets.values()];
  win?.webContents.send('pet-profiles-apply', profiles, registry.selectedPetId);
  settingsWin?.webContents.send('pet-profiles-apply', profiles, registry.selectedPetId);
  refreshTray();
}

function selectPet(id: string): PetProfile | null {
  const profile = pets.get(id);
  if (!profile) return null;
  registry.selectedPetId = id;
  registryDirty = true;
  scheduleConfigFlush();
  refreshTray();
  settingsWin?.webContents.send('selected-pet-apply', id);
  const icons = avatarIcons.get(id);
  if (icons) settingsWin?.webContents.send('avatar-icons-apply', id, icons);
  const list = wardrobeLists.get(id);
  if (list) settingsWin?.webContents.send('wardrobe-list-apply', id, list);
  return profile;
}

async function pushVrm(petId: string, path: string): Promise<void> {
  try {
    const buf = await readFile(path);
    updatePet(petId, { vrmPath: path });
    win?.webContents.send('vrm-buffer', petId, buf);
    sendPetProfiles();
  } catch (error) {
    console.log('[main] pushVrm failed', error);
  }
}

async function chooseVrm(petId: string): Promise<void> {
  app.focus({ steal: true });
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'VRM', extensions: ['vrm'] }]
  });
  if (!result.canceled && result.filePaths[0]) await pushVrm(petId, result.filePaths[0]);
}

async function chooseWorkspace(petId: string): Promise<string | null> {
  const profile = getPet(petId);
  if (!profile) return null;
  app.focus({ steal: true });
  settingsWin?.focus();
  const options: Electron.OpenDialogOptions = {
    title: '選擇工作目錄',
    buttonLabel: '選擇',
    defaultPath: profile.workspacePath ?? app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  };
  const result = settingsWin
    ? await dialog.showOpenDialog(settingsWin, options)
    : await dialog.showOpenDialog(options);
  const path = result.filePaths[0];
  if (result.canceled || !path) return profile.workspacePath ?? null;
  updatePet(petId, { workspacePath: path });
  sendPetProfiles();
  return path;
}

function createNewPet(): PetProfile {
  const profile = createProfile();
  pets.set(profile.id, profile);
  registry.petIds.push(profile.id);
  registry.selectedPetId = profile.id;
  refreshCursorPollHook?.(); // 全休息時新增的寵物是啟用的:恢復輪詢
  persistConfigSync();
  sendPetProfiles();
  return profile;
}

function removePet(id: string): boolean {
  if (pets.size <= 1 || !pets.has(id)) return false;
  const trashDir = join(petsDir(), '.trash');
  mkdirSync(trashDir, { recursive: true });
  try {
    renameSync(petPath(id), join(trashDir, `${id}-${Date.now()}.json`));
  } catch { /* 尚未落盤的新寵物沒有檔案可搬 */ }
  pets.delete(id);
  releasePetCaches(id);
  const idleTimer = idleMotionTimers.get(id);
  if (idleTimer) clearTimeout(idleTimer);
  idleMotionTimers.delete(id);
  void bridge?.closePetSession(id);
  registry.petIds = registry.petIds.filter((petId) => petId !== id);
  if (registry.selectedPetId === id) registry.selectedPetId = registry.petIds[0]!;
  refreshCursorPollHook?.(); // 刪掉最後一隻醒著的寵物時停輪詢
  persistConfigSync();
  sendPetProfiles();
  return true;
}

function resetState(petId: string): void {
  const state = { ...DEFAULT_STATE };
  updatePet(petId, { state });
  win?.webContents.send('apply-state', petId, state);
  settingsWin?.webContents.send('apply-state', petId, state);
}

let motionFiles: string[] = [];
let motionsDirMissing = false;

async function refreshMotions(): Promise<void> {
  try {
    motionFiles = (await readdir(join(dataDir(), 'motions')))
      .filter((file) => file.toLowerCase().endsWith('.vrma'))
      .sort();
    motionsDirMissing = false;
  } catch {
    motionFiles = [];
    motionsDirMissing = true;
  }
}

/* ── 待機動作:每寵一個 timer,20~60 秒隨機間隔從勾選清單挑一個播放 ──
 * 排程長駐、播放前才檢查當下狀態(啟用/清單/功率檔位),設定改完即生效、不用追著清 timer。 */
const IDLE_MOTION_MIN_MS = 20_000;
const IDLE_MOTION_SPAN_MS = 40_000;
const idleMotionTimers = new Map<string, NodeJS.Timeout>();
/** 功率檔位 suspended(鎖屏/睡眠)時暫停播放;power 區塊注入實作。 */
let idleMotionsPaused: () => boolean = () => false;

function scheduleIdleMotion(petId: string): void {
  const old = idleMotionTimers.get(petId);
  if (old) clearTimeout(old);
  idleMotionTimers.delete(petId);
  const profile = pets.get(petId);
  if (!profile || profile.enabled === false || !profile.idleMotions?.length) return;
  const delay = IDLE_MOTION_MIN_MS + Math.random() * IDLE_MOTION_SPAN_MS;
  idleMotionTimers.set(petId, setTimeout(() => {
    void (async () => {
      const current = pets.get(petId);
      const list = (current?.idleMotions ?? []).filter((file) => motionFiles.includes(file));
      if (current && current.enabled !== false && list.length && !idleMotionsPaused()) {
        const file = list[Math.floor(Math.random() * list.length)]!;
        try {
          win?.webContents.send('vrma-play', petId, await readFile(join(dataDir(), 'motions', file)));
        } catch { /* 檔案剛被移走:這輪跳過,下輪過濾自然排除 */ }
      }
      scheduleIdleMotion(petId); // 排下一輪(清單被清空/寵物休息時鏈條停止,由 updatePet 的接點重啟)
    })();
  }, delay));
}

function motionMenuItems(petId: string): Electron.MenuItemConstructorOptions[] {
  if (motionsDirMissing) return [{ label: '(找不到 motions 資料夾)', enabled: false }];
  if (!motionFiles.length) return [{ label: '(motions 資料夾裡沒有 .vrma 檔)', enabled: false }];
  const dir = join(dataDir(), 'motions');
  return motionFiles.map((file) => ({
    label: file.replace(/\.vrma$/i, ''),
    click: async () => {
      try {
        win?.webContents.send('vrma-play', petId, await readFile(join(dir, file)));
      } catch (error) {
        console.log('[main] vrma read failed', error);
      }
    }
  }));
}

/** 設定預設姿勢(選單與設定面板共用):即選即播 + 存檔 + 同步 UI。file=null 清除。 */
async function setDefaultPose(petId: string, file: string | null): Promise<void> {
  if (file && !motionFiles.includes(file)) return; // 白名單:只接受 motions/ 裡的檔名
  updatePet(petId, { defaultPose: file ?? undefined });
  refreshTray();
  sendPetProfiles(); // 設定面板的下拉跟著同步
  if (!file) return;
  try {
    win?.webContents.send('vrma-play', petId, await readFile(join(dataDir(), 'motions', file)));
  } catch (error) {
    console.log('[main] default pose read failed', error);
  }
}

function defaultPoseMenuItems(petId: string): Electron.MenuItemConstructorOptions[] {
  const current = getPet(petId)?.defaultPose;
  const none: Electron.MenuItemConstructorOptions = {
    label: '(無)',
    type: 'radio',
    checked: !current,
    click: () => void setDefaultPose(petId, null)
  };
  if (motionsDirMissing) return [none];
  return [
    none,
    ...motionFiles.map((file): Electron.MenuItemConstructorOptions => ({
      label: file.replace(/\.vrma$/i, ''),
      type: 'radio',
      checked: file === current,
      click: () => void setDefaultPose(petId, file)
    }))
  ];
}

function refreshTray(): void {
  if (registry) tray?.setContextMenu(petMenu(registry.selectedPetId));
}

function petMenu(requestedId?: string): Menu {
  const profile = getPet(requestedId) ?? [...pets.values()][0];
  const petId = profile.id;
  return Menu.buildFromTemplate([
    { label: `寵物：${profile.name}`, enabled: false },
    {
      label: '切換寵物',
      submenu: [...pets.values()].map((item) => ({
        // 休息中的寵物仍列出(讓使用者知道存在),但灰掉不可選——選了會變成
        // selectedPetId 卻沒有 runtime、桌面看不到角色。喚醒走「喚醒目前角色」
        // (若牠正是目前角色)或設定面板的寵物選單。
        label: `${item.enabled ? '' : '（休息中）'}${item.name}`,
        type: 'radio' as const,
        checked: item.id === petId,
        enabled: item.enabled,
        click: () => selectPet(item.id)
      }))
    },
    { type: 'separator' },
    { label: '選擇 VRM 檔…', click: () => void chooseVrm(petId) },
    {
      label: '角色動作',
      submenu: [
        { label: '播放動作', submenu: motionMenuItems(petId) },
        { label: '預設姿勢', submenu: defaultPoseMenuItems(petId) },
        { type: 'separator' },
        { label: '停止動作', click: () => win?.webContents.send('vrma-stop', petId) }
      ]
    },
    {
      // 三項都是同一個設定視窗的分頁,收成一組入口
      label: '設定',
      submenu: [
        { label: '工作（AI 助手）…', click: () => openSettings('project', petId) },
        { label: '燈光…', click: () => openSettings('light', petId) },
        { label: '角色…', click: () => openSettings('char', petId) },
        { label: '動作…', click: () => openSettings('motion', petId) }
      ]
    },
    { label: '重置位置與大小', click: () => resetState(petId) },
    {
      label: profile.enabled ? '讓目前角色休息' : '喚醒目前角色',
      click: () => setPetEnabled(petId, !profile.enabled)
    },
    { type: 'separator' },
    {
      label: '新增寵物',
      click: () => {
        const created = createNewPet();
        openSettings('project', created.id);
      }
    },
    // app.exit 不觸發 before-quit,清理要在這裡自己做(已知坑,見 DEVLOG §22)
    { label: '結束', click: () => { bridge?.shutdownSync(); petToolsHub?.dispose(); persistConfigSync(); app.exit(0); } }
  ]);
}

function openSettings(tab: 'light' | 'char' | 'motion' | 'project' = 'light', petId?: string): void {
  if (petId) selectPet(petId);
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('switch-tab', tab);
    settingsWin.webContents.send('selected-pet-apply', registry.selectedPetId);
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
    title: '桌寵設定',
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

function createOverlay(): BrowserWindow {
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
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
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
  return overlay;
}

const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZklEQVR4nGNgoAFQAOIEIJ4PxPeheD5UTAGfRpiG/wQwzEAMQIxmZEMwnE2sZhhG8U4CGQYkoPufVANQwoEU/2MNB4oNoNgLFAeiAhkGKDCgAYoSEiwciDHkPrr/0YECA5mZiSwAANJTnOH5R44LAAAAAElFTkSuQmCC';

app.whenReady().then(async () => {
  // headless 回歸自驗:不開視窗,跑完即退出(exit code 供 CI 化)。
  // =1 → MockProvider 全鏈;=claude / =codex → 真 CLI e2e(耗額度,顯式觸發才跑)
  const selftestMode = process.env['VRM_PET_AGENT_SELFTEST'];
  if (selftestMode) {
    const pass = selftestMode === 'claude' ? await runClaudeE2E()
      : selftestMode === 'codex' ? await runCodexE2E()
      : await runAgentSelftest();
    app.exit(pass ? 0 : 1);
    return;
  }
  if (process.platform === 'darwin') app.dock?.hide();
  loadConfigSync();

  /* ── 串流文字合併(效能優化階段 3)──
   * provider 的 text delta 是 token 級,每 token 一次 IPC 太密(renderer 每次都全文重渲);
   * 33ms 合併一次;非 text 事件(done/error/approval…)到達時先 flush 緩衝,嚴格保序。 */
  const chatTextBuffers = new Map<string, string>();
  let chatFlushTimer: NodeJS.Timeout | null = null;
  function flushChatText(): void {
    if (chatFlushTimer) {
      clearTimeout(chatFlushTimer);
      chatFlushTimer = null;
    }
    for (const [petId, text] of chatTextBuffers) {
      win?.webContents.send('chat-event-apply', petId, { kind: 'text', text });
    }
    chatTextBuffers.clear();
  }
  function sendChatEvent(petId: string, event: AgentEvent): void {
    if (event.kind === 'text') {
      chatTextBuffers.set(petId, (chatTextBuffers.get(petId) ?? '') + event.text);
      chatFlushTimer ??= setTimeout(flushChatText, 33);
      return;
    }
    flushChatText();
    win?.webContents.send('chat-event-apply', petId, event);
  }

  // 寵物工具中樞(v3):agent 經 MCP 呼叫 → socket 回連這裡 → 操縱桌寵
  petToolsHub = createPetToolsHub({
    playMotion: async (petId, file) => {
      if (!pets.has(petId) || !motionFiles.includes(file)) return false;
      try {
        win?.webContents.send('vrma-play', petId, await readFile(join(dataDir(), 'motions', file)));
        return true;
      } catch {
        return false;
      }
    },
    showExpression: (petId, name) => {
      if (!pets.has(petId) || !(PET_EXPRESSIONS as readonly string[]).includes(name)) return false;
      win?.webContents.send('expression-apply', petId, name);
      return true;
    },
    speak: (petId, text) => {
      const trimmed = text.trim();
      if (!pets.has(petId) || !trimmed) return false;
      // 走同一個合併器:pet_speak 不可與緩衝中的串流文字互相超車
      sendChatEvent(petId, { kind: 'text', text: `\n${trimmed.slice(0, 200)}\n` });
      return true;
    },
    listMotions: () => motionFiles
  });
  bridge = createAgentBridge({
    getPet: (id) => pets.get(id) ?? null,
    updatePet,
    send: sendChatEvent,
    providers: createProviders(petToolsHub)
  });
  await refreshMotions();
  for (const id of pets.keys()) scheduleIdleMotion(id); // 開機排程各寵的待機動作
  try {
    // macOS 單次檔案變動常觸發多個 watch 事件:debounce 讓一批變動只做一次 readdir + Tray 重建
    let motionsDebounce: NodeJS.Timeout | null = null;
    motionsWatcher = watch(join(dataDir(), 'motions'), () => {
      if (motionsDebounce) clearTimeout(motionsDebounce);
      motionsDebounce = setTimeout(() => void refreshMotions().then(refreshTray), 300);
    });
  } catch { /* 選單會顯示 motions 資料夾不存在 */ }

  win = createOverlay();

  ipcMain.on('set-interactive', (event, value: boolean) => {
    if (!win || event.sender !== win.webContents) return;
    overlayInteractive = value;
    syncOverlayMouseEvents();
  });
  ipcMain.handle('set-input-mode', (event, value: boolean) => {
    if (!win || event.sender !== win.webContents) return;
    overlayInputMode = value;
    win.setFocusable(value);
    syncOverlayMouseEvents();
    if (value) {
      app.focus({ steal: true });
      win.focus();
    }
  });

  ipcMain.handle('get-pet-collection', () => ({
    pets: [...pets.values()],
    selectedPetId: registry.selectedPetId
  }));
  ipcMain.handle('create-pet', () => createNewPet());
  ipcMain.handle('remove-pet', (_event, id: string) => removePet(id));
  ipcMain.handle('select-pet', (_event, id: string) => selectPet(id));
  ipcMain.handle('update-pet-meta', (_event, id: string, patch: Partial<PetProfile>) => {
    const profile = getPet(id);
    if (!profile) return null;
    const next: Partial<PetProfile> = {};
    if (typeof patch.name === 'string') next.name = patch.name.trim() || profile.name;
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.persona === 'string') next.persona = patch.persona.trim().slice(0, 4000) || undefined;
    if (Array.isArray(patch.idleMotions)) {
      const files = [...new Set(patch.idleMotions.filter((f): f is string => typeof f === 'string'))].slice(0, 50);
      next.idleMotions = files.length ? files : undefined;
    }
    if (patch.agent && (patch.agent.kind === 'codex' || patch.agent.kind === 'claude')) {
      const sessionId = typeof patch.agent.sessionId === 'string' ? patch.agent.sessionId.trim() : '';
      const model = typeof patch.agent.model === 'string' ? patch.agent.model.trim() : '';
      const effort = typeof patch.agent.effort === 'string' &&
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(patch.agent.effort) ? patch.agent.effort : '';
      const permission = patch.agent.permission === 'ask' || patch.agent.permission === 'auto'
        ? patch.agent.permission : undefined;
      next.agent = {
        kind: patch.agent.kind,
        ...(sessionId ? { sessionId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(permission ? { permission } : {})
      };
      // 換 agent 種類 = 換家,不共享 session:關掉舊的
      if (profile.agent?.kind && profile.agent.kind !== patch.agent.kind) void bridge?.closePetSession(id);
      // sessionId 被清空(「開新對話」鈕或手動清欄位)= 要求開新 session:
      // 光清 profile 不夠,bridge 記憶體裡還握著舊 session,下一句仍會續用舊對話
      else if (profile.agent?.sessionId && !sessionId) void bridge?.closePetSession(id);
    }
    const updated = updatePet(id, next); // enabled=false 時的快取釋放已內建於 updatePet
    sendPetProfiles();
    return updated;
  });
  /** 開新對話(泡泡的「新對話」鈕):清掉 sessionId 並關掉 bridge 的舊 session。
   *  在 main 端做而不是讓 renderer 重組 agent 設定——後者若拿到過期 profile 會洗掉 model/力度/權限。 */
  ipcMain.on('new-session', (event, id: string) => {
    const fromOurWindow = event.sender === win?.webContents || event.sender === settingsWin?.webContents;
    if (!fromOurWindow) return;
    const profile = getPet(id);
    if (!profile?.agent?.sessionId) return; // 已經是新對話
    const { sessionId: _dropped, ...keep } = profile.agent;
    updatePet(id, { agent: keep });
    void bridge?.closePetSession(id);
    sendPetProfiles();
  });

  ipcMain.handle('choose-workspace', (_event, id: string) => chooseWorkspace(id));

  // 模型清單:codex 要跟 app-server 要(首次會 lazy 啟動),成功才快取(失敗可能只是還沒登入,下次再試)
  // 快取 10 分鐘 TTL:CLI 升版新增模型不用重啟 app 才看得到
  const modelListCache = new Map<string, { at: number; list: unknown[] }>();
  ipcMain.handle('agent-models', async (_event, kind: string) => {
    if (kind !== 'codex' && kind !== 'claude') return [];
    const cached = modelListCache.get(kind);
    if (cached && Date.now() - cached.at < 600_000) return cached.list;
    const list = (await bridge?.listModels(kind)) ?? [];
    if (list.length) modelListCache.set(kind, { at: Date.now(), list });
    else if (cached) return cached.list; // 拉失敗時寧可用過期清單也不回空
    return list;
  });

  ipcMain.handle('motion-list', async () => {
    await refreshMotions(); // 面板打開時可能剛放了新檔,跟 popup 前刷新同一個保險
    return motionFiles;
  });
  ipcMain.on('set-default-pose', (_event, petId: string, file: string | null) => {
    if (!pets.has(petId)) return;
    void setDefaultPose(petId, typeof file === 'string' ? file : null);
  });

  ipcMain.on('chat-send', (event, petId: string, text: string) => {
    if (!win || event.sender !== win.webContents || !pets.has(petId)) return;
    bridge?.chatSend(petId, String(text));
  });
  ipcMain.on('chat-cancel', (event, petId: string) => {
    if (!win || event.sender !== win.webContents) return;
    bridge?.chatCancel(petId);
  });
  ipcMain.on('chat-approval', (event, petId: string, requestId: string, allow: boolean) => {
    if (!win || event.sender !== win.webContents) return;
    bridge?.respondApproval(petId, String(requestId), allow === true);
  });
  ipcMain.on('open-external', (event, url: string) => {
    if (!win || event.sender !== win.webContents) return;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  ipcMain.handle('get-state', (_event, id: string) => getPet(id)?.state ?? null);
  ipcMain.on('save-state', (event, id: string, state: PetState) => {
    if (!win || event.sender !== win.webContents) return;
    updatePet(id, { state });
    settingsWin?.webContents.send('apply-state', id, state);
  });
  ipcMain.on('set-state', (_event, id: string, state: PetState) => {
    updatePet(id, { state });
    win?.webContents.send('apply-state', id, state);
  });

  ipcMain.on('avatar-icons', (event, id: string, icons: { front: string; side: string }) => {
    if (!win || event.sender !== win.webContents || !pets.has(id)) return;
    avatarIcons.set(id, icons);
    settingsWin?.webContents.send('avatar-icons-apply', id, icons);
  });

  ipcMain.handle('get-lighting', (_event, id: string) => getPet(id)?.lighting ?? null);
  ipcMain.on('set-lighting', (_event, id: string, lighting: Lighting) => {
    updatePet(id, { lighting });
    win?.webContents.send('apply-lighting', id, lighting);
  });

  /* VRM 讀檔快取:N 隻寵物用同一個模型檔時開機只讀一次磁碟(VRM 可達十幾 MB)。
   * mtime 變了就重讀;開機潮過後(30s 無新請求)整批釋放,不長駐大 buffer。 */
  const vrmReadCache = new Map<string, { mtimeMs: number; data: Promise<Buffer> }>();
  let vrmCacheSweep: NodeJS.Timeout | null = null;
  ipcMain.handle('get-boot-vrm', async (_event, id: string) => {
    const path = getPet(id)?.vrmPath;
    if (!path) return null;
    try {
      const mtimeMs = (await stat(path)).mtimeMs;
      const hit = vrmReadCache.get(path);
      const entry = hit && hit.mtimeMs === mtimeMs ? hit : { mtimeMs, data: readFile(path) };
      vrmReadCache.set(path, entry);
      if (vrmCacheSweep) clearTimeout(vrmCacheSweep);
      vrmCacheSweep = setTimeout(() => vrmReadCache.clear(), 30_000);
      return await entry.data;
    } catch {
      vrmReadCache.delete(path);
      return null;
    }
  });
  ipcMain.handle('get-default-pose', async (_event, id: string) => {
    const file = getPet(id)?.defaultPose;
    if (!file) return null;
    try {
      return await readFile(join(dataDir(), 'motions', file));
    } catch {
      return null;
    }
  });

  ipcMain.handle('get-sway', (_event, id: string) => getPet(id)?.sway ?? null);
  ipcMain.on('set-sway', (_event, id: string, sway: Sway) => {
    updatePet(id, { sway });
    win?.webContents.send('apply-sway', id, sway);
  });

  ipcMain.on('wardrobe-list', (event, id: string, list: { key: string; label: string }[]) => {
    if (!win || event.sender !== win.webContents || !pets.has(id)) return;
    wardrobeLists.set(id, list);
    settingsWin?.webContents.send('wardrobe-list-apply', id, list);
  });
  ipcMain.handle('get-wardrobe', (_event, id: string) => ({
    list: wardrobeLists.get(id) ?? [],
    states: getPet(id)?.wardrobe ?? {}
  }));
  ipcMain.on('set-wardrobe', (_event, id: string, key: string, visible: boolean) => {
    const profile = getPet(id);
    if (!profile) return;
    const states = { ...(profile.wardrobe ?? {}), [key]: visible };
    updatePet(id, { wardrobe: states });
    win?.webContents.send('apply-wardrobe', id, states);
  });

  ipcMain.on('show-menu', (event, id: string) => {
    if (!win || event.sender !== win.webContents || !pets.has(id)) return;
    selectPet(id);
    void refreshMotions().then(() => petMenu(id).popup({ window: win! }));
  });

  let overlayBounds = win.getBounds();
  screen.on('display-metrics-changed', () => {
    if (win && !win.isDestroyed()) overlayBounds = win.getBounds();
  });

  /* ── 游標輪詢中央控制 + 功率檔位(效能優化階段 2)──
   * click-through 視窗收不到被動 mousemove(§平台實證),輪詢是必要之惡;
   * 但頻率交給功率檔位決定,鎖屏/睡眠/全寵休息時完全停掉。 */
  let cursorTimer: NodeJS.Timeout | null = null;
  let cursorPollMs = 30;
  function setCursorPoll(intervalMs: number | null): void {
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
    if (intervalMs === null) return;
    cursorPollMs = intervalMs;
    // 心跳不變量:renderer 拖曳看門狗(1200ms 判死)依賴 ≈1s 一次的強制心跳,
    // 任何輪詢頻率下 sameLimit 都要換算回「約 1 秒」而不是固定次數
    const sameLimit = Math.max(1, Math.round(1000 / intervalMs));
    let lastX = -1e9;
    let lastY = -1e9;
    let sameCount = 0;
    cursorTimer = setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const point = screen.getCursorScreenPoint();
      if (point.x === lastX && point.y === lastY && ++sameCount < sameLimit) return;
      sameCount = 0;
      lastX = point.x;
      lastY = point.y;
      win.webContents.send('cursor', { x: point.x - overlayBounds.x, y: point.y - overlayBounds.y });
    }, intervalMs);
  }

  /** 功率檔位:normal(AC)/ eco(電池或微熱)/ critical(過熱)/ suspended(鎖屏/睡眠)。 */
  const POWER_TIERS = {
    normal: { pollMs: 30, idleSkip: 6, idleDelayMs: 3000, activeSkip: 1 },
    eco: { pollMs: 60, idleSkip: 12, idleDelayMs: 1500, activeSkip: 2 },
    critical: { pollMs: 120, idleSkip: 20, idleDelayMs: 1000, activeSkip: 3 }
  } as const;
  type PowerTier = keyof typeof POWER_TIERS | 'suspended';
  let onBattery = false;
  let thermal = 'nominal';
  let screenOff = false; // 鎖屏或系統睡眠
  let powerTier: PowerTier | null = null; // null = 尚未套用過(開機首套必發)

  function computeTier(): PowerTier {
    if (screenOff) return 'suspended';
    if (thermal === 'serious' || thermal === 'critical') return 'critical';
    if (onBattery || thermal === 'fair') return 'eco';
    return 'normal';
  }

  function currentProfilePayload(): Record<string, unknown> {
    if (powerTier === 'suspended' || powerTier === null) {
      return { tier: powerTier ?? 'normal', paused: powerTier === 'suspended', ...POWER_TIERS.normal };
    }
    return { tier: powerTier, paused: false, ...POWER_TIERS[powerTier] };
  }

  function anyPetEnabled(): boolean {
    return [...pets.values()].some((profile) => profile.enabled !== false);
  }

  function applyPowerTier(): void {
    const next = computeTier();
    if (next === powerTier) return;
    powerTier = next;
    console.log(`[power] 功率檔位 → ${next}(battery=${onBattery} thermal=${thermal} screenOff=${screenOff})`);
    win?.webContents.send('power-profile-apply', currentProfilePayload());
    refreshCursorPoll();
  }

  /** 輪詢頻率 = 檔位 × 有沒有醒著的寵物(全休息時輪詢沒有意義)。 */
  function refreshCursorPoll(): void {
    if (powerTier === 'suspended' || !anyPetEnabled()) setCursorPoll(null);
    else setCursorPoll(POWER_TIERS[(powerTier ?? 'normal') as keyof typeof POWER_TIERS].pollMs);
  }
  refreshCursorPollHook = refreshCursorPoll; // updatePet(enabled 變更)經此重算
  idleMotionsPaused = () => powerTier === 'suspended'; // 鎖屏/睡眠不播待機動作

  const updatePowerState = (): void => {
    onBattery = powerMonitor.isOnBatteryPower();
    try {
      thermal = powerMonitor.getCurrentThermalState(); // macOS 專屬;其他平台 unknown
    } catch {
      thermal = 'unknown';
    }
    applyPowerTier();
  };
  powerMonitor.on('on-battery', updatePowerState);
  powerMonitor.on('on-ac', updatePowerState);
  powerMonitor.on('thermal-state-change', updatePowerState);
  powerMonitor.on('lock-screen', () => { screenOff = true; applyPowerTier(); });
  powerMonitor.on('unlock-screen', () => { screenOff = false; updatePowerState(); });
  powerMonitor.on('suspend', () => { screenOff = true; applyPowerTier(); });
  powerMonitor.on('resume', () => { screenOff = false; updatePowerState(); });

  win.webContents.on('did-finish-load', () => {
    // renderer 重載會失去檔位狀態:重送當前 profile 再重啟輪詢(沿用防疊 timer 的既有防護)
    win?.webContents.send('power-profile-apply', currentProfilePayload());
    refreshCursorPoll();
  });
  updatePowerState(); // 開機初始化(首套必發 profile)

  const icon = nativeImage.createFromDataURL(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('VRM 桌寵');
  tray.setContextMenu(petMenu(registry.selectedPetId));
});

app.on('window-all-closed', () => { /* 常駐 */ });
app.on('before-quit', () => {
  bridge?.shutdownSync();
  petToolsHub?.dispose();
  motionsWatcher?.close();
  persistConfigSync();
});
