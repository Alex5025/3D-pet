/** 從對話泡泡貼上的圖片；只在當輪訊息中傳遞，不落盤。 */
export interface ChatImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** 不含 data URL 前綴的 base64 內容。 */
  data: string;
  name?: string;
}
