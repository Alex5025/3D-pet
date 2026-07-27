import type { AgentEvent, AgentKind } from '../../shared/agentEvents';

export type { AgentEvent, AgentKind };

/**
 * Provider 抽象(docs/AGENT-BRIDGE-DESIGN.md §3):消費端(bridge/IPC/泡泡)只依賴這個介面,
 * 各家後端(codex app-server / claude -p spawn)可獨立演進、互換。
 */
export interface AgentProvider {
  readonly kind: AgentKind;
  /** 開新對話或恢復既有對話;回傳 provider 端 session/thread id。resume 失敗應丟例外,由 bridge 清 id 重開。 */
  startSession(opts: { workdir: string; resumeId?: string }): Promise<string>;
  /**
   * 送一句話,串流回統一事件。契約:結尾必須恰好 yield 一個終結事件(done 或 error);
   * 若 provider 因故無法保證(如行程被殺),bridge 會補發。
   */
  sendMessage(sessionId: string, text: string): AsyncIterable<AgentEvent>;
  /** 中斷該 session 進行中的 turn(codex: turn/interrupt;claude: 殺該 turn 的行程)。 */
  cancel(sessionId: string): Promise<void>;
  /** v2:回覆 approval 請求。v1 的 provider 可丟 not implemented。 */
  respondApproval(sessionId: string, requestId: string, allow: boolean): Promise<void>;
  /** 釋放單一 session(寵物休眠/刪除)。 */
  closeSession(sessionId: string): Promise<void>;
  /** 整個 provider 優雅收攤(SIGTERM → 1s → SIGKILL)。 */
  dispose(): Promise<void>;
  /** 同步殺掉所有子行程——app.exit 前用(await 不到 async dispose);session 都在磁碟,粗暴殺不丟資料。 */
  shutdownSync(): void;
}
