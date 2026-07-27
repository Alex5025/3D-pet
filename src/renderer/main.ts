import * as THREE from 'three';
import { createViewer, type Viewer } from './viewer';
import {
  createSpeechBubble,
  type SpeechBubble,
  type SpeechBubbleAvoidRect,
} from './speechBubble';
import type { PetProfile, PetState, WardrobeItem } from '../preload/index';

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

function addRuntime(profile: PetProfile): void {
  if (runtimes.has(profile.id) || !profile.enabled) return;
  const viewer = createViewer({ transparent: true });
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
      releaseInputFocus: () => { void window.pet.setInputMode(false); }
    })
  };
  runtimes.set(profile.id, runtime);
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
    }
  }
}

window.pet.onPetProfiles((profiles) => reconcileProfiles(profiles));
window.pet.getPetCollection().then(({ pets }) => reconcileProfiles(pets));

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

function scheduleSave(runtime: PetRuntime): void {
  const previous = saveTimers.get(runtime.profile.id);
  if (previous) clearTimeout(previous);
  saveTimers.set(runtime.profile.id, setTimeout(() => {
    saveTimers.delete(runtime.profile.id);
    window.pet.saveState(runtime.profile.id, runtime.state);
  }, 300));
}

function runtimeAt(x: number, y: number): PetRuntime | null {
  const ordered = [...runtimes.values()].reverse();
  for (const runtime of ordered) {
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
    hideVisibleBubble();
    setInteractive(false);
  }, 160);
}

function updateHover(x: number, y: number): void {
  const hit = runtimeAt(x, y);
  const visible = visiblePetId ? runtimes.get(visiblePetId) : null;
  if (hit) {
    cancelBubbleHide();
    if (visible && visible !== hit) visible.bubble.hide();
    visiblePetId = hit.profile.id;
    positionSpeechBubble(hit, true);
    setInteractive(true);
  } else if (visible?.bubble.containsPoint(x, y)) {
    cancelBubbleHide();
    setInteractive(true);
  } else if (visible) {
    scheduleBubbleHide();
    setInteractive(true);
  } else {
    setInteractive(false);
  }
}

function screenToWorld(runtime: PetRuntime, x: number, y: number): { x: number; y: number } {
  dragDirection.set((x / innerWidth) * 2 - 1, -((y / innerHeight) * 2 - 1), 0.5)
    .unproject(runtime.viewer.camera)
    .sub(runtime.viewer.camera.position);
  const scale = (runtime.state.z - runtime.viewer.camera.position.z) / dragDirection.z;
  return {
    x: runtime.viewer.camera.position.x + dragDirection.x * scale,
    y: runtime.viewer.camera.position.y + dragDirection.y * scale
  };
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
  for (const runtime of runtimes.values()) runtime.viewer.setLookAt(x, y);
  if (interactive && performance.now() - lastPointerAt < 100) return;
  updateHover(x, y);
});

addEventListener('mousedown', (event) => {
  lastPointerAt = performance.now();
  const visible = visiblePetId ? runtimes.get(visiblePetId) : null;
  if (visible?.bubble.containsPoint(event.clientX, event.clientY)) {
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
  if (visible?.bubble.element.contains(event.target as Node)) return;
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
