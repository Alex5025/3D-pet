import { DEFAULT_LIGHTING, type Lighting } from './viewer';

/**
 * 燈光設定面板:拉桿動了就即時送出(main 存檔 + 轉發疊層套用)。
 * 強度顯示成「× π」的倍數,比原始弧度值好讀。
 */
const KEYS = ['ambient', 'directional', 'dirX', 'dirY'] as const;

const sliders = Object.fromEntries(
  KEYS.map((k) => [k, document.getElementById(k) as HTMLInputElement])
) as Record<(typeof KEYS)[number], HTMLInputElement>;

const vals = Object.fromEntries(
  KEYS.map((k) => [k, document.getElementById(`${k}-val`) as HTMLSpanElement])
) as Record<(typeof KEYS)[number], HTMLSpanElement>;

function fmt(k: (typeof KEYS)[number], v: number): string {
  return k === 'ambient' || k === 'directional' ? `${(v / Math.PI).toFixed(2)} π` : v.toFixed(2);
}

function show(l: Lighting): void {
  for (const k of KEYS) {
    sliders[k].value = String(l[k]);
    vals[k].textContent = fmt(k, l[k]);
  }
}

function current(): Lighting {
  return {
    ambient: Number(sliders.ambient.value),
    directional: Number(sliders.directional.value),
    dirX: Number(sliders.dirX.value),
    dirY: Number(sliders.dirY.value)
  };
}

for (const k of KEYS) {
  sliders[k].addEventListener('input', () => {
    const l = current();
    vals[k].textContent = fmt(k, l[k]);
    window.pet.setLighting(l);
  });
}

document.getElementById('reset')!.addEventListener('click', () => {
  show(DEFAULT_LIGHTING);
  window.pet.setLighting(DEFAULT_LIGHTING);
});

window.pet.getLighting().then((l) => show({ ...DEFAULT_LIGHTING, ...l }));
