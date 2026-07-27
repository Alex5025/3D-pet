import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { app } from 'electron';
import type { AgentEvent, AgentProvider } from './types';

/**
 * ClaudeProvider:每 turn spawn `claude -p`(stream-json),吃本機 Claude Code CLI 的訂閱登入。
 * 事件形狀依 v0 煙霧測試樣本(scratchpad/agent-smoke/claude-p-*.jsonl)。
 * - session id 由首 turn 的 system/init 事件產生(claude 沒有「先開 session」的概念),
 *   startSession 只回傳 resumeId 或空字串;真 id 靠 sendMessage 的 session 事件回存。
 * - cancel = SIGTERM → 1s → SIGKILL;殺行程不丟 session(v0 實證,--resume 照常)。
 * - prompt 走 stdin(v0 實證可行;避免 argv 逃逸,也解掉 claude 等 stdin 3 秒的坑)。
 */

/** 簡單的 push→async iterate 佇列(readline 推、generator 拉)。 */
class EventQueue {
  private buffer: AgentEvent[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(event: AgentEvent): void {
    this.buffer.push(event);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *drain(): AsyncIterable<AgentEvent> {
    for (;;) {
      while (this.buffer.length) yield this.buffer.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

function killGracefully(child: ChildProcess): void {
  child.kill('SIGTERM');
  const hardKill = setTimeout(() => {
    if (!child.killed || child.exitCode === null) child.kill('SIGKILL');
  }, 1000);
  child.once('exit', () => clearTimeout(hardKill));
}

export function createClaudeProvider(): AgentProvider {
  /** handle → workdir(spawn 每 turn 都要 cwd;handle 是 resume 的真 id 或新 session 的暫時代號)。 */
  const sessions = new Map<string, string>();
  /** 進行中 turn 的子行程,鍵 = handle;init 拿到真 id 後補別名(cancel 用哪個 id 都找得到)。 */
  const running = new Map<string, ChildProcess>();
  /** 使用者主動取消的行程:SIGTERM 後 claude 會優雅吐 result is_error(v0 未觀察到、e2e 實證),要轉成 done ok:false 而非紅字錯誤。 */
  const cancelRequested = new WeakSet<ChildProcess>();
  let pendingSeq = 0;

  /* ── 權限審批基建(permission=ask 才啟用;契約依 v2.0 煙霧測試)──
   * claude 的 --permission-prompt-tool 把權限詢問導向我們的 MCP 腳本(permPromptServer.mjs),
   * 腳本經本機 socket 回連這裡 → 轉成 approval 事件 → 使用者在泡泡按 允許/拒絕 → 回寫 socket。 */
  const permToken = randomUUID();
  const permDir = mkdtempSync(join(tmpdir(), 'vrm-pet-perm-'));
  const permSocketPath = join(permDir, 'perm.sock');
  let permServer: Server | null = null;
  /** turnKey → 該 turn 的事件佇列(審批事件路由)。 */
  const approvalQueues = new Map<string, EventQueue>();
  /** requestId → 等待回覆的 socket。 */
  const pendingPerm = new Map<string, Socket>();
  let permSeq = 0;
  let turnSeq = 0;

  function ensurePermServer(): void {
    if (permServer) return;
    permServer = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>; } catch { socket.destroy(); return; }
        if (payload['token'] !== permToken) { socket.destroy(); return; }
        const queue = approvalQueues.get(String(payload['turnKey']));
        if (!queue) {
          socket.write(JSON.stringify({ behavior: 'deny', message: '對話已結束' }) + '\n');
          return;
        }
        const requestId = `perm-${++permSeq}`;
        pendingPerm.set(requestId, socket);
        socket.once('close', () => pendingPerm.delete(requestId));
        const input = (payload['input'] ?? {}) as Record<string, unknown>;
        const description = [
          typeof input['description'] === 'string' ? input['description'] : `想使用工具 ${String(payload['toolName'])}`,
          typeof input['command'] === 'string' ? `$ ${input['command']}` : '',
          typeof input['file_path'] === 'string' ? `檔案:${input['file_path']}` : ''
        ].filter(Boolean).join('\n');
        queue.push({ kind: 'approval', requestId, description });
      });
    });
    permServer.listen(permSocketPath);
  }

