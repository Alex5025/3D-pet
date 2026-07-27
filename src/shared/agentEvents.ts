/**
 * Agent 串接的跨程序共用型別(純 type,main / preload 均 import type,編譯期抹除)。
 * 對應 docs/AGENT-BRIDGE-DESIGN.md §3;跨 IPC 的 discriminated union 只維護這一份,避免雙份漂移。
 */

export type AgentKind = 'codex' | 'claude';

export interface AgentBinding {
  kind: AgentKind;
  sessionId?: string;
  /** 模型名(空 = 該 CLI 的全域預設)。codex 例:gpt-5.6-sol;claude 例:claude-fable-5 或別名 opus */
  model?: string;
  /** 推理力度(空 = 預設):low / medium / high / xhigh / max(max 僅 claude 支援) */
  effort?: string;
}

export type AgentEvent =
  | { kind: 'session'; sessionId: string } // 首個帶 session id 的事件;main 已回存 profile,renderer 僅供顯示用
  | { kind: 'thinking' } // 泡泡:「思考中…」
  | { kind: 'tool'; name: string } // 泡泡:「正在執行 ○○」(也用於「仍在執行…」看門狗提示)
  | { kind: 'text'; text: string } // 助手回覆文字(增量或整段)
  | { kind: 'approval'; requestId: string; description: string } // v2:泡泡顯示 允許/拒絕
  | { kind: 'done'; ok: boolean } // 終結事件:每個 turn 恰有一個 done 或 error
  | { kind: 'error'; message: string };
