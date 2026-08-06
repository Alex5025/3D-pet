import { app, BrowserWindow, ipcMain, powerMonitor, screen, Tray, Menu, nativeImage, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { AgentBinding, AgentEvent } from '../shared/agentEvents';
import type { ChatImage, ChatSendResult, ControlStatusSnapshot, ControlPetStatus, ControlTaskRecord } from '../shared/chat';
import { createChatDispatcher, createChatQueue } from './chatQueue';
import type { ProjectSandboxSettingsInput, ProjectSandboxSettingsResult } from '../shared/sandboxSettings';
import { groupPetsByWorkspace, normalizeWorkspacePath } from '../shared/petGroups';
import type { AgentBridge } from './agent/bridge';
import { createAgentBridge } from './agent/bridge';
import { createDragMonitor, type DragMonitor } from './dragMonitor';
import { PET_EXPRESSIONS, createPetToolsHub } from './agent/petToolsHub';
import type { PetToolsHub } from './agent/petToolsHub';
import { createProviders } from './agent/providers';
import { runAgentSelftest, runClaudeE2E, runCodexE2E } from './agent/selftest';
import { readProjectSandboxSettings, writeProjectSandboxSettings } from './sandboxConfig';
import { createDefaultWorkspace } from './workspaceDefaults';

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
  /** 新寵物預設工作目錄的根位置(全域);未設定時用 ~/Documents/PetWorkspaces。 */
  defaultWorkspaceRoot?: string;
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
let sandboxSettingsWin: BrowserWindow | null = null;
let controlWin: BrowserWindow | null = null;
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
let dragMonitor: DragMonitor | null = null;
/** 游標輪詢重算(功率檔位區塊注入):寵物啟用狀態變更時呼叫,全休息 = 停輪詢。 */
let refreshCursorPollHook: (() => void) | null = null;
/** 清空某寵的對話佇列(whenReady 注入):寵物休息/刪除/開新對話時呼叫。 */
let clearChatQueueHook: ((petId: string) => void) | null = null;
/** 全域派發(whenReady 注入):寵物喚醒時呼叫——醒來的寵物可領公用池的單。 */
let dispatchAllHook: (() => void) | null = null;
/** 中控面板快照重推(whenReady 注入,50ms debounce):寵物/佇列/agent 狀態變更時呼叫。 */
let scheduleControlStatusHook: (() => void) | null = null;

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
const systemPidPath = (): string => join(runtimeDataDir(), 'pet-system.pid');
/** 有效的新寵物預設工作根目錄:全域設定優先,否則 ~/Documents/PetWorkspaces。 */
const workspaceRoot = (): string =>
  registry.defaultWorkspaceRoot ?? join(app.getPath('documents'), 'PetWorkspaces');

/** 地端重啟腳本只需要這份 PID 紀錄；啟動命令固定寫在腳本內。 */
function writeSystemPidRecord(): void {
  mkdirSync(runtimeDataDir(), { recursive: true });
  writeFileSync(systemPidPath(), `${process.pid}\n`);
}

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
      // 全域設定要讀回保留,否則重建 registry 時會被洗掉
      const savedRoot = typeof rawRegistry['defaultWorkspaceRoot'] === 'string' && rawRegistry['defaultWorkspaceRoot']
        ? rawRegistry['defaultWorkspaceRoot']
        : undefined;
      registry = {
        schemaVersion: 2,
        selectedPetId: pets.has(requested) ? requested : pets.keys().next().value!,
        petIds: [...pets.keys()],
        ...(savedRoot ? { defaultWorkspaceRoot: savedRoot } : {})
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
    clearChatQueueHook?.(id); // 休息 = 放下手邊任務,排隊中的一併清掉(公用池不受影響)
    void bridge?.closePetSession(id);
  } else if (patch.enabled === true) {
    dispatchAllHook?.(); // 喚醒的寵物可以去領公用池的單
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
  sandboxSettingsWin?.webContents.send('pet-profiles-apply', profiles, registry.selectedPetId);
  controlWin?.webContents.send('pet-profiles-apply', profiles, registry.selectedPetId);
  scheduleControlStatusHook?.(); // 名稱/啟用/工作目錄變更都經過這裡,中控快照跟著重推
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
  sandboxSettingsWin?.webContents.send('selected-pet-apply', id);
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

async function chooseWorkspace(petId: string, parent?: BrowserWindow): Promise<string | null> {
  const profile = getPet(petId);
  if (!profile) return null;
  app.focus({ steal: true });
  parent?.focus();
  const options: Electron.OpenDialogOptions = {
    title: '選擇工作目錄',
    buttonLabel: '選擇',
    defaultPath: profile.workspacePath ?? app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const path = result.filePaths[0];
  if (result.canceled || !path) return profile.workspacePath ?? null;
  updatePet(petId, { workspacePath: path });
  sendPetProfiles();
  return path;
}

function createNewPet(): PetProfile {
  const profile = createProfile();
  // 自動建立預設工作目錄:避免忘記選目錄造成工作區污染;失敗時維持未設定(bridge 原擋門行為)
  const workspace = createDefaultWorkspace(workspaceRoot(), profile.name);
  if (workspace) profile.workspacePath = workspace;
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
  clearChatQueueHook?.(id);
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
/** 全域錯開:同一時間只有一寵播待機動作(多寵同時全速跑會疊 GPU;輪流動也更自然)。
 *  動作長度 main 不知道,以保守窗口互斥;撞到的寵物順延重排。 */
let idleMotionBusyUntil = 0;
const IDLE_MOTION_LOCK_MS = 10_000;

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
      if (current && current.enabled !== false && list.length && !idleMotionsPaused()
        && Date.now() >= idleMotionBusyUntil) {
        idleMotionBusyUntil = Date.now() + IDLE_MOTION_LOCK_MS;
        const file = list[Math.floor(Math.random() * list.length)]!;
        try {
          // 第三參數 lowPower=true:待機播放以半幀率跑(手動/agent 觸發的播放不帶)
          win?.webContents.send('vrma-play', petId, await readFile(join(dataDir(), 'motions', file)), true);
        } catch { /* 檔案剛被移走:這輪跳過,下輪過濾自然排除 */ }
      }
      scheduleIdleMotion(petId); // 排下一輪(撞到互斥鎖的這輪不播,順延到下一個隨機間隔)
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

/** 只重建指定寵物的 agent/runtime；設定與已持久化 session 保留，下一句可 resume。 */
async function restartPet(petId: string): Promise<void> {
  const profile = getPet(petId);
  if (!profile?.enabled) return;
  try {
    // provider 正在等待外部程序時 close 可能拖很久；角色重建不可被它無限卡住。
    await Promise.race([
      bridge?.closePetSession(petId) ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } finally {
    win?.webContents.send('pet-runtime-restart', petId);
  }
}

function shutdownSync(): void {
  // 每項各自隔離：某個外部程序或 watcher 清理失敗，不可阻止設定落盤與 app 結束／重啟。
  const cleanup = (label: string, action: () => void): void => {
    try { action(); } catch (error) { console.log(`[main] ${label} cleanup failed`, error); }
  };
  cleanup('agent bridge', () => bridge?.shutdownSync());
  cleanup('pet tools', () => petToolsHub?.dispose());
  cleanup('motions watcher', () => motionsWatcher?.close());
  cleanup('drag monitor', () => dragMonitor?.dispose());
  cleanup('config', persistConfigSync);
}

function restartApp(): void {
  // Electron 只觸發固定地端腳本；PID 讀取、終止程序與 npm run dev 全由腳本負責。
  persistConfigSync();
  const scriptPath = join(app.getAppPath(), 'scripts/restart-pet-system.sh');
  const child = spawn('/bin/zsh', [scriptPath], {
    cwd: app.getAppPath(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

function petMenu(requestedId?: string): Menu {
  const profile = getPet(requestedId) ?? [...pets.values()][0];
  const petId = profile.id;
  return Menu.buildFromTemplate([
    { label: `寵物：${profile.name}`, enabled: false },
    {
      label: '切換寵物',
      submenu: groupPetsByWorkspace([...pets.values()]).map((group) => ({
        label: `📁 ${group.name}`,
        submenu: group.pets.map((item) => ({
          // 休息中的寵物仍列出(讓使用者知道存在),但灰掉不可選。
          label: `${item.enabled ? '' : '（休息中）'}${item.name}`,
          type: 'radio' as const,
          checked: item.id === petId,
          enabled: item.enabled,
          click: () => selectPet(item.id)
        }))
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
      // 一般外觀與工作設定共用分頁；高風險沙盒設定刻意排除。
      label: '設定',
      submenu: [
        { label: '工作（AI 助手）…', click: () => openSettings('project', petId) },
        { label: '燈光…', click: () => openSettings('light', petId) },
        { label: '角色…', click: () => openSettings('char', petId) },
        { label: '動作…', click: () => openSettings('motion', petId) }
      ]
    },
    { label: '中控面板…', click: () => openControlPanel() },
    { label: '沙盒設定…', click: () => openSandboxSettings(petId) },
    { label: '重置位置與大小', click: () => resetState(petId) },
    {
      label: '重啟目前角色',
      enabled: profile.enabled,
      click: () => void restartPet(petId)
    },
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
    { label: '重啟寵物系統', click: restartApp },
    // app.exit 不觸發 before-quit,清理要在這裡自己做(已知坑,見 DEVLOG §22)
    { label: '結束', click: () => { shutdownSync(); app.exit(0); } }
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

/** 高風險設定使用獨立視窗與獨立 renderer，不可從一般設定分頁切入。 */
function openSandboxSettings(petId?: string): void {
  if (petId) selectPet(petId);
  if (sandboxSettingsWin && !sandboxSettingsWin.isDestroyed()) {
    sandboxSettingsWin.webContents.send('selected-pet-apply', registry.selectedPetId);
    sandboxSettingsWin.show();
    sandboxSettingsWin.focus();
    return;
  }
  sandboxSettingsWin = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: '專案沙盒設定',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  sandboxSettingsWin.on('closed', () => (sandboxSettingsWin = null));
  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev) sandboxSettingsWin.loadURL(`${dev}/sandboxSettings.html`);
  else sandboxSettingsWin.loadFile(join(__dirname, '../renderer/sandboxSettings.html'));
  app.focus({ steal: true });
}

/** 中控面板:多寵狀態總覽、指派任務(綁定/公用池)、佇列撤單、審批代答、系統操作。 */
function openControlPanel(): void {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.show();
    controlWin.focus();
    return;
  }
  controlWin = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 560,
    minHeight: 420,
    title: '中控面板', // 常駐工作視窗:可縮放、不置頂(疊層在 screen-saver 層且點擊穿透,不衝突)
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  controlWin.on('closed', () => (controlWin = null));
  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev) controlWin.loadURL(`${dev}/control.html`);
  else controlWin.loadFile(join(__dirname, '../renderer/control.html'));
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
  writeSystemPidRecord();
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
  /* ── 中控任務帳本:只追蹤中控投的任務(泡泡對話不進帳本);記憶體保留、不落盤,重啟即清空。
   * 佇列的單被領走就消失,「誰收到/在哪執行/執行狀態」的全生命週期靠這份紀錄。 ── */
  const taskLedger = new Map<string, ControlTaskRecord>();
  /** petId → 進行中的帳本任務 id(done/error 事件對回任務用;泡泡任務不在帳本,不會進這張表)。 */
  const runningTaskByPet = new Map<string, string>();
  const LEDGER_FINISHED_CAP = 50;
  const ledgerSummary = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);
  function finishLedgerTask(petId: string, ok: boolean): void {
    const taskId = runningTaskByPet.get(petId);
    if (!taskId) return;
    runningTaskByPet.delete(petId);
    const record = taskLedger.get(taskId);
    if (!record) return;
    record.status = ok ? 'done' : 'failed';
    record.finishedAt = Date.now();
    // 已終結(含已移除)超過上限 → 砍最舊,帳本不無限長大
    const finished = [...taskLedger.values()].filter((r) => r.finishedAt !== undefined);
    if (finished.length > LEDGER_FINISHED_CAP) {
      finished.sort((a, b) => a.finishedAt! - b.finishedAt!);
      for (const old of finished.slice(0, finished.length - LEDGER_FINISHED_CAP)) taskLedger.delete(old.id);
    }
  }
  function markLedgerRemoved(taskId: string): void {
    const record = taskLedger.get(taskId);
    if (record?.status === 'queued') {
      record.status = 'removed';
      record.finishedAt = Date.now();
    }
  }

  function sendChatEvent(petId: string, event: AgentEvent): void {
    if (event.kind === 'text') {
      // text 增量一律不推中控:中控只顯示狀態燈號,33ms 合併節奏的高頻 IPC 不打第二個視窗
      chatTextBuffers.set(petId, (chatTextBuffers.get(petId) ?? '') + event.text);
      chatFlushTimer ??= setTimeout(flushChatText, 33);
      return;
    }
    if (event.kind === 'done') finishLedgerTask(petId, event.ok);
    else if (event.kind === 'error') finishLedgerTask(petId, false);
    flushChatText();
    win?.webContents.send('chat-event-apply', petId, event);
    scheduleControlStatusHook?.(); // 非 text 事件(turnStart/approval/done…)= 狀態燈號可能變了
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
  /* ── 對話佇列(效能與擴展設計見 chatQueue.ts)──
   * turn 進行中送出的訊息排隊、turn 完自動接續;佇列變更即廣播給泡泡。
   * 將來中控面板 = 另一條帶 sender 驗證的 enqueue(source:'control')IPC + 訂閱同一個廣播。 */
  const chatQueue = createChatQueue((petId) => {
    if (petId) win?.webContents.send('chat-queue-apply', petId, chatQueue.summaries(petId));
    scheduleControlStatusHook?.(); // 綁定佇列與公用池(petId=undefined)變更都重推中控快照
  });
  const chatDispatcher = createChatDispatcher({
    queue: chatQueue,
    canAccept: (petId) => bridge?.canAccept(petId) ?? false,
    // 領公用池的資格:啟用中且已設工作目錄
    unboundCandidates: () => [...pets.values()]
      .filter((profile) => profile.enabled !== false && !!profile.workspacePath)
      .map((profile) => profile.id),
    workspaceOf: (petId) => pets.get(petId)?.workspacePath,
    runTask: (petId, task) => {
      // 中控投的任務進帳本:標執行中、補接收者與實際執行位置(公用池單在領走的這一刻才確定)
      const record = taskLedger.get(task.id);
      if (record) {
        const profile = pets.get(petId);
        record.status = 'running';
        record.assignee = petId;
        if (profile?.name) record.assigneeName = profile.name;
        if (profile?.workspacePath) record.workspacePath = profile.workspacePath;
        runningTaskByPet.set(petId, task.id);
      }
      // turnStart 讓泡泡知道「這一則開始跑了」(beginTurn);非 text 事件,合併器會先 flush 保序
      sendChatEvent(petId, { kind: 'turnStart', text: task.text });
      bridge?.chatSend(petId, task.text, task.images);
    }
  });
  clearChatQueueHook = (petId) => chatQueue.clear(petId);
  dispatchAllHook = () => chatDispatcher.dispatchAll();

  bridge = createAgentBridge({
    // 淺拷貝合併參考檔(ephemeral,不落盤——persist 走 pets.get 的原物件);資料夾以尾斜線標記
    getPet: (id) => {
      const profile = pets.get(id);
      if (!profile) return null;
      const refs = petRefFiles.get(id);
      return refs?.length ? { ...profile, refFiles: refs.map((r) => r.path + (r.isDir ? '/' : '')) } : profile;
    },
    updatePet,
    send: sendChatEvent,
    providers: createProviders(petToolsHub),
    // turn 結束(含早退)→ 派發佇列;用 dispatchAll:全域上限釋放的名額可能輪到別隻寵物
    onTurnFinished: () => chatDispatcher.dispatchAll()
  });

  /* ── 中控面板快照:全量組裝、50ms trailing debounce 推播 ──
   * 中控吃整份快照而非逐寵事件差分——量小(寵物十數隻、佇列 ≤10/寵),全量重繪省心且天然避開漏接。 */
  function buildControlStatus(): ControlStatusSnapshot {
    const agentStates = new Map((bridge?.petStates() ?? []).map((s) => [s.petId, s]));
    const petsStatus: ControlPetStatus[] = [...pets.values()].map((profile) => {
      const agent = agentStates.get(profile.id);
      const phase: ControlPetStatus['phase'] = profile.enabled === false
        ? 'resting'
        : agent?.pendingApproval ? 'awaitingApproval' : agent?.running ? 'working' : 'idle';
      return {
        petId: profile.id,
        name: profile.name,
        enabled: profile.enabled !== false,
        ...(profile.workspacePath ? { workspacePath: profile.workspacePath } : {}),
        phase,
        lastActivity: agent?.lastActivity ?? 0, // 從未對話 = 0(renderer 排最後)
        queue: chatQueue.summaries(profile.id),
        ...(agent?.pendingApproval ? { pendingApproval: agent.pendingApproval } : {})
      };
    });
    // 帳本:未終結在前,各自新→舊;排序歸 main(帳本是 main 的資料),清醒/休息分組歸 renderer(顯示邏輯)
    const tasks = [...taskLedger.values()].sort((a, b) => {
      const aFinished = a.finishedAt !== undefined ? 1 : 0;
      const bFinished = b.finishedAt !== undefined ? 1 : 0;
      if (aFinished !== bFinished) return aFinished - bFinished;
      return b.enqueuedAt - a.enqueuedAt;
    });
    return { pets: petsStatus, tasks };
  }
  let controlStatusTimer: NodeJS.Timeout | null = null;
  scheduleControlStatusHook = () => {
    if (!controlWin || controlStatusTimer) return;
    controlStatusTimer = setTimeout(() => {
      controlStatusTimer = null;
      controlWin?.webContents.send('control-status-apply', buildControlStatus());
    }, 50);
  };
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
  /* ── 參考檔案(拖放到寵物身上;當次對話有效,純記憶體不落盤)──
   * renderer 經 webUtils 取絕對路徑送來;這裡 stat 驗證存在、判資料夾,注入走 bridge 的 turnOpts。 */
  const petRefFiles = new Map<string, { path: string; isDir: boolean }[]>();
  const sendRefFiles = (petId: string): void =>
    win?.webContents.send('ref-files-apply', petId, petRefFiles.get(petId) ?? []);
  ipcMain.on('ref-files-add', (event, petId: string, paths: string[]) => {
    // 來源:疊層(保留給未來平台)或拖放接收窗
    const fromDropWin = [...dropWindows.values()].some((w) => !w.isDestroyed() && w.webContents === event.sender);
    if ((!fromDropWin && event.sender !== win?.webContents) || !pets.has(petId) || !Array.isArray(paths)) return;
    void (async () => {
      const list = petRefFiles.get(petId) ?? [];
      let changed = false;
      for (const path of paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/'))) {
        // .vrm/.vrma 維持原本拖放語意(換模型/播動作)——疊層收不到拖放後,接收窗是它們唯一的拖放入口
        const lower = path.toLowerCase();
        if (lower.endsWith('.vrm')) {
          void pushVrm(petId, path);
          continue;
        }
        if (lower.endsWith('.vrma')) {
          try {
            win?.webContents.send('vrma-play', petId, await readFile(path));
          } catch { /* 檔案讀不到就略過 */ }
          continue;
        }
        if (list.some((item) => item.path === path) || list.length >= 20) continue;
        try {
          list.push({ path, isDir: (await stat(path)).isDirectory() });
          changed = true;
        } catch {
          console.log('[main] 參考檔不存在,略過:', path);
        }
      }
      if (changed) {
        petRefFiles.set(petId, list);
        sendRefFiles(petId);
      }
    })();
  });
  ipcMain.on('ref-files-remove', (event, petId: string, path: string) => {
    if (!win || event.sender !== win.webContents || !petRefFiles.has(petId)) return;
    petRefFiles.set(petId, (petRefFiles.get(petId) ?? []).filter((item) => item.path !== path));
    sendRefFiles(petId);
  });

  /** 開新對話(泡泡的「新對話」鈕):清掉 sessionId 並關掉 bridge 的舊 session。
   *  在 main 端做而不是讓 renderer 重組 agent 設定——後者若拿到過期 profile 會洗掉 model/力度/權限。 */
  ipcMain.on('new-session', (event, id: string) => {
    const fromOurWindow = event.sender === win?.webContents || event.sender === settingsWin?.webContents
      || event.sender === controlWin?.webContents;
    if (!fromOurWindow) return;
    petRefFiles.delete(id); // 參考檔是「當次對話」的:開新對話一併清空
    sendRefFiles(id);
    clearChatQueueHook?.(id); // 排隊中的舊對話訊息也一併清掉
    const profile = getPet(id);
    if (!profile?.agent?.sessionId) return; // 已經是新對話(參考檔仍要清)
    const { sessionId: _dropped, ...keep } = profile.agent;
    updatePet(id, { agent: keep });
    void bridge?.closePetSession(id);
    sendPetProfiles();
  });

  ipcMain.handle('choose-workspace', (event, id: string) => {
    const parent = event.sender === settingsWin?.webContents
      ? settingsWin
      : event.sender === sandboxSettingsWin?.webContents
        ? sandboxSettingsWin
        : event.sender === controlWin?.webContents ? controlWin : undefined;
    return chooseWorkspace(id, parent ?? undefined);
  });

  /* ── 全域:新寵物預設工作根目錄 ── */
  ipcMain.handle('workspace-root-get', () => workspaceRoot());

  ipcMain.handle('choose-workspace-root', async (event): Promise<string> => {
    // 僅設定視窗可變更(循 choose-workspace 的 sender 驗證慣例)
    if (!settingsWin || event.sender !== settingsWin.webContents) return workspaceRoot();
    app.focus({ steal: true }); // 背景 app 的 dialog 會被壓在其他視窗底下
    settingsWin.focus();
    const result = await dialog.showOpenDialog(settingsWin, {
      title: '選擇新寵物的預設工作根目錄',
      buttonLabel: '選擇',
      defaultPath: workspaceRoot(),
      properties: ['openDirectory', 'createDirectory']
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return workspaceRoot();
    registry.defaultWorkspaceRoot = path;
    registryDirty = true;
    scheduleConfigFlush();
    settingsWin?.webContents.send('workspace-root-apply', path);
    return path;
  });

  /* ── 專案 Codex 沙盒設定──
   * 設定視窗明確按下後由 main 直接讀寫 <workspace>/.codex/config.toml；不啟動 agent、不跑 shell。 */
  ipcMain.handle('sandbox-settings-get', async (event, id: string): Promise<ProjectSandboxSettingsResult> => {
    if (!sandboxSettingsWin || event.sender !== sandboxSettingsWin.webContents) {
      return { ok: false, message: '沙盒設定只能從獨立安全視窗操作' };
    }
    const profile = getPet(id);
    if (!profile?.workspacePath) return { ok: false, message: '請先在「工作」分頁選擇工作目錄' };
    try {
      return {
        ok: true,
        message: '已讀取專案沙盒設定',
        settings: await readProjectSandboxSettings(profile.workspacePath),
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(
    'sandbox-settings-set',
    async (event, id: string, settings: ProjectSandboxSettingsInput): Promise<ProjectSandboxSettingsResult> => {
      if (!sandboxSettingsWin || event.sender !== sandboxSettingsWin.webContents) {
        return { ok: false, message: '沙盒設定只能從獨立安全視窗操作' };
      }
      const profile = getPet(id);
      if (!profile?.workspacePath) return { ok: false, message: '請先在「工作」分頁選擇工作目錄' };
      try {
        return {
          ok: true,
          message: '已直接寫入專案 .codex/config.toml；重新開啟 Codex 工作階段後生效',
          settings: await writeProjectSandboxSettings(profile.workspacePath, settings),
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

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

  // 對話送出改 invoke:回傳 {queued, position, reason?} 讓泡泡同步得知「立即執行/已排入/被拒」。
  // 「佇列已滿」不可走 error 事件——renderer 對 error 無條件 endTurn,會誤終結進行中的 turn。
  ipcMain.handle('chat-send', (event, petId: string, text: string, rawImages: unknown): ChatSendResult => {
    if (!win || event.sender !== win.webContents || !pets.has(petId)) {
      return { queued: false, position: -1, reason: '無效的請求' };
    }
    const images: ChatImage[] = [];
    if (Array.isArray(rawImages)) {
      for (const item of rawImages.slice(0, 4)) {
        if (!item || typeof item !== 'object') continue;
        const value = item as Record<string, unknown>;
        const mimeType = value['mimeType'];
        const data = value['data'];
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mimeType))) continue;
        if (typeof data !== 'string' || data.length > 11_200_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) continue;
        images.push({
          mimeType: mimeType as ChatImage['mimeType'],
          data,
          name: typeof value['name'] === 'string' ? value['name'].slice(0, 200) : undefined,
        });
      }
    }
    const trimmed = String(text).slice(0, 1000).trim();
    if (!trimmed && !images.length) return { queued: false, position: -1, reason: '訊息是空的' };
    const result = chatQueue.enqueue({ assignee: petId, text: trimmed, images, source: 'bubble' });
    if (!result.ok) return { queued: false, position: -1, reason: result.reason };
    chatDispatcher.dispatch(petId);
    return { queued: true, position: result.position };
  });
  ipcMain.on('chat-queue-remove', (event, petId: string, taskId: string) => {
    const fromOurWindow = event.sender === win?.webContents || event.sender === controlWin?.webContents;
    if (!fromOurWindow) return; // 綁定佇列撤單:泡泡與中控共用
    if (chatQueue.remove(String(petId), String(taskId))) markLedgerRemoved(String(taskId));
  });
  ipcMain.handle('chat-queue-get', (event, petId: string) => {
    if (!win || event.sender !== win.webContents) return [];
    return chatQueue.summaries(String(petId));
  });
  ipcMain.on('chat-cancel', (event, petId: string) => {
    if (!win || event.sender !== win.webContents) return;
    bridge?.chatCancel(petId);
  });
  ipcMain.on('chat-approval', (event, petId: string, requestId: string, allow: boolean, feedback?: string) => {
    // 泡泡與中控都可回覆;requestId 與掛著審批的相符性由 bridge 把關(雙 UI race 在源頭擋)
    const fromOurWindow = event.sender === win?.webContents || event.sender === controlWin?.webContents;
    if (!fromOurWindow) return;
    bridge?.respondApproval(
      petId,
      String(requestId),
      allow === true,
      typeof feedback === 'string' ? feedback.trim().slice(0, 1000) : undefined,
    );
  });
  ipcMain.on('open-external', (event, url: string) => {
    if (!win || event.sender !== win.webContents) return;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  /* ── 中控面板專用 IPC(sender 一律限 controlWin)──
   * 指派任務走自己的 enqueue 通道(chat-send 保持泡泡專用);一切失敗回饋走 invoke 回傳,
   * 絕不發 error 事件——renderer 對 error 無條件 endTurn,會誤終結進行中的 turn(§10 鐵律)。 */
  ipcMain.handle('control-enqueue', (event, text: string, assignee?: string, restrictWorkspace?: string): ChatSendResult => {
    if (!controlWin || event.sender !== controlWin.webContents) {
      return { queued: false, position: -1, reason: '無效的請求' };
    }
    const trimmed = String(text).slice(0, 1000).trim();
    if (!trimmed) return { queued: false, position: -1, reason: '訊息是空的' };
    let target: string | undefined;
    if (assignee !== undefined && assignee !== '') {
      const profile = pets.get(String(assignee));
      if (!profile) return { queued: false, position: -1, reason: '找不到該寵物' };
      if (profile.enabled === false) {
        // 投給休息中寵物的綁定單會躺死或在喚醒前被 clear,直接拒收
        return { queued: false, position: -1, reason: '該寵物休息中,請先喚醒或投入公用池' };
      }
      target = profile.id;
    }
    // 公用池單可限定工作區(= 發佈者指定運行路徑);必須是某寵物實際的工作區,亂傳拒收
    let restrict: string | undefined;
    if (!target && typeof restrictWorkspace === 'string' && restrictWorkspace) {
      const normalized = normalizeWorkspacePath(restrictWorkspace);
      const known = new Set(
        [...pets.values()].map((p) => normalizeWorkspacePath(p.workspacePath)).filter((p): p is string => !!p)
      );
      if (!normalized || !known.has(normalized)) {
        return { queued: false, position: -1, reason: '限定的工作區不存在' };
      }
      restrict = normalized;
    }
    const result = chatQueue.enqueue({
      assignee: target,
      ...(restrict ? { restrictWorkspace: restrict } : {}),
      text: trimmed,
      images: [],
      source: 'control'
    });
    if (!result.ok || !result.id) return { queued: false, position: -1, reason: result.reason };
    // 中控投的任務進帳本(status queued;綁定單即知接收者,公用池單記限定工作區)
    const record: ControlTaskRecord = {
      id: result.id,
      text: ledgerSummary(trimmed),
      source: 'control',
      status: 'queued',
      enqueuedAt: Date.now()
    };
    if (target) {
      record.assignee = target;
      const profile = pets.get(target);
      if (profile?.name) record.assigneeName = profile.name;
      if (profile?.workspacePath) record.workspacePath = profile.workspacePath;
    } else if (restrict) {
      record.workspacePath = restrict;
    }
    taskLedger.set(record.id, record);
    // enqueue 不自動派發:綁定單派給指定寵;公用池單讓任一合格閒置寵立刻領走
    if (target) chatDispatcher.dispatch(target);
    else chatDispatcher.dispatchAll();
    scheduleControlStatusHook?.();
    return { queued: true, position: result.position };
  });
  ipcMain.handle('control-status-get', (event) => {
    if (!controlWin || event.sender !== controlWin.webContents) return null;
    return buildControlStatus(); // 開窗初始化:晚開視窗只靠事件流會漏掉進行中的 turn
  });
  ipcMain.handle('chat-unbound-remove', (event, taskId: string): boolean => {
    if (!controlWin || event.sender !== controlWin.webContents) return false;
    const removed = chatQueue.removeUnbound(String(taskId)); // 內部 onChanged(undefined) 會自動重推快照
    if (removed) markLedgerRemoved(String(taskId));
    return removed;
  });
  ipcMain.on('open-sandbox-settings', (event, petId: string) => {
    if (!controlWin || event.sender !== controlWin.webContents) return;
    // 只開既有獨立視窗,不內嵌——sandbox-settings-get/set 的視窗隔離是刻意的安全設計
    openSandboxSettings(String(petId));
  });
  ipcMain.on('system-restart', (event) => {
    if (!controlWin || event.sender !== controlWin.webContents) return;
    restartApp();
  });
  ipcMain.on('system-quit', (event) => {
    if (!controlWin || event.sender !== controlWin.webContents) return;
    // app.exit 不觸發 before-quit,清理要自己做(同 Tray 結束;已知坑,見 DEVLOG §22)
    shutdownSync();
    app.exit(0);
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
  // 主顯示器變更(換螢幕/改解析度/闔蓋切外接)時,疊層要跟著鋪滿新的主顯示——
  // 視窗不會自己調整;不同步的話新螢幕比舊視窗寬的部分成為界外,寵物站在那裡就被切掉。
  function syncOverlayBounds(): void {
    if (!win || win.isDestroyed()) return;
    const target = screen.getPrimaryDisplay().bounds;
    const current = win.getBounds();
    if (
      current.x !== target.x || current.y !== target.y ||
      current.width !== target.width || current.height !== target.height
    ) {
      win.setBounds(target);
    }
    overlayBounds = win.getBounds();
  }
  syncOverlayBounds();
  screen.on('display-metrics-changed', syncOverlayBounds);
  screen.on('display-added', syncOverlayBounds);
  screen.on('display-removed', syncOverlayBounds);

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

  /** 輪詢頻率 = 檔位 × 有沒有醒著的寵物(全休息時輪詢沒有意義)。拖曳偵測 helper 同進退。 */
  function refreshCursorPoll(): void {
    const alive = powerTier !== 'suspended' && anyPetEnabled();
    if (!alive) setCursorPoll(null);
    else setCursorPoll(POWER_TIERS[(powerTier ?? 'normal') as keyof typeof POWER_TIERS].pollMs);
    dragMonitor?.setActive(alive);
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

  /* ── 檔案拖曳 → 寵物接收窗(拖放參考檔案的正式通道)──
   * 疊層視窗(透明+panel+不可聚焦+screen-saver 層)實測收不到任何拖放事件,連從啟動就
   * 永遠可互動也一樣(2026-07 實驗)。唯一可行解仿 Finder 彈簧資料夾:偵測到檔案拖曳的
   * 瞬間,在每隻寵物位置亮出「一般屬性」(不透明/可聚焦/floating)的小接收窗,拖完即收。 */
  const dropWindows = new Map<string, BrowserWindow>();
  let dragActive = false;

  function destroyDropWindows(): void {
    for (const dropWin of dropWindows.values()) {
      if (!dropWin.isDestroyed()) dropWin.destroy();
    }
    dropWindows.clear();
  }

  const dropPage = (petId: string, name: string): string =>
    'data:text/html;charset=utf-8,' + encodeURIComponent(`
    <body style="margin:0;height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
      font:12px system-ui;color:#f4f1fa;background:#38324e;border:1.5px dashed rgba(200,190,235,0.55);
      border-radius:10px;text-align:center;cursor:copy;letter-spacing:0.02em;">
      <div style="opacity:0.95;">📎 放開加入參考檔案<br/><b style="font-size:13px;">${name.replace(/[<>&]/g, '')}</b></div>
      <script>
        addEventListener('dragover', (e) => { e.preventDefault(); document.body.style.background = '#4a4170'; });
        addEventListener('dragleave', () => { document.body.style.background = '#38324e'; });
        addEventListener('drop', (e) => {
          e.preventDefault();
          const paths = [...e.dataTransfer.files].map((f) => window.pet.getFilePath(f)).filter(Boolean);
          if (paths.length) window.pet.addRefFiles(${JSON.stringify(petId)}, paths);
        });
      <\/script>
    </body>`);

  function showDropWindows(rects: { petId: string; name: string; left: number; top: number; right: number; bottom: number }[]): void {
    destroyDropWindows();
    for (const rect of rects) {
      const profile = pets.get(rect.petId);
      if (!profile || profile.enabled === false) continue;
      const width = Math.round(Math.min(Math.max(rect.right - rect.left, 170), 480));
      const height = Math.round(Math.min(Math.max(rect.bottom - rect.top, 110), 600));
      const centerX = overlayBounds.x + (rect.left + rect.right) / 2;
      const centerY = overlayBounds.y + (rect.top + rect.bottom) / 2;
      const dropWin = new BrowserWindow({
        width, height,
        x: Math.round(centerX - width / 2),
        y: Math.round(centerY - height / 2),
        frame: false, resizable: false, movable: false, skipTaskbar: true, show: false,
        webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false }
      });
      dropWin.setAlwaysOnTop(true, 'floating');
      // 半透明用 setOpacity 而非 transparent 視窗——實驗證明 transparent 那組屬性收不到拖放
      dropWin.setOpacity(0.72);
      void dropWin.loadURL(dropPage(rect.petId, profile.name));
      dropWin.once('ready-to-show', () => {
        if (!dropWin.isDestroyed() && dragActive) dropWin.showInactive(); // 不搶焦點
      });
      dropWindows.set(rect.petId, dropWin);
    }
  }

  ipcMain.on('pet-rects', (event, rects: { petId: string; name: string; left: number; top: number; right: number; bottom: number }[]) => {
    if (!win || event.sender !== win.webContents || !Array.isArray(rects) || !dragActive) return;
    showDropWindows(rects);
  });

  dragMonitor = createDragMonitor({
    onStart: () => {
      if (powerTier === 'suspended' || ![...pets.values()].some((p) => p.enabled !== false)) return;
      dragActive = true;
      win?.webContents.send('pet-rects-request'); // 寵物的螢幕矩形只有 renderer 知道(投影後)
    },
    onEnd: () => {
      dragActive = false;
      // drop 事件與放開左鍵幾乎同時:緩 300ms 讓接收窗先把 drop 處理完再收
      setTimeout(() => {
        if (!dragActive) destroyDropWindows();
      }, 300);
    }
  });
  refreshCursorPoll(); // dragMonitor 建立後同步一次啟停狀態(開機時全寵休息的情境)

  // VRM_PET_PERF_LOG=1:每 5 秒把 renderer 的 render/rAF 比例印到終端機。
  // 疊層開不了 DevTools(平台限制),這是唯一能在真 overlay 上讀 __perf 的通道;
  // 比例是節流機制不變量:閒置該 ≈1/idleSkip,持續 ≈1.0 = 有東西一直在喚醒渲染。
  if (process.env['VRM_PET_PERF_LOG'] === '1') {
    let last = { raf: 0, ren: 0, pos: 0 };
    setInterval(() => {
      void (async () => {
        try {
          const perf = await win?.webContents.executeJavaScript('window.__perf') as
            { rafTicks: number; renderedFrames: number; bubblePositions: number } | undefined;
          if (!perf) return;
          const dRaf = perf.rafTicks - last.raf;
          const dRen = perf.renderedFrames - last.ren;
          const dPos = perf.bubblePositions - last.pos;
          last = { raf: perf.rafTicks, ren: perf.renderedFrames, pos: perf.bubblePositions };
          console.log(`[perf] 5s: rAF=${dRaf} render=${dRen} ratio=${dRaf ? (dRen / dRaf).toFixed(2) : '-'} bubblePos=${dPos}`);
        } catch { /* renderer 重載間隙 */ }
      })();
    }, 5_000);
  }

  const icon = nativeImage.createFromDataURL(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('VRM 桌寵');
  tray.setContextMenu(petMenu(registry.selectedPetId));
});

app.on('window-all-closed', () => { /* 常駐 */ });
app.on('before-quit', shutdownSync);
