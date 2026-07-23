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
  // ⚠️ 不用 Box3.setFromObject:SkinnedMesh 的 geometry.boundingBox 會被 morph 目標
  // 撐爆、且和骨骼空間對不上(B 換膚後盒子整個歪掉 → 點不到,實際踩過)。
  // 改用「骨骼節點的世界座標」建盒:幾百個點、便宜、永遠貼著實際身形,
  // 再加一圈皮肉邊距;精準命中交給像素探針,盒子只負責預過濾。
  viewer.root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(viewer.root.matrixWorld).invert();
  const p = new THREE.Vector3();
  baseBox.makeEmpty();
  vrm.scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) baseBox.expandByPoint(o.getWorldPosition(p));
  });
  if (baseBox.isEmpty()) baseBox.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  baseBox.applyMatrix4(inv).expandByScalar(0.2);
  anchorH = (baseBox.max.y + baseBox.min.y) / 2;
  baseBoxReady = true;
}

/** 載入後自我診斷:探針戳角色中心,驗證整條命中鏈(box → 像素 alpha),結果進終端機。
 *  換模型後「點不到」這類問題不用使用者配合,看 log 就能定位斷在哪一環。 */
function hitSelfTest(): void {
  setTimeout(() => {
    const c = new THREE.Vector3(
      viewer.root.position.x,
      viewer.root.position.y + anchorH,
      viewer.root.position.z
    ).project(viewer.camera);
    const px = (c.x * 0.5 + 0.5) * innerWidth;
    const py = (-c.y * 0.5 + 0.5) * innerHeight;
    // 不經 overPet/探針(探針 30ms 就會被真游標輪詢覆蓋,一次性呼叫只會讀到假值):
    // 盒測直接算、像素直接同步渲染讀 alpha。
    ndc.set((px / innerWidth) * 2 - 1, -((py / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, viewer.camera);
    _hitBox.copy(baseBox).applyMatrix4(viewer.root.matrixWorld);
    const boxPass = raycaster.ray.intersectsBox(_hitBox);
    // 單點會恰好落在身體邊緣的空隙(旋轉的 T-pose 軀幹很窄),十字五點採樣才可靠
    // alphaMax:一次重繪讀五點(alphaAt 每呼叫都同步渲染一幀,五連發 = 白渲染四次)
    const alpha = viewer.alphaMax([
      [px, py],
      [px - 30, py],
      [px + 30, py],
      [px, py - 30],
      [px, py + 30]
    ]);
    viewer.requestAlphaScan(); // 一併印出實際有像素的範圍,對照 center 是否真的在角色身上
    console.log(
      `[hit] selftest center=(${Math.round(px)},${Math.round(py)}) boxPass=${boxPass} alpha=${alpha} → ${boxPass && alpha > 16 ? 'OK,點得到' : '有問題'}`
    );
  }, 500);
}

/** 預設姿勢:模型載入完自動播一次(有設定才播) */
function playDefaultPose(): void {
  window.pet.getDefaultPose().then((buf) => {
    if (buf) viewer.playVRMA(buf).catch((e) => console.log('[overlay] default pose failed', e));
  });
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
  viewer.wake(); // 拖曳/旋轉/縮放/面板改位置都經過這裡:恢復全速渲染
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
/** 模型載入完成後的共用鏈:量測/套狀態/快照/自檢/服裝/預設姿勢 */
function afterModelLoad(): void {
  measureAnchor();
  applyState();
  sendAvatarIcons();
  hitSelfTest();
  collectWardrobe();
  applyWardrobe();
  playDefaultPose();
}

/* 開機:先問 main 有沒有指定模型,單一載入路徑——
 * 「先載預設再被推播蓋掉」曾造成每次開機白載 14MB + 完成順序競態(code review R1)。 */
(async () => {
  try {
    const boot = await window.pet.getBootVrm();
    if (boot) await viewer.loadFromBuffer(boot);
    else await viewer.loadFromUrl('/AvatarSample_A.vrm');
    afterModelLoad();
  } catch (e) {
    console.log('[overlay] boot load failed, falling back to default', e);
    try {
      await viewer.loadFromUrl('/AvatarSample_A.vrm');
      afterModelLoad();
    } catch (e2) {
      console.log('[overlay] default load failed', e2);
    }
  }
})();

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

/* 晃動強度(頭髮/衣服/胸部) */
window.pet.getSway().then((s) => {
  if (s) viewer.setSway(s);
});
window.pet.onSway((s) => viewer.setSway(s));

/* ------------------------------------------------------------------ *
 * 服裝顯示:以「材質名」為鍵開關網格。
 * 清單在每次載入後送給 main(轉給設定面板),開關狀態存 config。
 * ------------------------------------------------------------------ */
let wardrobeStates: Record<string, boolean> = {};

/** 可開關的服裝類材質:皮膚/臉/眼睛以外的都算(頭髮也可關,想換造型的人用得到) */
function isWardrobeMat(name: string): boolean {
  return !/skin|face|eye|mouth|brow|lash/i.test(name);
}

/** 走訪模型的所有材質(含描邊)。cb 拿到「基底材質名」(描邊材質歸到其本體名下)。 */
function eachMaterial(cb: (m: THREE.Material, baseName: string) => void): void {
  const vrm = viewer.currentVrm();
  if (!vrm) return;
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m.name) continue;
      cb(m, m.name.replace(/ \(Outline\)$/i, ''));
    }
  });
}

