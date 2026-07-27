import type { AgentBinding, AgentEvent, AgentKind } from '../../shared/agentEvents';
import type { AgentProvider } from './types';

/** bridge 需要的 profile 子集(依賴注入,避免與 index.ts 循環引用)。 */
export interface AgentPetProfile {
  id: string;
  workspacePath?: string;
  agent?: AgentBinding;
}

export interface AgentBridgeDeps {
  getPet(id: string): AgentPetProfile | null;
  updatePet(id: string, patch: { agent: AgentBinding }): unknown;
  /** 事件推回泡泡;index.ts 綁 win?.webContents.send('chat-event-apply', petId, event)。 */
  send(petId: string, event: AgentEvent): void;
  providers: Record<AgentKind, AgentProvider>;
}

export interface AgentBridge {
  chatSend(petId: string, text: string): void;
  chatCancel(petId: string): void;
  /** 寵物休眠/刪除/換 agent 種類時關閉 session。 */
  closePetSession(petId: string): Promise<void>;
  dispose(): Promise<void>;
  /** app.exit 前的同步收攤(await 不到 async dispose)。 */
  shutdownSync(): void;
}

const MAX_CONCURRENT_TURNS = 4;
const STALL_NOTICE_MS = 30_000; // 30 秒無輸出 → 泡泡顯示「仍在執行…」
const HARD_TIMEOUT_MS = 300_000; // 5 分鐘硬上限 → cancel + error

interface PetAgentState {
  kind: AgentKind;
  sessionId: string | null;
  running: boolean;
}

/** 未設定 agent 的寵物預設走 codex(與舊 codexSessionId 欄位的血緣一致;設定面板可改)。 */
const DEFAULT_KIND: AgentKind = 'codex';

export function createAgentBridge(deps: AgentBridgeDeps): AgentBridge {
  const states = new Map<string, PetAgentState>();

  const runningCount = (): number => [...states.values()].filter((s) => s.running).length;

  function stateFor(petId: string, kind: AgentKind): PetAgentState {
    let state = states.get(petId);
    if (!state || state.kind !== kind) {
      state = { kind, sessionId: null, running: false };
      states.set(petId, state);
    }
    return state;
  }

  async function runTurn(petId: string, text: string): Promise<void> {
    const profile = deps.getPet(petId);
    if (!profile) return; // 寵物已消失,無處回報
    const send = (event: AgentEvent): void => deps.send(petId, event);

    if (!profile.workspacePath) {
      send({ kind: 'error', message: '請先在「工作設定」選擇工作目錄' });
      return;
    }
    const kind = profile.agent?.kind ?? DEFAULT_KIND;
    const provider = deps.providers[kind];
    const state = stateFor(petId, kind);
    if (state.running) {
      send({ kind: 'error', message: '上一輪對話還在進行中' });
      return;
    }
    if (runningCount() >= MAX_CONCURRENT_TURNS) {
      send({ kind: 'error', message: `同時進行的對話已達上限(${MAX_CONCURRENT_TURNS})` });
      return;
    }

    state.running = true;
    let terminated = false; // 保證每 turn 恰一個終結事件(done 或 error)
    const emit = (event: AgentEvent): void => {
      if (event.kind === 'done' || event.kind === 'error') {
        if (terminated) return;
        terminated = true;
      }
      send(event);
    };

    // 看門狗:30s 無輸出提示、5min 硬中斷
    let lastOutput = Date.now();
    let noticed = false;
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastOutput;
      if (!noticed && idle >= STALL_NOTICE_MS) {
        noticed = true;
        send({ kind: 'tool', name: '仍在執行…' });
      }
      if (idle >= HARD_TIMEOUT_MS) {
        if (state.sessionId) void provider.cancel(state.sessionId);
        emit({ kind: 'error', message: '執行逾時(5 分鐘),已中斷' });
      }
    }, 5_000);

    try {
      if (!state.sessionId) {
        const resumeId = profile.agent?.kind === kind ? profile.agent?.sessionId : undefined;
        try {
          state.sessionId = await provider.startSession({ workdir: profile.workspacePath, resumeId });
        } catch (error) {
          if (resumeId) {
            // resume 失敗策略:清掉舊 id、開全新 session(設計 §8 定案)
            console.log(`[agent] resume 失敗,改開新 session:${String(error)}`);
            deps.updatePet(petId, { agent: { kind } });
            state.sessionId = await provider.startSession({ workdir: profile.workspacePath });
          } else {
            throw error;
          }
        }
      }
      // startSession 回傳的是 handle,不持久化;真 id 只從 session 事件回存
      const turnOpts = { model: profile.agent?.model, effort: profile.agent?.effort };
      for await (const event of provider.sendMessage(state.sessionId, text, turnOpts)) {
        lastOutput = Date.now();
        noticed = false;
        if (event.kind === 'session') {
          state.sessionId = event.sessionId;
          if (profile.agent?.kind !== kind || profile.agent?.sessionId !== event.sessionId) {
            deps.updatePet(petId, { agent: { kind, sessionId: event.sessionId } });
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
    }
  }

  return {
    chatSend(petId, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      void runTurn(petId, trimmed);
    },
    chatCancel(petId) {
      const state = states.get(petId);
      if (!state?.running || !state.sessionId) return;
      void deps.providers[state.kind].cancel(state.sessionId);
    },
    async closePetSession(petId) {
      const state = states.get(petId);
      if (!state) return;
      states.delete(petId);
      if (state.sessionId) {
        if (state.running) await deps.providers[state.kind].cancel(state.sessionId).catch(() => undefined);
        await deps.providers[state.kind].closeSession(state.sessionId).catch(() => undefined);
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
