import type { HistoryStore } from './historyStore';
import { BrowserWindow, app, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHARACTER_KEYS } from '../shared/character';
import { LOCALES, resolveLocale, setLocale, t, type Locale } from '../shared/i18n';
import type { LocalPet, PetProject } from '../shared/projects';
import type { AgentBridge } from './agent/bridge';
import { appPrompt } from './appPrompt';
import { CharacterStore, applyCharacter, characterParameters, modelHash } from './characterStore';
import { createResourceScope } from './resourceScope';
import type { AppRegistry, PetProfile, PetState } from './runtimeTypes';
import { SettingsStore, migrateSettings } from './settingsStore';
import { ensurePetWorkspace } from './workspaceDefaults';

export interface CharactersDeps {
  readonly history?: HistoryStore;
  readonly runtimeDataDir: () => string;
  readonly settingsWin: BrowserWindow | null;
  readonly sendRefFiles: ((id: string) => void);
  readonly defaultVrmPath: () => string;
  readonly modelsDir: () => string;
  readonly clearChatQueue: ((petId: string) => void);
  readonly bridge: AgentBridge | null;
  readonly dispatchAll: (() => void);
  readonly refreshCursorPoll: (() => void);
  readonly scheduleIdleMotion: (petId: string) => void;
  readonly win: BrowserWindow | null;
  readonly controlWin: BrowserWindow | null;
  readonly scheduleControlStatus: (() => void);
  readonly refreshTray: () => void;
  readonly clearTranscript: ((petId: string) => void);
  readonly cancelIdleMotion: (id: string) => void;
}

