// 豪華升級:VRM0(MMD 轉制)補表情映射 + spring bone 物理
// 用法: node vrm-enrich.mjs <輸入.glb/.vrm> <輸出.vrm>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
const buf = readFileSync(src);
if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('不是 GLB');
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const binChunk = buf.subarray(20 + jsonLen); // 含 BIN chunk header,原樣保留

const vrm = json.extensions.VRM;
const nodes = json.nodes;
const targetNames = json.meshes[0].primitives[0].extras.targetNames;
const morph = (name) => {
  const i = targetNames.indexOf(name);
  if (i < 0) throw new Error('缺 morph: ' + name);
  return i;
};
const bind = (name, weight = 100) => ({ mesh: 0, index: morph(name), weight });

// ── 表情:MMD morph → VRM0 blendShapeGroups ──
vrm.blendShapeMaster.blendShapeGroups = [
  { name: 'Neutral', presetName: 'neutral', binds: [], materialValues: [], isBinary: false },
  { name: 'A', presetName: 'a', binds: [bind('あ')], materialValues: [], isBinary: false },
  { name: 'I', presetName: 'i', binds: [bind('い')], materialValues: [], isBinary: false },
  { name: 'U', presetName: 'u', binds: [bind('う')], materialValues: [], isBinary: false },
  { name: 'E', presetName: 'e', binds: [bind('え')], materialValues: [], isBinary: false },
  { name: 'O', presetName: 'o', binds: [bind('お')], materialValues: [], isBinary: false },
  { name: 'Blink', presetName: 'blink', binds: [bind('まばたき')], materialValues: [], isBinary: false },
  { name: 'Blink_L', presetName: 'blink_l', binds: [bind('ウィンク')], materialValues: [], isBinary: false },
  { name: 'Blink_R', presetName: 'blink_r', binds: [bind('ウィンク右')], materialValues: [], isBinary: false },
  // 開心:喜び眼 + にこり眉 + 嘴角上揚
  { name: 'Joy', presetName: 'joy', binds: [bind('喜び'), bind('にこり'), bind('口角上げ')], materialValues: [], isBinary: false },
  // 生氣:怒り目 + 怒り眉 + 嘴角收窄
  { name: 'Angry', presetName: 'angry', binds: [bind('怒り目'), bind('怒り'), bind('口横狭め', 40)], materialValues: [], isBinary: false },
  // 難過:悲しむ眼 + 困る眉
  { name: 'Sorrow', presetName: 'sorrow', binds: [bind('悲しむ'), bind('困る')], materialValues: [], isBinary: false },
  // 放鬆:なごみ(ω眼)+ ω嘴
  { name: 'Fun', presetName: 'fun', binds: [bind('なごみ'), bind('ω', 60)], materialValues: [], isBinary: false },
  // 驚訝(VRM0 無此 preset,走自訂名,three-vrm 以 name 註冊)
  { name: 'surprised', presetName: 'unknown', binds: [bind('びっくり'), bind('瞳小', 60), bind('あ', 35)], materialValues: [], isBinary: false },
];

// ── spring bone:髮/裙/袖/胸 ──
const parent = new Map();
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
const isCollider = (name) => /collider/i.test(name ?? '');
const roots = (re) => nodes
  .map((n, i) => ({ n, i }))
  .filter(({ n, i }) => n.name && re.test(n.name) && !isCollider(n.name) &&
    !(parent.has(i) && re.test(nodes[parent.get(i)].name ?? '') && !isCollider(nodes[parent.get(i)].name ?? '')))
  .map(({ i }) => i);

const humanBones = Object.fromEntries(vrm.humanoid.humanBones.map((b) => [b.bone, b.node]));
// 腿部 collider:沿骨軸(取子節點方向)放三顆球,裙擺才不會穿模
const limbColliders = (nodeIdx) => {
  const child = (nodes[nodeIdx].children ?? []).map((c) => nodes[c]).find((c) => c.translation);
  const t = child?.translation ?? [0, -0.3, 0];
  return [0, 0.35, 0.7].map((k) => ({
    offset: { x: t[0] * k, y: t[1] * k, z: t[2] * k },
    radius: 0.055,
  }));
};
vrm.secondaryAnimation = {
  colliderGroups: [
    { node: humanBones.head, colliders: [
      { offset: { x: 0, y: 0.08, z: 0 }, radius: 0.09 },
      { offset: { x: 0, y: 0.16, z: 0 }, radius: 0.075 },
    ] },
    { node: humanBones.leftUpperLeg, colliders: limbColliders(humanBones.leftUpperLeg) },
    { node: humanBones.rightUpperLeg, colliders: limbColliders(humanBones.rightUpperLeg) },
    { node: humanBones.leftLowerLeg, colliders: limbColliders(humanBones.leftLowerLeg) },
    { node: humanBones.rightLowerLeg, colliders: limbColliders(humanBones.rightLowerLeg) },
  ],
  boneGroups: [
    { comment: '髪', stiffiness: 0.7, gravityPower: 0.06, gravityDir: { x: 0, y: -1, z: 0 },
      dragForce: 0.4, center: -1, hitRadius: 0.015, bones: roots(/髪/), colliderGroups: [0] },
    { comment: 'スカート', stiffiness: 0.35, gravityPower: 0.15, gravityDir: { x: 0, y: -1, z: 0 },
      dragForce: 0.5, center: -1, hitRadius: 0.02, bones: roots(/スカート/), colliderGroups: [1, 2, 3, 4] },
    { comment: '袖', stiffiness: 0.4, gravityPower: 0.12, gravityDir: { x: 0, y: -1, z: 0 },
      dragForce: 0.45, center: -1, hitRadius: 0.02, bones: roots(/袖/), colliderGroups: [] },
    { comment: '胸', stiffiness: 1.6, gravityPower: 0.02, gravityDir: { x: 0, y: -1, z: 0 },
      dragForce: 0.65, center: -1, hitRadius: 0.01, bones: roots(/胸/), colliderGroups: [] },
  ],
};
console.log('骨群:', vrm.secondaryAnimation.boneGroups.map((g) => g.comment + '×' + g.bones.length).join(', '));
console.log('表情組:', vrm.blendShapeMaster.blendShapeGroups.length);

// ── 重組 GLB(JSON chunk 4-byte 對齊,空白填充)──
let jsonOut = Buffer.from(JSON.stringify(json), 'utf8');
if (jsonOut.length % 4) jsonOut = Buffer.concat([jsonOut, Buffer.alloc(4 - (jsonOut.length % 4), 0x20)]);
const header = Buffer.alloc(20);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(20 + jsonOut.length + binChunk.length, 8);
header.writeUInt32LE(jsonOut.length, 12);
header.write('JSON', 16, 'ascii');
writeFileSync(dst, Buffer.concat([header, jsonOut, binChunk]));
console.log('已輸出:', dst, (20 + jsonOut.length + binChunk.length) / 1048576 | 0, 'MB');
