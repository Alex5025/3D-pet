// 泡泡自驗入口:建一顆泡泡、塞長內容、固定錨點顯示;自動化經 window.__bubble 操作。
import { createSpeechBubble } from './speechBubble';

const bubble = createSpeechBubble({ petName: '測試' });
bubble.appendText('這是一段夠長的測試內容,用來把泡泡撐到寬度上限,驗證拖曳把手的縮放行為。'.repeat(8));
bubble.showAt(innerWidth / 2, innerHeight - 120);

declare global {
  interface Window {
    __bubble: typeof bubble;
  }
}
window.__bubble = bubble;