function collectWardrobe(): void {
  if (!viewer.currentVrm()) return;
  const seen = new Map<string, string>();
  eachMaterial((_m, base) => {
    if (isWardrobeMat(base) && !seen.has(base)) {
      // 顯示名:去掉 VRoid 的長前綴(F00_006_01_Tops_01_CLOTH → Tops_01)
      const label = base.replace(/^[FN]\d+_\d+_?\d*_/i, '').replace(/_(CLOTH|HAIR)(_\d+)?( \(Instance\))?$/i, '');
      seen.set(base, label || base);
    }
  });
  // 同名材質(常見:頭髮拆成多個 Hair_00)自動編號,清單才分得出誰是誰
  const items = [...seen.entries()].map(([key, label]) => ({ key, label }));
  const total = new Map<string, number>();
  for (const it of items) total.set(it.label, (total.get(it.label) ?? 0) + 1);
  const nth = new Map<string, number>();
  for (const it of items) {
    if ((total.get(it.label) ?? 0) > 1) {
      const n = (nth.get(it.label) ?? 0) + 1;
      nth.set(it.label, n);
      it.label = `${it.label} #${n}`;
    }
  }
  window.pet.sendWardrobeList(items);
  console.log(`[wardrobe] ${items.length} items`);
}

/** ⚠️ 只關「材質」不關「網格」:同一個網格常同時裝著衣服和皮膚兩組材質,
 *  關整個網格會把手臂等共乘的部位一起藏掉(實際踩過:取消上衣,手臂跟著消失)。
 *  material.visible 只隱藏用到該材質的那部分幾何;描邊材質跟著本體一起開關。 */
function applyWardrobe(): void {
  eachMaterial((m, base) => {
    if (isWardrobeMat(base)) m.visible = wardrobeStates[base] !== false;
  });
}

window.pet.getWardrobe().then(({ states }) => {
  wardrobeStates = states;
  applyWardrobe();
});
window.pet.onWardrobe((states) => {
  wardrobeStates = states;
  applyWardrobe();
});

window.pet.onVrm(async (buf) => {
  try {
    await viewer.loadFromBuffer(buf);
    afterModelLoad();
  } catch (e) {
    console.log('[overlay] vrm swap failed', e);
  }
});

/* VRMA 動作:選單點播 / 拖 .vrma 檔到角色上 */
window.pet.onVRMA((buf) => viewer.playVRMA(buf).catch((e) => console.log('[overlay] vrma failed', e)));
window.pet.onVRMAStop(() => viewer.stopVRMA());

/* 拖 .vrm 檔到角色上 = 換模型(官方 dnd.html 路徑);拖 .vrma = 播放動作 */
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (f.name.toLowerCase().endsWith('.vrma')) {
    try {
      await viewer.playVRMA(await f.arrayBuffer());
    } catch (err) {
      console.log('[overlay] vrma drop failed', err);
    }
    return;
  }
  if (!f.name.toLowerCase().endsWith('.vrm')) return;
  try {
    await viewer.loadFromBuffer(await f.arrayBuffer());
    afterModelLoad();
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

/** 命中測試,兩段式:
 *  1) 射線 vs 包圍盒(O(1) 預過濾)——盒外直接穿透,連像素都不用讀。
 *     ⚠️ 不可對 vrm.scene 做完整 raycast:three 對 SkinnedMesh 是逐頂點骨骼變換,
 *     幾萬頂點 × 每 30ms 輪詢會把 renderer 吃滿(「點不到東西」的元兇之一)。
 *  2) 盒內問「像素 alpha」(viewer 每幀渲染後讀游標那 1px)——
 *     T-pose 包圍盒=臂展寬,盒內的透明角落必須穿透,與看得到的完全一致。
 *  像素結果晚一幀(上一幀渲染的 alpha),對 30ms 輪詢的 hover 無感。 */
function overPet(x: number, y: number): boolean {
  if (!baseBoxReady) return false;
  ndc.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1));
  raycaster.setFromCamera(ndc, viewer.camera);
  _hitBox.copy(baseBox).applyMatrix4(viewer.root.matrixWorld); // 局部 → 世界(含旋轉)
  if (!raycaster.ray.intersectsBox(_hitBox)) {
    viewer.setHitProbe(-1, -1);
    return false;
  }
  viewer.setHitProbe(x, y);
  return viewer.isHit();
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
  if (dragging || rotating) {
    if (performance.now() - lastPointerAt > 1200) {
      console.log('[hit] watchdog cleared stuck drag');
      clearDragFlags();
      scheduleSave();
    } else {
      return; // 拖曳中 DOM mousemove 會做 setLookAt,這裡不重工
    }
  }
  // 互動中且 DOM 指標事件仍在流動 → 同一次移動 mousemove 已做過 setLookAt+overPet;
  // 用 lastPointerAt 而非只看 interactive:panel 視窗漏 DOM 事件時這裡自動接手,視線不凍結
  if (interactive && performance.now() - lastPointerAt < 100) return;
  viewer.setLookAt(x, y);
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
  viewer.wake();
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
  viewer.wake(); // hover 判定需要新渲染幀,即使視線目標沒變
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

/* 觸控板/滾輪(游標壓在角色上才生效):
 *  - 垂直(兩指上下)= 縮放(相機遠近)
 *  - 水平(兩指左右)= 旋轉角色 —— 與右鍵拖曳同方向
 * 縮放時同步補償角色位置,讓「角色中心」在螢幕上釘住不動:
 * 保持 (錨點 - 光軸中心) / 相機距離 不變 → 錨點' = 中心 + (錨點 - 中心) × (z'/z)。
 * 光軸中心 = 相機 x/y = (0, 1)(viewer 的官方設定,固定不動)。 */
addEventListener('wheel', (e) => {
  lastPointerAt = performance.now();
  viewer.wake();
  if (!interactive) return;

  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    // 兩指左右滑 = 旋轉(方向對齊右鍵拖曳:往右滑往右轉;覺得反了改這裡的正負號)
    state.rotY -= e.deltaX * 0.005;
    applyState();
    scheduleSave();
    return;
  }

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
