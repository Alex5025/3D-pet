import * as THREE from 'three';
import { createViewer, type Viewer } from './viewer';
import { perf } from './perf';
import {
  createSpeechBubble,
  type SpeechBubble,
  type SpeechBubbleAvoidRect,
} from './speechBubble';
import type { PetProfile, PetState, PowerProfile, WardrobeItem } from '../preload/index';

const DEFAULT_STATE: PetState = { x: 0, y: 0, z: 0, rotY: 0, camZ: 5 };

interface PetRuntime {
  profile: PetProfile;
  viewer: Viewer;
  state: PetState;
  anchorH: number;
  baseBox: THREE.Box3;
  baseBoxReady: boolean;
  bubble: SpeechBubble;
  wardrobeStates: Record<string, boolean>;
}

const runtimes = new Map<string, PetRuntime>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const transformedBox = new THREE.Box3();
const bubbleAnchor = new THREE.Vector3();
const projectedCorner = new THREE.Vector3();
const dragDirection = new THREE.Vector3();

let interactive = false;
let visiblePetId: string | null = null;
let bubbleHideTimer: ReturnType<typeof setTimeout> | null = null;
let interactionRuntime: PetRuntime | null = null;
let dragging = false;
let rotating = false;
let grab = { x: 0, y: 0 };
let downAt = { x: 0, y: 0 };
let rotationStart = 0;
let lastPointerAt = 0;

function setInteractive(value: boolean): void {
  if (value === interactive) return;
  interactive = value;
  window.pet.setInteractive(value);
}

function applyState(runtime: PetRuntime): void {
  const { viewer, state } = runtime;
  viewer.wake();
  state.z = Math.min(state.z, state.camZ - 1);
  viewer.root.position.set(state.x, state.y, state.z);
  viewer.root.rotation.y = state.rotY;
  viewer.root.updateMatrixWorld(true);
  viewer.camera.position.z = state.camZ;
  viewer.camera.updateMatrixWorld(true);
  positionSpeechBubble(runtime);
}

function projectedPetBounds(runtime: PetRuntime): SpeechBubbleAvoidRect {
  perf.bubblePositions++;
  const { baseBox, viewer } = runtime;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let boneCount = 0;

  const includeProjectedPoint = (): void => {
    projectedCorner.project(viewer.camera);
    const screenX = (projectedCorner.x * 0.5 + 0.5) * innerWidth;
    const screenY = (-projectedCorner.y * 0.5 + 0.5) * innerHeight;
    left = Math.min(left, screenX);
    right = Math.max(right, screenX);
    top = Math.min(top, screenY);
    bottom = Math.max(bottom, screenY);
  };

  // 載入時量到的 baseBox 常是 T-pose，側邊會被水平手臂撐得過寬。
  // 泡泡顯示時改讀目前姿勢的骨骼位置，才會貼近畫面上真正看到的角色。
  const vrm = viewer.currentVrm();
  if (vrm) {
    vrm.scene.updateWorldMatrix(true, true);
    vrm.scene.traverse((object) => {
      if (!(object as THREE.Bone).isBone) return;
      object.getWorldPosition(projectedCorner);
      includeProjectedPoint();
      boneCount++;
    });
  }

  // 非標準模型沒有骨骼時仍以載入包圍盒保底。
  if (!boneCount) {
    for (const x of [baseBox.min.x, baseBox.max.x]) {
      for (const y of [baseBox.min.y, baseBox.max.y]) {
        for (const z of [baseBox.min.z, baseBox.max.z]) {
          projectedCorner.set(x, y, z).applyMatrix4(viewer.root.matrixWorld);
          includeProjectedPoint();
        }
      }
    }
  }

  // 骨骼不包含衣服厚度與髮絲末端，依角色顯示高度補一圈小幅安全距離。
  const height = Math.max(0, bottom - top);
  const horizontalPadding = Math.min(24, Math.max(14, height * 0.04));
  const verticalPadding = Math.min(18, Math.max(10, height * 0.025));
  return {
    left: left - horizontalPadding,
    right: right + horizontalPadding,
    top: top - verticalPadding,
    bottom: bottom + verticalPadding,
  };
}

