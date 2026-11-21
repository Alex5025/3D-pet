import * as THREE from 'three';
import { createViewer } from './viewer';
import { bookCenter, createHouseScene, readingSeat } from './petHouseScene';

async function start(): Promise<void> {
  const model = await window.pet.getHouseModel();
  if (!model) { window.pet.houseSceneReady(false); return; }
  const viewer = createViewer({ transparent: true, antialias: true });
  viewer.scene.add(createHouseScene());
  viewer.camera.fov = 32;
  viewer.camera.position.set(4.55, 4.1, 5.55);
  viewer.camera.lookAt(0, 0.88, 0);
  viewer.camera.updateProjectionMatrix();
  viewer.setLighting({ temperature: 4400, x: 2, y: 4, z: 3, ambient: 1.9, directional: 1.8 });
  viewer.setPowerProfile({ paused: false, idleSkip: 8, idleDelayMs: 200, activeSkip: 3 });

  const vrm = await viewer.loadFromBuffer(model);
  const bone = (name: Parameters<typeof vrm.humanoid.getNormalizedBoneNode>[0]) => vrm.humanoid.getNormalizedBoneNode(name);
  const hips = bone('hips');
  const stature = Math.max(0.5, new THREE.Box3().setFromObject(vrm.scene).getSize(new THREE.Vector3()).y);
  const scale = 1.36 / stature;
  viewer.root.scale.setScalar(scale);
  const hipY = hips?.getWorldPosition(new THREE.Vector3()).y ?? 0.53;
  viewer.root.position.copy(readingSeat);
  viewer.root.position.y -= hipY;
  // VRM 0 的轉向校正在模型根節點，骨骼區域的 X、Z 旋轉方向也須反轉。
  const axis = vrm.meta.metaVersion === '0' ? -1 : 1;
  const bend = (name: Parameters<typeof bone>[0], x: number, z = 0) => {
    const node = bone(name);
    if (node) node.rotation.set(axis * x, 0, axis * z);
  };
  bend('leftUpperLeg', -1.35);
  bend('rightUpperLeg', -1.35);
  bend('leftLowerLeg', 1.39);
  bend('rightLowerLeg', 1.39);
  bend('leftUpperArm', -0.15, -1.16);
  bend('rightUpperArm', -0.15, 1.16);
  for (const side of ['left', 'right'] as const) {
    const elbow = bone(`${side}LowerArm`);
    const hand = bone(`${side}Hand`);
    if (!elbow || !hand || !elbow.parent) continue;
    const target = bookCenter.clone();
    target.x += side === 'left' ? 0.12 : -0.12;
    const direction = elbow.parent.worldToLocal(target).sub(elbow.position).normalize();
    elbow.quaternion.setFromUnitVectors(hand.position.clone().normalize(), direction);
  }
  bend('head', 0.24);
  vrm.update(0);
  viewer.renderer.render(viewer.scene, viewer.camera);
  window.pet.houseSceneReady(true);
}
void start().catch((error: unknown) => {
  console.error('[pet-house]', error);
  window.pet.houseSceneReady(false);
});
