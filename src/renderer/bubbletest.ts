// 泡泡自驗入口:建一顆泡泡、塞長內容、固定錨點顯示;自動化經 window.__bubble 操作。
import { createSpeechBubble } from './speechBubble';

const bubble = createSpeechBubble({
  petName: '測試',
  onSend: (text) => console.log('[bubbletest] onSend:', text),
  onRemoveQueued: (id) => console.log('[bubbletest] onRemoveQueued:', id)
});
bubble.appendText('這是一段夠長的測試內容,用來把泡泡撐到寬度上限,驗證拖曳把手的縮放行為。'.repeat(8));
// 佇列示範:busy 中輸入框仍可打字、清單每則可 ✕
bubble.beginTurn();
bubble.setQueue([
  { id: 'q1', text: '幫我更新 README 的功能清單', hasImages: false },
  { id: 'q2', text: '然後跑一次測試看有沒有壞', hasImages: true }
]);
bubble.showAt(innerWidth / 2, innerHeight - 120);

declare global {
  interface Window {
    __bubble: typeof bubble;
  }
}
window.__bubble = bubble;