function positionSpeechBubble(runtime: PetRuntime, show = false): void {
  if (!runtime.baseBoxReady || (!show && !runtime.bubble.isVisible())) return;
  const { baseBox, viewer } = runtime;
  bubbleAnchor
    .set(
      (baseBox.min.x + baseBox.max.x) / 2,
      baseBox.max.y + 0.08,
      (baseBox.min.z + baseBox.max.z) / 2
    )
    .applyMatrix4(viewer.root.matrixWorld)
    .project(viewer.camera);
  runtime.bubble.showAt(
    (bubbleAnchor.x * 0.5 + 0.5) * innerWidth,
    (-bubbleAnchor.y * 0.5 + 0.5) * innerHeight,
    projectedPetBounds(runtime),
  );
}

function measureRuntime(runtime: PetRuntime): void {
  const vrm = runtime.viewer.currentVrm();
  if (!vrm) return;
  runtime.viewer.root.updateWorldMatrix(true, true);
  const inverseRoot = new THREE.Matrix4().copy(runtime.viewer.root.matrixWorld).invert();
  const point = new THREE.Vector3();
  runtime.baseBox.makeEmpty();
  vrm.scene.traverse((object) => {
    if ((object as THREE.Bone).isBone) runtime.baseBox.expandByPoint(object.getWorldPosition(point));
  });
  if (runtime.baseBox.isEmpty()) {
    runtime.baseBox.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  }
  runtime.baseBox.applyMatrix4(inverseRoot).expandByScalar(0.2);
  runtime.anchorH = (runtime.baseBox.max.y + runtime.baseBox.min.y) / 2;
  runtime.baseBoxReady = true;
}

function hitSelfTest(runtime: PetRuntime): void {
  setTimeout(() => {
    if (!runtimes.has(runtime.profile.id) || !runtime.baseBoxReady) return;
    const center = new THREE.Vector3(
      runtime.viewer.root.position.x,
      runtime.viewer.root.position.y + runtime.anchorH,
      runtime.viewer.root.position.z
    ).project(runtime.viewer.camera);
    const x = (center.x * 0.5 + 0.5) * innerWidth;
    const y = (-center.y * 0.5 + 0.5) * innerHeight;
    ndc.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, runtime.viewer.camera);
    transformedBox.copy(runtime.baseBox).applyMatrix4(runtime.viewer.root.matrixWorld);
    const boxPass = raycaster.ray.intersectsBox(transformedBox);
    const alpha = runtime.viewer.alphaMax([
      [x, y], [x - 30, y], [x + 30, y], [x, y - 30], [x, y + 30]
    ]);
    console.log(
      `[hit] ${runtime.profile.name} (${runtime.profile.id.slice(0, 8)}) box=${boxPass} alpha=${alpha} → ` +
      `${boxPass && alpha > 16 ? 'OK' : '有問題'}`
    );
  }, 600);
}

function eachMaterial(
  runtime: PetRuntime,
  callback: (material: THREE.Material, baseName: string) => void
): void {
  const vrm = runtime.viewer.currentVrm();
  if (!vrm) return;
  vrm.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material.name) callback(material, material.name.replace(/ \(Outline\)$/i, ''));
    }
  });
}

function isWardrobeMaterial(name: string): boolean {
  return !/skin|face|eye|mouth|brow|lash/i.test(name);
}

