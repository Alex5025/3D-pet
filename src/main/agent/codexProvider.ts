import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent, AgentModelInfo, AgentPermission, AgentProvider } from './types';
import type { PetToolsHub } from './petToolsHub';

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

/** VRM_PET_AGENT_DEBUG=1:每個送往 app-server 的 JSON-RPC 請求原樣 dump 到終端機(除錯用)。 */
const AGENT_DEBUG = process.env['VRM_PET_AGENT_DEBUG'] === '1';

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export function createCodexProvider(hub: PetToolsHub | null = null): AgentProvider {
  let child: ChildProcess | null = null;
  let initialized: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (msg: JsonRpcMessage) => void; timer: NodeJS.Timeout }>();
  /** threadId → { workdir, persona, permission, petId }(crash 後 resume 與權限變更重載用)。 */
  const sessions = new Map<string, { workdir: string; persona?: string; permission: AgentPermission; petId?: string }>();
  /** requestId → 待回覆的審批 ServerRequest(rpc id + method,回覆形狀依 method 而異)。 */
  const pendingApprovals = new Map<string, { rpcId: number; method: string }>();
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
    pendingApprovals.clear();
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
      if (msg.method !== undefined && msg.id !== undefined) {
        handleServerRequest(msg);
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
    if (AGENT_DEBUG) console.log(`[codex][debug] → ${method}\n${JSON.stringify(params, null, 2)}`);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `${method} 逾時` } });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
    });
  }

  function respondToServer(rpcId: number, result: Record<string, unknown>): void {
    child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: rpcId, result }) + '\n');
  }

  /** 審批類 ServerRequest(v2.0 煙霧測試實證:item/commandExecution/requestApproval,params 帶現成中文 reason)。 */
  function handleServerRequest(msg: JsonRpcMessage): void {
    const params = msg.params ?? {};
    const threadId = (params['threadId'] ?? params['conversationId']) as string | undefined;
    const handler = threadId ? turnHandlers.get(threadId) : undefined;
    // 寵物工具的 MCP 呼叫核准(mcpServer/elicitation/request)自動放行——那是我們自己的工具
    if (msg.method === 'mcpServer/elicitation/request') {
      if (params['serverName'] === 'pettools') {
        respondToServer(msg.id!, { action: 'accept', content: {}, _meta: null });
        return;
      }
      // 使用者自己在 config.toml 掛的其他 MCP server → 轉泡泡審批(message 是人話)
      if (handler && msg.id !== undefined) {
        const requestId = `appr-${msg.id}`;
        pendingApprovals.set(requestId, { rpcId: msg.id, method: msg.method });
        handler('__approval__', { requestId, description: String(params['message'] ?? 'MCP 工具呼叫請求') });
      } else if (msg.id !== undefined) {
        respondToServer(msg.id, { action: 'decline', content: null, _meta: null });
      }
      return;
    }
    const known = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'execCommandApproval',
      'applyPatchApproval'
    ].includes(msg.method!);
    if (!handler || !known || msg.id === undefined) {
      // 沒有進行中 turn 或未知請求:decline 防呆,絕不讓 server 掛著等
      if (msg.id !== undefined) respondToServer(msg.id, { decision: 'decline' });
      console.log('[codex] 未處理的 ServerRequest,已自動拒絕:', msg.method);
      return;
    }
    const requestId = `appr-${msg.id}`;
    pendingApprovals.set(requestId, { rpcId: msg.id, method: msg.method! });
    const command = params['command'];
    const files = isRecordLike(params['fileChanges']) ? Object.keys(params['fileChanges'] as object).join('、') : '';
    // fileChange 的 params 常只有可為 null 的 reason(v2 實測)——fallback 要是人話,不能是方法名
    const fallback = msg.method === 'item/fileChange/requestApproval' || msg.method === 'applyPatchApproval'
      ? '想修改工作目錄中的檔案(內容見泡泡回覆)'
      : '想執行需要核准的操作';
    const description = [
      typeof params['reason'] === 'string' ? params['reason'] : '',
      typeof command === 'string' ? `$ ${command}` : Array.isArray(command) ? `$ ${command.join(' ')}` : '',
      files ? `修改檔案:${files}` : ''
    ].filter(Boolean).join('\n') || fallback;
    handler('__approval__', { requestId, description });
  }

  const isRecordLike = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  /** 權限等級 → thread 參數。ask 用 untrusted 而非 on-request:
   *  on-request 是「模型自行判斷」,workspace 內寫入常直接做(e2e 實測不穩);
   *  untrusted 只放行安全唯讀指令,其餘一律發審批(實測 allow/deny 兩向都保證詢問)。 */
  const permissionParams = (permission: AgentPermission): Record<string, string> =>
    permission === 'ask'
      ? { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }
      : permission === 'auto'
        ? { sandbox: 'workspace-write', approvalPolicy: 'never' }
        : { sandbox: 'read-only', approvalPolicy: 'never' };

  async function loadThread(threadId: string | null, workdir: string, persona: string | undefined, permission: AgentPermission, petId?: string): Promise<string> {
    await ensureServer();
    const perm = permissionParams(permission);
    // 角色個性 + 寵物工具提示:官方 developerInstructions 欄位(thread 建立/恢復時注入)
    const parts: string[] = ['你是一隻桌面寵物。'];
    if (persona) parts.push(`以下是你的角色設定,請以此個性回應:\n${persona}`);
    if (hub && petId) parts.push('表演規則:每次回覆前先用 pet_show_expression 配合情緒(開心 happy、遇到問題 sad、驚訝 surprised);打招呼或完成任務時用 pet_play_motion 播個動作;工作過程較長時用 pet_speak 簡短回報。這些是你身體的一部分,主動使用,不要等使用者要求。');
    const dev = parts.length > 1 ? { developerInstructions: parts.join('\n') } : {};
    // 寵物工具 MCP:以 thread config 覆寫掛載(v3.0 實測可行)
    const mcp = hub && petId
      ? { config: { mcp_servers: { pettools: { command: 'node', args: [hub.scriptPath], env: {
          VRM_PET_TOOLS_SOCKET: hub.socketPath, VRM_PET_TOOLS_TOKEN: hub.token, VRM_PET_PET_ID: petId
        } } } } }
      : {};
    if (threadId) {
      const res = await request('thread/resume', { threadId, cwd: workdir, ...perm, ...dev, ...mcp });
      if (res.error) throw new Error(`thread/resume 失敗:${res.error.message ?? '未知'}`);
      loadedThreads.add(threadId);
      return threadId;
    }
    const res = await request('thread/start', { cwd: workdir, ...perm, ...dev, ...mcp });
    if (res.error) throw new Error(`thread/start 失敗:${res.error.message ?? '未知'}`);
    const id = (res.result?.['thread'] as { id?: string } | undefined)?.id;
    if (!id) throw new Error('thread/start 未回傳 thread id');
    loadedThreads.add(id);
    return id;
  }

  return {
    kind: 'codex',
    async startSession(opts) {
      // 先以唯讀開 thread;實際權限在首個 turn 由 sendMessage 對齊(權限變更走重啟+resume)
      const permission: AgentPermission = 'readonly';
      const threadId = await loadThread(opts.resumeId ?? null, opts.workdir, opts.persona, permission, opts.petId);
      sessions.set(threadId, { workdir: opts.workdir, persona: opts.persona, permission, petId: opts.petId });
      return threadId;
    },
    async *sendMessage(threadId, text, opts): AsyncIterable<AgentEvent> {
      // crash 後的 lazy 重啟,或權限變更。
      // 實測(v2 煙霧):同 server 內對已載入 thread 重新 resume「不會」換 sandbox/approval;
      // 全新 server 的 resume 才會套新參數 → 權限變更 = 重啟 app-server 再 resume(context 保留)。
      // 代價:其他 codex 寵物進行中的 turn 會收到 error(權限切換是罕見操作,可接受)。
      const saved = sessions.get(threadId);
      const permission: AgentPermission = opts?.permission ?? 'readonly';
      if (loadedThreads.has(threadId) && saved?.permission !== permission) {
        const proc = child;
        teardown('權限變更,重啟 app-server');
        proc?.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!loadedThreads.has(threadId) || saved?.permission !== permission) {
        const workdir = saved?.workdir ?? process.cwd();
        const persona = saved?.persona ?? opts?.persona;
        const petId = saved?.petId ?? opts?.petId;
        loadedThreads.delete(threadId);
        await loadThread(threadId, workdir, persona, permission, petId);
        sessions.set(threadId, { workdir, persona, permission, petId });
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
        if (method === '__approval__') {
          push({ kind: 'approval', requestId: String(params['requestId']), description: String(params['description']) });
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
    async respondApproval(_threadId, requestId, allow) {
      const pending = pendingApprovals.get(requestId);
      if (!pending) return;
      pendingApprovals.delete(requestId);
      if (pending.method === 'mcpServer/elicitation/request') {
        respondToServer(pending.rpcId, { action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null });
        return;
      }
      const legacy = pending.method === 'execCommandApproval' || pending.method === 'applyPatchApproval';
      const decision = legacy
        ? (allow ? 'approved' : { denied: { rejection: '使用者拒絕' } })
        : (allow ? 'accept' : 'decline');
      respondToServer(pending.rpcId, { decision });
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
    },
    async listModels(): Promise<AgentModelInfo[]> {
      await ensureServer();
      const res = await request('model/list', {});
      if (res.error) throw new Error(res.error.message ?? 'model/list 失敗');
      const data = (res.result?.['data'] ?? []) as Array<{
        id?: string;
        displayName?: string;
        hidden?: boolean;
        isDefault?: boolean;
        supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
      }>;
      return data
        .filter((m) => m.id && !m.hidden)
        .map((m) => ({
          id: m.id!,
          label: m.displayName ?? m.id!,
          efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort!).filter(Boolean),
          isDefault: m.isDefault === true
        }));
    }
  };
}
