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
  x: number; // 角色世界座標(公尺)
  y: number;
  z: number; // 深度:+ 靠近鏡頭(變大)、- 遠離(變小)
  rotY: number; // 面向(弧度)
  camZ: number; // 相機距離 = 縮放
}
const DEFAULT_STATE: PetState = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };
let state: PetState = { ...DEFAULT_STATE };

/** 角色半身高(公尺):縮放錨點 = 模型中心,每次載入後量測更新 */
let anchorH = 0.8;
/** 命中測試用包圍盒(以 root 為原點的局部座標),載入時量一次 */
const baseBox = new THREE.Box3();
let baseBoxReady = false;

function measureAnchor(): void {
  const vrm = viewer.currentVrm();
  if (!vrm) return;
  const box = new THREE.Box3().setFromObject(vrm.scene);
  anchorH = (box.max.y + box.min.y) / 2 - viewer.root.position.y;
  baseBox.copy(box).translate(viewer.root.position.clone().negate());
  baseBoxReady = true;
}

/** 拍正面/側面小圖給設定面板當原點小人(換模型會自動更新)。
 *  等一幀讓 spring bone / 姿勢先安定,拍出來才不是 T-pose 剛落地的僵硬幀。 */
function sendAvatarIcons(): void {
  requestAnimationFrame(() => {
    try {
      window.pet.sendAvatarIcons({ front: viewer.snapshot(false), side: viewer.snapshot(true) });
    } catch (e) {
      console.log('[overlay] snapshot failed', e);
    }
  });
}

function applyState(): void {
  // transform 套在 viewer.root(容器),不碰 vrm.scene —— 那上面有 rotateVRM0 的轉正
  state.z = Math.min(state.z, state.camZ - 1); // 角色不能跑到相機後面
  viewer.root.position.set(state.x, state.y, state.z);
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
    sendAvatarIcons();
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
    sendAvatarIcons();
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
    sendAvatarIcons();
  } catch (err) {
    console.log('[overlay] drop swap failed', err);
  }
});

/* ------------------------------------------------------------------ *
 * 命中判定與互動切換
 * ------------------------------------------------------------------ */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const _hitBox = new THREE.Box3();
let interactive = false;

/** 命中測試:射線 vs 角色包圍盒。
 *  ⚠️ 不要對 vrm.scene 做完整 raycast —— three 對 SkinnedMesh 是逐頂點骨骼變換,
 *  幾萬頂點 × 每 30ms 輪詢會把 renderer 主執行緒吃滿,滑鼠事件全面卡死
 *  (「點不到東西」的元兇之一)。包圍盒是 O(1),hover 用途足夠精準。 */
function overPet(x: number, y: number): boolean {
  if (!baseBoxReady) return false;
  ndc.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1));
  raycaster.setFromCamera(ndc, viewer.camera);
  _hitBox.copy(baseBox).translate(viewer.root.position);
  return raycaster.ray.intersectsBox(_hitBox);
}

function setInteractive(v: boolean): void {
  if (v === interactive) return;
  interactive = v;
  window.pet.setInteractive(v);
}

/** 滑鼠像素 → 角色所在深度平面(z = state.z)上的世界座標(拖曳用) */
const _dir = new THREE.Vector3();
function screenToWorld(px: number, py: number): { x: number; y: number } {
  _dir.set((px / innerWidth) * 2 - 1, -((py / innerHeight) * 2 - 1), 0.5).unproject(viewer.camera);
  _dir.sub(viewer.camera.position);
  const t = (state.z - viewer.camera.position.z) / _dir.z;
  return {
    x: viewer.camera.position.x + _dir.x * t,
    y: viewer.camera.position.y + _dir.y * t
  };
}

/* 主行程輪詢的游標座標:視線跟隨永遠有效;沒在拖曳時順便做 hover 判定。
 *
 * ⚠️ 看門狗:dragging/rotating 只靠 mouseup 清除,而 macOS 上 focusable:false 的
 * panel 視窗可能漏接 mouseup(原生選單時序等)。旗標卡住 → 這裡永遠不更新穿透
 * 狀態 → 全螢幕疊層吃掉桌面所有點擊(實際發生過)。
 * 真拖曳中視窗是可互動的,DOM mousemove 連續進來;超過 1.2 秒沒有任何 DOM 指標
 * 事件 = mouseup 已漏接 → 強制解除,恢復正常 hover 判定。 */
window.pet.onCursor(({ x, y }) => {
  viewer.setLookAt(x, y);
  if (dragging || rotating) {
    if (performance.now() - lastPointerAt > 1200) {
      console.log('[hit] watchdog cleared stuck drag');
      clearDragFlags();
      scheduleSave();
    } else {
      return;
    }
  }
  setInteractive(overPet(x, y));
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
let lastPointerAt = 0; // 最後一次 DOM 指標事件的時間,看門狗用

function clearDragFlags(): void {
  dragging = false;
  rotating = false;
}

/* 保險絲:視窗失焦 / 頁面隱藏時,拖曳狀態一律解除 */
addEventListener('blur', clearDragFlags);
document.addEventListener('visibilitychange', clearDragFlags);

addEventListener('mousedown', (e) => {
  lastPointerAt = performance.now();
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
  lastPointerAt = performance.now();
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
  lastPointerAt = performance.now();
  if (e.button === 0 && dragging) {
    dragging = false;
    scheduleSave();
  } else if (e.button === 2 && rotating) {
    rotating = false;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
    if (moved) scheduleSave();
    else window.pet.showMenu(); // 右鍵點一下(沒拖)= 開選單
  }
  setInteractive(overPet(e.clientX, e.clientY)); // 放開後立即重算,不殘留互動狀態
});

addEventListener('contextmenu', (e) => e.preventDefault());

/* 縮放 = 相機遠近。透視下離軸的物體會朝光軸中心滑動,
 * 所以同步補償角色位置,讓「角色中心」在螢幕上釘住不動:
 * 保持 (錨點 - 光軸中心) / 相機距離 不變 → 錨點' = 中心 + (錨點 - 中心) × (z'/z)。
 * 光軸中心 = 相機 x/y = (0, 1)(viewer 的官方設定,固定不動)。 */
addEventListener('wheel', (e) => {
  lastPointerAt = performance.now();
  if (!interactive) return;
  const minZ = state.z + 1.2; // 相機不能貼到角色深度
  const newZ = Math.min(12, Math.max(minZ, state.camZ + e.deltaY * 0.005));
  // 透視縮放以「與角色深度平面的距離」為準
  const r = (newZ - state.z) / (state.camZ - state.z);
  if (r === 1) return;
  const ay = state.y + anchorH; // 錨點 = 模型中心
  state.x = state.x * r; // 光軸 x=0
  state.y = 1 + (ay - 1) * r - anchorH; // 光軸 y=1
  state.camZ = newZ;
  applyState();
  scheduleSave();
});