function collectWardrobe(runtime: PetRuntime): void {
  const seen = new Map<string, string>();
  eachMaterial(runtime, (_material, base) => {
    if (!isWardrobeMaterial(base) || seen.has(base)) return;
    const label = base
      .replace(/^[FN]\d+_\d+_?\d*_/i, '')
      .replace(/_(CLOTH|HAIR)(_\d+)?( \(Instance\))?$/i, '');
    seen.set(base, label || base);
  });
  const items: WardrobeItem[] = [...seen].map(([key, label]) => ({ key, label }));
  const totals = new Map<string, number>();
  const positions = new Map<string, number>();
  items.forEach((item) => totals.set(item.label, (totals.get(item.label) ?? 0) + 1));
  items.forEach((item) => {
    if ((totals.get(item.label) ?? 0) <= 1) return;
    const number = (positions.get(item.label) ?? 0) + 1;
    positions.set(item.label, number);
    item.label = `${item.label} #${number}`;
  });
  window.pet.sendWardrobeList(runtime.profile.id, items);
  console.log(`[wardrobe] ${runtime.profile.name}: ${items.length} items`);
}

function applyWardrobe(runtime: PetRuntime): void {
  eachMaterial(runtime, (material, base) => {
    if (isWardrobeMaterial(base)) material.visible = runtime.wardrobeStates[base] !== false;
  });
  runtime.viewer.wake();
}

function sendAvatarIcons(runtime: PetRuntime): void {
  requestAnimationFrame(() => {
    if (!runtimes.has(runtime.profile.id)) return;
    try {
      window.pet.sendAvatarIcons(runtime.profile.id, {
        front: runtime.viewer.snapshot(false),
        side: runtime.viewer.snapshot(true)
      });
    } catch (error) {
      console.log('[overlay] snapshot failed', error);
    }
  });
}

function playDefaultPose(runtime: PetRuntime): void {
  window.pet.getDefaultPose(runtime.profile.id).then((buffer) => {
    if (buffer && runtimes.has(runtime.profile.id)) {
      runtime.viewer.playVRMA(buffer).catch((error) =>
        console.log('[overlay] default pose failed', error)
      );
    }
  });
}

function afterModelLoad(runtime: PetRuntime): void {
  if (!runtimes.has(runtime.profile.id)) return;
  measureRuntime(runtime);
  applyState(runtime);
  runtime.viewer.enableRootMotionSway();
  collectWardrobe(runtime);
  applyWardrobe(runtime);
  sendAvatarIcons(runtime);
  playDefaultPose(runtime);
  hitSelfTest(runtime);
}

async function loadInitialModel(runtime: PetRuntime): Promise<void> {
  try {
    const boot = await window.pet.getBootVrm(runtime.profile.id);
    if (!runtimes.has(runtime.profile.id)) return;
    if (boot) await runtime.viewer.loadFromBuffer(boot);
    else await runtime.viewer.loadFromUrl('/AvatarSample_A.vrm');
    afterModelLoad(runtime);
  } catch (error) {
    console.log(`[overlay] ${runtime.profile.name} boot load failed, falling back`, error);
    if (!runtimes.has(runtime.profile.id)) return;
    try {
      await runtime.viewer.loadFromUrl('/AvatarSample_A.vrm');
      afterModelLoad(runtime);
    } catch (fallbackError) {
      console.log('[overlay] default load failed', fallbackError);
    }
  }
}

/** 泡泡徽章文字:AI 家別 + 模型 + 力度(未設就標預設)。 */
function agentInfoText(profile: PetProfile): string {
  const kind = profile.agent?.kind === 'claude' ? 'Claude' : 'Codex';
  const model = profile.agent?.model ?? '預設模型';
  const effort = profile.agent?.effort ? ` · ${profile.agent.effort}` : '';
  return `${kind} · ${model}${effort}`;
}

