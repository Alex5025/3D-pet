import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
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
        '--include-partial-messages',
        '--disallowedTools', '*' // v1 純問答
      ];
      if (opts?.model) args.push('--model', opts.model);
      if (opts?.effort) args.push('--effort', opts.effort);
      const isRealId = !sessionId.startsWith('pending-');
      if (isRealId) args.push('--resume', sessionId);

      const child = spawn('claude', args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      running.set(sessionId, child);
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
    async respondApproval() {
      throw new Error('claude provider:approval 是 v2');
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
    },
    shutdownSync() {
      for (const child of new Set(running.values())) child.kill('SIGTERM');
      running.clear();
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
