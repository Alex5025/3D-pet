import './speechBubble.css';

export interface SpeechBubble {
  element: HTMLElement;
  input: HTMLInputElement;
  isVisible: () => boolean;
  containsPoint: (x: number, y: number) => boolean;
  setPetName: (name: string) => void;
  showAt: (anchorX: number, anchorY: number, avoidRect?: SpeechBubbleAvoidRect) => void;
  hide: () => void;
  destroy: () => void;
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

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '輸入訊息…';
  input.maxLength = 120;
  input.autocomplete = 'off';
  const inputId = `pet-speech-input-${options.petId ?? 'default'}`;
  label.htmlFor = inputId;
  input.id = inputId;

  element.append(label, input);
  document.body.appendChild(element);

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
    if (event.key === 'Escape') input.blur();
  });

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
  };
}