function addRuntime(profile: PetProfile): void {
  if (runtimes.has(profile.id) || !profile.enabled) return;
  const viewer = createViewer({ transparent: true });
  if (powerProfile) viewer.setPowerProfile(powerProfile); // 晚加入的寵物補套當前檔位
  viewer.renderer.domElement.dataset['petId'] = profile.id;
  const runtime: PetRuntime = {
    profile,
    viewer,
    state: { ...DEFAULT_STATE, ...(profile.state ?? {}) },
    anchorH: 0.8,
    baseBox: new THREE.Box3(),
    baseBoxReady: false,
    wardrobeStates: { ...(profile.wardrobe ?? {}) },
    bubble: createSpeechBubble({
      petId: profile.id,
      petName: profile.name,
      requestInputFocus: () => window.pet.setInputMode(true),
      releaseInputFocus: () => { void window.pet.setInputMode(false); },
      onSend: (text) => {
        const current = runtimes.get(profile.id);
        if (!current) return;
        // workspacePath 就地提示(main 端仍二次把關)
        if (!current.profile.workspacePath) {
          current.bubble.endTurn(false, '請先在「工作設定」選擇工作目錄');
          return;
        }
        current.bubble.beginTurn();
        current.bubble.setStatus('連線中…');
        window.pet.chatSend(profile.id, text);
      },
      onCancel: () => window.pet.chatCancel(profile.id),
      onApproval: (requestId, allow) => window.pet.chatApproval(profile.id, requestId, allow),
      onOpenLink: (url) => window.pet.openExternal(url),
      onNewSession: () => window.pet.newSession(profile.id)
    })
  };
  runtimes.set(profile.id, runtime);
  refreshOrderedRuntimes();
  runtime.bubble.setAgentInfo(agentInfoText(profile));
  viewer.setLighting(profile.lighting ?? {});
  viewer.setSway(profile.sway ?? {});
  applyState(runtime);
  void loadInitialModel(runtime);
}

function removeRuntime(petId: string): void {
  const runtime = runtimes.get(petId);
  if (!runtime) return;
  // 休息前保存最後位置；接著才停止動畫與釋放 GPU/DOM 資源。
  window.pet.saveState(petId, { ...runtime.state });
  if (visiblePetId === petId) {
    visiblePetId = null;
    runtime.bubble.hide();
  }
  if (interactionRuntime === runtime) clearDragFlags();
  const timer = saveTimers.get(petId);
  if (timer) clearTimeout(timer);
  saveTimers.delete(petId);
  runtime.bubble.destroy();
  runtime.viewer.dispose();
  runtimes.delete(petId);
  refreshOrderedRuntimes();
}

function reconcileProfiles(profiles: PetProfile[]): void {
  const nextIds = new Set(profiles.filter((profile) => profile.enabled).map((profile) => profile.id));
  for (const id of runtimes.keys()) {
    if (!nextIds.has(id)) removeRuntime(id);
  }
  for (const profile of profiles) {
    const runtime = runtimes.get(profile.id);
    if (!profile.enabled) continue;
    if (!runtime) addRuntime(profile);
    else {
      runtime.profile = profile;
      runtime.bubble.setPetName(profile.name);
      runtime.bubble.setAgentInfo(agentInfoText(profile)); // 設定面板換模型/力度即時反映
    }
  }
}

window.pet.onPetProfiles((profiles) => reconcileProfiles(profiles));
window.pet.getPetCollection().then(({ pets }) => reconcileProfiles(pets));

/** 目前功率檔位(main 的 powerMonitor 推播);晚建立的 runtime 由 addRuntime 補套。 */
let powerProfile: PowerProfile | null = null;
window.pet.onPowerProfile((profile) => {
  powerProfile = profile;
  for (const runtime of runtimes.values()) runtime.viewer.setPowerProfile(profile);
  if (profile.paused) {
    // 鎖屏/睡眠:輪詢已停,拖曳看門狗不會再被 onCursor 觸發——旗標必須在這裡主動清,
    // 否則解鎖後 overlay 以為還在拖曳、持續吃掉桌面點擊
    clearDragFlags();
    setInteractive(false);
  }
});

