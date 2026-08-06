import './speechBubble.css';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { perf } from './perf';
import type { ChatImage } from '../shared/chat';
import { workspaceFolderName } from '../shared/petGroups';

// agent 回覆是 GFM markdown;breaks 讓單一換行也換行(聊天語感)
marked.setOptions({ gfm: true, breaks: true });

export interface SpeechBubble {
  element: HTMLElement;
  input: HTMLTextAreaElement;
  isVisible: () => boolean;
  containsPoint: (x: number, y: number) => boolean;
  setPetName: (name: string) => void;
  /** 顯示工作目錄最後一層名稱；完整路徑保留在 hover 提示。 */
  setWorkspacePath: (path?: string) => void;
  showAt: (anchorX: number, anchorY: number, avoidRect?: SpeechBubbleAvoidRect) => void;
  hide: () => void;
  destroy: () => void;
  /** 對話進行中(泡泡不因移開游標而隱藏;Enter 送出被擋)。 */
  isBusy: () => boolean;
  /** 使用者是否將泡泡切成常駐展開。 */
  isPinned: () => boolean;
  /** 寬度把手拖曳中(hover 邏輯須保持互動、不得收合或重新定位)。 */
  isResizing: () => boolean;
  /** 清空輸入框與待送附件(送出被 main 接受後由 renderer 呼叫;不綁在 beginTurn——佇列接續時會洗掉正在打的字)。 */
  clearComposer: () => void;
  /** 排隊中的訊息清單(輸入框上方;每則 ✕ → onRemoveQueued);空陣列收合。 */
  setQueue: (list: { id: string; text: string; hasImages: boolean }[]) => void;
  /** 就地錯誤(workspace 未設定/佇列滿):回覆區紅字 + activity 提示,不動 busy 狀態。 */
  showError: (message: string) => void;
  /** turn 開始:鎖輸入框、清回覆區、顯示狀態列。 */
  beginTurn: () => void;
  /** 回覆文字增量(自動展開回覆區並捲到底)。 */
  appendText: (chunk: string) => void;
  /** 狀態列文字(思考中…/正在執行 ○○);null 清空。 */
  setStatus: (status: string | null) => void;
  /** turn 結束:解鎖輸入框;失敗時紅字顯示訊息。 */
  endTurn: (ok: boolean, errorMessage?: string) => void;
  /** 顯示審批請求(描述 + 允許/拒絕);使用者按鈕後觸發 onApproval 並收合。 */
  showApproval: (requestId: string, description: string) => void;
  /** 審批已由別的 UI(中控面板)回覆:只收合審批區,不動 busy;requestId 不符或已收合則無事。 */
  hideApproval: (requestId: string) => void;
  /** 顯示目前的模型/力度徽章(如「Codex · gpt-5.6-sol · low」);null 隱藏。 */
  setAgentInfo: (text: string | null) => void;
  /** 參考檔案清單(拖放到寵物身上的絕對路徑;泡泡最下方);空陣列隱藏區塊。 */
  setRefFiles: (list: { path: string; isDir: boolean }[]) => void;
}

export interface SpeechBubbleAvoidRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type BubblePlacement = 'above' | 'below' | 'left' | 'right';