/** characters 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createCharacters(deps: CharactersDeps) {
  const scope = createResourceScope();

  const DEFAULT_STATE: PetState = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };

  let registry: AppRegistry;

  const pets = new Map<string, PetProfile>();

  const avatarIcons = new Map<string, { front: string; side: string; }>();

  const wardrobeLists = new Map<string, { key: string; label: string; }[]>();

  const settings = new SettingsStore(join(deps.runtimeDataDir(), 'app.yaml'), deps.history);

  let settingsReady = false;

  let characters = new CharacterStore(process.env['VRM_PET_SHARED_CHARACTERS'] ?? join(app.getPath('appData'), 'VRM Pet', 'runtime-data', 'characters.yaml'));

  let characterOperation: Promise<unknown> = Promise.resolve();

  function serializeCharacter<T>(operation: () => Promise<T>): Promise<T> {
    const result = characterOperation.then(operation);
    characterOperation = result.catch(() => { });
    return result;
  }

  let storageError = '';

  function reportStorageError(error: unknown): void {
    storageError = error instanceof Error ? error.message : String(error);
    deps.settingsWin?.webContents.send('character-storage-error', storageError);
  }

  function localPet(profile: PetProfile): LocalPet {
    return {
      id: profile.id, name: profile.name, enabled: profile.enabled, projects: profile.projects ?? [],
      workspacePath: profile.workspacePath, state: profile.state, personaVersion: profile.personaVersion
    };
  }

  function projectFor(profile: PetProfile, path = profile.workspacePath): PetProject | undefined {
    return profile.projects?.find((p) => p.workspacePath === path);
  }

  function selectProject(profile: PetProfile, path: string): boolean {
    const project = projectFor(profile, path);
    if (!project) return false;
    profile.workspacePath = path;
    profile.agent = project.agent;
    deps.sendRefFiles?.(profile.id);
    scheduleConfigFlush();
    sendPetProfiles();
    return true;
  }

  /** 預設工作根目錄：供新寵物及啟動時缺少工作目錄的角色使用。 */
  const workspaceRoot = (): string =>
    registry.defaultWorkspaceRoot ?? join(app.getPath('documents'), 'PetWorkspaces');

  function normalizeProfile(value: Partial<PetProfile>, index: number): PetProfile {
    const id = typeof value.id === 'string' && value.id ? value.id : randomUUID();
    const profile: PetProfile = {
      ...value,
      id,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : t('common.defaultPetName', { n: index + 1 }),
      enabled: value.enabled !== false,
      characterReady: false,
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
        name: t('common.defaultPetName', { n: index + 1 }),
        enabled: true,
        state: { ...DEFAULT_STATE, x: offset }
      },
      index
    );
  }

  /** 設定異動立即原子落盤；角色資料先寫入，啟動索引最後更新。 */
  function persistConfigSync(): void {
    try {
      if (!settingsReady) return;
      characters.flush();
      settings.save({
        initialized: true, selectedPetId: registry.selectedPetId,
        defaultWorkspaceRoot: registry.defaultWorkspaceRoot, locale: registry.locale,
        pets: [...pets.values()].map(localPet),
      });
      storageError = '';
      deps.settingsWin?.webContents.send('character-storage-error', '');
    } catch (error) {
      reportStorageError(error);
      console.log('[main] config flush failed', error);
    }
  }

  function scheduleConfigFlush(): void {
    persistConfigSync();
  }

  async function loadConfig(): Promise<void> {
    const boot = await migrateSettings(settings, deps.defaultVrmPath(), characters.filePath, {
      model: async (path, name) => {
        await appPrompt({ message: `「${name}」的模型路徑已失效，請重新選擇模型。`, detail: path, buttons: ['選擇模型', '取消'], cancelId: 1 }).then((answer) => { if (answer.response === 1) throw new Error('已取消修復'); });
        const result = await dialog.showOpenDialog({ title: `修復 ${name} 的模型路徑`, defaultPath: deps.modelsDir(), properties: ['openFile'], filters: [{ name: 'VRM', extensions: ['vrm'] }] });
        return result.filePaths[0] ?? null;
      },
      parameters: async (existing, incoming) => {
        const result = await appPrompt({
          message: '同一角色 ID 有不同版本的設定，請選擇要保留的版本。',
          detail: `既有設定：\n${JSON.stringify(existing, null, 2)}\n\n待匯入設定：\n${JSON.stringify(incoming, null, 2)}`,
          buttons: [`保留 ${existing.name}`, `採用 ${incoming.name}`, '取消'], cancelId: 2
        });
        return result.response === 0 ? 'existing' : result.response === 1 ? 'incoming' : 'cancel';
      },
    }, process.env['VRM_PET_BASELINE_DIR']);
    deps.history?.importFromMarker(deps.runtimeDataDir(), boot);
    characters = new CharacterStore(boot.charactersPath);
    setLocale(boot.locale && LOCALES.includes(boot.locale as Locale) ? boot.locale as Locale : resolveLocale(app.getLocale()));
    for (const item of boot.pets) {
      const profile = normalizeProfile({ ...item, characterId: item.id }, pets.size);
      profile.agent = projectFor(profile)?.agent;
      pets.set(item.id, profile);
    }
    registry = {
      schemaVersion: 2, selectedPetId: boot.selectedPetId ?? boot.pets[0]?.id ?? '', petIds: boot.pets.map((p) => p.id),
      defaultWorkspaceRoot: boot.defaultWorkspaceRoot, locale: boot.locale as Locale | undefined
    };
    settingsReady = true;
  }

  function getPet(id?: string): PetProfile | null {
    return pets.get(id ?? registry.selectedPetId) ?? null;
  }

  function updatePet(id: string, patch: Partial<PetProfile>): PetProfile | null {
    const profile = pets.get(id);
    if (!profile) return null;
    if (!profile.characterLoaded && Object.keys(patch).some((key) => key !== 'enabled')) return profile;
    if (patch.enabled === true && !profile.characterReady) return profile;
    if (CHARACTER_KEYS.some((key) => key in patch)) {
      if (!profile.enabled || !profile.characterReady) return profile;
      try {
        const parameters = characterParameters({ ...profile, ...patch });
        if (profile.characterId) characters.update(profile.characterId, parameters);
      } catch (error) { reportStorageError(error); return profile; }
    }
    if (patch.agent) {
      const project = projectFor(profile);
      if (project) project.agent = patch.agent;
    }
    Object.assign(profile, patch, { id: profile.id });
    // 「休息 → 釋放快取 + 關 agent session」是 disable 的固有副作用:集中在這唯一變更點,
    // 不管來自選單、設定面板或未來任何路徑都一致(避免各處各記一份)。
    if (patch.enabled === false) {
      releasePetCaches(id);
      deps.clearChatQueue?.(id); // 休息 = 放下手邊任務,排隊中的一併清掉(公用池不受影響)
      void deps.bridge?.closePetSession(id);
    } else if (patch.enabled === true) {
      deps.dispatchAll?.(); // 喚醒的寵物可以去領公用池的單
    }
    if (patch.enabled !== undefined) deps.refreshCursorPoll?.();
    if (patch.enabled !== undefined || 'idleMotions' in patch) deps.scheduleIdleMotion(id);
    scheduleConfigFlush();
    return profile;
  }

  function releasePetCaches(id: string): void {
    avatarIcons.delete(id);
    wardrobeLists.delete(id);
  }

  async function wakeCharacter(profile: PetProfile): Promise<void> {
    characters.loadForWake();
    const saved = characters.get(profile.id);
    if (profile.characterId && !saved) throw new Error('characters.yaml 缺少此角色，請還原設定');
    if (saved) {
      const version = modelHash(Buffer.from(saved.parameters.persona ?? ''));
      if (profile.personaVersion !== version) {
        await deps.bridge?.closePetSession(profile.id);
        for (const project of profile.projects ?? []) if (project.agent) delete project.agent.sessionId;
      }
      profile.personaVersion = version;
      profile.vrmPath = saved.vrmPath;
      profile.agent = projectFor(profile)?.agent;
      applyCharacter(profile, saved.parameters);
    }
    if (!profile.workspacePath) throw new Error('請先選擇工作目錄');
    await bindCharacter(profile, profile.workspacePath, profile.vrmPath ?? deps.defaultVrmPath(), true);
    updatePet(profile.id, { enabled: true });
  }

  async function setPetEnabled(id: string, enabled: boolean): Promise<PetProfile | null> {
    return serializeCharacter(async () => {
      const profile = getPet(id);
      if (!profile) return null;
      if (enabled && !profile.enabled) {
        try { await wakeCharacter(profile); }
        catch (error) {
          profile.enabled = false;
          profile.characterReady = false;
          profile.characterError = `角色設定載入失敗：${String(error)}`;
          await appPrompt({ message: profile.characterError, buttons: ['確定'], cancelId: 0 });
        }
      } else if (!enabled) {
        updatePet(id, { enabled: false });
        profile.characterReady = false;
      }
      persistConfigSync();
      sendPetProfiles();
      return profile;
    });
  }

  function sendPetProfiles(): void {
    const profiles = [...pets.values()];
    deps.win?.webContents.send('pet-profiles-apply', profiles, registry.selectedPetId);
    deps.settingsWin?.webContents.send('pet-profiles-apply', profiles, registry.selectedPetId);
    deps.controlWin?.webContents.send('pet-profiles-apply', profiles, registry.selectedPetId);
    deps.scheduleControlStatus?.(); // 名稱/啟用/工作目錄變更都經過這裡,中控快照跟著重推
    deps.refreshTray();
  }

  function selectPet(id: string): PetProfile | null {
    const profile = pets.get(id);
    if (!profile) return null;
    registry.selectedPetId = id;
    scheduleConfigFlush();
    deps.refreshTray();
    deps.settingsWin?.webContents.send('selected-pet-apply', id);
    const icons = avatarIcons.get(id);
    if (icons) deps.settingsWin?.webContents.send('avatar-icons-apply', id, icons);
    const list = wardrobeLists.get(id);
    if (list) deps.settingsWin?.webContents.send('wardrobe-list-apply', id, list);
    return profile;
  }

  /** 先完成讀檔及角色 ID 驗證，成功後才改變目前綁定。 */
  async function bindCharacter(profile: PetProfile, workspace: string, path: string, waking = false): Promise<void> {
    const bytes = await readFile(path);
    const hash = modelHash(bytes);
    if (!waking && !profile.characterLoaded) throw new Error('請先喚醒寵物以載入完整設定');
    characters.flush();
    const id = profile.id;
    const initial = characterParameters(profile);
    const document = characters.resolve(path, hash, initial, !!profile.characterId, id);
    if (!pets.has(profile.id)) throw new Error('桌寵已移除');
    profile.workspacePath = workspace;
    profile.vrmPath = path;
    profile.characterId = id;
    profile.characterReady = waking || profile.enabled;
    profile.characterLoaded = true;
    profile.characterRevision = (profile.characterRevision ?? 0) + 1;
    delete profile.characterError;
    applyCharacter(profile, document.parameters);
    releasePetCaches(profile.id);
    deps.scheduleIdleMotion(profile.id);
    if (!waking) { persistConfigSync(); sendPetProfiles(); }
    // 完整設定由 profile 廣播套用；模型由 renderer 依角色版本重建，避免兩次載入競態。
  }

  async function pushVrm(petId: string, path: string): Promise<void> {
    await serializeCharacter(async () => {
      const profile = getPet(petId);
      if (!profile) return;
      if (!profile.workspacePath) {
        await appPrompt({ message: '請先喚醒寵物以載入完整設定', buttons: ['確定'], cancelId: 0 });
        return;
      }
      try { await bindCharacter(profile, profile.workspacePath, path); }
      catch (error) {
        await appPrompt({ message: String(error), buttons: ['確定'], cancelId: 0 });
      }
    });
  }

  /** 啟動僅還原原先啟用的桌寵；休息中的桌寵不讀 YAML 或模型。 */
  async function initializeCharacters(): Promise<void> {
    for (const profile of pets.values()) {
      const enabled = profile.enabled;
      profile.enabled = false;
      profile.characterReady = false;
      if (!enabled) continue;
      try { await wakeCharacter(profile); }
      catch (error) {
        profile.characterError = `角色設定載入失敗（原檔已保留）：${String(error)}`;
      }
    }
    persistConfigSync();
  }

  async function chooseVrm(petId: string, parent?: BrowserWindow): Promise<void> {
    app.focus({ steal: true });
    const options: Electron.OpenDialogOptions = {
      defaultPath: deps.modelsDir(),
      properties: ['openFile'],
      filters: [{ name: 'VRM', extensions: ['vrm'] }]
    };
    // 有父視窗時掛成 sheet(循 chooseWorkspace 慣例):無父的對話框是 app 層級 modal,
    // 開著時會凍結設定面板等其他視窗,使用者容易以為面板壞掉。
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths[0]) await pushVrm(petId, result.filePaths[0]);
  }

  async function chooseWorkspace(petId: string, parent?: BrowserWindow): Promise<string | null> {
    const profile = getPet(petId);
    if (!profile) return null;
    app.focus({ steal: true });
    parent?.focus();
    const options: Electron.OpenDialogOptions = {
      title: t('dialog.chooseWorkspace'),
      buttonLabel: t('common.select'),
      defaultPath: profile.workspacePath ?? app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return profile.workspacePath ?? null;
    await serializeCharacter(async () => {
      try {
        const canonical = realpathSync.native(path);
        profile.projects ??= [];
        if (!projectFor(profile, canonical)) profile.projects.push({ workspacePath: canonical });
        selectProject(profile, canonical);
        persistConfigSync();
      }
      catch (error) { await appPrompt({ message: String(error), buttons: ['確定'], cancelId: 0 }); }
    });
    return profile.workspacePath ?? null;
  }

  async function createNewPet(): Promise<PetProfile> {
    const result = await dialog.showOpenDialog({ title: '選擇新寵物模型', defaultPath: deps.modelsDir(), properties: ['openFile'], filters: [{ name: 'VRM', extensions: ['vrm'] }] });
    if (result.canceled || !result.filePaths[0]) return getPet()!;
    const profile = createProfile();
    profile.vrmPath = result.filePaths[0];
    profile.enabled = false;
    characters.loadForWake(); // 新增寵物也是一次明確的喚醒操作。
    ensurePetWorkspace(workspaceRoot(), profile);
    if (profile.workspacePath) {
      profile.workspacePath = realpathSync.native(profile.workspacePath);
      profile.projects = [{ workspacePath: profile.workspacePath }];
    }
    pets.set(profile.id, profile);
    try { await wakeCharacter(profile); }
    catch (error) { pets.delete(profile.id); throw error; }
    registry.petIds.push(profile.id);
    registry.selectedPetId = profile.id;
    deps.refreshCursorPoll?.();
    persistConfigSync();
    sendPetProfiles();
    return profile;
  }

  function removePet(id: string): boolean {
    if (pets.size <= 1 || !pets.has(id)) return false;
    // 移除本世界的角色引用，不刪除其他世界仍使用的共用角色。
    pets.delete(id);
    releasePetCaches(id);
    deps.clearChatQueue?.(id);
    deps.clearTranscript?.(id); // 寵物刪了,對話紀錄不留在磁碟上
    deps.cancelIdleMotion(id);
    void deps.bridge?.closePetSession(id);
    registry.petIds = registry.petIds.filter((petId) => petId !== id);
    if (registry.selectedPetId === id) registry.selectedPetId = registry.petIds[0]!;
    deps.refreshCursorPoll?.(); // 刪掉最後一隻醒著的寵物時停輪詢
    persistConfigSync();
    sendPetProfiles();
    return true;
  }

  function resetState(petId: string): void {
    const state = { ...DEFAULT_STATE };
    updatePet(petId, { state });
    deps.win?.webContents.send('apply-state', petId, state);
    deps.settingsWin?.webContents.send('apply-state', petId, state);
  }

  /** 只重建指定寵物的 agent/runtime；設定與已持久化 session 保留，下一句可 resume。 */
  async function restartPet(petId: string): Promise<void> {
    const profile = getPet(petId);
    if (!profile?.enabled) return;
    try {
      // provider 正在等待外部程序時 close 可能拖很久；角色重建不可被它無限卡住。
      await Promise.race([
        deps.bridge?.closePetSession(petId) ?? Promise.resolve(),
        new Promise<void>((resolve) => scope.timeout(resolve, 2_000)),
      ]);
    } finally {
      deps.win?.webContents.send('pet-runtime-restart', petId);
    }
  }

  function start() {
    if (!scope.start()) return;

  }
  function prepareStore(): void {
    const boot = settings.loadRaw();
    if (boot.schemaVersion === 2 && typeof boot.charactersPath === 'string') characters = new CharacterStore(boot.charactersPath);
  }
  return {
    prepareStore,
    get settings() { return settings; },
    get characters() { return characters; },
    get loadConfig() { return loadConfig; },
    get initializeCharacters() { return initializeCharacters; },
    get pets() { return pets; },
    get persistConfigSync() { return persistConfigSync; },
    get selectPet() { return selectPet; },
    get registry() { return registry; },
    get getPet() { return getPet; },
    get chooseVrm() { return chooseVrm; },
    get resetState() { return resetState; },
    get restartPet() { return restartPet; },
    get setPetEnabled() { return setPetEnabled; },
    get serializeCharacter() { return serializeCharacter; },
    get createNewPet() { return createNewPet; },
    get projectFor() { return projectFor; },
    get scheduleConfigFlush() { return scheduleConfigFlush; },
    get updatePet() { return updatePet; },
    get sendPetProfiles() { return sendPetProfiles; },
    get removePet() { return removePet; },
    get avatarIcons() { return avatarIcons; },
    get wardrobeLists() { return wardrobeLists; },
    get pushVrm() { return pushVrm; },
    get storageError() { return storageError; },
    get reportStorageError() { return reportStorageError; },
    get selectProject() { return selectProject; },
    get chooseWorkspace() { return chooseWorkspace; },
    get workspaceRoot() { return workspaceRoot; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Characters = ReturnType<typeof createCharacters>;
