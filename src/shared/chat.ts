/** chat-send(invoke)的回覆:泡泡據此同步得知「立即執行 / 已排入第 N 位 / 被拒」。 */
export interface ChatSendResult {
  queued: boolean;
  /** 0 = 佇列原本是空的(大概率立即派發);>0 = 排在第幾位;-1 = 被拒。 */
  position: number;
  reason?: string;
}

/** 佇列任務來源:泡泡投入 / 中控面板投入 / selftest。聯集只維護這一份(chatQueue 與中控標色共用)。 */
export type ChatTaskSource = 'bubble' | 'control' | 'selftest';

/** 佇列廣播給泡泡的摘要(不含圖片內容)。 */
export interface QueuedMessageSummary {
  id: string;
  text: string;
  hasImages: boolean;
  source: ChatTaskSource;
}

/** 中控面板的每寵狀態(只有狀態燈號,不含回覆文字)。 */
export interface ControlPetStatus {
  petId: string;
  name: string;
  enabled: boolean;
  workspacePath?: string;
  /** resting=休息 / idle=閒置 / working=工作中 / awaitingApproval=等審批 */
  phase: 'resting' | 'idle' | 'working' | 'awaitingApproval';
  queue: QueuedMessageSummary[];
  pendingApproval?: { requestId: string; description: string };
}

/** 中控面板的全量快照:開窗初始化與每次變更都推整份(量小,全量重繪比事件差分省心)。 */
export interface ControlStatusSnapshot {
  pets: ControlPetStatus[];
  unbound: QueuedMessageSummary[];
}

/** 從對話泡泡貼上的圖片；只在當輪訊息中傳遞，不落盤。 */
export interface ChatImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** 不含 data URL 前綴的 base64 內容。 */
  data: string;
  name?: string;
}
