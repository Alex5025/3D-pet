import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { createHouseScene } from './petHouseScene';

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xfff0da, 0xe0bda3, 1.65));
const sun = new THREE.DirectionalLight(0xffecd4, 2);
sun.position.set(-3, 6, 4);
scene.add(sun);
const camera = new THREE.OrthographicCamera();
const loader = new GLTFLoader();
loader.register(parser => new VRMLoaderPlugin(parser));
const residents = new Map<string, Resident>();
let ids: string[] = [];
let house = createHouseScene(0);
scene.add(house.room);

function render() { renderer.render(scene, camera); }
function frame(): void {
  renderer.setSize(innerWidth, innerHeight);
  const bounds = new THREE.Box3().setFromObject(house.room);
  const center = bounds.getCenter(new THREE.Vector3());
  camera.position.copy(center).add(new THREE.Vector3(2, 3.3, 8).normalize().multiplyScalar(bounds.max.distanceTo(bounds.min) + 5));
  camera.lookAt(center);
  camera.updateMatrixWorld();
  const projected = bounds.clone().makeEmpty();
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    projected.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
  }
  const aspect = innerWidth / innerHeight;
  const height = Math.max(projected.max.y - projected.min.y, (projected.max.x - projected.min.x) / aspect) * 0.52;
  camera.top = height; camera.bottom = -height; camera.left = -height * aspect; camera.right = height * aspect;
  camera.far = 3 * bounds.max.distanceTo(bounds.min) + 20;
  camera.updateProjectionMatrix();
  render();
}

async function loadResident(id: string) {
  const asset = await window.pet.getHouseModel(id);
  if (!asset) return;
  const gltf = await loader.parseAsync(asset.bytes, '');
  const vrm: VRM | undefined = gltf.userData.vrm;
  if (!vrm) { VRMUtils.deepDispose(gltf.scene); return; }
  VRMUtils.rotateVRM0(vrm);
  const body = vrm.scene;
  const height = new THREE.Box3().setFromObject(body).getSize(new THREE.Vector3()).y;
  body.scale.multiplyScalar(1.5 / Math.max(height, 0.1));
  body.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (asset.wardrobe[material.name.replace(/ \(Outline\)$/i, '')] === false) material.visible = false;
    }
  });
  const bone = (name: Parameters<typeof vrm.humanoid.getNormalizedBoneNode>[0]) => vrm.humanoid.getNormalizedBoneNode(name);
  const arms = [bone('leftUpperArm'), bone('rightUpperArm')];
  const elbows = [bone('leftLowerArm'), bone('rightLowerArm')];
  const thighs = [bone('leftUpperLeg'), bone('rightUpperLeg')];
  const calves = [bone('leftLowerLeg'), bone('rightLowerLeg')];
  const spine = bone('spine'), head = bone('head');
  body.updateMatrixWorld(true);
  const foot = vrm.humanoid.getRawBoneNode('leftFoot')?.getWorldPosition(new THREE.Vector3());
  if (foot) body.position.y -= foot.y - 0.055;
  const group = new THREE.Group();
  group.add(body);
  const humanoid = vrm.humanoid;
  const phase = Math.random() * Math.PI * 2;
  const axis = vrm.meta.metaVersion === '0' ? -1 : 1;
  function animate(time: number, walking: boolean, activity: typeof house.spots[number]['activity']) {
    const wave = Math.sin(time * (walking ? 6 : 1.35) + phase);
    const reach = activity === 'flowers' || activity === 'read';
    const stretch = !walking && activity === 'stretch';
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const step = walking ? side * wave : 0;
      thighs[i]?.rotation.set(axis * step * 0.40, 0, 0);
      calves[i]?.rotation.set(axis * Math.max(0, -step) * 0.42, 0, 0);
      const lift = stretch ? -0.68 - 0.45 * wave : 1.17;
      arms[i]?.rotation.set(axis * (walking ? -step * 0.30 : reach ? -0.45 : -0.12), 0, -axis * side * lift);
      const elbow = walking ? -0.25 : reach ? -0.72 - side * wave * 0.21 : activity === 'tea' && i === 1 ? -1.1 - 0.5 * wave : -0.18;
      elbows[i]?.rotation.set(axis * elbow, 0, 0);
    }
    if (head) head.rotation.set(axis * (walking ? 0 : reach ? 0.18 : 0.04), 0.08 * wave, 0);
    if (spine) spine.rotation.x = axis * (walking ? 0.04 : activity === 'flowers' ? 0.17 + 0.06 * wave : 0.02 * wave);
    humanoid.update();
  }
  return { group, animate, hand: vrm.humanoid.getRawBoneNode('rightHand'), spot: 0, target: 0, pause: 0 };
}
type Resident = NonNullable<Awaited<ReturnType<typeof loadResident>>>;