window.pet.onVrm(async (petId, buffer) => {
  const runtime = runtimes.get(petId);
  if (!runtime) return;
  try {
    await runtime.viewer.loadFromBuffer(buffer);
    afterModelLoad(runtime);
  } catch (error) {
    console.log('[overlay] vrm swap failed', error);
  }
});
window.pet.onVRMA((petId, buffer) => {
  runtimes.get(petId)?.viewer.playVRMA(buffer).catch((error) =>
    console.log('[overlay] vrma failed', error)
  );
});
window.pet.onVRMAStop((petId) => runtimes.get(petId)?.viewer.stopVRMA());
window.pet.onExpression((petId, name) => runtimes.get(petId)?.viewer.setExpression(name));
window.pet.onState((petId, state) => {
  const runtime = runtimes.get(petId);
  if (!runtime) return;
  runtime.state = { ...DEFAULT_STATE, ...state };
  applyState(runtime);
});
window.pet.onLighting((petId, lighting) => runtimes.get(petId)?.viewer.setLighting(lighting));
window.pet.onSway((petId, sway) => runtimes.get(petId)?.viewer.setSway(sway));
window.pet.onWardrobe((petId, states) => {
  const runtime = runtimes.get(petId);
  if (!runtime) return;
  runtime.wardrobeStates = states;
  applyWardrobe(runtime);
});
window.pet.onChatEvent((petId, event) => {
  const bubble = runtimes.get(petId)?.bubble;
  if (!bubble) return;
  // AgentEvent → 泡泡方法的對映(泡泡是笨元件,不認識事件型別)
  switch (event.kind) {
    case 'session':
      break; // main 已回存 sessionId,renderer 不需處理
    case 'thinking':
      bubble.setStatus('思考中…');
      break;
    case 'tool':
      bubble.setStatus(`正在執行 ${event.name}`);
      break;
    case 'text':
      bubble.setStatus(null);
      bubble.appendText(event.text);
      break;
    case 'approval':
      bubble.setStatus('等待你的核准…');
      bubble.showApproval(event.requestId, event.description);
      break;
    case 'done':
      bubble.endTurn(event.ok, event.ok ? undefined : '已中斷');
      break;
    case 'error':
      bubble.endTurn(false, event.message);
      break;
  }
});

function scheduleSave(runtime: PetRuntime): void {
  const previous = saveTimers.get(runtime.profile.id);
  if (previous) clearTimeout(previous);
  saveTimers.set(runtime.profile.id, setTimeout(() => {
    saveTimers.delete(runtime.profile.id);
    window.pet.saveState(runtime.profile.id, runtime.state);
  }, 300));
}

/** runtimes 的倒序陣列快取(後加入者優先命中):runtimeAt 是 hover/mousedown/wheel 共同入口,
 *  每次呼叫重建陣列會在游標移動期間持續產生垃圾。變更點只有 add/remove runtime 兩處。 */
let orderedRuntimes: PetRuntime[] = [];
function refreshOrderedRuntimes(): void {
  orderedRuntimes = [...runtimes.values()].reverse();
}

function runtimeAt(x: number, y: number): PetRuntime | null {
  for (const runtime of orderedRuntimes) {
    if (!runtime.baseBoxReady) continue;
    ndc.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, runtime.viewer.camera);
    transformedBox.copy(runtime.baseBox).applyMatrix4(runtime.viewer.root.matrixWorld);
    if (!raycaster.ray.intersectsBox(transformedBox)) {
      runtime.viewer.setHitProbe(-1, -1);
      continue;
    }
    runtime.viewer.setHitProbe(x, y);
    if (runtime.viewer.isHit()) return runtime;
  }
  return null;
}

/** 游標壓在「任一」可見泡泡上的那隻寵物(不只 visiblePetId——多寵物下審批中的泡泡也要可互動)。 */
function bubbleAt(x: number, y: number): PetRuntime | null {
  for (const runtime of runtimes.values()) {
    if (runtime.bubble.containsPoint(x, y)) return runtime;
  }
  return null;
}

function cancelBubbleHide(): void {
  if (!bubbleHideTimer) return;
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = null;
}

