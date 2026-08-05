/** chat-send(invoke)的回覆:泡泡據此同步得知「立即執行 / 已排入第 N 位 / 被拒」。 */
export interface ChatSendResult {
  queued: boolean;
  /** 0 = 佇列原本是空的(大概率立即派發);>0 = 排在第幾位;-1 = 被拒。 */
  position: number;
  reason?: string;
}

/** 佇列廣播給泡泡的摘要(不含圖片內容)。 */
export interface QueuedMessageSummary {
  id: string;
  text: string;
  hasImages: boolean;
  source: string;
}

/** 從對話泡泡貼上的圖片；只在當輪訊息中傳遞，不落盤。 */
export interface ChatImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** 不含 data URL 前綴的 base64 內容。 */
  data: string;
  name?: string;
}
