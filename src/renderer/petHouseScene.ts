import * as THREE from 'three';

const materialCache = new Map<number, THREE.MeshStandardMaterial>();
function paint(color: number): THREE.MeshStandardMaterial {
  let material = materialCache.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    materialCache.set(color, material);
  }
  return material;
}
function block(group: THREE.Group, x: number, y: number, z: number, w: number, h: number, d: number, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), paint(color));
  mesh.position.set(x, y, z);
  group.add(mesh);
  return mesh;
}

export const readingSeat = new THREE.Vector3(-0.54, 0.44, -0.44);

export const bookCenter = new THREE.Vector3(-0.54, 0.56, -0.13);

export function createHouseScene(): THREE.Group {
  const room = new THREE.Group();
  const wood = 0xa66340, lightWood = 0xcb8d59, pink = 0xf3aebb, blue = 0x9095cd;
  block(room, 0, -0.10, 0, 3.30, 0.20, 2.90, 0x9cadd0);
  block(room, 0, 0.015, 0, 3.25, 0.035, 2.85, 0xf7ded1);
  block(room, 0, 1.13, -1.38, 3.3, 2.26, 0.10, pink);
  block(room, -1.6, 1.13, 0, 0.10, 2.26, 2.85, 0xeaa0b8);
  block(room, 0, 2.27, -1.38, 3.35, 0.05, 0.13, 0xffecd9);
  block(room, -1.6, 2.27, 0, 0.13, 0.05, 2.9, 0xffecd9);
  block(room, 0.30, 0.05, 0.72, 1.65, 0.02, 1.13, 0xe9a2ac);
  block(room, 0.30, 0.064, 0.72, 1.44, 0.012, 0.94, 0xf6bdba);

  // 沙發沿後牆，角色面向開口，膝上放一本攤開的書。
  block(room, -0.56, 0.30, -0.56, 1.22, 0.20, 0.54, blue);
  block(room, -0.56, 0.58, -0.81, 1.22, 0.48, 0.14, 0x7f86bb);
  for (const x of [-1.14, 0.02]) block(room, x, 0.48, -0.55, 0.11, 0.29, 0.55, 0x818dc5);
  const pillow = block(room, -0.94, 0.53, -0.67, 0.28, 0.27, 0.12, 0x8bd2d9);
  pillow.rotation.z = -0.22;
  block(room, -0.58, 0.22, 0.38, 0.92, 0.09, 0.45, lightWood);
  for (const x of [-0.94, -0.22]) block(room, x, 0.12, 0.38, 0.06, 0.21, 0.32, wood);

  // 窗、書桌、書架與燈皆以低面數幾何建模，不封裝參考圖片。
  block(room, 0.90, 1.51, -1.31, 0.87, 0.62, 0.05, lightWood);
  block(room, 0.90, 1.51, -1.273, 0.75, 0.49, 0.024, 0x87a6c9);
  block(room, 0.90, 1.51, -1.253, 0.76, 0.038, 0.02, 0xf7ccb1);
  block(room, 0.93, 0.59, -0.98, 1.08, 0.10, 0.51, lightWood);
  for (const x of [0.47, 1.39]) block(room, x, 0.29, -0.98, 0.09, 0.59, 0.44, wood);
  block(room, 0.96, 0.66, -0.94, 0.35, 0.025, 0.24, 0xece5f4);
  block(room, 0.96, 0.77, -1.07, 0.35, 0.22, 0.035, 0x90c1d1);
  for (const x of [-1.37, -0.86]) block(room, x, 0.92, -1.10, 0.06, 1.84, 0.39, wood);
  for (const y of [0.15, 0.57, 0.99, 1.41, 1.81]) {
    block(room, -1.115, y, -1.1, 0.56, 0.055, 0.39, lightWood);
    if (y < 1.8) for (let i = 0; i < 5; i++) {
      const h = 0.15 + 0.02 * (i % 4);
      block(room, -1.28 + 0.075 * i, y + h / 2 + 0.029, -1.08, 0.054, h, 0.16,
        [0x955a61, 0xdeac80, 0x7e93b4, 0xf0d3a5, 0x9879ab][i]);
    }
  }
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.20, 0.17, 14),
    new THREE.MeshStandardMaterial({ color: 0xffe4aa, emissive: 0xffbe68, emissiveIntensity: 0.7 }));
  lamp.position.set(-1.28, 0.99, 0.10);
  room.add(lamp);
  block(room, -1.28, 0.47, 0.10, 0.035, 0.94, 0.035, wood);
  block(room, -1.28, 0.052, 0.10, 0.22, 0.045, 0.22, lightWood);
  for (const [x, z] of [[1.17, 0.53], [-1.18, 0.99]]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 0.14, 10), paint(0xcc7a6d));
    pot.position.set(x, 0.09, z);
    room.add(pot);
    for (let i = 0; i < 3; i++) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 6), paint(i === 1 ? 0x7caf8e : 0x5f9674));
      leaf.position.set(x + (i - 1) * 0.085, 0.26 + (i % 2) * 0.07, z);
      leaf.scale.set(0.65, 1, 0.65);
      leaf.rotation.z = (i - 1) * -0.42;
      room.add(leaf);
    }
  }

  const { x, y, z } = bookCenter;
  const book = block(room, x, y, z, 0.29, 0.044, 0.21, 0xa24d6f);
  book.rotation.x = 0.17;
  block(room, x - 0.06, y + 0.024, z + 0.005, 0.12, 0.024, 0.19, 0xffe8d0).rotation.x = 0.17;
  block(room, x + 0.06, y + 0.024, z + 0.005, 0.12, 0.024, 0.19, 0xf9dcbf).rotation.x = 0.17;
  return room;
}