function hideVisibleBubble(): void {
  cancelBubbleHide();
  if (visiblePetId) runtimes.get(visiblePetId)?.bubble.hide();
  visiblePetId = null;
}

function scheduleBubbleHide(): void {
  if (bubbleHideTimer) return;
  bubbleHideTimer = setTimeout(() => {
    bubbleHideTimer = null;
    // 160ms 間可能剛開始 turn:busy 中泡泡不藏(對話進行中),只釋放互動
    if (visiblePetId && runtimes.get(visiblePetId)?.bubble.isBusy()) {
      setInteractive(false);
      return;
    }
    hideVisibleBubble();
    setInteractive(false);
  }, 160);
}

let lastBubblePosAt = 0;

function updateHover(x: number, y: number): void {
  const hit = runtimeAt(x, y);
  const visible = visiblePetId ? runtimes.get(visiblePetId) : null;
  const bubbleHit = bubbleAt(x, y);
  if (hit) {
    cancelBubbleHide();
    // busy 中的泡泡不因切換到別隻而藏(其 turn 仍進行);只在非 busy 時換泡泡
    if (visible && visible !== hit && !visible.bubble.isBusy()) visible.bubble.hide();
    visiblePetId = hit.profile.id;
    // 定位含整棵骨骼投影(projectedPetBounds),hover 期間 100ms 節流;首次顯示不等
    const now = performance.now();
    if (!hit.bubble.isVisible() || now - lastBubblePosAt > 100) {
      lastBubblePosAt = now;
      positionSpeechBubble(hit, true);
    }
    setInteractive(true);
  } else if (bubbleHit) {
    // 游標在任一可見泡泡上(含審批中的幽靈泡泡)→ 恢復互動;認領回 visiblePetId 讓離開時的收合正常
    cancelBubbleHide();
    visiblePetId = bubbleHit.profile.id;
    setInteractive(true);
  } else if (visible) {
    if (visible.bubble.isBusy()) {
      // running 中移開游標:泡泡留著看進度,但 overlay 轉穿透讓底下視窗可點;
      // 游標回到泡泡上時 containsPoint 分支恢復互動,可按「停止」。
      cancelBubbleHide();
      setInteractive(false);
    } else {
      scheduleBubbleHide();
      setInteractive(true);
    }
  } else {
    setInteractive(false);
  }
}

/** screenToWorld 共用回傳物件:拖曳中每個 mousemove 呼叫一次,呼叫端都立即消費,不必每次配置。 */
const worldPoint = { x: 0, y: 0 };
function screenToWorld(runtime: PetRuntime, x: number, y: number): { x: number; y: number } {
  dragDirection.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1), 0.5)
    .unproject(runtime.viewer.camera)
    .sub(runtime.viewer.camera.position);
  const scale = (runtime.state.z - runtime.viewer.camera.position.z) / dragDirection.z;
  worldPoint.x = runtime.viewer.camera.position.x + dragDirection.x * scale;
  worldPoint.y = runtime.viewer.camera.position.y + dragDirection.y * scale;
  return worldPoint;
}

function clearDragFlags(): void {
  dragging = false;
  rotating = false;
  interactionRuntime = null;
}

addEventListener('blur', clearDragFlags);
document.addEventListener('visibilitychange', clearDragFlags);

window.pet.onCursor(({ x, y }) => {
  if (dragging || rotating) {
    if (performance.now() - lastPointerAt > 1200) {
      const runtime = interactionRuntime;
      clearDragFlags();
      if (runtime) scheduleSave(runtime);
    } else {
      return;
    }
  }
  // DOM mousemove 流存活(interactive 時可達 60-120Hz)剛做過同一件事:輪詢路徑整段跳過
  if (interactive && performance.now() - lastPointerAt < 100) return;
  for (const runtime of runtimes.values()) runtime.viewer.setLookAt(x, y);
  updateHover(x, y);
});

