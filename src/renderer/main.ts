import * as THREE from 'three';
import { createViewer } from './viewer';

/**
 * 桌面疊層 = 官方 viewer + 互動層(對齊 Steam 桌寵的操作習慣):
 *  - 視線跟著游標(官方 lookAt;游標座標由主行程輪詢推送,不需要視窗事件)
 *  - 左鍵拖曳移動角色
 *  - 右鍵拖曳旋轉;右鍵點一下 → 原生選單(換 VRM / 重置 / 結束)
 *  - 滾輪縮放(動相機距離,不縮放模型 —— 模型永遠原尺寸)
 *  - 位置/角度/縮放/選過的 VRM 都存 config.json,重開沿用
 */
const viewer = createViewer({ transparent: true });

/* ------------------------------------------------------------------ *
 * 狀態(config.json 持久化)
 * ------------------------------------------------------------------ */
interface PetState {
  x: number; // 角色在 z=0 平面上的世界座標
  y: number;
  rotY: number; // 面向(弧度)
  camZ: number; // 相機距離 = 縮放
}
const DEFAULT_STATE: PetState = { x: 0, y: 0, rotY: 0, camZ: 5 };
let state: PetState = { ...DEFAULT_STATE };

/** 角色半身高(公尺):縮放錨點 = 模型中心,每次載入後量測更新 */
let anchorH = 0.8;

function measureAnchor(): void {
  const vrm = viewer.currentVrm();
  if (!vrm) return;
  const box = new THREE.Box3().setFromObject(vrm.scene);
  anchorH = (box.max.y + box.min.y) / 2 - viewer.root.position.y;
}

function applyState(): void {
  // transform 套在 viewer.root(容器),不碰 vrm.scene —— 那上面有 rotateVRM0 的轉正
  viewer.root.position.set(state.x, state.y, 0);
  viewer.root.rotation.y = state.rotY;
  viewer.camera.position.z = state.camZ;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.pet.saveState(state), 300);
}

/* ------------------------------------------------------------------ *
 * 載入
 * ------------------------------------------------------------------ */
viewer
  .loadFromUrl('/AvatarSample_A.vrm')
  .then(() => {
    measureAnchor();
    applyState();
  })
  .catch((e) => console.log('[overlay] default load failed', e));

window.pet.getState().then((s) => {
  if (s) state = { ...DEFAULT_STATE, ...s };
  applyState();
});

window.pet.onState((s) => {
  state = { ...DEFAULT_STATE, ...s };
  applyState();
});

/* 燈光:開機讀存檔值,設定面板拖動時即時套用 */
window.pet.getLighting().then((l) => {
  if (l) {
    viewer.setLighting(l);
    console.log('[overlay] lighting applied ' + JSON.stringify(l));
  }
});
window.pet.onLighting((l) => viewer.setLighting(l));

window.pet.onVrm(async (buf) => {
  try {
    await viewer.loadFromBuffer(buf);
    measureAnchor();
    applyState(); // 新模型套回同一組位置/角度
  } catch (e) {
    console.log('[overlay] vrm swap failed', e);
  }
});

/* 拖 .vrm 檔到角色上 = 換模型(官方 dnd.html 路徑) */
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f || !f.name.endsWith('.vrm')) return;
  try {
    await viewer.loadFromBuffer(await f.arrayBuffer());
    measureAnchor();
    applyState();
  } catch (err) {
    console.log('[overlay] drop swap failed', err);
  }
});

/* ------------------------------------------------------------------ *
 * 命中判定與互動切換
 * ------------------------------------------------------------------ */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let interactive = false;

function overPet(x: number, y: number): boolean {
  const vrm = viewer.currentVrm();
  if (!vrm) return false;
  ndc.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1));
  raycaster.setFromCamera(ndc, viewer.camera);
  return raycaster.intersectObject(vrm.scene, true).length > 0;
}

function setInteractive(v: boolean): void {
  if (v === interactive) return;
  interactive = v;
  window.pet.setInteractive(v);
}

/** 滑鼠像素 → z=0 平面上的世界座標(拖曳用) */
const _dir = new THREE.Vector3();
function screenToWorld(px: number, py: number): { x: number; y: number } {
  _dir.set((px / innerWidth) * 2 - 1, -((py / innerHeight) * 2 - 1), 0.5).unproject(viewer.camera);
  _dir.sub(viewer.camera.position);
  const t = -viewer.camera.position.z / _dir.z;
  return {
    x: viewer.camera.position.x + _dir.x * t,
    y: viewer.camera.position.y + _dir.y * t
  };
}

/* 主行程輪詢的游標座標:視線跟隨永遠有效;沒在拖曳時順便做 hover 判定 */
window.pet.onCursor(({ x, y }) => {
  viewer.setLookAt(x, y);
  if (!dragging && !rotating) setInteractive(overPet(x, y));
});

/* ------------------------------------------------------------------ *
 * 左鍵拖曳移動 / 右鍵拖曳旋轉 / 右鍵點擊選單 / 滾輪縮放
 * (視窗只有游標壓在角色上時才吃得到這些事件)
 * ------------------------------------------------------------------ */
let dragging = false;
let rotating = false;
let grab = { x: 0, y: 0 }; // 世界座標:按下點與角色原點的差
let downAt = { x: 0, y: 0 }; // 螢幕像素:判斷右鍵是「點」還是「拖」
let rotStart = 0;

addEventListener('mousedown', (e) => {
  if (!overPet(e.clientX, e.clientY)) return;
  if (e.button === 0) {
    dragging = true;
    const w = screenToWorld(e.clientX, e.clientY);
    grab = { x: w.x - state.x, y: w.y - state.y };
  } else if (e.button === 2) {
    rotating = true;
    downAt = { x: e.clientX, y: e.clientY };
    rotStart = state.rotY;
  }
});

addEventListener('mousemove', (e) => {
  viewer.setLookAt(e.clientX, e.clientY);
  if (dragging) {
    const w = screenToWorld(e.clientX, e.clientY);
    state.x = w.x - grab.x;
    state.y = w.y - grab.y;
    applyState();
  } else if (rotating) {
    state.rotY = rotStart + (e.clientX - downAt.x) * 0.02;
    applyState();
  } else {
    setInteractive(overPet(e.clientX, e.clientY));
  }
});

addEventListener('mouseup', (e) => {
  if (e.button === 0 && dragging) {
    dragging = false;
    scheduleSave();
  } else if (e.button === 2 && rotating) {
    rotating = false;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
    if (moved) scheduleSave();
    else window.pet.showMenu(); // 右鍵點一下(沒拖)= 開選單
  }
});

addEventListener('contextmenu', (e) => e.preventDefault());

/* 縮放 = 相機遠近。透視下離軸的物體會朝光軸中心滑動,
 * 所以同步補償角色位置,讓「角色中心」在螢幕上釘住不動:
 * 保持 (錨點 - 光軸中心) / 相機距離 不變 → 錨點' = 中心 + (錨點 - 中心) × (z'/z)。
 * 光軸中心 = 相機 x/y = (0, 1)(viewer 的官方設定,固定不動)。 */
addEventListener('wheel', (e) => {
  if (!interactive) return;
  const newZ = Math.min(12, Math.max(1.2, state.camZ + e.deltaY * 0.005));
  const r = newZ / state.camZ;
  if (r === 1) return;
  const ay = state.y + anchorH; // 錨點 = 模型中心
  state.x = state.x * r; // 光軸 x=0
  state.y = 1 + (ay - 1) * r - anchorH; // 光軸 y=1
  state.camZ = newZ;
  applyState();
  scheduleSave();
});
