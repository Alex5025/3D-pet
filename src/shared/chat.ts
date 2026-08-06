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
  /** 最後回報時間(agent 最後一次事件;從未對話 = 0)。中控依此新到舊排序。 */
  lastActivity: number;
  queue: QueuedMessageSummary[];
  pendingApproval?: { requestId: string; description: string };
}

/** 任務帳本的一筆紀錄:任務從投入到終結的完整生命週期(佇列本身領走就消失,追蹤靠這份)。 */
export interface ControlTaskRecord {
  id: string;
  /** 80 字摘要(同佇列摘要)。 */
  text: string;
  source: ChatTaskSource;
  /** queued=排隊中 / running=執行中 / done=完成 / failed=失敗或中斷 / removed=手動移除 */
  status: 'queued' | 'running' | 'done' | 'failed' | 'removed';
  /** 接收者 petId:綁定單投入即有;公用池單被領走時寫入。 */
  assignee?: string;
  /** 接收者名稱(寫入當下快照,寵物改名不回溯)。 */
  assigneeName?: string;
  /** 執行位置:領單寵物的工作目錄;公用池排隊中 = 發佈時限定的工作區(未限定為空)。 */
  workspacePath?: string;
  enqueuedAt: number;
  finishedAt?: number;
}

/** 中控面板的全量快照:開窗初始化與每次變更都推整份(量小,全量重繪比事件差分省心)。 */
export interface ControlStatusSnapshot {
  pets: ControlPetStatus[];
  /** 任務帳本,新到舊;含排隊中(公用池 = status queued 且無 assignee)與近期已終結者。 */
  tasks: ControlTaskRecord[];
}

/** 從對話泡泡貼上的圖片；只在當輪訊息中傳遞，不落盤。 */
export interface ChatImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** 不含 data URL 前綴的 base64 內容。 */
  data: string;
  name?: string;
}
