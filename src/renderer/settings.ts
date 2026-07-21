import { DEFAULT_LIGHTING, DEFAULT_SWAY, type Lighting, type Sway } from './viewer';
import type { PetState, WardrobeItem } from '../preload/index';

/**
 * 設定面板,兩個分頁:
 *  - 光影:光源強度/陰影 + 光源位置平面墊(XZ 俯視 / YZ 側視)
 *  - 角色:晃動強度(頭髮/衣服/胸部)+ 服裝顯示開關 + 角色位置平面墊
 * 所有變更即時送 main(存 config + 轉發疊層);疊層拖角色時也會同步回來。
 */
const DEFAULT_STATE: PetState = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };

let lighting: Lighting = { ...DEFAULT_LIGHTING };
let sway: Sway = { ...DEFAULT_SWAY };
let pet: PetState = { ...DEFAULT_STATE };

const el = (id: string): HTMLElement => document.getElementById(id)!;

/* ---------- 分頁 ---------- */
for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    el(`tab-${btn.dataset['tab']}`).classList.add('active');
  });
}

/* ---------- 拉桿(光影 3 條 + 晃動 3 條) ---------- */
const LIGHT_KEYS = ['ambient', 'directional', 'shade'] as const;
const SWAY_KEYS = ['hair', 'cloth', 'chest'] as const;

const slider = (id: string): HTMLInputElement => el(id) as HTMLInputElement;

for (const k of LIGHT_KEYS) {
  slider(k).addEventListener('input', () => {
    lighting[k] = Number(slider(k).value);
    window.pet.setLighting(lighting);
    render();
  });
}
for (const k of SWAY_KEYS) {
  slider(k).addEventListener('input', () => {
    sway[k] = Number(slider(k).value);
    window.pet.setSway(sway);
    render();
  });
}

/* ---------- 平面拖曳墊 ---------- */
interface PadSpec {
  el: HTMLElement;
  hRange: [number, number]; // 水平軸(左→右)
  vRange: [number, number]; // 垂直軸(下→上;反向範圍 = 軸朝下)
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
    const v = spec.vRange[1] - fv * (spec.vRange[1] - spec.vRange[0]);
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

makePad({
  el: el('light-xz'),
  hRange: [-3, 3], vRange: [3, -3], // 俯視:下 = 朝你(+Z)
  getH: () => lighting.x, getV: () => lighting.z,
  set: (h, v) => { lighting.x = h; lighting.z = v; window.pet.setLighting(lighting); }
});
makePad({
  el: el('light-yz'),
  hRange: [-3, 3], vRange: [-3, 3], // 側視:橫 = Z(右 = 朝你)
  getH: () => lighting.z, getV: () => lighting.y,
  set: (h, v) => { lighting.z = h; lighting.y = v; window.pet.setLighting(lighting); }
});
makePad({
  el: el('pet-xy'),
  hRange: [-3, 3], vRange: [-3, 3],
  getH: () => pet.x, getV: () => pet.y,
  set: (h, v) => { pet.x = h; pet.y = v; window.pet.setPetState(pet); }
});
makePad({
  el: el('pet-zy'),
  hRange: [-2, 2], vRange: [-3, 3], // 橫 = Z(右 = 靠鏡頭變大)
  getH: () => pet.z, getV: () => pet.y,
  set: (h, v) => { pet.z = h; pet.y = v; window.pet.setPetState(pet); }
});

/* ---------- 服裝顯示 ---------- */
let wardrobeStates: Record<string, boolean> = {};

function renderWardrobe(list: WardrobeItem[]): void {
  const box = el('wardrobe');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<span class="empty">此模型沒有可開關的部件</span>';
    return;
  }
  for (const item of list) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = wardrobeStates[item.key] !== false;
    cb.addEventListener('change', () => {
      wardrobeStates[item.key] = cb.checked;
      window.pet.setWardrobe(item.key, cb.checked);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(item.label));
    box.appendChild(label);
  }
}

/* ---------- 顯示 ---------- */
function render(): void {
  for (const k of LIGHT_KEYS) {
    slider(k).value = String(lighting[k]);
    el(`${k}-val`).textContent =
      k === 'shade' ? lighting[k].toFixed(2) : `${(lighting[k] / Math.PI).toFixed(2)} π`;
  }
  for (const k of SWAY_KEYS) {
    slider(k).value = String(sway[k]);
    el(`${k}-val`).textContent = `× ${sway[k].toFixed(2)}`;
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

/* ---------- 重置 ---------- */
el('reset').addEventListener('click', () => {
  lighting = { ...DEFAULT_LIGHTING };
  sway = { ...DEFAULT_SWAY };
  pet = { ...DEFAULT_STATE };
  window.pet.setLighting(lighting);
  window.pet.setSway(sway);
  window.pet.setPetState(pet);
  for (const key of Object.keys(wardrobeStates)) {
    if (wardrobeStates[key] === false) window.pet.setWardrobe(key, true);
    wardrobeStates[key] = true;
  }
  window.pet.getWardrobe().then(({ list }) => renderWardrobe(list));
  render();
});

/* ---------- 原點小人(目前載入角色的實拍) ---------- */
window.pet.onAvatarIcons(({ front, side }) => {
  const fx = el('origin-xz');
  fx.innerHTML = `<img src="${front}" alt="">`;
  const fy = el('origin-yz');
  fy.classList.remove('origin-side');
  fy.innerHTML = `<img src="${side}" alt="">`;
});

/* ---------- 初始值與同步 ---------- */
window.pet.getLighting().then((l) => {
  lighting = { ...DEFAULT_LIGHTING, ...l };
  render();
});
window.pet.getSway().then((s) => {
  sway = { ...DEFAULT_SWAY, ...s };
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
window.pet.getWardrobe().then(({ list, states }) => {
  wardrobeStates = { ...states };
  renderWardrobe(list);
});
window.pet.onWardrobeList((list) => renderWardrobe(list));

render();
