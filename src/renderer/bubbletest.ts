// 泡泡自驗入口:建一顆泡泡、塞長內容、固定錨點顯示;自動化經 window.__bubble 操作。
import { createSpeechBubble } from './speechBubble';
import { setLocale, type Locale } from '../shared/i18n';

const agentChanges: { model?: string; effort?: string; permission?: string }[] = [];
const bubble = createSpeechBubble({
  petName: '測試',
  onSend: (text) => console.log('[bubbletest] onSend:', text),
  onRemoveQueued: (id) => console.log('[bubbletest] onRemoveQueued:', id),
  onAgentChange: (patch) => agentChanges.push(patch)
});
// 徽章控制項示範:與實際 app 一致——setAgentInfo 開列、setAgentControls 填內容
bubble.setAgentInfo('Claude');
bubble.setAgentControls({
  kind: 'claude', model: 'opus', effort: 'high', permission: 'readonly',
  models: [
    { id: 'opus', label: 'opus', efforts: ['low', 'medium', 'high'] },
    { id: 'sonnet', label: 'sonnet', efforts: ['low', 'high', 'max'] }
  ]
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
    /** 自驗回填上次對話。 */
    __restore: (user: string, reply: string) => void;
    /** 自驗換語言:setLocale + 泡泡逐元素重套。 */
    __setLocale: (locale: string) => void;
    /** 自驗:徽章控制項送出的變更紀錄。 */
    __agentChanges: typeof agentChanges;
  }
}
window.__bubble = bubble;
window.__setLocale = (locale) => {
  setLocale(locale as Locale);
  bubble.applyLocale();
};

// 上次對話回填自驗:重啟情境(泡泡空白時回填)、進行中不覆蓋
window.__restore = (user, reply) => bubble.restoreTranscript({ user, reply, at: Date.now() });
window.__agentChanges = agentChanges;
