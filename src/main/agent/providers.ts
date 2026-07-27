import type { AgentKind, AgentProvider } from './types';
import type { PetToolsHub } from './petToolsHub';
import { createClaudeProvider } from './claudeProvider';
import { createCodexProvider } from './codexProvider';
import { createMockProvider } from './mockProvider';

/** VRM_PET_AGENT_MOCK=1 時全部給 MockProvider(UI 鏈路驗證不耗額度)。 */
export function createProviders(hub: PetToolsHub | null): Record<AgentKind, AgentProvider> {
  if (process.env['VRM_PET_AGENT_MOCK']) {
    return { codex: createMockProvider('codex'), claude: createMockProvider('claude') };
  }
  return { codex: createCodexProvider(hub), claude: createClaudeProvider(hub) };
}
