import type { AgentEvent, AgentKind, AgentProvider } from './types';

/**
 * 照腳本吐事件的假 provider:headless selftest 與 VRM_PET_AGENT_MOCK UI 驗證共用,
 * 不依賴真 CLI、不耗額度。魔法 prompt:含「ERROR」→ 吐 error;含「SLOW」→ 拉長延遲(供 cancel/單 turn 測試)。
 */
export interface MockProvider extends AgentProvider {
  /** 供 selftest 斷言的行為記錄(started/message/cancelled/closed/disposed)。 */
  readonly log: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockProvider(kind: AgentKind): MockProvider {
  const log: string[] = [];
  let seq = 0;
  const cancelled = new Set<string>();
  const approvals = new Map<string, (allow: boolean) => void>();

  return {
    kind,
    log,
    async startSession(opts) {
      const sessionId = opts.resumeId ?? `mock-${kind}-${++seq}`;
      log.push(`started:${sessionId}${opts.resumeId ? ':resumed' : ''}`);
      return sessionId;
    },
    async *sendMessage(sessionId, text, opts): AsyncIterable<AgentEvent> {
      log.push(`message:${sessionId}:${text}`);
      if (opts?.images?.length) log.push(`images:${sessionId}:${opts.images.length}`);
      cancelled.delete(sessionId);
      yield { kind: 'session', sessionId };
      yield { kind: 'thinking' };
      if (text.includes('ERROR')) {
        yield { kind: 'error', message: 'mock error' };
        return;
      }
      if (text.includes('APPROVAL')) {
        // 審批腳本:發 approval 事件 → 等 respondApproval → 依決定收尾
        const requestId = `mock-appr-${++seq}`;
        const decision = new Promise<boolean>((resolve) => approvals.set(requestId, resolve));
        yield { kind: 'approval', requestId, description: 'mock 想執行 $ touch mock.txt' };
        const allowed = await decision;
        log.push(`approval:${requestId}:${allowed}`);
        if (allowed) {
          yield { kind: 'text', text: '已執行' };
          yield { kind: 'done', ok: true };
        } else {
          yield { kind: 'text', text: '好的,不執行' };
          yield { kind: 'done', ok: true };
        }
        return;
      }
      const slow = text.includes('SLOW');
      const chunks = ['這是', 'Mock 的', `回覆:${text}`];
      for (const chunk of chunks) {
        await sleep(slow ? 400 : 30);
        if (cancelled.has(sessionId)) {
          yield { kind: 'done', ok: false };
          return;
        }
        yield { kind: 'text', text: chunk };
      }
      yield { kind: 'done', ok: true };
    },
    async cancel(sessionId) {
      cancelled.add(sessionId);
      log.push(`cancelled:${sessionId}`);
    },
    async respondApproval(_sessionId, requestId, allow) {
      approvals.get(requestId)?.(allow);
      approvals.delete(requestId);
    },
    async closeSession(sessionId) {
      cancelled.add(sessionId);
      log.push(`closed:${sessionId}`);
    },
    async dispose() {
      log.push('disposed');
    },
    shutdownSync() {
      log.push('shutdown');
    }
  };
}
