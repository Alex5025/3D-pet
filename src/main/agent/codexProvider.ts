import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent, AgentProvider } from './types';

/**
 * CodexProvider:長駐 `codex app-server`(NDJSON JSON-RPC over stdio,官方給自訂 client 的介面)。
 * method 名與 payload 形狀依 v0 產物(codex app-server generate-ts)與煙霧測試樣本
 * (scratchpad/agent-smoke/codex-appserver-events.jsonl,codex-cli 0.145.0 實測)。
 * - session handle = threadId(真 id,thread/start 即拿到)。
 * - v1 純問答:sandbox read-only + approvalPolicy never(實測全程零 approval)。
 * - cancel = turn/interrupt {threadId, turnId}(實測 status=interrupted、thread 可續用)。
 * - crash:偵測 exit → 進行中 turn 吐 error;下次呼叫 lazy 重啟,未載入的 thread 自動 thread/resume。
 */

const REQUEST_TIMEOUT_MS = 30_000;

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export function createCodexProvider(): AgentProvider {
  let child: ChildProcess | null = null;
  let initialized: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (msg: JsonRpcMessage) => void; timer: NodeJS.Timeout }>();
  /** threadId → workdir(crash 後 resume 用)。 */
  const sessions = new Map<string, string>();
  /** 本世代 server 已載入(start/resume 過)的 thread;server 重啟後清空。 */
  const loadedThreads = new Set<string>();
  /** threadId → 進行中 turn 的通知處理器(單寵單 turn,一 thread 至多一個)。 */
  const turnHandlers = new Map<string, NotificationHandler>();
  /** threadId → 進行中 turnId(interrupt 用)。 */
  const activeTurns = new Map<string, string>();

  function teardown(reason: string): void {
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer);
      resolve({ error: { message: reason } });
    }
    pending.clear();
    for (const handler of turnHandlers.values()) {
      handler('__crash__', { message: reason });
    }
    turnHandlers.clear();
    activeTurns.clear();
    loadedThreads.clear();
    child = null;
    initialized = null;
  }

  async function ensureServer(): Promise<void> {
    if (child && initialized) return initialized;
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    proc.stderr?.on('data', () => undefined); // stderr 只有啟動雜訊,壓掉避免洗終端機
    proc.on('error', (error) => teardown(`codex app-server 啟動失敗:${error.message}`));
    proc.on('exit', () => {
      if (child === proc) teardown('codex app-server 已結束(將於下次對話自動重啟)');
    });
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          pending.delete(msg.id);
          waiter.resolve(msg);
        }
        return;
      }
      if (msg.method && msg.params) {
        const threadId = msg.params['threadId'];
        if (typeof threadId === 'string') turnHandlers.get(threadId)?.(msg.method, msg.params);
        // ServerRequest(approval 類)在 read-only+never 下不會出現(v0 實證);v2 再接
      }
    });
    initialized = request('initialize', {
      clientInfo: { name: 'vrm-pet', title: 'VRM 桌寵', version: '0.1.0' },
      capabilities: null
    }).then((res) => {
      if (res.error) throw new Error(`initialize 失敗:${res.error.message ?? '未知'}`);
    });
    return initialized;
  }

  function request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonRpcMessage> {
    const proc = child;
    if (!proc?.stdin?.writable) return Promise.resolve({ error: { message: 'codex app-server 未連線' } });
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} 逾時` } });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
    });
  }

  /** v1 純問答的 thread 參數(唯讀沙箱、永不 approval)。 */
  const READONLY = { sandbox: 'read-only', approvalPolicy: 'never' } as const;

  async function loadThread(threadId: string | null, workdir: string): Promise<string> {
    await ensureServer();
    if (threadId) {
      const res = await request('thread/resume', { threadId, cwd: workdir, ...READONLY });
      if (res.error) throw new Error(`thread/resume 失敗:${res.error.message ?? '未知'}`);
      loadedThreads.add(threadId);
      return threadId;
    }
    const res = await request('thread/start', { cwd: workdir, ...READONLY });
    if (res.error) throw new Error(`thread/start 失敗:${res.error.message ?? '未知'}`);
    const id = (res.result?.['thread'] as { id?: string } | undefined)?.id;
    if (!id) throw new Error('thread/start 未回傳 thread id');
    loadedThreads.add(id);
    return id;
  }

  return {
    kind: 'codex',
    async startSession(opts) {
      const threadId = await loadThread(opts.resumeId ?? null, opts.workdir);
      sessions.set(threadId, opts.workdir);
      return threadId;
    },
    async *sendMessage(threadId, text, opts): AsyncIterable<AgentEvent> {
      // crash 後的 lazy 重啟:thread 不在本世代 server 裡就先 resume
      if (!loadedThreads.has(threadId)) {
        await loadThread(threadId, sessions.get(threadId) ?? process.cwd());
      }

      const buffer: AgentEvent[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      const push = (event: AgentEvent): void => {
        buffer.push(event);
        wake?.();
      };
      const end = (): void => {
        ended = true;
        wake?.();
      };

      turnHandlers.set(threadId, (method, params) => {
        if (method === '__crash__') {
          push({ kind: 'error', message: String(params['message'] ?? 'codex app-server 中斷') });
          end();
          return;
        }
        if (method === 'turn/started') {
          const turnId = (params['turn'] as { id?: string } | undefined)?.id;
          if (turnId) activeTurns.set(threadId, turnId);
          push({ kind: 'thinking' });
          return;
        }
        if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
          push({ kind: 'text', text: params['delta'] });
          return;
        }
        if (method === 'item/started') {
          const type = (params['item'] as { type?: string } | undefined)?.type;
          if (type === 'commandExecution') push({ kind: 'tool', name: '指令' });
          else if (type === 'webSearch') push({ kind: 'tool', name: '搜尋' });
          return;
        }
        if (method === 'turn/completed') {
          const turn = params['turn'] as { status?: string; error?: { message?: string } } | undefined;
          activeTurns.delete(threadId);
          if (turn?.status === 'completed') push({ kind: 'done', ok: true });
          else if (turn?.status === 'interrupted') push({ kind: 'done', ok: false });
          else push({ kind: 'error', message: turn?.error?.message ?? `turn 結束(${turn?.status ?? '未知'})` });
          end();
        }
      });

      try {
        // threadId 即真 session id:每 turn 開頭補 session 事件,bridge 據此持久化(去重後只落盤一次)
        push({ kind: 'session', sessionId: threadId });
        // model / effort 是官方 TurnStartParams 欄位(v0 generate-ts 產物),逐 turn 指定、免重開 thread
        const turnParams: Record<string, unknown> = { threadId, input: [{ type: 'text', text, text_elements: [] }] };
        if (opts?.model) turnParams['model'] = opts.model;
        if (opts?.effort) turnParams['effort'] = opts.effort;
        const res = await request('turn/start', turnParams, 120_000);
        if (res.error) {
          push({ kind: 'error', message: `turn/start 失敗:${res.error.message ?? '未知'}` });
          end();
        }
        for (;;) {
          while (buffer.length) yield buffer.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        turnHandlers.delete(threadId);
        activeTurns.delete(threadId);
      }
    },
    async cancel(threadId) {
      const turnId = activeTurns.get(threadId);
      if (turnId) await request('turn/interrupt', { threadId, turnId });
    },
    async respondApproval() {
      throw new Error('codex provider:approval 是 v2');
    },
    async closeSession(threadId) {
      // thread 在磁碟($CODEX_HOME),清掉本地載入狀態即可;下次以 resume 恢復
      sessions.delete(threadId);
      loadedThreads.delete(threadId);
      activeTurns.delete(threadId);
      turnHandlers.delete(threadId);
    },
    async dispose() {
      const proc = child;
      teardown('provider dispose');
      if (proc) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 1000);
      }
    },
    shutdownSync() {
      const proc = child;
      child = null;
      proc?.kill('SIGTERM');
    }
  };
}
