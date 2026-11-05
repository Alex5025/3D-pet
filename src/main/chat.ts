import { BrowserWindow } from 'electron';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { HistoryStore, SavedTurn, TurnStatus } from './historyStore';
import { join } from 'node:path';
import type { AgentEvent } from '../shared/agentEvents';
import type { ChatTranscript, ControlTaskRecord } from '../shared/chat';
import type { PetProject } from '../shared/projects';
import type { AgentBridge } from './agent/bridge';
import { createAgentBridge } from './agent/bridge';
import type { PetToolsHub } from './agent/petToolsHub';
import { PET_EXPRESSIONS, createPetToolsHub } from './agent/petToolsHub';
import { createProviders } from './agent/providers';
import { createChatDispatcher, createChatQueue } from './chatQueue';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface ChatDeps {
  readonly win: BrowserWindow | null;
  readonly history: HistoryStore;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
  readonly finishLedgerTask: (petId: string, ok: boolean) => void;
  readonly scheduleControlStatus: (() => void);
  readonly pets: Map<string, PetProfile>;
  readonly taskLedger: Map<string, ControlTaskRecord>;
  readonly runningTaskByPet: Map<string, string>;
  readonly motionFiles: string[];
  readonly motionsDir: () => string;
  readonly projectFor: (profile: PetProfile, path?: string | undefined) => PetProject | undefined;
  readonly petRefFiles: Map<string, { path: string; isDir: boolean; }[]>;
  readonly refKey: (id: string, workspacePath?: string | undefined) => string;
  readonly scheduleConfigFlush: () => void;
}