interface SpeechBubbleOptions {
  petId?: string;
  petName?: string;
  workspacePath?: string;
  /** Electron 疊層預設不可聚焦；按輸入框時由主程序暫時開放鍵盤焦點。 */
  requestInputFocus?: () => Promise<void>;
  releaseInputFocus?: () => void;
  /** Enter 送出(非 busy 且有文字或圖片時觸發)。 */
  onSend?: (text: string, images: ChatImage[]) => void;
  /** 停止鈕/Esc 中斷進行中的 turn。 */
  onCancel?: () => void;
  /** 審批按鈕(允許/拒絕)的回覆。 */
  onApproval?: (requestId: string, allow: boolean, feedback?: string) => void;
  /** 回覆區的連結點擊(交給外部瀏覽器開)。 */
  onOpenLink?: (url: string) => void;
  /** 「新對話」鈕:清掉 session,下一句從零開始。 */
  onNewSession?: () => void;
  /** 參考檔案清單的 ✕(移除該路徑)。 */
  onRemoveRef?: (path: string) => void;
  /** 佇列清單的 ✕(移除該則排隊訊息)。 */
  onRemoveQueued?: (taskId: string) => void;
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 16;
const MAX_PASTED_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set<ChatImage['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export function createSpeechBubble(options: SpeechBubbleOptions = {}): SpeechBubble {
  const element = document.createElement('aside');
  element.className = 'pet-speech-bubble';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', '角色對話');
  element.setAttribute('aria-hidden', 'true');

  const label = document.createElement('label');
  label.textContent = `${options.petName ?? '寵物'}：想對我說什麼？`;

  const workspace = document.createElement('div');
  workspace.className = 'bubble-workspace';
  const setWorkspacePath = (path?: string): void => {
    const name = workspaceFolderName(path);
    workspace.textContent = name ? `📁 ${name}` : '';
    workspace.title = path ?? '';
    workspace.classList.toggle('open', !!name);
  };
  setWorkspacePath(options.workspacePath);

  // 外側上、下角控制：實際靠左或靠右由 showAt 依螢幕中心動態決定。
  const pinHotspot = document.createElement('div');
  pinHotspot.className = 'bubble-pin-hotspot';
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'bubble-corner-dot bubble-pin';
  pin.setAttribute('aria-label', '讓對話泡泡保持展開');
  pin.setAttribute('aria-pressed', 'false');
  pin.title = '保持展開：關';
  pin.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 2.2h5.6l-1 3.4 2.1 2.1v1.1H8.7V14L8 15l-.7-1V8.8H4.1V7.7l2.1-2.1-1-3.4Z"/></svg>';
  pinHotspot.append(pin);
  const activity = document.createElement('div');
  activity.className = 'bubble-activity idle read';
  activity.setAttribute('role', 'status');
  const activityDot = document.createElement('span');
  activityDot.className = 'bubble-activity-dot';
  const activityText = document.createElement('span');
  activityText.className = 'bubble-activity-text';
  activity.append(activityDot, activityText);
  activity.setAttribute('aria-label', '執行狀態：閒置');
  activity.title = '閒置';
  let pinned = false;
  let activityReadTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivityKey = 'idle:閒置';
  const markActivityRead = (): void => {
    if (activityReadTimer) clearTimeout(activityReadTimer);
    activityReadTimer = null;
    activity.classList.add('read');
  };
  const setActivity = (state: 'idle' | 'working' | 'approval' | 'done' | 'error', text: string): void => {
    const key = `${state}:${text}`;
    activity.classList.remove('idle', 'working', 'approval', 'done', 'error');
    activity.classList.add(state);
    activityText.textContent = text;
    activity.setAttribute('aria-label', `執行狀態：${text}`);
    activity.title = text;
    if (key !== lastActivityKey) {
      lastActivityKey = key;
      if (activityReadTimer) clearTimeout(activityReadTimer);
      activityReadTimer = null;
      activity.classList.remove('read');
    }
  };
  activity.addEventListener('pointerenter', () => {
    if (activity.classList.contains('read')) return;
    activityReadTimer = setTimeout(markActivityRead, 500);
  });
  activity.addEventListener('pointerleave', () => {
    if (!activityReadTimer) return;
    clearTimeout(activityReadTimer);
    activityReadTimer = null;
  });
  pin.addEventListener('click', () => {
    pinned = !pinned;
    pin.classList.toggle('active', pinned);
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', pinned ? '取消保持對話泡泡展開' : '讓對話泡泡保持展開');
    pin.title = `保持展開：${pinned ? '開' : '關'}`;
  });

  // textarea 才能承載多行(Shift+Enter 換行);高度隨內容自動增長,上限由 CSS max-height 管
  const input = document.createElement('textarea');
  input.rows = 1;
  input.placeholder = '輸入訊息…(Shift+Enter 換行)';
  input.maxLength = 1000;
  input.autocomplete = 'off';
  const inputId = `pet-speech-input-${options.petId ?? 'default'}`;
  label.htmlFor = inputId;
  input.id = inputId;
  const autosize = (): void => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`; // CSS max-height 封頂,超過轉捲動
  };
  input.addEventListener('input', autosize);

  // 回覆區 + 狀態列(含停止鈕):agent 對話的顯示面;泡泡是笨元件,事件對映由 main.ts 做。
  const reply = document.createElement('div');
  reply.className = 'bubble-reply';
  const mdBox = document.createElement('div');
  mdBox.className = 'reply-md';
  reply.append(mdBox);
  let replyRaw = '';
  const renderReply = (): void => {
    perf.renderReplies++;
    // agent 輸出是不可信文字:markdown 轉 HTML 後必經 DOMPurify 消毒
    mdBox.innerHTML = DOMPurify.sanitize(marked.parse(replyRaw) as string);
    reply.scrollTop = reply.scrollHeight;
  };
  /** 串流重渲以 rAF 批次:一幀內到達的多個 chunk 只重渲一次(全文重跑 marked 是 O(n),不能每 token 一次)。 */
  let renderQueued = false;
  const queueRenderReply = (): void => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderReply();
    });
  };
  /** containsPoint 的 rect 快取(100ms):見 containsPoint 內註解。 */
  let cachedRect: DOMRect | null = null;
  let cachedRectAt = 0;
  /** 回覆全文上限:超過就截頭保尾(切在段落邊界;截掉奇數個 ``` 圍欄要補回,防剩餘內文全被當 code block)。 */
  const MAX_REPLY_CHARS = 60_000;
  const truncateReplyRaw = (): void => {
    let start = replyRaw.length - MAX_REPLY_CHARS;
    const paragraph = replyRaw.indexOf('\n\n', start);
    if (paragraph >= 0 && paragraph < start + MAX_REPLY_CHARS / 2) start = paragraph + 2;
    const removed = replyRaw.slice(0, start);
    const fences = (removed.match(/^```/gm) ?? []).length;
    replyRaw = '…(前段過長已截斷)\n\n' + (fences % 2 === 1 ? '```\n' : '') + replyRaw.slice(start);
  };
  reply.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a');
    if (anchor?.href) {
      event.preventDefault();
      options.onOpenLink?.(anchor.href);
    }
  });

