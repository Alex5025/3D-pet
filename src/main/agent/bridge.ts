import { t } from '../../shared/i18n';
import type { AgentBinding, AgentEvent, AgentKind } from '../../shared/agentEvents';
import type { ChatImage } from '../../shared/chat';
import type { AgentModelInfo, AgentProvider } from './types';

/** bridge 需要的 profile 子集(依賴注入,避免與 index.ts 循環引用)。 */
export interface AgentPetProfile {
  id: string;
  workspacePath?: string;
  agent?: AgentBinding;
  persona?: string;
  /** 參考檔案(當次對話有效;index.ts 的 getPet 以記憶體清單合併進來,不落盤)。 */
  refFiles?: string[];
}

export interface AgentBridgeDeps {
  getPet(id: string, workspacePath?: string): AgentPetProfile | null;
  updatePet(id: string, patch: { agent: AgentBinding }, workspacePath?: string): unknown;
  /** 事件推回泡泡;index.ts 綁 win?.webContents.send('chat-event-apply', petId, event)。 */
  send(petId: string, event: AgentEvent, workspacePath?: string): void;
  providers: Record<AgentKind, AgentProvider>;
  /** turn 結束(含早退路徑)後回呼:對話佇列據此派發下一則。時序保證在 running=false 之後。 */
  onTurnFinished?(petId: string): void;
}

export interface AgentBridge {
  chatSend(petId: string, text: string, images?: ChatImage[], workspacePath?: string): void;
  /** 這隻寵物現在能不能開新 turn(未在跑 && 全域上限內)——dispatcher 派發前的閘門。 */
  canAccept(petId: string): boolean;
  chatCancel(petId: string, workspacePath?: string): void;
  /** 泡泡/中控審批按鈕的回覆(requestId 來自 approval 事件;不符目前掛著的審批則忽略——防雙 UI race)。 */
  respondApproval(petId: string, requestId: string, allow: boolean, feedback?: string, workspacePath?: string): void;
  /** 每寵執行狀態快照(中控面板開窗初始化用;晚開視窗只靠事件流會漏掉進行中 turn)。 */
  petStates(): PetAgentSnapshot[];
  /** 設定面板下拉用;provider 不支援或失敗回空清單。 */
  listModels(kind: AgentKind): Promise<AgentModelInfo[]>;
  /** 寵物休眠/刪除/換 agent 種類時關閉 session。 */
  closePetSession(petId: string, workspacePath?: string): Promise<void>;
  dispose(): Promise<void>;
  /** app.exit 前的同步收攤(await 不到 async dispose)。 */
  shutdownSync(): void;
}

const MAX_CONCURRENT_TURNS = 4;
const STALL_NOTICE_MS = 30_000; // 30 秒無輸出 → 泡泡顯示「仍在執行…」
const HARD_TIMEOUT_MS = 300_000; // 5 分鐘硬上限 → cancel + error

interface PetAgentState {
  petId: string;
  workspacePath: string;
  kind: AgentKind;
  sessionId: string | null;
  running: boolean;
  /** 有審批請求掛著等使用者點頭:看門狗暫停計時(等人不是卡死)。 */
  awaitingApproval: boolean;
  /** 掛著的審批內容(中控面板晚開窗要能拿到 description;回覆或 turn 終結時清空)。 */
  pendingApproval: { requestId: string; description: string } | null;
  /** 最後一次事件時間(看門狗依據;回覆審批時重置)。 */
  lastActivity: number;
}

/** petStates() 回傳的每寵快照(淺拷貝,states Map 不外洩)。 */
export interface PetAgentSnapshot {
  workspacePath?: string;
  petId: string;
  running: boolean;
  awaitingApproval: boolean;
  pendingApproval: { requestId: string; description: string } | null;
  /** 最後回報時間(最後一次 agent 事件;中控依此排序)。 */
  lastActivity: number;
}

/** 未設定 agent 的寵物預設走 codex(與舊 codexSessionId 欄位的血緣一致;設定面板可改)。 */
const DEFAULT_KIND: AgentKind = 'codex';

