import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type HouseActivity = 'flowers' | 'read' | 'tea' | 'stretch';
export interface ActivitySpot {
  position: THREE.Vector3;
  facing: number;
  activity: HouseActivity;
  page?: THREE.Mesh;
  cup?: THREE.Group;
  cupRest?: THREE.Vector3;
}
export function createHouseScene(count: number) {
  const room = new THREE.Group();
  const total = Math.max(6, count * 2);
  const radius = Math.max(1.45, total * 0.21);
  const width = radius * 2 + 1.75, depth = radius * 1.5 + 1.65;
  const columns = Math.max(2, Math.round(width / 1.65));
  const back = -depth / 2 + 0.18;
  const brass = 0xac7843, sage = 0x42665b, cream = 0xffe1ac;
  function mesh(geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number) {
    const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.78 }));
    m.position.set(x, y, z);
    room.add(m);
    return m;
  }
  function slab(x: number, y: number, z: number, w: number, h: number, d: number, color: number) {
    return mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d, 0.16) * 0.48), color, x, y, z);
  }
  function orb(x: number, y: number, z: number, w: number, h: number, d: number, color: number) {
    const m = mesh(new THREE.SphereGeometry(1, 14, 10), color, x, y, z);
    m.scale.set(w, h, d);
    return m;
  }
  function rod(x: number, y: number, z: number, radius: number, height: number, color: number) {
    return mesh(new THREE.CylinderGeometry(radius, radius, height, 16), color, x, y, z);
  }
  slab(0, -0.14, 0, width, 0.25, depth, sage);
  slab(0, -0.045, 0, width + 0.018, 0.032, depth + 0.018, brass);
  slab(0, 0, 0, width - 0.06, 0.09, depth - 0.06, 0xdbb388);
  // 木板接縫與短紋在透明桌布上也能讀出平台厚度。
  for (let z = -depth / 2 + 0.24; z < depth / 2 - 0.08; z += 0.22) {
    slab(0, 0.046, z, width - 0.18, 0.007, 0.012, 0xb88962);
  }
  const spots: ActivitySpot[] = [];
  const activities: HouseActivity[] = ['flowers', 'read', 'stretch', 'tea'];
  for (let i = 0; i < total; i++) {
    const angle = i * 2 * Math.PI / total + 0.3;
    const dx = Math.sin(angle), dz = Math.cos(angle);
    const position = new THREE.Vector3(radius * dx, 0.06, radius * 0.75 * dz);
    const activity = activities[i % activities.length]!;
    const spot: ActivitySpot = { position, facing: angle, activity };
    spots.push(spot);
    const x = position.x + dx * 0.43, z = position.z + dz * 0.43;
    if (activity === 'stretch') continue;
    rod(x, 0.28, z, 0.065, 0.44, brass);
    rod(x, 0.10, z, 0.18, 0.08, sage);
    rod(x, 0.53, z, 0.26, 0.07, 0xb88861);
    if (activity === 'flowers') {
      rod(x, 0.64, z, 0.12, 0.18, 0xc88268);
      for (let k = 0; k < 5; k++) {
        const fx = x + 0.09 * Math.cos(k * 2.4), fz = z + 0.09 * Math.sin(k * 2.4);
        const h = 0.14 + 0.055 * (k % 3);
        rod(fx, 0.72 + h / 2, fz, 0.009, h, sage);
        orb(fx, 0.72 + h, fz, 0.065, 0.043, 0.065, k % 2 ? 0xebac91 : 0xe1bf79);
      }
    } else if (activity === 'read') {
      for (const side of [-1, 1]) {
        const page = slab(x + side * 0.09 * dz, 0.605, z - side * 0.09 * dx, 0.19, 0.035, 0.25, cream);
        if (side === 1) spot.page = page;
        page.rotation.order = 'YXZ'; page.rotation.y = angle; page.rotation.z = -side * 0.15;
      }
    } else {
      rod(x, 0.58, z, 0.115, 0.02, cream);
      const cup = new THREE.Group();
      cup.position.set(x, 0.65, z);
      room.add(cup);
      cup.attach(rod(x, 0.65, z, 0.073, 0.12, 0xeed6b3));
      cup.attach(rod(x, 0.713, z, 0.062, 0.006, 0x83553a));
      spot.cup = cup;
      spot.cupRest = cup.position.clone();
      orb(x + 0.15, 0.65, z + 0.07, 0.09, 0.08, 0.09, sage);
    }
  }
  const wallY = 1.48;
  const span = (width - 0.42) / columns;
  for (let i = 0; i < columns; i++) {
    const x = (i - (columns - 1) / 2) * span, r = span / 2;
    // 拱窗的半透明玻璃讓桌布自然透出。
    const pane = new THREE.Shape();
    pane.moveTo(-r, 0); pane.lineTo(r, 0); pane.lineTo(r, wallY);
    pane.absarc(0, wallY, r, 0, Math.PI, false); pane.closePath();
    const glass = mesh(new THREE.ShapeGeometry(pane), 0x80bbab, x, 0.04, back);
    // 暖色山景彩繪玻璃：按整面窗的座標取樣，讓相鄰拱窗接成同一片風景。
    const canvas = document.createElement('canvas');
    canvas.width = 192; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const sky = ctx.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, '#85a6b4'); sky.addColorStop(0.46, '#f1c9a9'); sky.addColorStop(1, '#f7dbaf');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, 192, 256);
    if (i === columns - 1) {
      ctx.fillStyle = '#fff0bf'; ctx.beginPath(); ctx.arc(80, 83, 25, 0, Math.PI * 2); ctx.fill();
    }
    for (const [layer, shade] of ['#b1b5a9', '#839e95', '#66867d'].entries()) {
      ctx.fillStyle = shade; ctx.beginPath(); ctx.moveTo(0, 256);
      for (let px = 0; px <= 192; px++) {
        const u = (px / 192 + i) * 2.8;
        ctx.lineTo(px, 126 + layer * 29 + 22 * Math.sin(u + layer * 2) + 9 * Math.cos(2.6 * u + layer));
      }
      ctx.lineTo(192, 256); ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const uv = glass.geometry.getAttribute('uv');
    for (let v = 0; v < uv.count; v++) uv.setXY(v, (uv.getX(v) + r) / span, uv.getY(v) / (wallY + r));
    glass.material.map = texture; glass.material.color.setHex(0xffffff);
    glass.material.transparent = true; glass.material.opacity = 0.88; glass.material.depthWrite = false;
    mesh(new THREE.TorusGeometry(r, 0.034, 8, 40, Math.PI), sage, x, wallY, back + 0.02);
    rod(x - r, wallY / 2, back + 0.02, 0.039, wallY, sage);
    rod(x, (wallY + r) / 2, back + 0.025, 0.016, wallY + r, brass);
    slab(x, wallY, back + 0.03, span, 0.045, 0.045, sage);
    const cord = 0.24 + (i % 2) * 0.11;
    rod(x, wallY + r - cord / 2, back + 0.09, 0.012, cord, brass);
    const light = orb(x, wallY + r - cord - 0.09, back + 0.1, 0.095, 0.12, 0.095, cream);
    light.material.emissive.setHex(0xffbb66); light.material.emissiveIntensity = 0.55;
  }
  rod(span * columns / 2, wallY / 2, back + 0.02, 0.039, wallY, sage);
  for (const side of [-1, 1]) {
    const x = side * (width / 2 - 0.24), z = back + 0.44;
    mesh(new THREE.CylinderGeometry(0.19, 0.13, 0.32, 12), 0xb26d52, x, 0.20, z);
    for (let k = 0; k < 7; k++) {
      const angle = k * 2.4;
      const leaf = orb(x + 0.12 * Math.cos(angle), 0.48 + k * 0.052, z + 0.10 * Math.sin(angle),
        0.075, 0.19, 0.08, [0x49775d, 0x779564, 0x96aa74][k % 3]!);
      leaf.rotation.z = -0.6 * Math.cos(angle);
      if (k % 2 === 0) orb(leaf.position.x, leaf.position.y + 0.15, leaf.position.z, 0.065, 0.055, 0.065, 0xe6a68c);
    }
  }
  // 前緣鋪編織地毯，留出角色腿部空間。
  const front = depth / 2 - 0.31;
  slab(0, 0.061, front, width - 0.68, 0.025, 0.42, 0xb97965);
  for (const dz of [-0.14, 0.14]) slab(0, 0.078, front + dz, width - 0.8, 0.012, 0.025, cream);
  return { room, spots };
}