  // 模型/力度徽章(標題右下的小字)
  // 徽章列:左邊「家別 · 模型 · 力度」,右邊「新對話」鈕
  const agentInfo = document.createElement('div');
  agentInfo.className = 'bubble-agent-info';
  const agentInfoText = document.createElement('span');
  const newSessionBtn = document.createElement('button');
  newSessionBtn.type = 'button';
  newSessionBtn.className = 'bubble-new-session';
  newSessionBtn.textContent = '＋ 新對話';
  newSessionBtn.title = '清掉目前對話上下文,下一句從零開始';
  agentInfo.append(agentInfoText, newSessionBtn);
  // 審批區塊:agent 想做危險操作時顯示,等使用者點頭
  const approvalBox = document.createElement('div');
  approvalBox.className = 'bubble-approval';
  const approvalText = document.createElement('div');
  approvalText.className = 'approval-text';
  const approvalFeedback = document.createElement('textarea');
  approvalFeedback.className = 'approval-feedback';
  approvalFeedback.rows = 2;
  approvalFeedback.maxLength = 1000;
  approvalFeedback.placeholder = '拒絕原因或希望如何調整（選填）';
  const approvalButtons = document.createElement('div');
  approvalButtons.className = 'approval-buttons';
  const allowButton = document.createElement('button');
  allowButton.type = 'button';
  allowButton.className = 'approval-allow';
  allowButton.textContent = '允許';
  const denyButton = document.createElement('button');
  denyButton.type = 'button';
  denyButton.className = 'approval-deny';
  denyButton.textContent = '拒絕';
  approvalButtons.append(allowButton, denyButton);
  approvalBox.append(approvalText, approvalFeedback, approvalButtons);
  let approvalRequestId: string | null = null;
  const answerApproval = (allow: boolean): void => {
    if (!approvalRequestId) return;
    const requestId = approvalRequestId;
    const feedback = approvalFeedback.value.trim();
    approvalRequestId = null;
    // textarea 聚焦時 overlay 會暫時攔截鍵盤；收起選擇框前必須主動 blur，
    // 否則隱藏的欄位仍可能讓透明桌面層卡在輸入模式。
    approvalFeedback.blur();
    approvalBox.classList.remove('open');
    approvalFeedback.value = '';
    setActivity('working', allow ? '已允許，執行中' : '已拒絕，調整中');
    options.onApproval?.(requestId, allow, allow ? undefined : feedback);
  };
  allowButton.addEventListener('click', () => answerApproval(true));
  denyButton.addEventListener('click', () => answerApproval(false));
  approvalFeedback.addEventListener('pointerdown', (event) => {
    if (!options.requestInputFocus || document.activeElement === approvalFeedback) return;
    event.preventDefault();
    void options.requestInputFocus().then(() => approvalFeedback.focus());
  });
  approvalFeedback.addEventListener('blur', () => options.releaseInputFocus?.());

