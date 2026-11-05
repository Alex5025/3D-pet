import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatTranscript } from '../shared/chat';
import type { BootSettings } from './settingsStore';
import { RETENTION_MS } from '../../scripts/storage-layout.mjs';

export const HISTORY_RETENTION_MS = RETENTION_MS;
export type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export interface SavedTurn {
  id: string; petId: string; workspace: string; conversation: string; provider: string;
  user: string; reply: string; at: number; updatedAt: number; status: TurnStatus;
}
interface PendingSettings { previous: string | null; next: string; }

/** 單一主程序擁有資料庫；renderer 只能透過既有 IPC 取得目前對話。 */
export class HistoryStore {
  private db: Database.Database | null = null;
  constructor(readonly filePath: string) {}
  private connection(): Database.Database {
    if (this.db) return this.db;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const db = new Database(this.filePath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('busy_timeout = 5000');
      const version = db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== 1) throw new Error('不支援的對話資料庫版本');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS conversations (petId TEXT NOT NULL, workspace TEXT NOT NULL, conversation TEXT NOT NULL, PRIMARY KEY(petId, workspace));
          CREATE TABLE IF NOT EXISTS turns (
            id TEXT PRIMARY KEY, petId TEXT NOT NULL, workspace TEXT NOT NULL, conversation TEXT NOT NULL, provider TEXT NOT NULL,
            user TEXT NOT NULL, reply TEXT NOT NULL, at INTEGER NOT NULL, updatedAt INTEGER NOT NULL, status TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS turns_lookup ON turns(petId, workspace, conversation, at);
          CREATE INDEX IF NOT EXISTS turns_age ON turns(at);
          CREATE TABLE IF NOT EXISTS settings_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS settings_pending (id INTEGER PRIMARY KEY CHECK(id=1), previous TEXT, next TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS imports (source TEXT PRIMARY KEY, at INTEGER NOT NULL);
          PRAGMA user_version = 1;
        `);
      })();
      this.db = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }
  initialize(now = Date.now()): void {
    this.connection().prepare("UPDATE turns SET status='interrupted', updatedAt=? WHERE status='running'").run(now);
    this.prune(now);
  }
  prune(now = Date.now()): void {
    this.connection().prepare('DELETE FROM turns WHERE at < ?').run(now - HISTORY_RETENTION_MS);
  }
  conversation(petId: string, workspace: string): string {
    const db = this.connection();
    const row = db.prepare('SELECT conversation FROM conversations WHERE petId=? AND workspace=?').get(petId, workspace) as { conversation: string } | undefined;
    if (row) return row.conversation;
    return this.newConversation(petId, workspace);
  }
  newConversation(petId: string, workspace: string): string {
    const id = randomUUID();
    this.connection().prepare('INSERT INTO conversations VALUES (?, ?, ?) ON CONFLICT(petId,workspace) DO UPDATE SET conversation=excluded.conversation').run(petId, workspace, id);
    return id;
  }
  saveTurn(turn: SavedTurn): void {
    this.connection().prepare(`INSERT INTO turns VALUES (@id,@petId,@workspace,@conversation,@provider,@user,@reply,@at,@updatedAt,@status)
      ON CONFLICT(id) DO UPDATE SET user=excluded.user, reply=excluded.reply, updatedAt=excluded.updatedAt, status=excluded.status`).run(turn);
  }
  latest(petId: string, workspace: string, now = Date.now()): ChatTranscript | null {
    const row = this.connection().prepare(`SELECT user,reply,at FROM turns WHERE petId=? AND workspace=? AND conversation=? AND at>=?
      ORDER BY at DESC, rowid DESC LIMIT 1`).get(petId, workspace, this.conversation(petId, workspace), now - HISTORY_RETENTION_MS) as ChatTranscript | undefined;
    return row ?? null;
  }
  /** YAML 原子替換前先記錄意圖；只有確認檔案已發布，才把前一版加入版本表。 */
  prepareSettings(previous: string | null, next: string): void {
    this.connection().prepare('INSERT INTO settings_pending VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET previous=excluded.previous,next=excluded.next').run(previous, next);
  }
  reconcileSettings(actual: string | null): void {
    const db = this.connection();
    const pending = db.prepare('SELECT previous,next FROM settings_pending WHERE id=1').get() as PendingSettings | undefined;
    if (!pending) return;
    if (actual !== pending.next && actual !== pending.previous) throw new Error('設定寫入中斷後檔案又被修改；請先確認 app.yaml，原版本仍保留在資料庫');
    db.transaction(() => {
      if (actual === pending.next && pending.previous !== null && pending.previous !== actual) {
        db.prepare('INSERT INTO settings_versions(content,at) VALUES (?,?)').run(pending.previous, Date.now());
        db.exec('DELETE FROM settings_versions WHERE id NOT IN (SELECT id FROM settings_versions ORDER BY id DESC LIMIT 2)');
      }
      db.exec('DELETE FROM settings_pending');
    })();
  }
  /** 舊 JSON 只有最後一輪；逐檔交易、來源去重，來源壞掉時保留並回報。 */
  importLegacy(runtime: string, boot: BootSettings, now = Date.now()): void {
    const db = this.connection();
    for (const pet of boot.pets) for (const project of pet.projects) {
      const key = createHash('sha256').update(JSON.stringify([pet.id, project.workspacePath])).digest('hex');
      const candidates = [join(runtime, 'transcripts', `${key}.json`), join(runtime, 'transcripts', `${pet.id}.json`)];
      // 舊的寵物單檔只可歸到當時選取的專案，不能複製到其他專案。
      const source = existsSync(candidates[0]) ? candidates[0] : pet.workspacePath === project.workspacePath && existsSync(candidates[1]) ? candidates[1] : undefined;
      if (!source || db.prepare('SELECT 1 FROM imports WHERE source=?').get(source)) continue;
      const raw = JSON.parse(readFileSync(source, 'utf8')) as Partial<ChatTranscript>;
      if (typeof raw.user !== 'string' || typeof raw.reply !== 'string' || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) throw new Error(`舊對話紀錄無效：${source}`);
      db.transaction(() => {
        if (raw.at! >= now - HISTORY_RETENTION_MS) this.saveTurn({ id: `legacy-${createHash('sha256').update(source).digest('hex')}`, petId: pet.id, workspace: project.workspacePath,
          conversation: this.conversation(pet.id, project.workspacePath), provider: project.agent?.kind ?? 'codex', user: raw.user!, reply: raw.reply!, at: raw.at!, updatedAt: raw.at!, status: 'completed' });
        db.prepare('INSERT INTO imports VALUES (?,?)').run(source, now);
      })();
    }
  }
  importFromMarker(runtime: string, boot: BootSettings): void {
    const marker = join(runtime, 'migration-source.json');
    if (existsSync(marker)) {
      const record = JSON.parse(readFileSync(marker, 'utf8')) as { source?: unknown };
      if (typeof record.source !== 'string') throw new Error('遷移來源紀錄無效');
      this.importLegacy(record.source, boot);
    }
    // 安裝版及更早的遷移流程可能仍有本地 JSON。
    this.importLegacy(runtime, boot);
  }
  close(): void { this.db?.close(); this.db = null; }
}