/** chat 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createChat(deps: ChatDeps) {
  const scope = createResourceScope();

  let bridge: AgentBridge | null = null;

  let petToolsHub: PetToolsHub | null = null;

  /* ── 串流文字合併(效能優化階段 3)──
   * provider 的 text delta 是 token 級,每 token 一次 IPC 太密(renderer 每次都全文重渲);
   * 33ms 合併一次;非 text 事件(done/error/approval…)到達時先 flush 緩衝,嚴格保序。 */
  const chatTextBuffers = new Map<string, { text: string; workspacePath?: string; revision: number; }>();

  const chatRevisions = new Map<string, number>();

  const chatKey = (id: string, path?: string): string => JSON.stringify([id, path]);

  let chatFlushTimer: NodeJS.Timeout | null = null;

  function flushChatText(): void {
    if (chatFlushTimer) {
      scope.clearTimeout(chatFlushTimer);
      chatFlushTimer = null;
    }
    for (const [petId, value] of chatTextBuffers) {
      deps.win?.webContents.send('chat-event-apply', petId, { kind: 'text', text: value.text }, value.workspacePath, value.revision);
    }
    chatTextBuffers.clear();
  }

  // 每輪獨立保存；串流定期落盤，關閉時寫入中斷狀態。
  const liveTranscripts = new Map<string, { user: string; reply: string; workspacePath?: string; }>();
  const turns = new Map<string, SavedTurn>();
  const completedTranscripts = new Map<string, ChatTranscript>();
  let storageFailure = '';
  function reportHistoryError(petId: string, error: unknown): void {
    const message = `對話紀錄儲存失敗：${String(error)}`;
    if (storageFailure !== message) {
      console.error('[history]', message);
      deps.win?.webContents.send('chat-event-apply', petId, { kind: 'tool', name: message }, turns.get(petId)?.workspace);
    }
    storageFailure = message;
  }
  function saveLive(petId: string, status: TurnStatus = 'running'): void {
    const live = liveTranscripts.get(petId);
    const turn = turns.get(petId);
    if (!live || !turn) return;
    try {
      if (!turn.conversation) turn.conversation = deps.history.conversation(petId, turn.workspace);
      Object.assign(turn, { user: live.user, reply: live.reply, updatedAt: Date.now(), status });
      deps.history.saveTurn(turn);
      storageFailure = '';
    } catch (error) { reportHistoryError(petId, error); }
  }
  function beginTranscript(petId: string, userText: string, workspacePath?: string): void {
    liveTranscripts.set(petId, { user: userText, reply: '', workspacePath });
    const profile = deps.getPet(petId);
    const provider = profile && deps.projectFor(profile, workspacePath)?.agent?.kind || 'codex';
    const now = Date.now();
    turns.set(petId, { id: randomUUID(), petId, workspace: workspacePath ?? '', conversation: '', provider,
      user: userText, reply: '', at: now, updatedAt: now, status: 'running' });
    saveLive(petId);
  }
  function persistTranscript(petId: string, status: TurnStatus): void {
    const live = liveTranscripts.get(petId);
    if (!live) return;
    saveLive(petId, status);
    completedTranscripts.set(chatKey(petId, live.workspacePath), { user: live.user, reply: live.reply, at: turns.get(petId)?.at ?? Date.now() });
    liveTranscripts.delete(petId);
    turns.delete(petId);
  }
  const clearTranscript = (petId: string) => {
    const selected = deps.getPet(petId)?.workspacePath;
    deps.history.newConversation(petId, selected ?? '');
    if (liveTranscripts.get(petId)?.workspacePath === selected) { liveTranscripts.delete(petId); turns.delete(petId); }
    completedTranscripts.delete(chatKey(petId, selected));
  };

  function sendChatEvent(petId: string, event: AgentEvent, workspacePath = bridge?.petStates().find((s) => s.petId === petId && s.running)?.workspacePath ?? deps.getPet(petId)?.workspacePath): void {
    const key = chatKey(petId, workspacePath);
    const revision = (chatRevisions.get(key) ?? 0) + 1;
    chatRevisions.set(key, revision);
    if (event.kind === 'turnStart') beginTranscript(petId, event.text, workspacePath);
    else if (event.kind === 'text') {
      const live = liveTranscripts.get(petId);
      if (live) live.reply += event.text;
    } else if (event.kind === 'done' || event.kind === 'error') {
      persistTranscript(petId, event.kind === 'error' ? 'failed' : event.ok ? 'completed' : 'interrupted');
    }
    if (event.kind === 'text') {
      // text 增量一律不推中控:中控只顯示狀態燈號,33ms 合併節奏的高頻 IPC 不打第二個視窗
      chatTextBuffers.set(petId, { text: (chatTextBuffers.get(petId)?.text ?? '') + event.text, workspacePath, revision });
      chatFlushTimer ??= scope.timeout(flushChatText, 33);
      return;
    }
    if (event.kind === 'done') deps.finishLedgerTask(petId, event.ok);
    else if (event.kind === 'error') deps.finishLedgerTask(petId, false);
    flushChatText();
    deps.win?.webContents.send('chat-event-apply', petId, event, workspacePath, revision);
    deps.scheduleControlStatus?.(); // 非 text 事件(turnStart/approval/done…)= 狀態燈號可能變了
  }

  /* ── 對話佇列(效能與擴展設計見 chatQueue.ts)──
   * turn 進行中送出的訊息排隊、turn 完自動接續;佇列變更即廣播給泡泡。
   * 將來中控面板 = 另一條帶 sender 驗證的 enqueue(source:'control')IPC + 訂閱同一個廣播。 */
  const chatQueue = createChatQueue((petId) => {
    if (petId) deps.win?.webContents.send('chat-queue-apply', petId, chatQueue.summaries(petId));
    deps.scheduleControlStatus?.(); // 綁定佇列與公用池(petId=undefined)變更都重推中控快照
  });

  const queuedTaskCount = (id: string) => chatQueue.size(id);

  const chatDispatcher = createChatDispatcher({
    queue: chatQueue,
    canAccept: (petId) => !scope.disposed && !!deps.getPet(petId)?.enabled && (bridge?.canAccept(petId) ?? false),
    // 領公用池的資格:啟用中且已設工作目錄
    unboundCandidates: () => [...deps.pets.values()]
      .filter((profile) => profile.enabled !== false && !!profile.workspacePath)
      .map((profile) => profile.id),
    workspaceOf: (petId) => deps.pets.get(petId)?.workspacePath,
    workspacesOf: (petId) => deps.pets.get(petId)?.projects?.map((p) => p.workspacePath) ?? [],
    runTask: (petId, task) => {
      // 中控投的任務進帳本:標執行中、補接收者與實際執行位置(公用池單在領走的這一刻才確定)
      const record = deps.taskLedger.get(task.id);
      if (record) {
        const profile = deps.pets.get(petId);
        record.status = 'running';
        record.assignee = petId;
        if (profile?.name) record.assigneeName = profile.name;
        if (task.workspacePath) record.workspacePath = task.workspacePath;
        deps.runningTaskByPet.set(petId, task.id);
      }
      // turnStart 讓泡泡知道「這一則開始跑了」(beginTurn);非 text 事件,合併器會先 flush 保序
      sendChatEvent(petId, { kind: 'turnStart', text: task.text }, task.workspacePath);
      bridge?.chatSend(petId, task.text, task.images, task.workspacePath);
    }
  });

  const clearChatQueue = (petId: string) => chatQueue.clear(petId);

  const dispatchAll = () => chatDispatcher.dispatchAll();
  async function start() {
    if (!scope.start()) return;
    scope.interval(() => { for (const petId of liveTranscripts.keys()) saveLive(petId); }, 1000);

    // 寵物工具中樞(v3):agent 經 MCP 呼叫 → socket 回連這裡 → 操縱桌寵
    petToolsHub = createPetToolsHub({
      playMotion: async (petId, file) => {
        if (!deps.pets.has(petId) || !deps.motionFiles.includes(file)) return false;
        try {
          deps.win?.webContents.send('vrma-play', petId, await readFile(join(deps.motionsDir(), file)));
          return true;
        } catch {
          return false;
        }
      },
      showExpression: (petId, name) => {
        if (!deps.pets.has(petId) || !(PET_EXPRESSIONS as readonly string[]).includes(name)) return false;
        deps.win?.webContents.send('expression-apply', petId, name);
        return true;
      },
      speak: (petId, text) => {
        const trimmed = text.trim();
        if (!deps.pets.has(petId) || !trimmed) return false;
        // 走同一個合併器:pet_speak 不可與緩衝中的串流文字互相超車
        sendChatEvent(petId, { kind: 'text', text: `\n${trimmed.slice(0, 200)}\n` });
        return true;
      },
      listMotions: () => deps.motionFiles
    });

    bridge = createAgentBridge({
      // 淺拷貝合併參考檔(ephemeral,不落盤——persist 走 pets.get 的原物件);資料夾以尾斜線標記
      getPet: (id, workspacePath) => {
        const profile = deps.pets.get(id);
        if (!profile) return null;
        const project = deps.projectFor(profile, workspacePath);
        if (!project) return null;
        try { if (realpathSync.native(project.workspacePath) !== project.workspacePath) return null; } catch { return null; }
        const refs = deps.petRefFiles.get(deps.refKey(id, project.workspacePath));
        return { ...profile, workspacePath: project.workspacePath, agent: project.agent, refFiles: refs?.map((r) => r.path + (r.isDir ? '/' : '')) };
      },
      updatePet: (id, patch, workspacePath) => {
        const profile = deps.getPet(id);
        const project = profile && deps.projectFor(profile, workspacePath);
        if (!profile || !project) return;
        project.agent = patch.agent;
        if (profile.workspacePath === project.workspacePath) profile.agent = patch.agent;
        deps.scheduleConfigFlush();
      },
      send: sendChatEvent,
      providers: createProviders(petToolsHub),
      // turn 結束(含早退)→ 派發佇列;用 dispatchAll:全域上限釋放的名額可能輪到別隻寵物
      onTurnFinished: () => chatDispatcher.dispatchAll()
    });
  }
  scope.add(() => { petToolsHub?.dispose(); petToolsHub = null; });
  scope.add(() => { bridge?.shutdownSync(); bridge = null; });
  scope.add(flushChatText);
  scope.add(() => { for (const petId of liveTranscripts.keys()) persistTranscript(petId, 'interrupted'); });
  return {
    get clearChatQueue() { return clearChatQueue; },
    get bridge() { return bridge; },
    get dispatchAll() { return dispatchAll; },
    get clearTranscript() { return clearTranscript; },
    get petToolsHub() { return petToolsHub; },
    get chatQueue() { return chatQueue; },
    get chatKey() { return chatKey; },
    get chatRevisions() { return chatRevisions; },
    get liveTranscripts() { return liveTranscripts; },
    get completedTranscripts() { return completedTranscripts; },
    get chatDispatcher() { return chatDispatcher; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Chat = ReturnType<typeof createChat>;
