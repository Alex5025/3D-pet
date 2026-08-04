import type { AgentEvent, AgentKind, AgentPermission } from '../../shared/agentEvents';
import type { ChatImage } from '../../shared/chat';

export type { AgentEvent, AgentKind, AgentPermission };

/** 參考檔案清單 → 注入 prompt 的文字段(兩家 provider 共用;空清單回 null)。
 *  只給路徑不塞內容——讓 AI 自己用工具讀,大檔塞 prompt 是反模式。 */
export function refFilesPrompt(refFiles: string[] | undefined): string | null {
  if (!refFiles?.length) return null;
  const lines = refFiles.map((p) => `- ${p}${p.endsWith('/') ? '(資料夾)' : ''}`);
  return `參考檔案(使用者指定的絕對路徑;需要查閱時直接讀取,被要求更新該文件時直接修改它):\n${lines.join('\n')}`;
}

/** provider.sendMessage 的每 turn 選項(全部來自 profile,空 = 預設)。 */
export interface TurnOptions {
  model?: string;
  effort?: string;
  persona?: string;
  permission?: AgentPermission;
  /** 寵物 id:寵物工具 MCP(v3)路由用。 */
  petId?: string;
  /** 參考檔案絕對路徑(資料夾以尾斜線標記):注入 system prompt,AI 據此查找/更新文件。 */
  refFiles?: string[];
  /** 從剪貼簿貼上的當輪圖片附件。 */
  images?: ChatImage[];
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
   * opts.images = 當輪貼上的圖片(codex 原生 image input;claude 以短命暫存檔交給 Read)。
   */
  sendMessage(sessionId: string, text: string, opts?: TurnOptions): AsyncIterable<AgentEvent>;
  /** 中斷該 session 進行中的 turn(codex: turn/interrupt;claude: 殺該 turn 的行程)。 */
  cancel(sessionId: string): Promise<void>;
  /** 回覆 approval 事件(requestId 來自該事件);只在 permission=ask 時會發生。 */
  respondApproval(sessionId: string, requestId: string, allow: boolean, feedback?: string): Promise<void>;
  /** 釋放單一 session(寵物休眠/刪除)。 */
  closeSession(sessionId: string): Promise<void>;
  /** 整個 provider 優雅收攤(SIGTERM → 1s → SIGKILL)。 */
  dispose(): Promise<void>;
  /** 同步殺掉所有子行程——app.exit 前用(await 不到 async dispose);session 都在磁碟,粗暴殺不丟資料。 */
  shutdownSync(): void;
  /** 可選:回報可用模型清單(設定面板下拉用)。失敗丟例外,由呼叫端退回空清單。 */
  listModels?(): Promise<AgentModelInfo[]>;
}