function place(resident: Resident, index: number) {
  resident.spot = resident.target = index * 2;
  const spot = house.spots[resident.spot]!;
  resident.group.position.copy(spot.position);
  resident.group.rotation.y = spot.facing;
  resident.pause = 1 + Math.random() * 5;
}

let last = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.15, (now - last) / 1000);
  last = now;
  if (document.hidden || !residents.size) return;
  const busy = new Set<number>();
  for (const r of residents.values()) { busy.add(r.spot); busy.add(r.target); }
  for (const spot of house.spots) {
    if (spot.cup && spot.cupRest) spot.cup.position.copy(spot.cupRest);
    if (spot.page) spot.page.rotation.z = -0.15;
  }
  for (const r of residents.values()) {
    const group = r.group;
    if (r.spot === r.target && (r.pause -= dt) <= 0) {
      const direction = Math.random() < 0.7 ? 1 : -1;
      const options = [direction, -direction].map(d => (r.spot + d + house.spots.length) % house.spots.length);
      const free = options.find(i => !busy.has(i));
      if (free !== undefined) { r.target = free; busy.add(free); }
      else r.pause = 0.8;
    }
    const spot = house.spots[r.target]!;
    const walking = r.spot !== r.target;
    let facing = spot.facing;
    if (walking) {
      const dx = spot.position.x - group.position.x, dz = spot.position.z - group.position.z;
      const distance = Math.hypot(dx, dz), step = dt * 0.49;
      facing = Math.atan2(dx, dz);
      if (distance <= step) {
        group.position.copy(spot.position); r.spot = r.target; r.pause = 4 + Math.random() * 7;
      } else {
        group.position.x += dx * step / distance; group.position.z += dz * step / distance;
      }
    }
    const turn = facing - group.rotation.y;
    group.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * Math.min(1, dt * 6);
    r.animate(now / 1000, walking, spot.activity);
    if (!walking) {
      const beat = (1 + Math.cos(r.pause * 1.8)) / 2;
      if (spot.page) spot.page.rotation.z = -0.15 + beat ** 6 * 1.35;
      if (spot.cup && r.hand) {
        const hand = r.hand.getWorldPosition(new THREE.Vector3());
        spot.cup.position.lerp(hand, Math.min(1, beat * 1.6, r.pause * 2));
      }
    }
  }
  render();
}
window.setInterval(tick, 80);

// 以一條載入佇列限制解碼記憶體；每次完成均重新核對最新名單。
let loading = false;
const failed = new Set<string>();
async function populate(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    for (;;) {
      const id = ids.find(id => !residents.has(id) && !failed.has(id));
      if (!id) break;
      try {
        const resident = await loadResident(id);
        const index = ids.indexOf(id);
        if (!resident) { if (index >= 0) failed.add(id); continue; }
        if (index < 0) { VRMUtils.deepDispose(resident.group); continue; }
        place(resident, index);
        residents.set(id, resident); scene.add(resident.group); render();
      } catch (error) { failed.add(id); console.error('[pet-house]', id, error); }
    }
  } finally { loading = false; }
}
window.pet.onHouseRoster(next => {
  ids = next;
  for (const [id, { group }] of residents) {
    if (ids.includes(id)) continue;
    scene.remove(group); VRMUtils.deepDispose(group); residents.delete(id);
  }
  failed.clear();
  scene.remove(house.room); VRMUtils.deepDispose(house.room);
  house = createHouseScene(ids.length); scene.add(house.room);
  ids.forEach((id, i) => { const resident = residents.get(id); if (resident) place(resident, i); });
  frame(); void populate();
});
window.pet.requestHouseRoster();
window.addEventListener('resize', frame);
frame();
