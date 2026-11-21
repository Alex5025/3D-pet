import { cpSync, copyFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HistoryStore } from './historyStore';
import { randomUUID } from 'node:crypto';
import { atomicYaml, characterParameters, modelHash, parseCharacterYaml, parseStoredCharacter, signature, writeCharacters, migrateCharacterDatabase, CharacterStore } from './characterStore';
import type { CharacterDocument, CharacterParameters } from '../shared/character';
import type { LocalPet, PetProject } from '../shared/projects';
import type { AgentBinding } from '../shared/agentEvents';

/** 記憶體中的完整快照；磁碟上的啟動 YAML 使用 schemaVersion 3。 */
export interface BootSettings {
  schemaVersion: 2;
  initialized: boolean;
  port: number;
  charactersPath: string;
  selectedPetId?: string;
  defaultWorkspaceRoot?: string;
  locale?: string;
  pets: LocalPet[];
}
/** 所有可即時修改的欄位只存在本地 SQLite。 */
export type LiveSettings = Pick<BootSettings, 'initialized' | 'selectedPetId' | 'defaultWorkspaceRoot' | 'locale' | 'pets'>;
function liveSettings(boot: BootSettings): LiveSettings {
  return { initialized: boot.initialized, selectedPetId: boot.selectedPetId,
    defaultWorkspaceRoot: boot.defaultWorkspaceRoot, locale: boot.locale, pets: boot.pets };
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseBoot(raw: unknown): BootSettings {
  if (!record(raw) || raw.schemaVersion !== 2 || typeof raw.charactersPath !== 'string' || !raw.charactersPath || !Number.isInteger(raw.port)
    || Number(raw.port) < 1024 || Number(raw.port) > 65535 || typeof raw.initialized !== 'boolean' || !Array.isArray(raw.pets)) throw new Error('app.yaml 格式或 port 無效');
  const ids = new Set<string>();
  for (const pet of raw.pets) {
    if (!record(pet) || typeof pet.id !== 'string' || !pet.id || ids.has(pet.id) || typeof pet.name !== 'string' || typeof pet.enabled !== 'boolean' || !Array.isArray(pet.projects)) throw new Error('角色設定清單無效');
    ids.add(pet.id);
    const paths = new Set<string>();
    for (const project of pet.projects) {
      if (!record(project) || typeof project.workspacePath !== 'string' || !project.workspacePath) throw new Error('專案路徑無效');
      // 不要求離線或已搬走的專案在啟動時可存取；加入及執行時另驗證實體路徑。
      if (existsSync(project.workspacePath)) project.workspacePath = realpathSync.native(project.workspacePath);
      if (paths.has(project.workspacePath as string)) throw new Error('同一角色不可重複綁定專案');
      paths.add(project.workspacePath as string);
      if (project.agent !== undefined) {
        const agent = project.agent;
        if (!record(agent) || !['codex', 'claude', 'agy'].includes(String(agent.kind))) throw new Error('專案 Agent 無效');
        for (const key of ['sessionId', 'model', 'effort', 'permission']) if (agent[key] !== undefined && typeof agent[key] !== 'string') throw new Error('專案 Agent 欄位無效');
      }
    }
    if (typeof pet.workspacePath === 'string' && existsSync(pet.workspacePath)) pet.workspacePath = realpathSync.native(pet.workspacePath);
    if (pet.workspacePath !== undefined && (typeof pet.workspacePath !== 'string' || !paths.has(pet.workspacePath))) throw new Error('選取專案不屬於角色');
  }
  if (raw.initialized && (!ids.size || typeof raw.selectedPetId !== 'string' || !ids.has(raw.selectedPetId))) throw new Error('設定選取角色無效');
  return raw as unknown as BootSettings;
}
export class SettingsStore {
  private cached: Record<string, unknown> = { schemaVersion: 1, initialized: false, port: 5173, pets: [] };
  private readonly history: HistoryStore;
  private readonly ownsHistory: boolean;
  constructor(readonly filePath: string, history?: HistoryStore) {
    this.ownsHistory = !history;
    this.history = history ?? new HistoryStore(join(dirname(filePath), 'history.sqlite'));
  }
  /** 先提交可重試的 SQLite 匯入，再發布只含啟動欄位的 YAML。 */
  private initialize(boot: BootSettings): BootSettings {
    const before = signature(this.filePath);
    const path = migrateCharacterDatabase(boot.charactersPath);
    const backup = `${this.filePath}.pre-sqlite.bak`;
    if (before !== null && !existsSync(backup)) copyFileSync(this.filePath, backup, constants.COPYFILE_EXCL);
    if (signature(this.filePath) !== before) throw new Error('app.yaml 遷移來源正在被修改');
    this.history.importLiveSettings(liveSettings(boot), next => { parseBoot({ ...boot, ...next }); });
    if (signature(this.filePath) !== before) throw new Error('app.yaml 遷移來源正在被修改');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const migrated = parseBoot({ schemaVersion: 2, port: boot.port, charactersPath: path, ...this.history.liveSettings() });
    atomicYaml(this.filePath, { schemaVersion: 3, port: boot.port, charactersPath: path });
    return migrated;
  }
  loadRaw(): Record<string, unknown> {
    const before = signature(this.filePath);
    const text = before === null ? null : readFileSync(this.filePath, 'utf8');
    this.history.reconcileSettings(text); // 完成舊版尚未結束的 YAML 寫入紀錄。
    if (text !== null) {
      const raw = parseCharacterYaml(text);
      if (!record(raw) || ![1, 2, 3].includes(Number(raw.schemaVersion))) throw new Error('app.yaml 版本無效');
      if (signature(this.filePath) !== before) throw new Error('app.yaml 正在被外部修改');
      if (raw.schemaVersion === 3) {
        if (Object.keys(raw).some(key => !['schemaVersion', 'port', 'charactersPath'].includes(key))) throw new Error('app.yaml 只接受啟動設定；即時設定請由介面修改');
        const live = this.history.liveSettings();
        if (!live) throw new Error('缺少本地即時設定資料庫，請還原 history.sqlite；不會從舊 YAML 覆蓋資料');
        this.cached = parseBoot({ schemaVersion: 2, port: raw.port, charactersPath: raw.charactersPath, ...live }) as unknown as Record<string, unknown>;
      } else if (raw.schemaVersion === 2 && raw.initialized === true) {
        this.cached = this.initialize(parseBoot(raw)) as unknown as Record<string, unknown>;
      } else this.cached = raw;
    }
    return structuredClone(this.cached);
  }
  load(): BootSettings { return parseBoot(this.loadRaw()); }
  snapshot(): BootSettings { return parseBoot(structuredClone(this.cached)); }
  save(patch: Partial<BootSettings>, characters?: CharacterStore, reset?: { petId: string; workspace: string }): void {
    const next = parseBoot({ ...this.cached, ...patch });
    if (this.cached.schemaVersion !== 2 || this.cached.initialized !== true) {
      this.cached = this.initialize(next) as unknown as Record<string, unknown>;
      return;
    }
    if (next.port !== this.cached.port || next.charactersPath !== this.cached.charactersPath) throw new Error('啟動設定請修改 app.yaml，重啟後生效');
    // 一般儲存不讀寫 YAML，外部修改 port 不影響本次即時設定提交。
    this.history.saveLiveSettings(liveSettings(next), characters, reset);
    this.cached = structuredClone(next) as unknown as Record<string, unknown>;
  }
  close(): void { if (this.ownsHistory) this.history.close(); }
}
export interface MigrationChoices {
  model(path: string, name: string): Promise<string | null>;
  parameters(existing: CharacterParameters, incoming: CharacterParameters): Promise<'existing' | 'incoming' | 'cancel'>;
}
/** 一次性初始化才讀完整角色；一般啟動讀啟動 YAML 及本地 SQLite。衝突必須由使用者選擇。 */
export async function migrateSettings(store: SettingsStore, defaultModel: string, sharedPath: string, choices: MigrationChoices, baseline?: string): Promise<BootSettings> {
  const boot = store.loadRaw();
  if (boot.schemaVersion === 2 && boot.initialized === true) return parseBoot(boot);
  if (/\.sqlite$/i.test(sharedPath) && !existsSync(sharedPath)) sharedPath = sharedPath.replace(/\.sqlite$/i, '.yaml');
  const runtime = dirname(store.filePath);
  const ownData = dirname(runtime);
  const hasOwn = boot.initialized === true || ['app.json', 'characters.yaml', 'config.json', 'pets'].some((n) => existsSync(join(runtime, n)));
  const sourceData = !hasOwn && baseline ? baseline : ownData;
  const copying = sourceData !== ownData;
  const source = copying ? join(sourceData, existsSync(join(sourceData, 'runtime_data', 'app.yaml')) ? 'runtime_data' : 'runtime-data') : runtime;
  const watched = new Map<string, string | null>();
  const read = (path: string, yaml = false): unknown => {
    const before = signature(path); watched.set(path, before);
    if (before === null) return null;
    const text = readFileSync(path, 'utf8');
    return yaml ? parseCharacterYaml(text) : JSON.parse(text) as unknown;
  };
  let sourceBoot = read(join(source, 'app.yaml'), true);
  if (record(sourceBoot) && sourceBoot.schemaVersion === 3) {
    const live = HistoryStore.readLiveSettings(join(source, 'history.sqlite'));
    if (!live) throw new Error('基準實例缺少即時設定資料庫');
    sourceBoot = { ...sourceBoot, ...live };
  }
  const registry = read(join(source, 'app.json'));
  const rawCharacters = record(sourceBoot) && sourceBoot.schemaVersion === 3 ? null : read(join(source, 'characters.yaml'), true);
  const oldDocs = record(rawCharacters) && Array.isArray(rawCharacters.characters) ? rawCharacters.characters as Record<string, unknown>[] : [];
  if (rawCharacters !== null && (!record(rawCharacters) || ![1, 2, 3].includes(Number(rawCharacters.schemaVersion)) || !Array.isArray(rawCharacters.characters))) throw new Error('舊角色 YAML 無效');
  // 已遷移的共用庫由 SQLite 讀取；舊 YAML 僅供首次升級。
  const databasePath = sharedPath.replace(/\.ya?ml$/i, '.sqlite');
  const existingDatabase = existsSync(databasePath);
  const sharedStore = existingDatabase ? new CharacterStore(sharedPath) : undefined;
  const globalSignature = signature(sharedPath);
  let globalRaw: unknown;
  if (existingDatabase) {
    sharedStore!.loadForWake();
    globalRaw = { schemaVersion: 3, characters: sharedStore!.all() };
  } else globalRaw = read(sharedPath, true);
  const globals = new Map<string, CharacterDocument>();
  if (record(globalRaw) && globalRaw.schemaVersion === 3 && Array.isArray(globalRaw.characters)) {
    for (const raw of globalRaw.characters) {
      const doc = parseStoredCharacter(raw);
      if (globals.has(doc.id)) throw new Error('共用角色 ID 重複');
      globals.set(doc.id, doc);
    }
  } else if (globalRaw !== null && sharedPath !== join(source, 'characters.yaml')) throw new Error('共用角色檔需先從原資料來源遷移');
  const existingGlobalIds = new Set(globals.keys());
  let profiles: Record<string, unknown>[] = [];
  let global: Record<string, unknown> = record(registry) ? registry : {};
  if (record(sourceBoot) && sourceBoot.initialized === true) {
    global = sourceBoot;
    if (!Array.isArray(sourceBoot.pets)) throw new Error('來源角色清單無效');
    profiles = sourceBoot.pets.map((pet: unknown) => {
      if (!record(pet)) throw new Error('來源角色無效');
      const doc = oldDocs.find((d) => d.id === pet.id) ?? [...globals.values()].find((d) => d.id === pet.id) as unknown as Record<string, unknown> | undefined;
      if (!doc) throw new Error(`缺少角色設定：${pet.name}`);
      return { ...(record(doc.runtime) ? doc.runtime : {}), ...(doc.parameters as object), ...pet,
        workspacePath: pet.workspacePath ?? doc.workspacePath, vrmPath: doc.vrmPath ?? (record(doc.runtime) ? doc.runtime.vrmPath : undefined) };
    });
  } else if (record(registry) && Array.isArray(registry.petIds)) {
    profiles = registry.petIds.map((id) => {
      if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('舊寵物 ID 無效');
      const raw = read(join(source, 'pets', `${id}.json`));
      if (!record(raw) || raw.id !== id) throw new Error(`缺少舊角色：${id}`);
      const doc = oldDocs.find((d) => d.id === raw.characterId);
      return { ...raw, ...(record(doc?.parameters) ? doc.parameters : {}) };
    });
  } else {
    const legacy = read(join(source, 'config.json')) ?? read(join(sourceData, 'config.json'));
    if (record(legacy)) { global = legacy; profiles = Array.isArray(legacy.pets) ? legacy.pets as Record<string, unknown>[] : [legacy]; }
  }
  if (!profiles.length && oldDocs.length) throw new Error('角色設定缺少啟動清單，請還原 app 設定');
  if (!profiles.length) profiles = [{ name: '我的寵物', enabled: false, vrmPath: defaultModel }];
  const locals = new Map<string, LocalPet>();
  const oldToNew = new Map<string, string>();
  for (const [index, profile] of profiles.entries()) {
    const parameters = characterParameters({ name: '我的寵物', ...profile });
    let vrmPath = typeof profile.vrmPath === 'string' ? profile.vrmPath : defaultModel;
    if (!existsSync(vrmPath)) {
      const replacement = await choices.model(vrmPath, parameters.name);
      if (!replacement) throw new Error('已取消模型路徑修復，原資料保留');
      vrmPath = replacement;
    }
    vrmPath = realpathSync.native(vrmPath);
    const hash = modelHash(readFileSync(vrmPath));
    // 缺少舊 ID 時以來源與記錄位置產生穩定識別，不能以 VRM 或名稱合併。
    const id = typeof profile.id === 'string' && profile.id ? profile.id
      : `legacy-${modelHash(Buffer.from(JSON.stringify([existsSync(sourceData) ? realpathSync.native(sourceData) : resolve(sourceData), index])))}`;
    let doc = globals.get(id);
    if (doc && !(copying && existingGlobalIds.has(id)) && JSON.stringify(doc.parameters) !== JSON.stringify(parameters)) {
      const decision = await choices.parameters(doc.parameters, parameters);
      if (decision === 'cancel') throw new Error('已取消角色設定整併，原資料保留');
      if (decision === 'incoming') doc = { ...doc, parameters, vrmPath, modelHash: hash };
    }
    doc ??= { schemaVersion: 1, id, modelHash: hash, vrmPath, parameters };
    globals.set(id, doc);
    if (typeof profile.id === 'string') oldToNew.set(profile.id, doc.id);
    let local = locals.get(doc.id);
    if (!local) {
      local = { id: doc.id, name: doc.parameters.name, enabled: !copying && profile.enabled !== false, projects: [], state: profile.state as LocalPet['state'] };
      locals.set(doc.id, local);
    }
    local.name = doc.parameters.name;
    let projects = Array.isArray(profile.projects) ? profile.projects as PetProject[] : [];
    if (!projects.length) {
      const path = typeof profile.workspacePath === 'string' ? profile.workspacePath : join(ownData, 'workspaces', doc.id);
      if (typeof profile.workspacePath !== 'string') mkdirSync(path, { recursive: true });
      projects = [{ workspacePath: path, agent: profile.agent as AgentBinding | undefined }];
    }
    for (const project of projects) {
      // 舊工作區可能已搬移；遷移保留原路徑，避免阻斷整個應用程式啟動。
      const path = existsSync(project.workspacePath) ? realpathSync.native(project.workspacePath) : project.workspacePath;
      if (local.projects.some((p) => p.workspacePath === path)) continue;
      const agent = project.agent ? { ...project.agent } : undefined;
      if (copying && agent) delete agent.sessionId;
      local.projects.push({ workspacePath: path, agent });
      local.workspacePath ??= path;
    }
  }
  for (const [path, before] of watched) if (signature(path) !== before) throw new Error('遷移來源正在被修改，請稍後重試');
  const next: BootSettings = { schemaVersion: 2, initialized: true, port: Number(boot.port ?? 5173), charactersPath: sharedPath,
    pets: [...locals.values()], selectedPetId: oldToNew.get(String(global.selectedPetId)) ?? locals.keys().next().value,
    ...(typeof global.locale === 'string' ? { locale: global.locale } : {}),
    ...(typeof global.defaultWorkspaceRoot === 'string' ? { defaultWorkspaceRoot: global.defaultWorkspaceRoot } : {}),
  };
  parseBoot(next);
  const backup = join(runtime, 'backups', `shared-${Date.now()}-${randomUUID()}`);
  mkdirSync(backup, { recursive: true });
  for (const name of ['app.yaml', 'characters.yaml', 'app.json', 'pets', 'characters', 'config.json']) {
    const path = join(runtime, name);
    if (existsSync(path)) cpSync(path, join(backup, name), { recursive: true });
  }
  if (!existingDatabase && globalSignature !== null && sharedPath !== join(runtime, 'characters.yaml')) cpSync(sharedPath, join(backup, 'shared-characters.yaml'));
  const nextDocuments = [...globals.values()];
  if (existingDatabase) {
    const shared = sharedStore!;
    for (const doc of nextDocuments) {
      shared.resolve(doc.vrmPath, doc.modelHash, doc.parameters, false, doc.id);
      shared.update(doc.id, doc.parameters);
    }
    shared.flush();
  } else writeCharacters(sharedPath, globalSignature, nextDocuments);
  const check = new CharacterStore(existingDatabase ? databasePath : sharedPath); check.loadForWake();
  const verified = { characters: check.all() };
  if (verified.characters.length !== globals.size) throw new Error('共用角色讀回驗證失敗');
  // 同實例升級保留歷史：舊檔保留，另複製到「角色＋專案」的新索引。
  // 新平行世界不繼承基準對話。
  if (!copying) {
    for (const profile of profiles) {
      if (typeof profile.id !== 'string') continue;
      const id = oldToNew.get(profile.id);
      if (!id) continue;
      const projects = Array.isArray(profile.projects) ? profile.projects as PetProject[]
        : typeof profile.workspacePath === 'string' ? [{ workspacePath: profile.workspacePath }] : [];
      for (const project of projects) {
        const workspace = existsSync(project.workspacePath) ? realpathSync.native(project.workspacePath) : project.workspacePath;
        const oldKey = modelHash(Buffer.from(JSON.stringify([profile.id, workspace])));
        const candidates = [join(runtime, 'transcripts', `${oldKey}.json`), join(runtime, 'transcripts', `${profile.id}.json`)];
        const existing = candidates.find(existsSync);
        if (!existing) continue;
        const targetKey = modelHash(Buffer.from(JSON.stringify([id, workspace])));
        const target = join(runtime, 'transcripts', `${targetKey}.json`);
        if (existing !== target && !existsSync(target)) copyFileSync(existing, target, constants.COPYFILE_EXCL);
      }
    }
  }
  store.save(next);
  // 已有備份且發布成功，才把舊作用中資料移離；不移動真正的共用檔。
  for (const name of ['app.json', 'pets', 'characters', 'config.json', 'characters.yaml']) {
    const path = join(runtime, name);
    if (path !== sharedPath && existsSync(path)) renameSync(path, join(backup, `original-${name}`));
  }
  return store.load();
}
