import { DEFAULT_LIGHTING, type Lighting } from './viewer';
import type { PetState } from '../preload/index';

/**
 * 燈光與位置面板。
 * - 強度:拉桿(顯示成 × π 倍數)
 * - 光源位置 / 角色位置:XY(正面)與 ZY(側面)兩個平面拖曳墊,拖點即時生效
 * 所有變更即時送 main(存 config + 轉發疊層);疊層那邊拖角色時也會同步回來。
 */
const DEFAULT_STATE: PetState = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };

let lighting: Lighting = { ...DEFAULT_LIGHTING };
let pet: PetState = { ...DEFAULT_STATE };

/* ---------- 強度拉桿 ---------- */
const INTENSITY = ['ambient', 'directional', 'shade'] as const;
const sliders = Object.fromEntries(
  INTENSITY.map((k) => [k, document.getElementById(k) as HTMLInputElement])
) as Record<(typeof INTENSITY)[number], HTMLInputElement>;
const sliderVals = Object.fromEntries(
  INTENSITY.map((k) => [k, document.getElementById(`${k}-val`) as HTMLSpanElement])
) as Record<(typeof INTENSITY)[number], HTMLSpanElement>;

for (const k of INTENSITY) {
  sliders[k].addEventListener('input', () => {
    lighting[k] = Number(sliders[k].value);
    pushLighting();
    render();
  });
}

/* ---------- 平面拖曳墊 ---------- */
interface PadSpec {
  el: HTMLElement;
  hRange: [number, number]; // 水平軸(左→右)
  vRange: [number, number]; // 垂直軸(下→上)
  getH: () => number;
  getV: () => number;
  set: (h: number, v: number) => void;
}

const pads: PadSpec[] = [];

function makePad(spec: PadSpec): void {
  pads.push(spec);
  const drag = (e: PointerEvent): void => {
    const r = spec.el.getBoundingClientRect();
    const fh = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fv = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const h = spec.hRange[0] + fh * (spec.hRange[1] - spec.hRange[0]);
    const v = spec.vRange[1] - fv * (spec.vRange[1] - spec.vRange[0]); // 螢幕 y 向下 → 軸向上
    spec.set(Math.round(h * 100) / 100, Math.round(v * 100) / 100);
    render();
  };
  spec.el.addEventListener('pointerdown', (e) => {
    spec.el.setPointerCapture(e.pointerId);
    drag(e);
    const move = (ev: PointerEvent): void => drag(ev);
    const up = (): void => {
      spec.el.removeEventListener('pointermove', move);
      spec.el.removeEventListener('pointerup', up);
    };
    spec.el.addEventListener('pointermove', move);
    spec.el.addEventListener('pointerup', up);
  });
}

const el = (id: string): HTMLElement => document.getElementById(id)!;

makePad({
  el: el('light-xz'),
  // 俯視:橫 = X(右+);縱 = Z,「下 = 朝你(+Z)、上 = 角色背後(-Z)」→ 反向範圍
  hRange: [-3, 3], vRange: [3, -3],
  getH: () => lighting.x, getV: () => lighting.z,
  set: (h, v) => { lighting.x = h; lighting.z = v; pushLighting(); }
});
makePad({
  el: el('light-yz'),
  // 側視:橫 = Z(右 = 朝你);縱 = Y(上+)
  hRange: [-3, 3], vRange: [-3, 3],
  getH: () => lighting.z, getV: () => lighting.y,
  set: (h, v) => { lighting.z = h; lighting.y = v; pushLighting(); }
});
makePad({
  el: el('pet-xy'),
  hRange: [-3, 3], vRange: [-3, 3],
  getH: () => pet.x, getV: () => pet.y,
  set: (h, v) => { pet.x = h; pet.y = v; pushPet(); }
});
makePad({
  el: el('pet-zy'),
  hRange: [-2, 2], vRange: [-3, 3], // 水平 = Z(右 = 靠鏡頭變大)
  getH: () => pet.z, getV: () => pet.y,
  set: (h, v) => { pet.z = h; pet.y = v; pushPet(); }
});

/* ---------- 送出 / 顯示 ---------- */
function pushLighting(): void {
  window.pet.setLighting(lighting);
}
function pushPet(): void {
  window.pet.setPetState(pet);
}

function render(): void {
  for (const k of INTENSITY) {
    sliders[k].value = String(lighting[k]);
    sliderVals[k].textContent =
      k === 'shade' ? lighting[k].toFixed(2) : `${(lighting[k] / Math.PI).toFixed(2)} π`;
  }
  for (const p of pads) {
    const dot = p.el.querySelector('.dot') as HTMLElement;
    const fh = (p.getH() - p.hRange[0]) / (p.hRange[1] - p.hRange[0]);
    const fv = (p.vRange[1] - p.getV()) / (p.vRange[1] - p.vRange[0]);
    dot.style.left = `${Math.min(100, Math.max(0, fh * 100))}%`;
    dot.style.top = `${Math.min(100, Math.max(0, fv * 100))}%`;
  }
  el('lxz-val').textContent = `${lighting.x.toFixed(1)}, ${lighting.z.toFixed(1)}`;
  el('lyz-val').textContent = `${lighting.y.toFixed(1)}, ${lighting.z.toFixed(1)}`;
  el('pxy-val').textContent = `${pet.x.toFixed(1)}, ${pet.y.toFixed(1)}`;
  el('pzy-val').textContent = `${pet.z.toFixed(1)}, ${pet.y.toFixed(1)}`;
}

document.getElementById('reset')!.addEventListener('click', () => {
  lighting = { ...DEFAULT_LIGHTING };
  pet = { ...DEFAULT_STATE };
  pushLighting();
  pushPet();
  render();
});

/* 原點小人:疊層送來「目前載入角色」的正面/側面照(側面照已朝 +Z,移除 emoji 的鏡像) */
window.pet.onAvatarIcons(({ front, side }) => {
  const fx = el('origin-xz');
  fx.innerHTML = `<img src="${front}" alt="">`;
  const fy = el('origin-yz');
  fy.classList.remove('origin-side');
  fy.innerHTML = `<img src="${side}" alt="">`;
});

/* 初始值 + 疊層拖曳時的同步 */
window.pet.getLighting().then((l) => {
  lighting = { ...DEFAULT_LIGHTING, ...l };
  render();
});
window.pet.getState().then((s) => {
  pet = { ...DEFAULT_STATE, ...s };
  render();
});
window.pet.onState((s) => {
  pet = { ...DEFAULT_STATE, ...s };
  render();
});
