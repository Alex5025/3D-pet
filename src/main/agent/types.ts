import type { AgentEvent, AgentKind, AgentPermission } from '../../shared/agentEvents';

export type { AgentEvent, AgentKind, AgentPermission };

/** provider.sendMessage 的每 turn 選項(全部來自 profile,空 = 預設)。 */
export interface TurnOptions {
  model?: string;
  effort?: string;
  persona?: string;
  permission?: AgentPermission;
  /** 寵物 id:寵物工具 MCP(v3)路由用。 */
  petId?: string;
}

/** 設定面板下拉選單用的模型資訊。 */
export interface AgentModelInfo {
  id: string;
  label: string;
  /** 該模型支援的推理力度(codex 由 model/list 逐模型回報;claude 為固定清單)。 */
  efforts: string[];
  isDefault?: boolean;
}

/**
 * Provider 抽象(docs/AGENT-BRIDGE-DESIGN.md §3):消費端(bridge/IPC/泡泡)只依賴這個介面,
 * 各家後端(codex app-server / claude -p spawn)可獨立演進、互換。
 */
export interface AgentProvider {
  readonly kind: AgentKind;
  /**
   * 開新對話或恢復既有對話;回傳 provider 端的 session handle(bridge 之後的呼叫都用它)。
   * handle 不持久化——可持久化的真 id 由 sendMessage 的 `session` 事件給(codex 的 handle 即真 threadId;
   * claude 新 session 在首 turn 才拿得到 id,handle 是暫時代號)。resume 失敗應丟例外,由 bridge 清 id 重開。
   */
  startSession(opts: { workdir: string; resumeId?: string; persona?: string; petId?: string; permission?: AgentPermission }): Promise<string>;
  /**
   * 送一句話,串流回統一事件。契約:結尾必須恰好 yield 一個終結事件(done 或 error);
   * 若 provider 因故無法保證(如行程被殺),bridge 會補發。
   * opts.model / opts.effort 為每寵設定(空 = CLI 預設);兩家都支援逐 turn 指定。
   * opts.persona = 角色個性(claude 逐 turn 注入 --append-system-prompt;codex 在 thread 建立/恢復時吃 developerInstructions)。
   * opts.permission = 權限等級(見 AgentPermission;codex 對映 sandbox/approvalPolicy、claude 對映旗標)。
   */
  sendMessage(sessionId: string, text: string, opts?: TurnOptions): AsyncIterable<AgentEvent>;
  /** 中斷該 session 進行中的 turn(codex: turn/interrupt;claude: 殺該 turn 的行程)。 */
  cancel(sessionId: string): Promise<void>;
  /** 回覆 approval 事件(requestId 來自該事件);只在 permission=ask 時會發生。 */
  respondApproval(sessionId: string, requestId: string, allow: boolean): Promise<void>;
  /** 釋放單一 session(寵物休眠/刪除)。 */
  closeSession(sessionId: string): Promise<void>;
  /** 整個 provider 優雅收攤(SIGTERM → 1s → SIGKILL)。 */
  dispose(): Promise<void>;
  /** 同步殺掉所有子行程——app.exit 前用(await 不到 async dispose);session 都在磁碟,粗暴殺不丟資料。 */
  shutdownSync(): void;
  /** 可選:回報可用模型清單(設定面板下拉用)。失敗丟例外,由呼叫端退回空清單。 */
  listModels?(): Promise<AgentModelInfo[]>;
}
