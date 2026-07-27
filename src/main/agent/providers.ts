import type { AgentKind, AgentProvider } from './types';
import { createMockProvider } from './mockProvider';

/** 真 provider 實作前的占位:一開口就回報未實作,不會靜默失敗。 */
function createStubProvider(kind: AgentKind): AgentProvider {
  const notReady = (): never => {
    throw new Error(`${kind} provider 尚未實作`);
  };
  return {
    kind,
    startSession: async () => notReady(),
    // eslint-disable-next-line require-yield
    sendMessage: async function* () {
      notReady();
    },
    cancel: async () => undefined,
    respondApproval: async () => notReady(),
    closeSession: async () => undefined,
    dispose: async () => undefined,
    shutdownSync: () => undefined
  };
}

/** VRM_PET_AGENT_MOCK=1 時全部給 MockProvider(UI 鏈路驗證不耗額度)。 */
export function createProviders(): Record<AgentKind, AgentProvider> {
  if (process.env['VRM_PET_AGENT_MOCK']) {
    return { codex: createMockProvider('codex'), claude: createMockProvider('claude') };
  }
  return { codex: createStubProvider('codex'), claude: createStubProvider('claude') };
}
