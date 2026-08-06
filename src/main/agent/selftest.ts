import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from './types';
import type { AgentPetProfile } from './bridge';
import { createAgentBridge } from './bridge';
import { createChatDispatcher, createChatQueue } from '../chatQueue';
import { createClaudeProvider } from './claudeProvider';
import { createCodexProvider } from './codexProvider';
import { createMockProvider } from './mockProvider';
import { createPetToolsHub, type PetToolsHub } from './petToolsHub';
import { parseProjectSandboxConfig, updateProjectSandboxConfig } from '../sandboxConfig';
import { resolveWorkspaceDirName, sanitizeWorkspaceName } from '../workspaceDefaults';

/**
 * Headless 回歸自驗(VRM_PET_AGENT_SELFTEST=1 觸發,不開視窗):
 * 用 MockProvider 驗 bridge 的完整鏈——事件序、sessionId 回存、單 turn 限制、cancel、closeSession。
 * 仿 [hit] selftest 慣例:終端機印 [agent-selftest] PASS/FAIL,exit code 供 CI 化。
 */
/** 真 provider 的 headless e2e 骨架:一隻假寵物 + 事件收集,回傳操作句柄。 */
function makeHarness(kind: 'codex' | 'claude', provider: Parameters<typeof createAgentBridge>[0]['providers']['claude']): {
  profile: AgentPetProfile;
  events: AgentEvent[];
  bridge: ReturnType<typeof createAgentBridge>;
  waitTerminal: (count: number, timeoutMs?: number) => Promise<void>;
  textOf: () => string;
} {
  const profile: AgentPetProfile = {
    id: 'e2e',
    workspacePath: mkdtempSync(join(tmpdir(), 'vrm-pet-e2e-')),
    agent: { kind }
  };
  const events: AgentEvent[] = [];
  const bridge = createAgentBridge({
    getPet: (id) => (id === profile.id ? profile : null),
    updatePet: (_id, patch) => {
      profile.agent = patch.agent;
      return profile;
    },
    send: (_petId, event) => events.push(event),
    providers: { codex: provider, claude: provider }
  });
  const terminalCount = (): number => events.filter((e) => e.kind === 'done' || e.kind === 'error').length;
  return {
    profile,
    events,
    bridge,
    waitTerminal: async (count, timeoutMs = 120_000) => {
      const deadline = Date.now() + timeoutMs;
      while (terminalCount() < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    textOf: () => events.filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text').map((e) => e.text).join('')
  };
}

/** 真 claude CLI 的 e2e(VRM_PET_AGENT_SELFTEST=claude;會耗訂閱額度,顯式觸發才跑)。 */
export async function runClaudeE2E(): Promise<boolean> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean): void => {
    console.log(`[agent-e2e:claude] ${ok ? 'ok' : 'FAIL'} - ${name}`);
    if (!ok) failures.push(name);
  };
  const { hub, calls } = makeRecordingHub();
  const h = makeHarness('claude', createClaudeProvider(hub));

  // 1. 一問一答 + session 回存
  h.bridge.chatSend('e2e', '請只回答數字,不要其他文字:7+7=?');
  await h.waitTerminal(1);
  check('回覆含 14', h.textOf().includes('14'));
  check('done ok', h.events.some((e) => e.kind === 'done' && e.ok));
  const sid = h.profile.agent?.sessionId;
  check('sessionId 回存(uuid 形)', typeof sid === 'string' && sid.length > 20 && !sid.startsWith('pending-'));

  // 2. resume:第二問引用第一問
  h.events.length = 0;
  h.bridge.chatSend('e2e', '我上一句問的算式是什麼?請只回答算式本身。');
  await h.waitTerminal(1);
  check('resume 上下文(答出 7+7)', h.textOf().includes('7+7'));
  check('sessionId 不變', h.profile.agent?.sessionId === sid);

  // 3. cancel:長回答中殺行程 → bridge 補 done ok:false;session 不丟。
  // 等到第一個 text 增量出現(確認 turn 真的在跑)就立刻取消,避免「寫太快先完成」的競態。
  h.events.length = 0;
  h.bridge.chatSend('e2e', '請寫一篇 5000 字的超長文,詳細介紹海洋的歷史、生態、洋流與人類的關係。');
  {
    const deadline = Date.now() + 60_000;
    while (!h.events.some((e) => e.kind === 'text') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  h.bridge.chatCancel('e2e');
  await h.waitTerminal(1, 30_000);
  console.log('[agent-e2e:claude] cancel 後事件:', JSON.stringify(h.events.filter((e) => e.kind !== 'text').slice(-5)));
  check('cancel → done ok:false', h.events.some((e) => e.kind === 'done' && !e.ok));
  h.events.length = 0;
  h.bridge.chatSend('e2e', '不用寫了。請只回答:OK');
  await h.waitTerminal(1);
  check('cancel 後 session 仍可用', h.textOf().includes('OK'));

  // 4. 審批流(permission=ask;permission-prompt MCP 腳本 + socket 回連)
  await runApprovalE2E('審批', h, check);

  // 5. 寵物工具(readonly 下 dontAsk+白名單放行 pettools)
  await runPetToolsE2E(h, calls, check);

  await h.bridge.dispose();
  hub.dispose();
  const pass = failures.length === 0;
  console.log(`[agent-e2e:claude] ${pass ? 'PASS' : `FAIL(${failures.length}):${failures.join('、')}`}`);
  return pass;
}

/** 記錄型寵物工具 hub(e2e 用):工具呼叫只記錄不真的動桌寵。 */
function makeRecordingHub(): { hub: PetToolsHub; calls: string[] } {
  const calls: string[] = [];
  const hub = createPetToolsHub({
    playMotion: async (_petId, file) => { calls.push(`motion:${file}`); return true; },
    showExpression: (_petId, name) => { calls.push(`expr:${name}`); return true; },
    speak: (_petId, text) => { calls.push(`speak:${text}`); return true; },
    listMotions: () => ['01-全身展示.vrma', '04-揮手.vrma']
  });
  return { hub, calls };
}

/** 寵物工具 e2e(兩家共用):readonly 權限下請 agent 切表情 → hub 收到呼叫。 */
async function runPetToolsE2E(
  h: ReturnType<typeof makeHarness>,
  calls: string[],
  check: (name: string, ok: boolean) => void
): Promise<void> {
  h.profile.agent = { ...h.profile.agent!, permission: undefined } as typeof h.profile.agent; // 回到 readonly
  h.events.length = 0;
  h.bridge.chatSend('e2e', '請呼叫 pet_show_expression 工具把你的表情切換成 happy,完成後告訴我結果。');
  await h.waitTerminal(1);
  check('寵物工具:hub 收到表情呼叫', calls.some((c) => c === 'expr:happy'));
  check('寵物工具:turn 正常完成', h.events.some((e) => e.kind === 'done' && e.ok));
}

/** 審批流 e2e(兩家共用):permission=ask → 要求建檔 → 泡泡事件 → 允許/拒絕 → 驗檔案。 */
async function runApprovalE2E(
  label: string,
  h: ReturnType<typeof makeHarness>,
  check: (name: string, ok: boolean) => void
): Promise<void> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  h.profile.agent = { ...h.profile.agent!, permission: 'ask' };

  const waitApproval = async (): Promise<Extract<AgentEvent, { kind: 'approval' }> | undefined> => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const found = h.events.find((e): e is Extract<AgentEvent, { kind: 'approval' }> => e.kind === 'approval');
      if (found) return found;
      if (h.events.some((e) => e.kind === 'done' || e.kind === 'error')) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
  };

  // 允許
  h.events.length = 0;
  h.bridge.chatSend('e2e', '請用 shell 指令 `touch approved.txt` 在目前工作目錄建立檔案。需要權限就向我請求。');
  const allowRequest = await waitApproval();
  check(`${label}:收到審批事件`, !!allowRequest);
  if (allowRequest) h.bridge.respondApproval('e2e', allowRequest.requestId, true);
  await h.waitTerminal(1);
  check(`${label}:允許後檔案存在`, existsSync(join(h.profile.workspacePath!, 'approved.txt')));

  // 拒絕
  h.events.length = 0;
  h.bridge.chatSend('e2e', '請用 shell 指令 `touch denied.txt` 在目前工作目錄建立檔案。需要權限就向我請求。');
  const denyRequest = await waitApproval();
  check(`${label}:拒絕案收到審批事件`, !!denyRequest);
  if (denyRequest) h.bridge.respondApproval('e2e', denyRequest.requestId, false);
  await h.waitTerminal(1);
  check(`${label}:拒絕後無檔案`, !existsSync(join(h.profile.workspacePath!, 'denied.txt')));
}

