import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { t } from '../../shared/i18n';
import type { AgentEvent, AgentModelInfo, AgentProvider } from './types';
import { refFilesPrompt } from './types';

/**
 * AgyProvider:每 turn spawn `agy -p`(Antigravity CLI,stream-json),吃本機 Google 登入。
 * 事件形狀依煙霧測試樣本(scratchpad/agy-smoke/stream*.jsonl,2026-08-17,agy 1.1.13):
 * - `init` 事件帶 conversation_id(= session id;resume 用 `--conversation <id>`)。
 * - 文字在 `step_update`(step_type=agent_response)的 text_delta——實測整段一次到達,
 *   非逐字增量;解析器仍做「同 step 只發後綴」防重,兩種語意都安全。
 * - 工具在 step_update(step_type=tool)的 tool_name;終結是 `result` 事件的 status。
 * - 權限:headless 模式需要權限的工具會被 CLI 自動拒絕(實測),所以
 *   readonly = 預設行為(天然唯讀)、auto = --dangerously-skip-permissions、plan = --mode plan;
 *   **ask 做不了**(無 permission-prompt 等效機制),UI 端對 agy 過濾掉 ask。
 * - 無 --append-system-prompt:persona/參考檔案走 codex 式「上下文更新」——組合值變了才在
 *   prompt 前綴注入,沒變就不重複打擾。
 * - 寵物工具(pettools MCP)v1 不接:agy 無逐 turn 的 mcp-config 旗標,全域 settings.json 不碰。
 */

const AGENT_DEBUG = process.env['VRM_PET_AGENT_DEBUG'] === '1';

/** 簡單的 push→async iterate 佇列(readline 推、generator 拉;與 claudeProvider 同款)。 */
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

const EFFORT_SUFFIXES = ['low', 'medium', 'high'] as const;