addEventListener('mousedown', (event) => {
  lastPointerAt = performance.now();
  const visible = visiblePetId ? runtimes.get(visiblePetId) : null;
  if (bubbleAt(event.clientX, event.clientY)) {
    cancelBubbleHide();
    return;
  }
  const runtime = runtimeAt(event.clientX, event.clientY);
  if (!runtime) return;
  hideVisibleBubble();
  interactionRuntime = runtime;
  runtime.viewer.wake();
  if (event.button === 0) {
    dragging = true;
    const world = screenToWorld(runtime, event.clientX, event.clientY);
    grab = { x: world.x - runtime.state.x, y: world.y - runtime.state.y };
  } else if (event.button === 2) {
    rotating = true;
    downAt = { x: event.clientX, y: event.clientY };
    rotationStart = runtime.state.rotY;
  }
});

addEventListener('mousemove', (event) => {
  lastPointerAt = performance.now();
  for (const runtime of runtimes.values()) runtime.viewer.setLookAt(event.clientX, event.clientY);
  if (dragging && interactionRuntime) {
    const world = screenToWorld(interactionRuntime, event.clientX, event.clientY);
    interactionRuntime.state.x = world.x - grab.x;
    interactionRuntime.state.y = world.y - grab.y;
    applyState(interactionRuntime);
  } else if (rotating && interactionRuntime) {
    interactionRuntime.state.rotY = rotationStart + (event.clientX - downAt.x) * 0.02;
    applyState(interactionRuntime);
  } else {
    updateHover(event.clientX, event.clientY);
  }
});

addEventListener('mouseup', (event) => {
  lastPointerAt = performance.now();
  const runtime = interactionRuntime;
  if (event.button === 0 && dragging) {
    dragging = false;
    if (runtime) scheduleSave(runtime);
  } else if (event.button === 2 && rotating) {
    rotating = false;
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4;
    if (runtime) {
      if (moved) scheduleSave(runtime);
      else window.pet.showMenu(runtime.profile.id);
    }
  }
  interactionRuntime = null;
  updateHover(event.clientX, event.clientY);
});

addEventListener('contextmenu', (event) => event.preventDefault());

addEventListener('wheel', (event) => {
  lastPointerAt = performance.now();
  const visible = visiblePetId ? runtimes.get(visiblePetId) : null;
  if ((event.target as HTMLElement | null)?.closest?.('.pet-speech-bubble')) return;
  const runtime = runtimeAt(event.clientX, event.clientY);
  if (!runtime) return;
  runtime.viewer.wake();
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    runtime.state.rotY -= event.deltaX * 0.005;
    applyState(runtime);
    scheduleSave(runtime);
    return;
  }
  const minimum = runtime.state.z + 1.2;
  const cameraZ = Math.min(12, Math.max(minimum, runtime.state.camZ + event.deltaY * 0.005));
  const ratio = (cameraZ - runtime.state.z) / (runtime.state.camZ - runtime.state.z);
  if (ratio === 1) return;
  const anchorY = runtime.state.y + runtime.anchorH;
  runtime.state.x *= ratio;
  runtime.state.y = 1 + (anchorY - 1) * ratio - runtime.anchorH;
  runtime.state.camZ = cameraZ;
  applyState(runtime);
  scheduleSave(runtime);
});

addEventListener('dragover', (event) => event.preventDefault());
addEventListener('drop', async (event) => {
  event.preventDefault();
  const runtime = runtimeAt(event.clientX, event.clientY);
  const file = event.dataTransfer?.files?.[0];
  if (!runtime || !file) return;
  try {
    if (file.name.toLowerCase().endsWith('.vrma')) {
      await runtime.viewer.playVRMA(await file.arrayBuffer());
    } else if (file.name.toLowerCase().endsWith('.vrm')) {
      await runtime.viewer.loadFromBuffer(await file.arrayBuffer());
      afterModelLoad(runtime);
    }
  } catch (error) {
    console.log('[overlay] dropped file failed', error);
  }
});