/** 真 codex app-server 的 e2e(VRM_PET_AGENT_SELFTEST=codex;會耗訂閱額度,顯式觸發才跑)。 */
export async function runCodexE2E(): Promise<boolean> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean): void => {
    console.log(`[agent-e2e:codex] ${ok ? 'ok' : 'FAIL'} - ${name}`);
    if (!ok) failures.push(name);
  };
  const { hub, calls } = makeRecordingHub();
  const h = makeHarness('codex', createCodexProvider(hub));

  // 1. 一問一答 + threadId 回存
  h.bridge.chatSend('e2e', '請只回答數字,不要其他文字:8+8=?');
  await h.waitTerminal(1);
  check('回覆含 16', h.textOf().includes('16'));
  check('done ok', h.events.some((e) => e.kind === 'done' && e.ok));
  const tid = h.profile.agent?.sessionId;
  check('threadId 回存(uuid 形)', typeof tid === 'string' && tid.length > 20);

  // 2. resume:第二問引用第一問
  h.events.length = 0;
  h.bridge.chatSend('e2e', '我上一句問的算式是什麼?請只回答算式本身。');
  await h.waitTerminal(1);
  check('resume 上下文(答出 8+8)', h.textOf().includes('8+8'));

  // 3. cancel = turn/interrupt:等第一個 text 增量後取消 → done ok:false;thread 可續用
  h.events.length = 0;
  h.bridge.chatSend('e2e', '請從 1 慢慢數到 500,每個數字單獨一行。');
  {
    const deadline = Date.now() + 60_000;
    while (!h.events.some((e) => e.kind === 'text') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  h.bridge.chatCancel('e2e');
  await h.waitTerminal(1, 30_000);
  check('interrupt → done ok:false', h.events.some((e) => e.kind === 'done' && !e.ok));
  h.events.length = 0;
  h.bridge.chatSend('e2e', '不用數了。請只回答:OK');
  await h.waitTerminal(1);
  check('interrupt 後 thread 仍可用', h.textOf().includes('OK'));

  // 4. crash 重連:外部殺掉 app-server → 下次對話自動重啟 + resume
  await new Promise<void>((resolve) => execFile('pkill', ['-f', 'codex app-server'], () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  h.events.length = 0;
  h.bridge.chatSend('e2e', '我最開始問的算式是什麼?請只回答算式本身。');
  await h.waitTerminal(1);
  check('crash 後自動重啟 + resume(答出 8+8)', h.textOf().includes('8+8'));

  // 5. 審批流(permission=ask;權限變更會觸發重啟+resume,一併驗證)
  await runApprovalE2E('審批', h, check);

  // 6. 寵物工具(thread config 掛 MCP + elicitation 自動放行)
  await runPetToolsE2E(h, calls, check);

  // 7. 死 threadId 復原:落盤 id 對應的 rollout 不存在(被清掉/從未寫入)→ 自動開新 thread 接手,
  //    不可讓寵物永久卡在 "no rollout found"(實機回報的 bug)
  await h.bridge.closePetSession('e2e');
  h.profile.agent = { ...h.profile.agent, kind: 'codex', sessionId: '019f0000-0000-7000-8000-000000000000' };
  h.events.length = 0;
  h.bridge.chatSend('e2e', '請只回答:RECOVERED');
  await h.waitTerminal(1, 120_000);
  check('死 threadId → 開新 thread 復原', h.textOf().includes('RECOVERED'));
  check('死 threadId → 新 id 已回存', typeof h.profile.agent?.sessionId === 'string' &&
    h.profile.agent.sessionId !== '019f0000-0000-7000-8000-000000000000');

  // 8. 參考檔案注入:refFiles 經 syncContext(inject_items)注入,模型答得出路徑
  h.profile.refFiles = ['/tmp/vrm-pet-ref-demo.md'];
  h.events.length = 0;
  h.bridge.chatSend('e2e', '我的參考檔案清單裡有哪個路徑?請只回答那個路徑,不要其他文字。');
  await h.waitTerminal(1, 120_000);
  check('參考檔案路徑注入', h.textOf().includes('/tmp/vrm-pet-ref-demo.md'));
  delete h.profile.refFiles;

  // 9. auto 權限的新寵物首句(根因回歸):thread 必須以當下權限建立——
  //    若先用假的 readonly 開再對齊,首個 turn 會 resume 一個沒有 rollout 的新 thread 而必定失敗
  await h.bridge.closePetSession('e2e');
  h.profile.agent = { kind: 'codex', permission: 'auto' }; // 無 sessionId = 全新寵物
  h.events.length = 0;
  h.bridge.chatSend('e2e', '請只回答:AUTO-OK');
  await h.waitTerminal(1, 120_000);
  check('auto 權限新寵物首句成功', h.textOf().includes('AUTO-OK'));

  await h.bridge.dispose();
  hub.dispose();
  const pass = failures.length === 0;
  console.log(`[agent-e2e:codex] ${pass ? 'PASS' : `FAIL(${failures.length}):${failures.join('、')}`}`);
  return pass;
}

export async function runAgentSelftest(): Promise<boolean> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean): void => {
    console.log(`[agent-selftest] ${ok ? 'ok' : 'FAIL'} - ${name}`);
    if (!ok) failures.push(name);
  };

  // 專案沙盒設定只改三個指定鍵，既有 Codex 設定與 table 內容必須保留。
  const sandboxUpdated = updateProjectSandboxConfig(
    'model = "gpt-test"\n\n[sandbox_workspace_write]\nwritable_roots = ["/tmp"]\n\n[mcp_servers.demo]\ncommand = "demo"\n',
    { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', networkAccess: true },
  );
  const sandboxParsed = parseProjectSandboxConfig('/tmp/work', '/tmp/work/.codex/config.toml', sandboxUpdated);
  check('沙盒設定保留其他 config.toml 內容', sandboxUpdated.includes('model = "gpt-test"') &&
    sandboxUpdated.includes('writable_roots = ["/tmp"]') && sandboxUpdated.includes('command = "demo"'));
  check('沙盒設定寫入與讀回一致', sandboxParsed.approvalPolicy === 'on-request' &&
    sandboxParsed.sandboxMode === 'workspace-write' && sandboxParsed.networkAccess === true);

  // 新寵物預設工作目錄:純函式層(消毒、時間戳、碰撞)
  check('工作目錄:消毒去空白', sanitizeWorkspaceName('寵物 3') === '寵物3');
  check('工作目錄:消毒去不合法字元', sanitizeWorkspaceName('a/b:c*?') === 'abc');
  check('工作目錄:全符號名退回 pet', sanitizeWorkspaceName('///') === 'pet');
  const wsDate = new Date(2026, 7, 6, 14, 30, 52);
  check('工作目錄:名稱_時間戳格式',
    resolveWorkspaceDirName('寵物 3', wsDate, () => false) === '寵物3_2026-08-06_14-30-52');
  check('工作目錄:同秒碰撞加序號',
    resolveWorkspaceDirName('寵物 3', wsDate, (d) => !d.endsWith('-3')) === '寵物3_2026-08-06_14-30-52-3');

  const profile: AgentPetProfile = { id: 'p1', workspacePath: '/tmp', agent: { kind: 'claude' } };
  const events: AgentEvent[] = [];
  const mockClaude = createMockProvider('claude');
  const mockCodex = createMockProvider('codex');
  const bridge = createAgentBridge({
    getPet: (id) => (id === profile.id ? profile : null),
    updatePet: (_id, patch) => {
      profile.agent = patch.agent;
      return profile;
    },
    send: (_petId, event) => events.push(event),
    providers: { claude: mockClaude, codex: mockCodex }
  });

  const terminalCount = (): number => events.filter((e) => e.kind === 'done' || e.kind === 'error').length;
  const waitTerminal = async (count: number, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (terminalCount() < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // 1. 完整 turn:事件序 + sessionId 回存
  bridge.chatSend('p1', '你好');
  await waitTerminal(1);
  const kinds = events.map((e) => e.kind);
  check('事件序 session→thinking→text…→done', kinds[0] === 'session' && kinds[1] === 'thinking' && kinds.includes('text') && kinds[kinds.length - 1] === 'done');
  check('done ok=true', events.some((e) => e.kind === 'done' && e.ok));
  check('sessionId 已回存 profile', profile.agent?.sessionId === 'mock-claude-1');
  check('每 turn 恰一個終結事件', terminalCount() === 1);

  // 1.5 圖片可單獨成為一則訊息,且完整傳到 provider。
  events.length = 0;
  bridge.chatSend('p1', '', [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
  await waitTerminal(1);
  check('純圖片訊息有送到 provider', mockClaude.log.includes('images:mock-claude-1:1'));

  // 2. 單 turn 限制:running 中第二句 → error
  events.length = 0;
  bridge.chatSend('p1', 'SLOW 慢慢想');
  await new Promise((resolve) => setTimeout(resolve, 120)); // 讓第一輪進入 running
  bridge.chatSend('p1', '插隊');
  await waitTerminal(2, 5000);
  check('running 中插隊被拒(error)', events.some((e) => e.kind === 'error' && e.message.includes('進行中')));
  check('原 turn 正常完成', events.some((e) => e.kind === 'done' && e.ok));

  // 3. cancel:done ok=false
  events.length = 0;
  bridge.chatSend('p1', 'SLOW 再慢慢想');
  await new Promise((resolve) => setTimeout(resolve, 120));
  bridge.chatCancel('p1');
  await waitTerminal(1, 5000);
  check('cancel → done ok=false', events.some((e) => e.kind === 'done' && !e.ok));
  check('mock 收到 cancel', mockClaude.log.some((l) => l.startsWith('cancelled:')));

  // 3.5 審批流:approval 事件 → respondApproval(允許/拒絕)→ mock 收到決定
  events.length = 0;
  profile.agent = { ...profile.agent!, model: 'mock-model', permission: 'ask' }; // 順便驗回存不洗設定
  bridge.chatSend('p1', 'APPROVAL 請建檔');
  {
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.kind === 'approval') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const approvalEvent = events.find((e): e is Extract<AgentEvent, { kind: 'approval' }> => e.kind === 'approval');
  check('收到 approval 事件(含描述)', !!approvalEvent && approvalEvent.description.includes('touch'));
  // 中控面板依賴的快照與 guard:petStates 拿得到掛著的審批;錯誤 requestId 被忽略(雙 UI race)
  const pendingSnap = bridge.petStates().find((s) => s.petId === 'p1');
  check('petStates:審批中 running 且 pendingApproval 相符',
    pendingSnap?.running === true && pendingSnap?.pendingApproval?.requestId === approvalEvent?.requestId &&
    !!pendingSnap?.pendingApproval?.description.includes('touch'));
  bridge.respondApproval('p1', 'wrong-request-id', true);
  check('審批 guard:錯誤 requestId 被忽略', !mockClaude.log.some((l) => l.endsWith(':true')) &&
    bridge.petStates().find((s) => s.petId === 'p1')?.pendingApproval !== null);
  bridge.respondApproval('p1', approvalEvent?.requestId ?? '', true);
  await waitTerminal(1, 3000);
  check('允許後 turn 完成', events.some((e) => e.kind === 'done' && e.ok));
  check('mock 收到允許決定', mockClaude.log.some((l) => l.endsWith(':true')));
  check('審批回覆後事件流有 approvalResolved', events.some((e) => e.kind === 'approvalResolved'));
  check('petStates:回覆後 pendingApproval 清空',
    bridge.petStates().find((s) => s.petId === 'p1')?.pendingApproval === null);
  check('sessionId 回存不洗掉 model/permission', profile.agent?.model === 'mock-model' && profile.agent?.permission === 'ask');

  events.length = 0;
  bridge.chatSend('p1', 'APPROVAL 再建一次');
  {
    const deadline = Date.now() + 3000;
    while (!events.some((e) => e.kind === 'approval') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const denyEvent = events.find((e): e is Extract<AgentEvent, { kind: 'approval' }> => e.kind === 'approval');
  bridge.respondApproval('p1', denyEvent?.requestId ?? '', false);
  await waitTerminal(1, 3000);
  check('拒絕後 mock 收到 deny', mockClaude.log.some((l) => l.endsWith(':false')));
  profile.agent = { kind: 'claude', sessionId: profile.agent?.sessionId };

  // 4. closePetSession:mock 被關
  await bridge.closePetSession('p1');
  check('mock 收到 close', mockClaude.log.some((l) => l.startsWith('closed:')));

  // 5. resume:close 後再送話,以回存的 sessionId 恢復
  events.length = 0;
  bridge.chatSend('p1', '回來了');
  await waitTerminal(1);
  check('close 後以回存 id resume', mockClaude.log.some((l) => l === 'started:mock-claude-1:resumed'));

  await bridge.dispose();
  check('dispose 傳到 provider', mockClaude.log.includes('disposed') && mockCodex.log.includes('disposed'));

  // 6. 對話佇列:純邏輯
  {
    const changed: (string | undefined)[] = [];
    const queue = createChatQueue((petId) => changed.push(petId));
    const enqueueText = (petId: string, text: string) =>
      queue.enqueue({ assignee: petId, text, images: [], source: 'selftest' });
    check('佇列:position 遞增', enqueueText('q1', 'a').position === 0 && enqueueText('q1', 'b').position === 1);
    check('佇列:onChanged 有觸發', changed.length === 2);
    const longText = 'x'.repeat(100);
    enqueueText('q1', longText);
    const summary = queue.summaries('q1')[2];
    check('佇列:摘要截 80 字', !!summary && summary.text.length === 81 && summary.text.endsWith('…'));
    const removeTarget = queue.summaries('q1')[1]!.id;
    check('佇列:remove 指定則', queue.remove('q1', removeTarget) && queue.size('q1') === 2 && queue.summaries('q1')[1]!.text.startsWith('x'));
    for (let i = 0; i < 8; i++) enqueueText('q1', `fill-${i}`);
    check('佇列:滿 10 拒收且給 reason', !enqueueText('q1', '第11則').ok && !!enqueueText('q1', '第11則').reason);
    const withImages = (n: number) => queue.enqueue({ assignee: 'q2', text: '圖', images: Array.from({ length: n }, () => ({ mimeType: 'image/png' as const, data: 'x' })), source: 'selftest' });
    check('佇列:圖片總數 8 封頂', withImages(4).ok && withImages(4).ok && !withImages(1).ok);
    queue.clear('q1');
    check('佇列:clear 後空且 petsWithTasks 只剩 q2', queue.size('q1') === 0 && queue.petsWithTasks().join() === 'q2');
    queue.clear('q2');

    // 歸屬語意:泡泡必綁定;公用池 claim/remove/clear 邊界
    check('歸屬:bubble 缺 assignee 拒收', !queue.enqueue({ text: '無主泡泡訊息', images: [], source: 'bubble' }).ok);
    check('歸屬:公用池投單', queue.enqueue({ text: '公用一', images: [], source: 'selftest' }).ok && queue.hasUnbound());
    queue.enqueue({ text: '公用二', images: [], source: 'selftest' });
    check('歸屬:clear(petId) 不動公用池', (queue.clear('q1'), queue.unboundSummaries().length === 2));
    const claimed = queue.claimUnbound('q9');
    check('歸屬:claim 取最舊且寫入 assignee', claimed?.text === '公用一' && claimed?.assignee === 'q9' && queue.unboundSummaries().length === 1);
    check('歸屬:removeUnbound', queue.removeUnbound(queue.unboundSummaries()[0]!.id) && !queue.hasUnbound());
    check('歸屬:removeUnbound 不存在的 id 回 false', !queue.removeUnbound('no-such-id'));

    // 中控來源:帶 assignee 綁定、缺 assignee 進公用池;公用池上限 20
    const controlBound = queue.enqueue({ assignee: 'q1', text: '中控綁定單', images: [], source: 'control' });
    check('中控:帶 assignee 進綁定佇列', controlBound.ok && queue.size('q1') === 1 && !queue.hasUnbound());
    const controlPool = queue.enqueue({ text: '中控公用單', images: [], source: 'control' });
    check('中控:缺 assignee 進公用池', controlPool.ok && queue.unboundSummaries()[0]?.source === 'control');
    queue.clear('q1');
    queue.removeUnbound(queue.unboundSummaries()[0]!.id);
    for (let i = 0; i < 20; i++) queue.enqueue({ text: `pool-${i}`, images: [], source: 'control' });
    const poolFull = queue.enqueue({ text: '第21單', images: [], source: 'control' });
    check('中控:公用池滿 20 拒收且給 reason', !poolFull.ok && !!poolFull.reason);

    // enqueue 回傳 id(任務帳本追蹤依據)
    const withId = queue.enqueue({ assignee: 'q8', text: '有 id 的單', images: [], source: 'control' });
    check('中控:enqueue 回傳 id 且與摘要一致', !!withId.id && queue.summaries('q8')[0]?.id === withId.id);
    queue.clear('q8');
  }

  // 6.5 公用池限定工作區:只有該工作區的寵物能領(= 發佈者指定運行路徑)
  {
    const queue = createChatQueue();
    queue.enqueue({ text: '限定 A 區', images: [], source: 'control', restrictWorkspace: '/tmp/a' });
    queue.enqueue({ text: '不限區', images: [], source: 'control' });
    const claimedByB = queue.claimUnbound('petB', '/tmp/b');
    check('限定工作區:不符者跳過限定單、領到最舊合格單', claimedByB?.text === '不限區');
    const claimedByA = queue.claimUnbound('petA', '/tmp/a/'); // 尾斜線要 normalize 後相符
    check('限定工作區:相符者領得到(路徑 normalize)', claimedByA?.text === '限定 A 區');
    queue.enqueue({ text: '又一張限定 A', images: [], source: 'control', restrictWorkspace: '/tmp/a' });
    check('限定工作區:全池皆不合格時領不到', queue.claimUnbound('petB', '/tmp/b') === undefined && queue.hasUnbound());
  }

  // 7. 佇列 + dispatcher + mock bridge 全鏈:排 3 則依序執行、中途移除、cancel 後續行
  {
    const qProfile: AgentPetProfile = { id: 'qp', workspacePath: '/tmp', agent: { kind: 'claude' } };
    const qEvents: AgentEvent[] = [];
    const qMock = createMockProvider('claude');
    const ran: string[] = [];
    let qBridge!: ReturnType<typeof createAgentBridge>;
    const queue = createChatQueue();
    const dispatcher = createChatDispatcher({
      queue,
      canAccept: (petId) => qBridge.canAccept(petId),
      unboundCandidates: () => ['qp'],
      workspaceOf: () => '/tmp',
      runTask: (petId, task) => {
        ran.push(`${petId}:${task.text}`);
        qEvents.push({ kind: 'turnStart', text: task.text });
        qBridge.chatSend(petId, task.text, task.images);
      }
    });
    qBridge = createAgentBridge({
      getPet: (id) => (id === qProfile.id ? qProfile : null),
      updatePet: (_id, patch) => { qProfile.agent = patch.agent; return qProfile; },
      send: (_petId, event) => qEvents.push(event),
      providers: { claude: qMock, codex: qMock },
      onTurnFinished: () => dispatcher.dispatchAll()
    });
    const qTerminal = (): number => qEvents.filter((e) => e.kind === 'done' || e.kind === 'error').length;
    const qWait = async (count: number, timeoutMs = 6000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (qTerminal() < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    };
    const push = (text: string) => {
      const result = queue.enqueue({ assignee: 'qp', text, images: [], source: 'selftest' });
      dispatcher.dispatch('qp');
      return result;
    };
    // 排 3 則:第 1 則立即執行,2/3 排隊,turn 結束自動接續
    push('SLOW 第一則');
    await new Promise((r) => setTimeout(r, 80)); // 進入 running
    const second = push('第二則');
    const third = push('第三則');
    check('佇列:running 中排入不立即執行', second.position === 0 && third.position === 1 && ran.length === 1);
    // 中途移除第二則
    const secondId = queue.summaries('qp')[0]!.id;
    queue.remove('qp', secondId);
    await qWait(2);
    check('佇列:turn 完自動接續且跳過被移除者', ran.join('|') === 'qp:SLOW 第一則|qp:第三則');
    check('佇列:每則各有終結事件', qTerminal() === 2);
    check('佇列:turnStart 在前一則 done 之後', (() => {
      const kinds = qEvents.map((e) => e.kind);
      const firstDone = kinds.indexOf('done');
      const secondStart = kinds.indexOf('turnStart', 1);
      return firstDone >= 0 && secondStart > firstDone;
    })());
    // cancel 當前 → done ok:false → 佇列續行
    qEvents.length = 0;
    ran.length = 0;
    push('SLOW 會被取消');
    await new Promise((r) => setTimeout(r, 80));
    push('取消後接續');
    qBridge.chatCancel('qp');
    await qWait(2);
    check('佇列:cancel 後自動續行', ran.join('|') === 'qp:SLOW 會被取消|qp:取消後接續' &&
      qEvents.some((e) => e.kind === 'done' && !e.ok) && qEvents.some((e) => e.kind === 'done' && e.ok));

    // 8. 公用池全鏈:綁定優先、閒者領單、資格過濾
    qEvents.length = 0;
    ran.length = 0;
    // 情境:qp 有綁定任務;公用池兩單;candidates 只有 qp(qx 無資格)
    queue.enqueue({ assignee: 'qp', text: 'SLOW 綁定優先', images: [], source: 'selftest' });
    queue.enqueue({ text: '公用A', images: [], source: 'selftest' });
    queue.enqueue({ text: '公用B', images: [], source: 'selftest' });
    dispatcher.dispatchAll();
    await new Promise((r) => setTimeout(r, 80));
    check('歸屬:綁定任務先跑、公用單等待', ran.length === 1 && ran[0] === 'qp:SLOW 綁定優先' && queue.unboundSummaries().length === 2);
    await qWait(1);
    await qWait(2); // 綁定完 → onTurnFinished → 領公用A;公用A 完 → 領公用B
    await qWait(3, 8000);
    check('歸屬:佇列空檔依序領公用池(最舊優先)', ran.join('|') === 'qp:SLOW 綁定優先|qp:公用A|qp:公用B' && !queue.hasUnbound());
    await qBridge.dispose();
  }

  const pass = failures.length === 0;
  console.log(`[agent-selftest] ${pass ? 'PASS' : `FAIL(${failures.length}):${failures.join('、')}`}`);
  return pass;
}
