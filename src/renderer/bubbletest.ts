// 泡泡自驗入口:建一顆泡泡、塞長內容、固定錨點顯示;自動化經 window.__bubble 操作。
import { createSpeechBubble } from './speechBubble';
import { setLocale, type Locale } from '../shared/i18n';

const agentChanges: { model?: string; effort?: string; permission?: string }[] = [];
let chooseWorkspaceCalls = 0;
const bubble = createSpeechBubble({
  petName: '測試',
  workspacePath: '/Users/alex/project/3D-pet',
  // 自驗沒有 main:送出直接當作被接受,才走得到 clearComposer(↑/↓ 歷史就在那裡收)
  onSend: (text) => { console.log('[bubbletest] onSend:', text); bubble.clearComposer(); },
  onRemoveQueued: (id) => console.log('[bubbletest] onRemoveQueued:', id),
  onAgentChange: (patch) => agentChanges.push(patch),
  onChooseWorkspace: () => { chooseWorkspaceCalls += 1; console.log('[bubbletest] onChooseWorkspace'); }
});
// 徽章控制項示範:與實際 app 一致——setAgentInfo 開列、setAgentControls 填內容
bubble.setAgentInfo('Claude');
bubble.setAgentControls({
  kind: 'claude', model: 'opus', effort: 'high', permission: 'readonly',
  models: [
    // opus 標成 CLI 預設、且帶 defaultEffort;sonnet 不帶 → 驗「知道才標」
    { id: 'opus', label: 'opus', efforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'medium' },
    { id: 'sonnet', label: 'sonnet', efforts: ['low', 'high', 'max'] }
  ]
});
bubble.appendText('這是一段夠長的測試內容,用來把泡泡撐到寬度上限,驗證拖曳把手的縮放行為。'.repeat(8));
// 佇列示範:busy 中輸入框仍可打字、清單每則可 ✕;beginTurn 帶原話 → 釘在回覆上方的交辦列
bubble.beginTurn('幫我把泡泡的徽章列改成靠左對齊,順便讓工作目錄可以就地更換');
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
    /** 自驗:📁 chip 被按下的次數。 */
    __chooseWorkspaceCalls: () => number;
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
window.__chooseWorkspaceCalls = () => chooseWorkspaceCalls;