  // 新對話:turn 進行中不給按(要先停止);按下後就地清空回覆區,視覺上等於「重新開始」
  newSessionBtn.addEventListener('click', () => {
    if (busy) return;
    replyRaw = '';
    reply.replaceChildren(mdBox);
    mdBox.innerHTML = '';
    reply.classList.remove('open');
    newSessionBtn.textContent = '已清空';
    setTimeout(() => (newSessionBtn.textContent = '＋ 新對話'), 1400);
    options.onNewSession?.();
  });

  // 參考檔案清單(泡泡最下方):拖放檔案/資料夾到寵物身上後出現,每列可 ✕ 移除
  const refsBox = document.createElement('div');
  refsBox.className = 'bubble-refs';

  // 圖片只以附件數量呈現，不產生縮圖；送出後才清空。
  const imagesBox = document.createElement('div');
  imagesBox.className = 'bubble-images';
  const imagesText = document.createElement('span');
  const clearImages = document.createElement('button');
  clearImages.type = 'button';
  clearImages.textContent = '移除';
  clearImages.title = '移除所有已貼上的圖片';
  imagesBox.append(imagesText, clearImages);
  let pendingImages: ChatImage[] = [];
  const updateImagesBox = (): void => {
    imagesText.textContent = `📎 已貼上 ${pendingImages.length} 張圖片`;
    imagesBox.classList.toggle('open', pendingImages.length > 0);
  };
  clearImages.addEventListener('click', () => {
    pendingImages = [];
    updateImagesBox();
  });

  const statusRow = document.createElement('div');
  statusRow.className = 'bubble-status-row';
  const status = document.createElement('div');
  status.className = 'bubble-status';
  const stop = document.createElement('button');
  stop.className = 'bubble-stop';
  stop.type = 'button';
  stop.textContent = '停止';
  statusRow.append(status, stop);

  // 佇列清單(輸入框上方):turn 進行中再送出的訊息排在這裡,每則可 ✕ 移除
  const queueBox = document.createElement('div');
  queueBox.className = 'bubble-queue';

  element.append(pinHotspot, activity, label, workspace, agentInfo, reply, approvalBox, statusRow, imagesBox, queueBox, input, refsBox);

