import { spawn, type ChildProcess } from 'node:child_process';
import { t } from '../../shared/i18n';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentModelInfo, AgentPermission, AgentProvider } from './types';
import { refFilesPrompt } from './types';
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

/** 讀 ~/.codex/config.toml 的 model_reasoning_effort(codex 未指定力度時的實際預設)。
 *  純唯讀、失敗即回 undefined —— 這只是 UI 標示用,拿不到不影響任何行為。 */
function readCodexDefaultEffort(): string | undefined {
  try {
    const text = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    return /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

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
  /** threadId → 已對模型生效的上下文組合值(persona + 參考檔案;'' = 無);null = 未知
   *  (resume 回來的 thread,rollout 裡的舊指示看不到)。與當下組合值不一致時,下個 turn 前注入更新。 */
  const appliedContext = new Map<string, string | null>();
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
    proc.on('error', (error) => teardown(t('agent.errCodexStart', { error: error.message })));
    proc.on('exit', () => {
      if (child === proc) teardown(t('agent.codexEnded'));
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
      if (res.error) throw new Error(t('agent.initFailed', { error: res.error.message ?? t('common.unknown') }));
    });
    return initialized;
  }

  function request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonRpcMessage> {
    const proc = child;
    if (!proc?.stdin?.writable) return Promise.resolve({ error: { message: t('agent.codexNotConnected') } });
    const id = nextId++;
    if (AGENT_DEBUG) console.log(`[codex][debug] → ${method}\n${JSON.stringify(params, null, 2)}`);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: t('agent.rpcTimeout', { method }) } });
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
        handler('__approval__', { requestId, description: String(params['message'] ?? t('agent.approvalMcp')) });
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
      ? t('agent.approvalEditFallback')
      : t('agent.approvalExec');
    const description = [
      typeof params['reason'] === 'string' ? params['reason'] : '',
      typeof command === 'string' ? `$ ${command}` : Array.isArray(command) ? `$ ${command.join(' ')}` : '',
      files ? t('agent.approvalEditFiles', { files }) : ''
    ].filter(Boolean).join('\n') || fallback;
    handler('__approval__', { requestId, description });
  }

  const isRecordLike = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  /** 權限等級 → thread 參數。ask 用 untrusted 而非 on-request:
   *  on-request 是「模型自行判斷」,workspace 內寫入常直接做(e2e 實測不穩);
   *  untrusted 只放行安全唯讀指令,其餘一律發審批(實測 allow/deny 兩向都保證詢問)。 */
  const permissionParams = (permission: AgentPermission): Record<string, string> =>
    // plan 走唯讀沙盒:codex CLI 沒有對應的 plan 旗標(實測 --help 無此選項),
    // 「先出計畫不動手」= 唯讀 + 計畫指示(指示在 composeContext 注入)
    permission === 'ask'
      ? { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }
      : permission === 'auto'
        ? { sandbox: 'workspace-write', approvalPolicy: 'never' }
        : { sandbox: 'read-only', approvalPolicy: 'never' };

  async function loadThread(threadId: string | null, workdir: string, persona: string | undefined, permission: AgentPermission, petId?: string): Promise<string> {
    await ensureServer();
    const perm = permissionParams(permission);
    // 角色個性 + 寵物工具提示:官方 developerInstructions 欄位(thread 建立/恢復時注入)
    const parts: string[] = [t('prompt.petPreamble')];
    if (persona) parts.push(`${t('prompt.personaIntro')}\n${persona}`);
    if (hub && petId) parts.push(t('prompt.performanceRules'));
    const dev = parts.length > 1 ? { developerInstructions: parts.join('\n') } : {};
    // 寵物工具 MCP:以 thread config 覆寫掛載(v3.0 實測可行)
    const mcp = hub && petId
      ? { config: { mcp_servers: { pettools: { command: 'node', args: [hub.scriptPath], env: {
          VRM_PET_TOOLS_SOCKET: hub.socketPath, VRM_PET_TOOLS_TOKEN: hub.token, VRM_PET_PET_ID: petId
        } } } } }
      : {};
    if (threadId) {
      // 注意:resume 的 developerInstructions「不會」生效(2026-07 實測,連全新 server 也一樣,
      // schema 有欄位但 server 沿用 rollout 裡的舊指示)——既有 thread 的上下文走 syncContext 注入。
      const res = await request('thread/resume', { threadId, cwd: workdir, ...perm, ...mcp });
      if (res.error) throw new Error(t('agent.resumeFailed', { error: res.error.message ?? t('common.unknown') }));
      loadedThreads.add(threadId);
      appliedContext.set(threadId, null); // rollout 裡的舊指示看不到,上下文狀態未知
      return threadId;
    }
    const res = await request('thread/start', { cwd: workdir, ...perm, ...dev, ...mcp });
    if (res.error) throw new Error(t('agent.startFailed', { error: res.error.message ?? t('common.unknown') }));
    const id = (res.result?.['thread'] as { id?: string } | undefined)?.id;
    if (!id) throw new Error(t('agent.noThreadId'));
    loadedThreads.add(id);
    appliedContext.set(id, composeContext(persona, undefined, permission)); // thread/start 只注入 persona,參考檔由首個 turn 的 syncContext 補上
    return id;
  }

  /** persona + 參考檔案的組合上下文(比對與注入都用這個組合值;'' = 兩者皆無)。 */
  function composeContext(
    persona: string | undefined,
    refFiles: string[] | undefined,
    permission?: AgentPermission,
  ): string {
    const parts: string[] = [];
    // 計畫模式的指示放最前面(權限值成為組合值的一部分 → 切換權限時下個 turn 自動注入,
    // 與換語言同一個刻意依賴;離開計畫模式時指示消失,codex 就恢復正常動手)
    if (permission === 'plan') parts.push(t('prompt.planMode'));
    const trimmed = persona?.trim();
    if (trimmed) parts.push(`${t('prompt.personaCurrentIntro')}\n${trimmed}`);
    const refs = refFilesPrompt(refFiles);
    if (refs) parts.push(refs);
    return parts.join('\n\n');
  }

  /** 既有 thread 的上下文對齊(persona + 參考檔案):與已生效組合值不同時,以 thread/inject_items
   *  注入 developer 訊息(2026-07 實測:注入可即時生效、壓過 rollout 舊指示與歷史慣性;
   *  resume 換 developerInstructions 則無效)。移除參考檔 = 組合值變了 → 注入「以本則為準」的新清單。 */
  async function syncContext(
    threadId: string,
    persona: string | undefined,
    refFiles: string[] | undefined,
    permission?: AgentPermission,
  ): Promise<void> {
    const wanted = composeContext(persona, refFiles, permission);
    const applied = appliedContext.get(threadId) ?? null;
    if (wanted === applied) return;
    if (!wanted && applied === null) return; // 未知基準且無上下文:視為無,不注入
    const text = wanted
      ? `${t('prompt.contextUpdate')}\n${wanted}` // 換語言會讓組合值改變 → 下個 turn 自動 inject 新語言指示(刻意依賴)
      : t('prompt.contextCleared');
    const res = await request('thread/inject_items', { threadId, items: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }
    ] });
    if (res.error) {
      console.log(`[codex] 上下文注入失敗(下個 turn 重試):${res.error.message ?? '未知'}`);
      return;
    }
    appliedContext.set(threadId, wanted);
  }

  return {
    kind: 'codex',
    async startSession(opts) {
      // thread 直接以「當下權限」建立——不可先用假的 readonly 再讓 sendMessage 對齊:
      // 那會在首個 turn 觸發「權限變更 → 重啟 server + resume」,而剛建立、還沒跑過 turn 的
      // thread 在 codex 那邊沒有 rollout 檔,resume 必定失敗(no rollout found,實測)。
      const permission: AgentPermission = opts.permission ?? 'readonly';
      const threadId = await loadThread(opts.resumeId ?? null, opts.workdir, opts.persona, permission, opts.petId);
      sessions.set(threadId, { workdir: opts.workdir, persona: opts.persona, permission, petId: opts.petId });
      return threadId;
    },
    async *sendMessage(threadId, text, opts): AsyncIterable<AgentEvent> {
      // crash 後的 lazy 重啟,或權限變更。
      // 實測(v2 煙霧):同 server 內對已載入 thread 重新 resume「不會」換 sandbox/approval;
      // 全新 server 的 resume 才會套新權限 → 權限變更 = 重啟 app-server 再 resume(context 保留)。
      // 代價:其他 codex 寵物進行中的 turn 會收到 error(權限切換是罕見操作,可接受)。
      // persona/參考檔不走這條:resume 的 developerInstructions 實測無效,改由 syncContext 注入(免重啟)。
      const saved = sessions.get(threadId);
      const permission: AgentPermission = opts?.permission ?? 'readonly';
      // persona 以本 turn 傳入為準(bridge 每 turn 帶當下 profile.persona;undefined = 已清空)——
      // 不能讓 saved 舊值優先,否則設定面板改了個性、這裡永遠用舊的
      const persona = opts ? opts.persona : saved?.persona;
      if (loadedThreads.has(threadId) && saved?.permission !== permission) {
        const proc = child;
        teardown(t('agent.permRestart'));
        proc?.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!loadedThreads.has(threadId) || saved?.permission !== permission) {
        const workdir = saved?.workdir ?? process.cwd();
        const petId = saved?.petId ?? opts?.petId;
        loadedThreads.delete(threadId);
        try {
          await loadThread(threadId, workdir, persona, permission, petId);
          sessions.set(threadId, { workdir, persona, permission, petId });
        } catch (error) {
          // resume 失敗(rollout 被清掉/從未寫入)→ 開全新 thread 接手,不讓寵物永久卡死。
          // 本 turn 起改用新 id;下方每 turn 固定 push 的 session 事件會帶新 id 給 bridge 持久化。
          console.log(`[codex] resume 失敗,改開新 thread:${String(error)}`);
          const fresh = await loadThread(null, workdir, persona, permission, petId);
          sessions.delete(threadId);
          appliedContext.delete(threadId);
          sessions.set(fresh, { workdir, persona, permission, petId });
          threadId = fresh; // 通知路由(turnHandlers)/interrupt 都跟著換到新 thread
        }
      }
      await syncContext(threadId, persona, opts?.refFiles, permission); // 上下文對齊(有變更才注入;失敗不擋 turn)

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
          push({ kind: 'error', message: String(params['message'] ?? t('agent.codexDisconnected')) });
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
          if (type === 'commandExecution') push({ kind: 'tool', name: t('agent.toolCommand') });
          else if (type === 'webSearch') push({ kind: 'tool', name: t('agent.toolSearch') });
          return;
        }
        if (method === 'turn/completed') {
          const turn = params['turn'] as { status?: string; error?: { message?: string } } | undefined;
          activeTurns.delete(threadId);
          if (turn?.status === 'completed') push({ kind: 'done', ok: true });
          else if (turn?.status === 'interrupted') push({ kind: 'done', ok: false });
          else push({ kind: 'error', message: turn?.error?.message ?? t('agent.turnEnded', { status: turn?.status ?? t('common.unknown') }) });
          end();
        }
      });

      try {
        // threadId 即真 session id:每 turn 開頭補 session 事件,bridge 據此持久化(去重後只落盤一次)
        push({ kind: 'session', sessionId: threadId });
        // model / effort 是官方 TurnStartParams 欄位(v0 generate-ts 產物),逐 turn 指定、免重開 thread
        const input: Record<string, unknown>[] = [];
        if (text) input.push({ type: 'text', text, text_elements: [] });
        for (const image of opts?.images ?? []) {
          input.push({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` });
        }
        const turnParams: Record<string, unknown> = { threadId, input };
        if (opts?.model) turnParams['model'] = opts.model;
        if (opts?.effort) turnParams['effort'] = opts.effort;
        const res = await request('turn/start', turnParams, 120_000);
        if (res.error) {
          push({ kind: 'error', message: t('agent.turnStartFailed', { error: res.error.message ?? t('common.unknown') }) });
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
    async respondApproval(threadId, requestId, allow, feedback) {
      const pending = pendingApprovals.get(requestId);
      if (!pending) return;
      pendingApprovals.delete(requestId);
      if (pending.method === 'mcpServer/elicitation/request') {
        respondToServer(pending.rpcId, { action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null });
        const turnId = activeTurns.get(threadId);
        if (!allow && feedback && turnId) {
          await request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: 'text', text: t('prompt.denyFeedback', { feedback }), text_elements: [] }],
          });
        }
        return;
      }
      const legacy = pending.method === 'execCommandApproval' || pending.method === 'applyPatchApproval';
      const decision = legacy
        ? (allow ? 'approved' : { denied: { rejection: feedback || '使用者拒絕' } })
        : (allow ? 'accept' : 'decline');
      respondToServer(pending.rpcId, { decision });
      const turnId = activeTurns.get(threadId);
      if (!allow && feedback && !legacy && turnId) {
        await request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: 'text', text: t('prompt.denyFeedback', { feedback }), text_elements: [] }],
        });
      }
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
      // 不指定力度時 codex 用 ~/.codex/config.toml 的 model_reasoning_effort;
      // model/list 不回這個值,只能讀設定檔(唯讀,讀不到就當不知道)
      const defaultEffort = readCodexDefaultEffort();
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
          isDefault: m.isDefault === true,
          ...(defaultEffort ? { defaultEffort } : {})
        }));
    }
  };
}