export function createAgyProvider(): AgentProvider {
  /** handle → workdir(spawn 每 turn 都要 cwd;handle 是 resume 的真 id 或新 session 的暫時代號)。 */
  const sessions = new Map<string, string>();
  /** 進行中 turn 的子行程,鍵 = handle;init 拿到真 id 後補別名(cancel 用哪個 id 都找得到)。 */
  const running = new Map<string, ChildProcess>();
  const cancelRequested = new WeakSet<ChildProcess>();
  /** child → 該 turn 的事件佇列:cancel 的強制終結保險用(close 可能被孤兒子行程佔住 stdio 而不觸發)。 */
  const queueByChild = new WeakMap<ChildProcess, EventQueue>();
  /** session → 上次注入的上下文組合值(persona+refFiles):變了才注入「上下文更新」前綴。 */
  const appliedContext = new Map<string, string>();
  /** listModels 摺疊出的「基底模型 → 可用力度」(gemini-3.7-flash 之類):基底模型必帶 --effort。 */
  const collapsedBases = new Map<string, string[]>();
  const imageDir = mkdtempSync(join(tmpdir(), 'vrm-pet-agy-'));
  let pendingSeq = 0;
  let pastedImageSeq = 0;

  /** persona + 參考檔案的組合值(與 codexProvider.composeContext 同構)。 */
  function composeContext(persona: string | undefined, refFiles: string[] | undefined): string {
    const parts: string[] = [];
    const trimmed = persona?.trim();
    if (trimmed) parts.push(`${t('prompt.personaCurrentIntro')}\n${trimmed}`);
    const refs = refFilesPrompt(refFiles);
    if (refs) parts.push(refs);
    return parts.join('\n\n');
  }

  return {
    kind: 'agy',
    async startSession(opts) {
      // agy 沒有「先開 session」的動作,真 conversation_id 在首 turn 的 init 事件才出現
      const handle = opts.resumeId ?? `pending-${++pendingSeq}`;
      sessions.set(handle, opts.workdir);
      return handle;
    },
    async *sendMessage(sessionId, text, opts): AsyncIterable<AgentEvent> {
      const queue = new EventQueue();
      const workdir = sessions.get(sessionId);
      // 注意:agy 的 --print 是「帶值旗標」(Go flag 風格),prompt 必須當它的參數值;
      // 光給 -p 再餵 stdin 會把下一個旗標吃成問題本身(E2E 實證)。prompt 在下方組完後 push。
      const args = ['--output-format', 'stream-json'];

      // 權限等級 → 旗標(煙霧測試實證:headless 預設就會拒絕寫入/命令 = 天然唯讀)
      const permission = opts?.permission ?? 'readonly';
      if (permission === 'auto') args.push('--dangerously-skip-permissions');
      else if (permission === 'plan') args.push('--mode', 'plan');
      // readonly 與(不該出現的)ask 都走預設 request-review:headless 自動拒絕需權限的工具

      // 模型/力度:agy 原生吃「基底 model + --effort」(實測錯誤訊息明載);
      // 基底模型(listModels 摺疊出的 gemini 系列)必帶 --effort,未選時退 medium。
      if (opts?.model) {
        args.push('--model', opts.model);
        const knownEfforts = collapsedBases.get(opts.model)
          ?? ((/^gemini-/.test(opts.model) && !/-(?:high|medium|low)$/.test(opts.model))
            ? [...EFFORT_SUFFIXES] : null);
        if (knownEfforts) {
          const effort = opts.effort && knownEfforts.includes(opts.effort)
            ? opts.effort
            : knownEfforts.includes('medium') ? 'medium' : knownEfforts[0]!;
          args.push('--effort', effort);
        } else if (opts.effort) {
          args.push('--effort', opts.effort);
        }
      } else if (opts?.effort) {
        args.push('--effort', opts.effort);
      }

      // 貼圖:寫暫存檔,prompt 附路徑清單交給 agy 的 view_file 讀(讀取類工具不需權限)
      const pastedImagePaths: string[] = [];
      for (const image of opts?.images ?? []) {
        const extension = image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/webp' ? 'webp' : 'jpg';
        const path = join(imageDir, `pasted-${++pastedImageSeq}.${extension}`);
        writeFileSync(path, Buffer.from(image.data, 'base64'));
        pastedImagePaths.push(path);
      }

      const isRealId = !sessionId.startsWith('pending-');
      if (isRealId) args.push('--conversation', sessionId);

      // 上下文注入(codex 式):組合值變了才在這一輪 prompt 前綴「上下文更新」;
      // 換語言也會讓組合值改變 → 下個 turn 自動注入新語言指示(刻意依賴,與 codexProvider 同)
      const wanted = composeContext(opts?.persona, opts?.refFiles);
      const applied = appliedContext.get(sessionId) ?? '';
      let contextPrefix = '';
      if (wanted !== applied) {
        contextPrefix = wanted
          ? `${t('prompt.contextUpdate')}\n${wanted}\n\n---\n\n`
          : `${t('prompt.contextCleared')}\n\n---\n\n`;
        appliedContext.set(sessionId, wanted);
      }
      const imagePrompt = pastedImagePaths.length
        ? `\n\n${t('prompt.imagesPasted')}\n${pastedImagePaths.map((path) => `- ${path}`).join('\n')}`
        : '';
      args.push('--print', contextPrefix + (text || t('prompt.readImages')) + imagePrompt);

      if (AGENT_DEBUG) {
        console.log(`[agy][debug] cwd=${workdir ?? '(無)'} spawn agy \\\n  ${args.map((a) => JSON.stringify(a)).join(' \\\n  ')}`);
      }
      const child = spawn('agy', args, { cwd: workdir, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      running.set(sessionId, child);
      queueByChild.set(child, queue);
      let realSessionId = sessionId;
      let sawResult = false;
      let stderrTail = '';
      /** 文字緩衝:agy 的 text_delta 以 byte 邊界切割,多位元組字元在接縫變 U+FFFD(實測),
       *  但 result.response 全文是乾淨的——所以片段只緩衝不發,result 時一次發乾淨全文;
       *  片段到達時發 thinking 餵 bridge 看門狗(長回覆才不會 5 分鐘無事件被硬中斷)。 */
      let bufferedText = '';

      child.stdin.end(); // prompt 已在 argv(--print 的值);stdin 立即收掉避免 CLI 等輸入
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-500);
      });
      child.on('error', (error) => {
        queue.push({ kind: 'error', message: t('agent.errAgyStart', { error: error.message }) });
        queue.end();
      });

      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // 「jetski: …」等非 JSON 提示行忽略(煙霧測試實測存在)
        }
        const event = msg['event'];
        if (event === 'init') {
          const init = msg as { conversation_id?: string };
          if (typeof init.conversation_id === 'string' && init.conversation_id) {
            realSessionId = init.conversation_id;
            running.set(realSessionId, child); // 補真 id 別名,cancel(真 id) 找得到行程
            if (workdir) sessions.set(realSessionId, workdir);
            // 上下文已注入本 turn:真 id 也記一份,之後的 turn 用真 id 當 handle 比對
            appliedContext.set(realSessionId, appliedContext.get(sessionId) ?? '');
            queue.push({ kind: 'session', sessionId: realSessionId });
            queue.push({ kind: 'thinking' });
          }
          return;
        }
        if (event === 'step_update') {
          const su = msg['step_update'] as Record<string, unknown> | undefined;
          if (!su) return;
          if (su['step_type'] === 'agent_response' && typeof su['text_delta'] === 'string') {
            bufferedText += su['text_delta']; // 只緩衝(接縫含 U+FFFD),result 時以乾淨全文取代
            queue.push({ kind: 'thinking' }); // 餵看門狗:生成有在推進
            return;
          }
          if (su['step_type'] === 'tool') {
            const info = su['tool_info'] as Record<string, unknown> | undefined;
            if (su['state'] === 'ACTIVE') {
              queue.push({ kind: 'tool', name: String(su['tool_name'] ?? info?.['name'] ?? 'tool') });
            }
          }
          return;
        }
        if (event === 'result') {
          sawResult = true;
          const result = msg['result'] as Record<string, unknown> | undefined;
          const clean = typeof result?.['response'] === 'string' ? result['response'] : '';
          if (result?.['status'] === 'SUCCESS') {
            // 優先用乾淨全文;萬一 result 沒帶(防衛),退回緩衝片段(可能含 U+FFFD 但總比沒有好)
            const finalText = clean || bufferedText;
            if (finalText) queue.push({ kind: 'text', text: finalText });
            queue.push({ kind: 'done', ok: true });
          } else if (cancelRequested.has(child)) {
            queue.push({ kind: 'done', ok: false }); // 使用者主動取消,不是錯誤
          } else {
            queue.push({ kind: 'error', message: t('agent.errAgyResult', { status: String(result?.['status'] ?? t('common.unknown')) }) });
          }
        }
      });
      child.on('close', (code) => {
        if (AGENT_DEBUG) console.log(`[agy][debug] close code=${code} sawResult=${sawResult}`);
        if (!sawResult && code !== 0 && code !== null && stderrTail) {
          queue.push({ kind: 'error', message: t('agent.errAgyExit', { code: String(code), detail: stderrTail.trim() }) });
        }
        // 被 cancel 殺掉 → 不吐終結事件,由 bridge 補 done ok:false。
        // 清理只刪「仍指向本 child」的條目(同 claudeProvider:晚到的 close 不可刪掉新 turn 的註冊)
        if (running.get(sessionId) === child) running.delete(sessionId);
        if (realSessionId && running.get(realSessionId) === child) running.delete(realSessionId);
        for (const path of pastedImagePaths) {
          try { rmSync(path, { force: true }); } catch { /* 暫存檔,dispose 一併清理 */ }
        }
        queue.end();
      });

      yield* queue.drain();
    },
    async cancel(sessionId) {
      const child = running.get(sessionId);
      if (AGENT_DEBUG) console.log(`[agy][debug] cancel(${sessionId}) child=${child ? child.pid : '無'}`);
      if (child) {
        cancelRequested.add(child);
        killGracefully(child);
        // 強制終結保險(承 claudeProvider 的 e2e 實證坑):孤兒子行程佔住 stdio 時 close 不來,
        // 2.5 秒後 close 還沒處理就直接收隊;之後 close 真來也無害。
        setTimeout(() => {
          if (running.get(sessionId) !== child) return;
          running.delete(sessionId);
          const queue = queueByChild.get(child);
          queue?.push({ kind: 'done', ok: false });
          queue?.end();
        }, 2_500);
      }
    },
    async respondApproval() {
      // agy headless 無互動審批機制(需權限的工具由 CLI 自動拒絕);UI 端已過濾 ask,不應走到這裡
    },
    async closeSession(sessionId) {
      // agy 無常駐行程,關 session = 殺掉還在跑的 turn(conversation 在磁碟,--conversation 不受影響)
      const child = running.get(sessionId);
      if (child) killGracefully(child);
      sessions.delete(sessionId);
      appliedContext.delete(sessionId);
    },
    async dispose() {
      for (const child of new Set(running.values())) killGracefully(child);
      running.clear();
      try { rmSync(imageDir, { recursive: true, force: true }); } catch { /* tmp 檔,留著無害 */ }
    },
    shutdownSync() {
      for (const child of new Set(running.values())) child.kill('SIGTERM');
      running.clear();
    },
    async listModels() {
      // `agy models` 有機器可讀輸出(id\tlabel);gemini 系列把力度編在尾碼,
      // 三檔位齊的摺疊成「基底模型 + efforts」,其餘原樣列出(靠 --effort 旗標)。
      // stdin 必須 'ignore':掛著的 pipe 會讓 agy models 等輸入直到逾時(實測)。
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn('agy', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('agy models timeout'));
        }, 10_000);
        child.stdout.on('data', (chunk) => (out += String(chunk)));
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(`agy models exit ${code}`));
        });
      });
      const raw: { id: string; label: string }[] = [];
      for (const line of stdout.split('\n')) {
        const [id, label] = line.split('\t');
        if (id && label && !id.includes(' ')) raw.push({ id: id.trim(), label: label.trim() });
      }
      const byBase = new Map<string, Map<string, string>>(); // base → (effort 尾碼 → label)
      for (const model of raw) {
        const match = model.id.match(/^(.*)-(high|medium|low)$/);
        if (match) {
          const efforts = byBase.get(match[1]!) ?? new Map<string, string>();
          efforts.set(match[2]!, model.label);
          byBase.set(match[1]!, efforts);
        }
      }
      const models: AgentModelInfo[] = [];
      const consumed = new Set<string>();
      for (const model of raw) {
        const match = model.id.match(/^(.*)-(high|medium|low)$/);
        const base = match?.[1];
        if (base && (byBase.get(base)?.size ?? 0) >= 2) {
          if (consumed.has(base)) continue; // 同基底只列一次
          consumed.add(base);
          const efforts = EFFORT_SUFFIXES.filter((effort) => byBase.get(base)!.has(effort));
          collapsedBases.set(base, [...efforts]);
          models.push({
            id: base,
            label: model.label.replace(/\s*\((?:High|Medium|Low)\)\s*$/, ''),
            efforts: [...efforts]
          });
        } else {
          models.push({ id: model.id, label: model.label, efforts: [] });
        }
      }
      return models;
    }
  };
}
