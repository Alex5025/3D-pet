import type { AgentEvent } from './types';
import type { AgentPetProfile } from './bridge';
import { createAgentBridge } from './bridge';
import { createMockProvider } from './mockProvider';

/**
 * Headless 回歸自驗(VRM_PET_AGENT_SELFTEST=1 觸發,不開視窗):
 * 用 MockProvider 驗 bridge 的完整鏈——事件序、sessionId 回存、單 turn 限制、cancel、closeSession。
 * 仿 [hit] selftest 慣例:終端機印 [agent-selftest] PASS/FAIL,exit code 供 CI 化。
 */
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