  /** 每 turn 一份 mcp-config(env 帶 turnKey 做審批路由)。 */
  function writePermConfig(turnKey: string): string {
    const script = join(app.getAppPath(), 'src/main/agent/permPromptServer.mjs');
    const path = join(permDir, `${turnKey}.json`);
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        vrmpet: {
          command: 'node',
          args: [script],
          env: { VRM_PET_PERM_SOCKET: permSocketPath, VRM_PET_PERM_TOKEN: permToken, VRM_PET_TURN_KEY: turnKey }
        }
      }
    }));
    return path;
  }

  return {
    kind: 'claude',
    async startSession(opts) {
      // claude 沒有「先開 session」的動作,真 id 在首 turn 的 init 事件才出現
      const handle = opts.resumeId ?? `pending-${++pendingSeq}`;
      sessions.set(handle, opts.workdir);
      return handle;
    },
    async *sendMessage(sessionId, text, opts): AsyncIterable<AgentEvent> {
      const queue = new EventQueue();
      const workdir = sessions.get(sessionId);
      const env = { ...process.env };
      delete env['ANTHROPIC_API_KEY']; // 硬性約束:不用計費 API,一律走 CLI 訂閱登入
      const args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages'
      ];
      // 權限等級 → 旗標(v2.0 實證:permission-prompt-tool 契約見 VERDICT)
      const permission = opts?.permission ?? 'readonly';
      let turnKey: string | null = null;
      if (permission === 'ask') {
        ensurePermServer();
        turnKey = `turn-${++turnSeq}`;
        args.push('--permission-prompt-tool', 'mcp__vrmpet__approve', '--mcp-config', writePermConfig(turnKey));
      } else if (permission === 'auto') {
        args.push('--permission-mode', 'bypassPermissions');
      } else {
        args.push('--disallowedTools', '*'); // 唯讀:純問答
      }
      if (opts?.model) args.push('--model', opts.model);
      if (opts?.effort) args.push('--effort', opts.effort);
      // 角色個性:附加到 system prompt(逐 turn 注入,設定面板改完下一句就生效)
      if (opts?.persona) args.push('--append-system-prompt', `你是一隻桌面寵物。以下是你的角色設定,請以此個性回應:\n${opts.persona}`);
      const isRealId = !sessionId.startsWith('pending-');
      if (isRealId) args.push('--resume', sessionId);

      const child = spawn('claude', args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      running.set(sessionId, child);
      if (turnKey) approvalQueues.set(turnKey, queue);
      let realSessionId = sessionId;
      let sawResult = false;
      let stderrTail = '';

      child.stdin.write(text + '\n');
      child.stdin.end();
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-500);
      });
      child.on('error', (error) => {
        queue.push({ kind: 'error', message: `claude 啟動失敗:${error.message}` });
        queue.end();
      });

      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // 非 JSON 行忽略(v0 樣本中不存在,防衛性)
        }
        const type = msg['type'];
        if (type === 'system' && msg['subtype'] === 'init' && typeof msg['session_id'] === 'string') {
          realSessionId = msg['session_id'];
          running.set(realSessionId, child); // 補真 id 別名,讓 cancel(真 id) 找得到行程
          if (workdir) sessions.set(realSessionId, workdir); // 之後的 turn 會改用真 id 當 handle
          queue.push({ kind: 'session', sessionId: realSessionId });
          queue.push({ kind: 'thinking' });
          return;
        }
        if (type === 'stream_event') {
          const event = msg['event'] as Record<string, unknown> | undefined;
          if (event?.['type'] === 'content_block_delta') {
            const delta = event['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
              queue.push({ kind: 'text', text: delta['text'] });
            }
          }
          return;
        }
        if (type === 'assistant') {
          // 文字已由 stream_event delta 給過,這裡只取 tool_use(v1 禁工具,防衛性保留)
          const content = (msg['message'] as { content?: { type?: string; name?: string }[] })?.content ?? [];
          for (const block of content) {
            if (block.type === 'tool_use' && block.name) queue.push({ kind: 'tool', name: block.name });
          }
          return;
        }
        if (type === 'result') {
          sawResult = true;
          if (msg['is_error']) {
            if (cancelRequested.has(child)) {
              queue.push({ kind: 'done', ok: false }); // 使用者主動取消,不是錯誤
            } else {
              const detail = typeof msg['result'] === 'string' ? msg['result'] : 'claude 回報錯誤';
              queue.push({ kind: 'error', message: detail });
            }
          } else {
            queue.push({ kind: 'done', ok: true });
          }
        }
        // rate_limit_event / system post_turn_summary 等其他型別忽略(v0 樣本)
      });
      child.on('close', (code) => {
        if (!sawResult && code !== 0 && code !== null && stderrTail) {
          queue.push({ kind: 'error', message: `claude 結束(code ${code}):${stderrTail.trim()}` });
        }
        // 被 cancel 殺掉(SIGTERM)→ 不吐終結事件,由 bridge 補 done ok:false
        running.delete(sessionId);
        if (realSessionId) running.delete(realSessionId);
        if (turnKey) approvalQueues.delete(turnKey);
        queue.end();
      });

      yield* queue.drain();
    },
    async cancel(sessionId) {
      const child = running.get(sessionId);
      if (child) {
        cancelRequested.add(child);
        killGracefully(child);
      }
    },
    async respondApproval(_sessionId, requestId, allow) {
      const socket = pendingPerm.get(requestId);
      if (!socket) return;
      pendingPerm.delete(requestId);
      socket.write(JSON.stringify(
        allow ? { behavior: 'allow', updatedInput: undefined } : { behavior: 'deny', message: '使用者拒絕了這個操作' }
      ) + '\n');
    },
    async closeSession(sessionId) {
      // claude 無常駐行程,關 session = 殺掉還在跑的 turn(session 檔在磁碟,resume 不受影響)
      const child = running.get(sessionId);
      if (child) killGracefully(child);
      sessions.delete(sessionId);
    },
    async dispose() {
      for (const child of new Set(running.values())) killGracefully(child);
      running.clear();
      permServer?.close();
      try { rmSync(permDir, { recursive: true, force: true }); } catch { /* tmp 檔,留著無害 */ }
    },
    shutdownSync() {
      for (const child of new Set(running.values())) child.kill('SIGTERM');
      running.clear();
      permServer?.close();
    },
    async listModels() {
      // claude CLI 沒有機器可讀的模型清單指令;別名穩定(--help 明載),haiku 實測可用(2026-07)
      const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
      return [
        { id: 'fable', label: 'Fable(最強)', efforts },
        { id: 'opus', label: 'Opus', efforts, isDefault: true },
        { id: 'sonnet', label: 'Sonnet(均衡)', efforts },
        { id: 'haiku', label: 'Haiku(最快)', efforts }
      ];
    }
  };
}