export function createAgentBridge(deps: AgentBridgeDeps): AgentBridge {
  const states = new Map<string, PetAgentState>();
  const closing = new Map<string, number>();

  const runningCount = (): number => [...states.values()].filter((s) => s.running).length;

  function stateFor(petId: string, kind: AgentKind, workspacePath: string): PetAgentState {
    const key = JSON.stringify([petId, workspacePath]);
    let state = states.get(key);
    if (!state || state.kind !== kind) {
      state = { petId, workspacePath, kind, sessionId: null, running: false, awaitingApproval: false, pendingApproval: null, lastActivity: Date.now() };
      states.set(key, state);
    }
    return state;
  }

  async function runTurn(petId: string, text: string, images: ChatImage[], workspacePath?: string): Promise<void> {
    const profile = deps.getPet(petId, workspacePath);
    if (!profile) { deps.send(petId, { kind: 'error', message: '角色或專案綁定已失效' }, workspacePath); return; }
    const send = (event: AgentEvent): void => deps.send(petId, event, profile.workspacePath);

    if (!profile.workspacePath) {
      send({ kind: 'error', message: t('agent.needWorkspace') });
      return;
    }
    const kind = profile.agent?.kind ?? DEFAULT_KIND;
    const provider = deps.providers[kind];
    if (closing.has(petId) || [...states.values()].some((s) => s.petId === petId && s.running)) {
      send({ kind: 'error', message: t('agent.turnInProgress') });
      return;
    }
    if (runningCount() >= MAX_CONCURRENT_TURNS) {
      send({ kind: 'error', message: t('agent.concurrencyLimit', { n: MAX_CONCURRENT_TURNS }) });
      return;
    }

    const state = stateFor(petId, kind, profile.workspacePath);
    state.running = true;
    let terminated = false; // 保證每 turn 恰一個終結事件(done 或 error)
    const emit = (event: AgentEvent): void => {
      if (event.kind === 'done' || event.kind === 'error') {
        if (terminated) return;
        terminated = true;
      }
      send(event);
    };

    // 看門狗:30s 無輸出提示、5min 硬中斷;等待審批時暫停(等人點頭不算卡死)
    state.lastActivity = Date.now();
    let noticed = false;
    const watchdog = setInterval(() => {
      if (state.awaitingApproval) return;
      const idle = Date.now() - state.lastActivity;
      if (!noticed && idle >= STALL_NOTICE_MS) {
        noticed = true;
        send({ kind: 'tool', name: t('agent.stillRunning') });
      }
      if (idle >= HARD_TIMEOUT_MS) {
        if (state.sessionId) void provider.cancel(state.sessionId);
        emit({ kind: 'error', message: t('agent.timeout') });
      }
    }, 5_000);

    try {
      if (!state.sessionId) {
        const resumeId = profile.agent?.kind === kind ? profile.agent?.sessionId : undefined;
        try {
          state.sessionId = await provider.startSession({ workdir: profile.workspacePath, resumeId, persona: profile.persona, petId, permission: profile.agent?.permission });
        } catch (error) {
          if (resumeId) {
            // resume 失敗策略:清掉舊 id、開全新 session(設計 §8 定案)
            console.log(`[agent] resume 失敗,改開新 session:${String(error)}`);
            deps.updatePet(petId, { agent: { ...profile.agent, kind, sessionId: undefined } }, profile.workspacePath);
            state.sessionId = await provider.startSession({ workdir: profile.workspacePath, persona: profile.persona, petId, permission: profile.agent?.permission });
          } else {
            throw error;
          }
        }
      }
      // startSession 回傳的是 handle,不持久化;真 id 只從 session 事件回存
      const turnOpts = {
        model: profile.agent?.model,
        effort: profile.agent?.effort,
        persona: profile.persona,
        permission: profile.agent?.permission,
        petId,
        refFiles: profile.refFiles,
        images,
      };
      for await (const event of provider.sendMessage(state.sessionId, text, turnOpts)) {
        state.lastActivity = Date.now();
        noticed = false;
        if (event.kind === 'approval') {
          state.awaitingApproval = true;
          state.pendingApproval = { requestId: event.requestId, description: event.description };
        }
        if (event.kind === 'session') {
          state.sessionId = event.sessionId;
          if (profile.agent?.kind !== kind || profile.agent?.sessionId !== event.sessionId) {
            // 展開既有 agent 設定再蓋 sessionId:回存不可洗掉 model/effort/permission
            deps.updatePet(petId, { agent: { ...profile.agent, kind, sessionId: event.sessionId } }, profile.workspacePath);
          }
        }
        emit(event);
        if (terminated && (event.kind === 'done' || event.kind === 'error')) break;
      }
      // provider 流結束卻沒吐終結事件(例:行程被殺)→ bridge 補發
      emit({ kind: 'done', ok: false });
    } catch (error) {
      emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(watchdog);
      state.running = false;
      state.awaitingApproval = false;
      state.pendingApproval = null; // turn 終結 = 審批必然已了結或作廢
    }
  }

  return {
    chatSend(petId, text, images = [], workspacePath) {
      const trimmed = text.trim();
      if (!trimmed && !images.length) return; // 空訊息不觸發 onTurnFinished(佇列端 enqueue 已擋空,不會漏派)
      // hook 掛在 promise 的 finally 而非 runTurn 內部——早退路徑(無 workspace 等)不經
      // runTurn 的 try/finally,掛裡面佇列會永久卡死;掛這裡任何路徑都觸發,
      // 且在 runTurn 自身 finally(running=false)之後的 microtask 執行,時序正確。
      void runTurn(petId, trimmed, images, workspacePath).finally(() => deps.onTurnFinished?.(petId));
    },
    canAccept(petId) {
      // 審批等待期間 running 維持 true → 自動不派發,佇列自然等待
      return !closing.has(petId) && ![...states.values()].some((state) => state.petId === petId && state.running) && runningCount() < MAX_CONCURRENT_TURNS;
    },
    petStates() {
      const chosen = new Map<string, PetAgentState>();
      for (const state of states.values()) if (!chosen.get(state.petId)?.running) chosen.set(state.petId, state);
      return [...chosen.values()].map((state) => ({ petId: state.petId, workspacePath: state.workspacePath,
        running: state.running, awaitingApproval: state.awaitingApproval,
        pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null, lastActivity: state.lastActivity }));
    },
    chatCancel(petId, workspacePath) {
      const state = [...states.values()].find((s) => s.petId === petId && s.running && (!workspacePath || s.workspacePath === workspacePath));
      if (state?.sessionId) void deps.providers[state.kind].cancel(state.sessionId);
    },
    respondApproval(petId, requestId, allow, feedback, workspacePath) {
      const state = [...states.values()].find((s) => s.petId === petId && s.running && s.pendingApproval?.requestId === requestId && (!workspacePath || s.workspacePath === workspacePath));
      if (!state?.sessionId) return;
      state.pendingApproval = null;
      state.awaitingApproval = false;
      state.lastActivity = Date.now();
      deps.send(petId, { kind: 'approvalResolved', requestId }, state.workspacePath);
      void deps.providers[state.kind].respondApproval(state.sessionId, requestId, allow, feedback).catch(async (error) => {
        deps.send(petId, { kind: 'error', message: t('agent.approvalReplyFailed', { error: String(error) }) }, state.workspacePath);
        await deps.providers[state.kind].cancel(state.sessionId!).catch(() => undefined);
      });
    },
    async listModels(kind) {
      try {
        return (await deps.providers[kind].listModels?.()) ?? [];
      } catch (error) {
        console.log(`[agent] ${kind} model/list 失敗:`, error);
        return [];
      }
    },
    async closePetSession(petId, workspacePath) {
      closing.set(petId, (closing.get(petId) ?? 0) + 1);
      try {
        const targets = [...states.entries()].filter(([, s]) => s.petId === petId && (!workspacePath || s.workspacePath === workspacePath));
        for (const [key, state] of targets) {
          if (state.sessionId) {
            if (state.running) await deps.providers[state.kind].cancel(state.sessionId).catch(() => undefined);
            await deps.providers[state.kind].closeSession(state.sessionId).catch(() => undefined);
          }
          states.delete(key);
        }
      } finally {
        const remaining = (closing.get(petId) ?? 1) - 1;
        if (remaining) closing.set(petId, remaining); else closing.delete(petId);
        deps.onTurnFinished?.(petId);
      }
    },
    async dispose() {
      states.clear();
      await Promise.all(Object.values(deps.providers).map((p) => p.dispose().catch(() => undefined)));
    },
    shutdownSync() {
      states.clear();
      for (const provider of Object.values(deps.providers)) provider.shutdownSync();
    }
  };
}