  // 左右邊緣的寬度把手：拖曳＝手動設定這顆泡泡的寬度上限（內容少時照樣縮小、多時撐到這裡為止）；
  // 雙擊還原純密度上限。只存記憶體，寵物重啟後回到自動。
  let resizing = false;
  const makeResizeHandle = (side: 'left' | 'right'): HTMLDivElement => {
    const handle = document.createElement('div');
    handle.className = `bubble-resize ${side}`;
    handle.title = '拖曳調整泡泡寬度（雙擊還原自動）';
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || resizing) return;
      event.preventDefault();
      const startRect = element.getBoundingClientRect();
      resizing = true;
      // 先把目前寬度固定成 inline width、再清掉上次的手動 max-width——
      // max-width 永遠壓過 width,不清的話調窄後就再也拉不寬。
      element.style.width = `${Math.round(startRect.width)}px`;
      element.style.maxWidth = '';
      // move/up 掛 window,不用 setPointerCapture:實測疊層視窗(type: panel、不可聚焦)的
      // pointer capture 會靜默失敗(hasPointerCapture 為 false),游標一離開把手事件就斷。
      const onMove = (move: PointerEvent): void => {
        // 拖曳中固定對側邊緣、寬度直接跟著游標（CSS min/max-width 會夾限）；收手後才交還 showAt 重新定位。
        const width = side === 'right'
          ? move.clientX - startRect.left
          : startRect.right - move.clientX;
        element.style.width = `${Math.round(width)}px`;
        if (side === 'left') element.style.left = `${Math.round(startRect.right - element.offsetWidth)}px`;
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('blur', onUp);
        resizing = false;
        // 夾限後的實際寬度轉成上限；包進 min() 讓密度上限(半屏/三分之一屏)仍然有效。
        element.style.maxWidth = `min(${element.offsetWidth}px, var(--bubble-max-width, calc(50vw - 24px)))`;
        element.style.width = '';
        showAt(lastAnchorX, lastAnchorY, lastAvoidRect);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('blur', onUp);
    });
    handle.addEventListener('dblclick', () => {
      element.style.maxWidth = '';
      showAt(lastAnchorX, lastAnchorY, lastAvoidRect);
    });
    return handle;
  };
  element.append(makeResizeHandle('left'), makeResizeHandle('right'));
  document.body.appendChild(element);

  let busy = false;

  input.addEventListener('pointerdown', (event) => {
    if (!options.requestInputFocus || document.activeElement === input) return;
    // 先讓 Electron 視窗可聚焦，再由 renderer 聚焦輸入框；否則只會看得到游標，收不到鍵盤。
    event.preventDefault();
    void options.requestInputFocus().then(() => {
      if (element.classList.contains('visible')) input.focus();
      else options.releaseInputFocus?.();
    });
  });
  input.addEventListener('blur', () => options.releaseInputFocus?.());
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.setRangeText(text, start, end, 'end');
      autosize();
    }
    const slots = Math.max(0, MAX_PASTED_IMAGES - pendingImages.length);
    for (const file of files.slice(0, slots)) {
      if (!ACCEPTED_IMAGE_TYPES.has(file.type as ChatImage['mimeType']) || file.size > MAX_IMAGE_BYTES) continue;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        if (typeof reader.result !== 'string' || pendingImages.length >= MAX_PASTED_IMAGES) return;
        const comma = reader.result.indexOf(',');
        if (comma < 0) return;
        pendingImages.push({
          mimeType: file.type as ChatImage['mimeType'],
          data: reader.result.slice(comma + 1),
          name: file.name || undefined,
        });
        updateImagesBox();
      });
      reader.readAsDataURL(file);
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // Shift+Enter = 換行(交給 textarea 預設行為);IME 選字的 Enter(注音/日文)不可觸發送出
      if (event.shiftKey || event.isComposing) return;
      event.preventDefault();
      // busy 中也可送出:main 端會排入佇列(是否清空輸入框由 invoke 回覆決定)
      if (input.value.trim() || pendingImages.length) {
        options.onSend?.(input.value.trim(), [...pendingImages]);
      }
      return;
    }
    // Esc 只收鍵盤焦點;中斷執行以停止鈕為主
    if (event.key === 'Escape') input.blur();
  });
  stop.addEventListener('click', () => options.onCancel?.());

  let lastAnchorX = 0;
  let lastAnchorY = 0;
  let lastAvoidRect: SpeechBubbleAvoidRect | undefined;

  function showAt(anchorX: number, anchorY: number, avoidRect?: SpeechBubbleAvoidRect): void {
    lastAnchorX = anchorX;
    lastAnchorY = anchorY;
    lastAvoidRect = avoidRect;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const avoided = avoidRect ?? {
      left: anchorX,
      right: anchorX,
      top: anchorY,
      bottom: anchorY,
    };
    const available = {
      above: avoided.top - VIEWPORT_MARGIN,
      below: window.innerHeight - VIEWPORT_MARGIN - avoided.bottom,
      left: avoided.left - VIEWPORT_MARGIN,
      right: window.innerWidth - VIEWPORT_MARGIN - avoided.right,
    };
    const horizontalNeed = width + ANCHOR_GAP;
    const verticalNeed = height + ANCHOR_GAP;
    const sideOrder: BubblePlacement[] = available.left >= available.right
      ? ['left', 'right']
      : ['right', 'left'];
    let placement: BubblePlacement;
    if (available.above >= verticalNeed) {
      placement = 'above';
    } else if (available[sideOrder[0] as 'left' | 'right'] >= horizontalNeed) {
      placement = sideOrder[0];
    } else if (available[sideOrder[1] as 'left' | 'right'] >= horizontalNeed) {
      placement = sideOrder[1];
    } else if (available.below >= verticalNeed) {
      placement = 'below';
    } else {
      // 角色或泡泡極大時可能沒有完整空位；選相對容納比例最高的方向。
      placement = (Object.entries({
        above: available.above / verticalNeed,
        below: available.below / verticalNeed,
        left: available.left / horizontalNeed,
        right: available.right / horizontalNeed,
      }) as Array<[BubblePlacement, number]>).sort((a, b) => b[1] - a[1])[0][0];
    }

    let left = anchorX - width / 2;
    let top = avoided.top - height - ANCHOR_GAP;
    if (placement === 'below') top = avoided.bottom + ANCHOR_GAP;
    if (placement === 'left') {
      left = avoided.left - width - ANCHOR_GAP;
      top = anchorY - height / 2;
    } else if (placement === 'right') {
      left = avoided.right + ANCHOR_GAP;
      top = anchorY - height / 2;
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(window.innerWidth - width - VIEWPORT_MARGIN, left));
    top = Math.max(VIEWPORT_MARGIN, Math.min(window.innerHeight - height - VIEWPORT_MARGIN, top));

    const tailLeft = Math.max(22, Math.min(width - 22, anchorX - left));
    const tailTop = Math.max(22, Math.min(height - 22, anchorY - top));
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.setProperty('--tail-left', `${Math.round(tailLeft)}px`);
    element.style.setProperty('--tail-top', `${Math.round(tailTop)}px`);
    element.classList.remove('below', 'left-of', 'right-of');
    if (placement === 'below') element.classList.add('below');
    if (placement === 'left') element.classList.add('left-of');
    if (placement === 'right') element.classList.add('right-of');
    element.classList.toggle('outer-left', left + width / 2 < window.innerWidth / 2);
    element.classList.toggle('outer-right', left + width / 2 >= window.innerWidth / 2);
    element.classList.add('visible');
    element.setAttribute('aria-hidden', 'false');
    cachedRect = null; // 位置剛變,舊 rect 作廢
  }

  // 寬度改為隨內容伸縮（max-content + 上限）：串流回覆會讓尺寸中途變化，
  // 用上次錨點重新定位，避免泡泡長出螢幕邊緣。showAt 只動 left/top，不會造成觀察迴圈。
  const resizeObserver = new ResizeObserver(() => {
    if (resizing) return; // 拖曳中位置由把手直接控制,收手時會補一次 showAt
    if (element.classList.contains('visible')) showAt(lastAnchorX, lastAnchorY, lastAvoidRect);
  });
  resizeObserver.observe(element);

  function hide(): void {
    if (document.activeElement === input) input.blur();
    element.classList.remove('visible');
    element.setAttribute('aria-hidden', 'true');
    cachedRect = null;
  }

  return {
    element,
    input,
    isVisible: () => element.classList.contains('visible'),
    containsPoint: (x, y) => {
      if (!element.classList.contains('visible')) return false;
      // getBoundingClientRect 會強制 layout,而 containsPoint 在游標輪詢/滑動中高頻呼叫:
      // 快取 100ms(泡泡位置與尺寸在這個尺度內幾乎不變;過期或剛 showAt 時才重量)
      const now = performance.now();
      if (!cachedRect || now - cachedRectAt > 100) {
        cachedRect = element.getBoundingClientRect();
        cachedRectAt = now;
      }
      // 角落圓點有一半伸出泡泡本體，命中範圍同步外擴。
      return x >= cachedRect.left - 20 && x <= cachedRect.right + 20 &&
        y >= cachedRect.top - 20 && y <= cachedRect.bottom + 28;
    },
    setPetName: (name) => {
      label.textContent = `${name || '寵物'}：想對我說什麼？`;
    },
    setWorkspacePath,
    showAt,
    hide,
    destroy: () => {
      resizeObserver.disconnect();
      if (activityReadTimer) clearTimeout(activityReadTimer);
      if (element.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      hide();
      element.remove();
    },
    isBusy: () => busy,
    isPinned: () => pinned,
    isResizing: () => resizing,
    beginTurn: () => {
      busy = true;
      setActivity('working', '執行中');
      // 不清 input/附件、不 disable——佇列接續時使用者可能正在打下一句;
      // composer 的清空由「送出被接受」時的 clearComposer() 負責
      replyRaw = '';
      reply.replaceChildren(mdBox); // 清掉上一輪的錯誤列,保留 md 容器
      mdBox.innerHTML = '';
      reply.classList.remove('open');
      status.textContent = '';
      statusRow.classList.add('open');
    },
    clearComposer: () => {
      input.value = '';
      input.style.height = 'auto'; // 多行送出後收回單行高度
      pendingImages = [];
      updateImagesBox();
    },
    setQueue: (list) => {
      queueBox.replaceChildren();
      queueBox.classList.toggle('open', list.length > 0);
      list.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'queue-row';
        const name = document.createElement('span');
        name.className = 'queue-text';
        name.textContent = `${index + 1}. ${item.text}${item.hasImages ? ' 📎' : ''}`;
        name.title = item.text;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'queue-remove';
        remove.textContent = '✕';
        remove.title = '從佇列移除這則訊息';
        remove.addEventListener('click', () => options.onRemoveQueued?.(item.id));
        row.append(name, remove);
        queueBox.append(row);
      });
    },
    showError: (message) => {
      // 不動 busy:進行中 turn 的 UI 不能被就地錯誤(如 workspace 未設定、佇列滿)誤終結
      setActivity('error', message);
      reply.classList.add('open');
      const line = document.createElement('div');
      line.className = 'reply-error';
      line.textContent = message;
      reply.append(line);
      reply.scrollTop = reply.scrollHeight;
    },
    setAgentInfo: (text) => {
      agentInfoText.textContent = text ?? '';
      agentInfo.classList.toggle('open', !!text);
    },
    setRefFiles: (list) => {
      refsBox.replaceChildren();
      refsBox.classList.toggle('open', list.length > 0);
      for (const item of list) {
        const row = document.createElement('div');
        row.className = 'ref-row';
        const name = document.createElement('span');
        name.className = 'ref-name';
        name.textContent = `${item.isDir ? '📁' : '📄'} ${item.path.split('/').filter(Boolean).pop() ?? item.path}`;
        name.title = item.path; // hover 看完整路徑
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ref-remove';
        remove.textContent = '✕';
        remove.title = '移除這個參考檔案';
        remove.addEventListener('click', () => options.onRemoveRef?.(item.path));
        row.append(name, remove);
        refsBox.append(row);
      }
    },
    showApproval: (requestId, description) => {
      approvalRequestId = requestId;
      approvalText.textContent = description;
      approvalFeedback.value = '';
      approvalBox.classList.add('open');
      setActivity('approval', '等待核准');
    },
    hideApproval: (requestId) => {
      // 自己按鈕回覆時 approvalRequestId 已清空(answerApproval),這裡只處理「中控代答」的收合
      if (approvalRequestId !== requestId) return;
      approvalRequestId = null;
      approvalFeedback.blur(); // 同 answerApproval:收合前必須 blur,否則透明層卡在輸入模式
      approvalBox.classList.remove('open');
      approvalFeedback.value = '';
      setActivity('working', '已在中控面板處理,執行中');
    },
    appendText: (chunk) => {
      reply.classList.add('open');
      replyRaw += chunk;
      if (replyRaw.length > MAX_REPLY_CHARS) truncateReplyRaw();
      queueRenderReply();
    },
    setStatus: (text) => {
      status.textContent = text ?? '';
      if (busy) setActivity('working', text || '執行中');
    },
    endTurn: (ok, errorMessage) => {
      busy = false;
      setActivity(ok ? 'done' : 'error', ok ? '已完成' : (errorMessage || '執行失敗'));
      statusRow.classList.remove('open');
      status.textContent = '';
      approvalRequestId = null;
      approvalBox.classList.remove('open');
      if (!ok && errorMessage) {
        reply.classList.add('open');
        const line = document.createElement('div');
        line.className = 'reply-error';
        line.textContent = errorMessage;
        reply.append(line);
        reply.scrollTop = reply.scrollHeight;
      }
    },
  };
}
