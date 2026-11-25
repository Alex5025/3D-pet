import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, existsSync, copyFileSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { CHARACTER_KEYS, parseCharacterExport, parseCharacterParameters, type CharacterDocument, type CharacterParameters } from '../shared/character';

export function modelHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function atomicText(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* 已替換成功，或寫入前即失敗。 */ }
  }
}
export function atomicYaml(path: string, value: unknown): void {
  atomicText(path, stringify(value, { lineWidth: 0, aliasDuplicateObjects: false }));
}
export function parseCharacterYaml(text: string): unknown {
  const document = parseDocument(text, { schema: 'core', uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(`YAML 格式錯誤：${[...document.errors, ...document.warnings].map((error) => error.message).join('\n')}`);
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}
export function characterParameters(profile: CharacterParameters): CharacterParameters {
  return parseCharacterParameters(profile);
}
/** 刪掉缺省欄位，避免切換角色時保留上一隻的外觀。 */
export function applyCharacter(target: CharacterParameters, parameters: CharacterParameters): void {
  for (const key of CHARACTER_KEYS) if (key !== 'name') delete target[key];
  Object.assign(target, structuredClone(parameters));
}
export function parseStoredCharacter(raw: unknown): CharacterDocument {
  const parsed = parseCharacterExport(raw);
  const value = raw as Record<string, unknown>;
  if (typeof value.vrmPath !== 'string' || !value.vrmPath || typeof value.id !== 'string' || !value.id) throw new Error('角色模型路徑或 ID 無效');
  return { ...parsed, id: value.id, vrmPath: value.vrmPath };
}
/** 跨實例互斥與版本檢查；不得以整份舊快照蓋掉其他世界的修改。 */
export function writeCharacters(path: string, expected: string | null, documents: CharacterDocument[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd: number;
  try { fd = openSync(lock, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('其他實例正在儲存共用角色設定，請稍後重試');
  }
  try {
    writeFileSync(fd, String(process.pid));
    if (signature(path) !== expected) throw new Error('characters.yaml 已被其他實例或外部修改，未覆寫；請重新載入後再編輯');
    const parsed = documents.map(parseStoredCharacter);
    if (new Set(parsed.map((d) => d.id)).size !== parsed.length) throw new Error('共用角色 ID 重複');
    atomicYaml(path, { schemaVersion: 3, characters: parsed });
  } finally { closeSync(fd); unlinkSync(lock); }
}
export function signature(path: string): string | null {
  try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** 只套用本地相對於喚醒快照的異動，保留其他實例修改的欄位。 */
function mergeChanges(base: unknown, local: unknown, disk: unknown, path: string): unknown {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (equal(base, local)) return disk;
  if (equal(base, disk) || equal(local, disk)) return local;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (record(base) && record(local) && record(disk)) {
    const merged: Record<string, unknown> = { ...disk };
    for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
      const value = mergeChanges(base[key], local[key], disk[key], `${path}.${key}`);
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }
  throw new Error(`共用角色已被外部修改同一欄位（${path}），未覆寫；請確認兩邊內容後重試`);
}

/** YAML 僅在第一次升級時匯入；原檔及獨立備份皆保留。 */
export function characterDatabasePath(path: string): string {
  return /\.ya?ml$/i.test(path) ? path.replace(/\.ya?ml$/i, '.sqlite') : path;
}
export function migrateCharacterDatabase(source: string): string {
  const path = characterDatabasePath(source);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    const version = db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) throw new Error('不支援的共用角色資料庫版本');
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS character_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
      if (!db.prepare("SELECT 1 FROM character_meta WHERE key='initialized'").get()) {
        if (source === path || !existsSync(source)) throw new Error('缺少共用角色遷移來源，請還原角色設定');
        const before = signature(source);
        const raw = parseCharacterYaml(readFileSync(source, 'utf8')) as { schemaVersion?: number; characters?: unknown[] };
        if (raw?.schemaVersion !== 3 || !Array.isArray(raw.characters)) throw new Error('共用角色 YAML 無效');
        const documents = raw.characters.map(parseStoredCharacter);
        if (new Set(documents.map(d => d.id)).size !== documents.length) throw new Error('共用角色 ID 重複');
        const backup = `${source}.pre-sqlite.bak`;
        if (!existsSync(backup)) copyFileSync(source, backup, constants.COPYFILE_EXCL);
        if (signature(source) !== before) throw new Error('共用角色遷移來源正在被修改');
        const insert = db.prepare('INSERT INTO characters VALUES (?,?)');
        for (const document of documents) insert.run(document.id, JSON.stringify(document));
        db.prepare("INSERT INTO character_meta VALUES ('initialized','1')").run();
      }
      if (version === 0) db.pragma('user_version = 1');
    }).immediate();
    return path;
  } finally { db.close(); }
}

/** 共用角色以 SQLite 儲存；三方合併保留其他實例的獨立修改。 */
export class CharacterStore {
  private documents = new Map<string, CharacterDocument>();
  private dirty = false;
  private baseline = new Map<string, CharacterDocument>();
  private loaded = false;
  readonly filePath: string;
  constructor(readonly sourcePath: string) { this.filePath = characterDatabasePath(sourcePath); }
  get(id: string): CharacterDocument | undefined { return this.documents.get(id); }
  /** 只讀取休息區的外觀，不觸發喚醒或更新角色快取。 */
  readRestingAppearance(id: string) {
    const db = new Database(this.filePath, { readonly: true });
    try {
      const row = db.prepare('SELECT document FROM characters WHERE id = ?').get(id) as { document: string } | undefined;
      if (!row) return null;
      const doc = parseStoredCharacter(JSON.parse(row.document));
      return { path: doc.vrmPath, wardrobe: doc.parameters.wardrobe ?? {} };
    } finally { db.close(); }
  }
  all(): CharacterDocument[] { return [...this.documents.values()]; }
  get hasChanges(): boolean { return this.dirty; }
  private open(): Database.Database {
    migrateCharacterDatabase(this.sourcePath);
    const db = new Database(this.filePath);
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    return db;
  }
  loadForWake(): void {
    this.flush();
    const db = this.open();
    try {
      this.documents = new Map((db.prepare('SELECT document FROM characters').all() as { document: string }[])
        .map(row => { const document = parseStoredCharacter(JSON.parse(row.document)); return [document.id, document]; }));
      this.baseline = structuredClone(this.documents);
      this.loaded = true;
    } finally { db.close(); }
  }
  resolve(vrmPath: string, hash: string, initial: CharacterParameters, requireExisting: boolean, id: string): CharacterDocument {
    if (!this.loaded) throw new Error('請先喚醒寵物以載入角色資料庫');
    if (!id) throw new Error('角色 ID 不可為空');
    vrmPath = realpathSync.native(vrmPath);
    const cached = this.documents.get(id);
    if (cached && cached.modelHash === hash && cached.vrmPath === vrmPath) return cached;
    if (!cached && requireExisting) throw new Error('共用角色資料庫缺少此角色，請還原設定');
    const document: CharacterDocument = { schemaVersion: 1, id, vrmPath, modelHash: hash,
      parameters: cached?.parameters ?? characterParameters(initial) };
    this.documents.set(id, document);
    this.dirty = true;
    return document;
  }
  update(id: string, parameters: CharacterParameters): void {
    const document = this.documents.get(id);
    if (!document) throw new Error('請先喚醒寵物以載入角色設定');
    const next = characterParameters(parameters);
    if (JSON.stringify(next) === JSON.stringify(document.parameters)) return;
    this.documents.set(id, { ...document, parameters: next });
    this.dirty = true;
  }
  discardChanges(): void {
    this.documents = structuredClone(this.baseline);
    this.dirty = false;
  }
  /** 呼叫者必須持有寫入交易；回呼只可在 COMMIT 成功後執行。 */
  writeInTransaction(db: Database.Database, schema: 'main' | 'shared'): () => void {
    if (!this.dirty) return () => {};
    if (!db.inTransaction) throw new Error('角色儲存需要交易');
    const rows = db.prepare(`SELECT document FROM ${schema}.characters`).all() as { document: string }[];
    const disk = new Map(rows.map(row => { const d = parseStoredCharacter(JSON.parse(row.document)); return [d.id, d]; }));
    const insert = db.prepare(`INSERT INTO ${schema}.characters VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`);
    for (const [id, local] of this.documents) {
      const merged = mergeChanges(this.baseline.get(id), local, disk.get(id), id);
      if (merged !== undefined) insert.run(id, JSON.stringify(parseStoredCharacter(merged)));
    }
    return () => { this.baseline = structuredClone(this.documents); this.dirty = false; };
  }
  flush(): void {
    if (!this.dirty) return;
    const db = this.open();
    try { db.transaction(() => this.writeInTransaction(db, 'main')).immediate()(); }
    finally { db.close(); }
  }
}
