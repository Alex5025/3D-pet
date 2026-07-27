import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync, watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import type { AgentBinding } from '../shared/agentEvents';
import type { AgentBridge } from './agent/bridge';
import { createAgentBridge } from './agent/bridge';
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
  vrmPath?: string;
  state?: PetState;
  lighting?: Lighting;
  sway?: Sway;
  wardrobe?: Record<string, boolean>;
  defaultPose?: string;
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
  } catch (error) {
    console.log('[main] config flush failed', error);
  }
}

function scheduleConfigFlush(): void {
  if (configFlush) clearTimeout(configFlush);
  configFlush = setTimeout(persistConfigSync, 500);
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
  void bridge?.closePetSession(id);
  registry.petIds = registry.petIds.filter((petId) => petId !== id);
  if (registry.selectedPetId === id) registry.selectedPetId = registry.petIds[0]!;
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
    { label: '工作設定…', click: () => openSettings('project', petId) },
    { label: '播放動作', submenu: motionMenuItems(petId) },
    { label: '預設姿勢', submenu: defaultPoseMenuItems(petId) },
    { label: '停止動作', click: () => win?.webContents.send('vrma-stop', petId) },
    { label: '調整燈光…', click: () => openSettings('light', petId) },
    { label: '角色調整…', click: () => openSettings('char', petId) },
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
    { label: '結束', click: () => { bridge?.shutdownSync(); persistConfigSync(); app.exit(0); } }
  ]);
}

function openSettings(tab: 'light' | 'char' | 'project' = 'light', petId?: string): void {
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
  bridge = createAgentBridge({
    getPet: (id) => pets.get(id) ?? null,
    updatePet,
    send: (petId, event) => win?.webContents.send('chat-event-apply', petId, event),
    providers: createProviders()
  });
  await refreshMotions();
  try {
    watch(join(dataDir(), 'motions'), () => void refreshMotions().then(refreshTray));
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
    if (patch.agent && (patch.agent.kind === 'codex' || patch.agent.kind === 'claude')) {
      const sessionId = typeof patch.agent.sessionId === 'string' ? patch.agent.sessionId.trim() : '';
      const model = typeof patch.agent.model === 'string' ? patch.agent.model.trim() : '';
      const effort = typeof patch.agent.effort === 'string' &&
        ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(patch.agent.effort) ? patch.agent.effort : '';
      next.agent = {
        kind: patch.agent.kind,
        ...(sessionId ? { sessionId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {})
      };
      // 換 agent 種類 = 換家,不共享 session:關掉舊的
      if (profile.agent?.kind && profile.agent.kind !== patch.agent.kind) void bridge?.closePetSession(id);
    }
    const updated = updatePet(id, next); // enabled=false 時的快取釋放已內建於 updatePet
    sendPetProfiles();
    return updated;
  });
  ipcMain.handle('choose-workspace', (_event, id: string) => chooseWorkspace(id));

  // 模型清單:codex 要跟 app-server 要(首次會 lazy 啟動),成功才快取(失敗可能只是還沒登入,下次再試)
  const modelListCache = new Map<string, unknown[]>();
  ipcMain.handle('agent-models', async (_event, kind: string) => {
    if (kind !== 'codex' && kind !== 'claude') return [];
    const cached = modelListCache.get(kind);
    if (cached) return cached;
    const list = (await bridge?.listModels(kind)) ?? [];
    if (list.length) modelListCache.set(kind, list);
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

  ipcMain.handle('get-boot-vrm', async (_event, id: string) => {
    const path = getPet(id)?.vrmPath;
    if (!path) return null;
    try {
      return await readFile(path);
    } catch {
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
  let cursorTimer: NodeJS.Timeout | null = null;
  let lastX = -1e9;
  let lastY = -1e9;
  let sameCount = 0;
  win.webContents.on('did-finish-load', () => {
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const point = screen.getCursorScreenPoint();
      if (point.x === lastX && point.y === lastY && ++sameCount < 33) return;
      sameCount = 0;
      lastX = point.x;
      lastY = point.y;
      win.webContents.send('cursor', { x: point.x - overlayBounds.x, y: point.y - overlayBounds.y });
    }, 30);
  });

  const icon = nativeImage.createFromDataURL(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('VRM 桌寵');
  tray.setContextMenu(petMenu(registry.selectedPetId));
});

app.on('window-all-closed', () => { /* 常駐 */ });
app.on('before-quit', () => {
  bridge?.shutdownSync();
  persistConfigSync();
});
