import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
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

/** 全角色集中儲存；一般啟動不讀內容，喚醒或一次性遷移才載入。 */
export class CharacterStore {
  private documents = new Map<string, CharacterDocument>();
  private dirty = false;
  private loaded = false;
  private sourceSignature: string | null = null;
  constructor(readonly filePath: string) {}
  get(id: string): CharacterDocument | undefined { return this.documents.get(id); }
  all(): CharacterDocument[] { return [...this.documents.values()]; }
  loadForWake(): void {
    this.flush();
    const before = signature(this.filePath);
    if (before === null) throw new Error('characters.yaml 已遺失，請還原檔案');
    const raw = parseCharacterYaml(readFileSync(this.filePath, 'utf8')) as Record<string, unknown> | null;
    if (!raw || raw.schemaVersion !== 3 || !Array.isArray(raw.characters)) throw new Error('角色 YAML 版本或清單無效');
    const next = new Map<string, CharacterDocument>();
    for (const item of raw.characters) {
      const doc = parseStoredCharacter(item);
      if (next.has(doc.id)) throw new Error('重複寵物 ID');
      next.set(doc.id, doc);
    }
    if (signature(this.filePath) !== before) throw new Error('角色設定正在被外部修改，請重新喚醒');
    this.documents = next;
    this.sourceSignature = before;
    this.loaded = true;
  }
  resolve(vrmPath: string, hash: string, initial: CharacterParameters, requireExisting: boolean, id: string): CharacterDocument {
    if (!this.loaded) throw new Error('請先喚醒寵物以載入 characters.yaml');
    if (!id) throw new Error('角色 ID 不可為空');
    vrmPath = realpathSync.native(vrmPath);
    const cached = this.documents.get(id);
    if (cached && cached.modelHash === hash && cached.vrmPath === vrmPath) return cached;
    if (!cached && requireExisting) throw new Error('characters.yaml 缺少此角色，請還原設定');
    const document: CharacterDocument = {
      schemaVersion: 1, id, vrmPath, modelHash: hash,
      parameters: cached?.parameters ?? characterParameters(initial),
    };
    this.documents.set(id, document);
    this.dirty = true;
    return document;
  }
  update(id: string, parameters: CharacterParameters): void {
    const document = this.documents.get(id);
    if (!document) throw new Error('請先喚醒寵物以載入角色設定');
    const next = characterParameters(parameters);
    if (JSON.stringify(next) === JSON.stringify(document.parameters)) return;
    document.parameters = next;
    this.dirty = true;
  }
  flush(): void {
    if (!this.loaded || !this.dirty) return;
    if (signature(this.filePath) !== this.sourceSignature) throw new Error('characters.yaml 已被外部修改，未覆寫檔案；請先處理尚未儲存的變更');
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeCharacters(this.filePath, this.sourceSignature, this.all());
    this.sourceSignature = signature(this.filePath);
    this.dirty = false;
  }
}
