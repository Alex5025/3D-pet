import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from './types';
import type { AgentPetProfile } from './bridge';
import { createAgentBridge } from './bridge';
import { createClaudeProvider } from './claudeProvider';
import { createCodexProvider } from './codexProvider';
import { createMockProvider } from './mockProvider';

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
  const h = makeHarness('claude', createClaudeProvider());

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

  await h.bridge.dispose();
  const pass = failures.length === 0;
  console.log(`[agent-e2e:claude] ${pass ? 'PASS' : `FAIL(${failures.length}):${failures.join('、')}`}`);
  return pass;
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
  const h = makeHarness('codex', createCodexProvider());

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

  // 5. 審批流(permission=ask;權限變更會觸發 thread re-resume,一併驗證)
  await runApprovalE2E('審批', h, check);

  await h.bridge.dispose();
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
  bridge.respondApproval('p1', approvalEvent?.requestId ?? '', true);
  await waitTerminal(1, 3000);
  check('允許後 turn 完成', events.some((e) => e.kind === 'done' && e.ok));
  check('mock 收到允許決定', mockClaude.log.some((l) => l.endsWith(':true')));
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

  const pass = failures.length === 0;
  console.log(`[agent-selftest] ${pass ? 'PASS' : `FAIL(${failures.length}):${failures.join('、')}`}`);
  return pass;
}
