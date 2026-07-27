import './speechBubble.css';

export interface SpeechBubble {
  element: HTMLElement;
  input: HTMLTextAreaElement;
  isVisible: () => boolean;
  containsPoint: (x: number, y: number) => boolean;
  setPetName: (name: string) => void;
  showAt: (anchorX: number, anchorY: number, avoidRect?: SpeechBubbleAvoidRect) => void;
  hide: () => void;
  destroy: () => void;
  /** 對話進行中(泡泡不因移開游標而隱藏;Enter 送出被擋)。 */
  isBusy: () => boolean;
  /** turn 開始:鎖輸入框、清回覆區、顯示狀態列。 */
  beginTurn: () => void;
  /** 回覆文字增量(自動展開回覆區並捲到底)。 */
  appendText: (chunk: string) => void;
  /** 狀態列文字(思考中…/正在執行 ○○);null 清空。 */
  setStatus: (status: string | null) => void;
  /** turn 結束:解鎖輸入框;失敗時紅字顯示訊息。 */
  endTurn: (ok: boolean, errorMessage?: string) => void;
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
  /** Electron 疊層預設不可聚焦；按輸入框時由主程序暫時開放鍵盤焦點。 */
  requestInputFocus?: () => Promise<void>;
  releaseInputFocus?: () => void;
  /** Enter 送出(非 busy 且非空白時觸發)。 */
  onSend?: (text: string) => void;
  /** 停止鈕/Esc 中斷進行中的 turn。 */
  onCancel?: () => void;
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 16;

export function createSpeechBubble(options: SpeechBubbleOptions = {}): SpeechBubble {
  const element = document.createElement('aside');
  element.className = 'pet-speech-bubble';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', '角色對話');
  element.setAttribute('aria-hidden', 'true');

  const label = document.createElement('label');
  label.textContent = `${options.petName ?? '寵物'}：想對我說什麼？`;

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
  const statusRow = document.createElement('div');
  statusRow.className = 'bubble-status-row';
  const status = document.createElement('div');
  status.className = 'bubble-status';
  const stop = document.createElement('button');
  stop.className = 'bubble-stop';
  stop.type = 'button';
  stop.textContent = '停止';
  statusRow.append(status, stop);

  element.append(label, reply, statusRow, input);
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
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // Shift+Enter = 換行(交給 textarea 預設行為);IME 選字的 Enter(注音/日文)不可觸發送出
      if (event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!busy && input.value.trim()) options.onSend?.(input.value.trim());
      return;
    }
    // busy 中 input 已 disabled 收不到 Esc,中斷以停止鈕為主;這裡保留非 busy 的收合行為。
    if (event.key === 'Escape') input.blur();
  });
  stop.addEventListener('click', () => options.onCancel?.());

  function showAt(anchorX: number, anchorY: number, avoidRect?: SpeechBubbleAvoidRect): void {
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
    element.classList.add('visible');
    element.setAttribute('aria-hidden', 'false');
  }

  function hide(): void {
    if (document.activeElement === input) input.blur();
    element.classList.remove('visible');
    element.setAttribute('aria-hidden', 'true');
  }

  return {
    element,
    input,
    isVisible: () => element.classList.contains('visible'),
    containsPoint: (x, y) => {
      if (!element.classList.contains('visible')) return false;
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    },
    setPetName: (name) => {
      label.textContent = `${name || '寵物'}：想對我說什麼？`;
    },
    showAt,
    hide,
    destroy: () => {
      hide();
      element.remove();
    },
    isBusy: () => busy,
    beginTurn: () => {
      busy = true;
      input.value = '';
      input.style.height = 'auto'; // 多行送出後收回單行高度
      input.disabled = true; // 會觸發 blur → releaseInputFocus,running 中不需要鍵盤
      reply.textContent = '';
      reply.classList.remove('open');
      status.textContent = '';
      statusRow.classList.add('open');
    },
    appendText: (chunk) => {
      reply.classList.add('open');
      reply.append(document.createTextNode(chunk));
      reply.scrollTop = reply.scrollHeight;
    },
    setStatus: (text) => {
      status.textContent = text ?? '';
    },
    endTurn: (ok, errorMessage) => {
      busy = false;
      input.disabled = false;
      statusRow.classList.remove('open');
      status.textContent = '';
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
