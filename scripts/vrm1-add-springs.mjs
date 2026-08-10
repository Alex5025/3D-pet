// VRM1 補 spring bone 物理:依骨名 pattern 找鏈,寫入 VRMC_springBone(含頭/腿 collider)
// 用法: node vrm1-add-springs.mjs <輸入.vrm> <輸出.vrm>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
const buf = readFileSync(src);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const binChunk = buf.subarray(20 + jsonLen);
const nodes = json.nodes ?? [];
const parent = new Map();
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));

// 依 pattern 找根,DFS 展開;分叉處拆成多條線性鏈(VRM1 spring 的 joints 必須是單鏈)
const chains = (re) => {
  const rootIdx = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n, i }) => re.test(n.name ?? '') && !re.test(nodes[parent.get(i)]?.name ?? ''))
    .map(({ i }) => i);
  const out = [];
  const walk = (idx, path) => {
    const next = (nodes[idx].children ?? []).filter((c) => re.test(nodes[c].name ?? ''));
    if (!next.length) { out.push([...path, idx]); return; }
    for (const c of next) walk(c, [...path, idx]);
  };
  for (const r of rootIdx) walk(r, []);
  return out.filter((c) => c.length >= 2);
};

const spring = (name, chain, s) => ({
  name,
  joints: chain.map((node) => ({
    node, hitRadius: s.hitRadius, stiffness: s.stiffness,
    gravityPower: s.gravityPower, gravityDir: [0, -1, 0], dragForce: s.dragForce,
  })),
  colliderGroups: s.colliderGroups ?? [],
});

const hb = json.extensions.VRMC_vrm.humanoid.humanBones;
const limbColliders = (nodeIdx) => {
  const child = (nodes[nodeIdx].children ?? []).map((c) => nodes[c]).find((c) => c.translation);
  const t = child?.translation ?? [0, -0.3, 0];
  return [0, 0.35, 0.7].map((k) => ({
    node: nodeIdx,
    shape: { sphere: { offset: [t[0] * k, t[1] * k, t[2] * k], radius: 0.05 } },
  }));
};
const colliders = [
  { node: hb.head.node, shape: { sphere: { offset: [0, 0.08, 0], radius: 0.09 } } },
  ...limbColliders(hb.leftUpperLeg.node), ...limbColliders(hb.rightUpperLeg.node),
  ...limbColliders(hb.leftLowerLeg.node), ...limbColliders(hb.rightLowerLeg.node),
];
const colliderGroups = [
  { name: 'head', colliders: [0] },
  { name: 'legs', colliders: colliders.map((_, i) => i).slice(1) },
];

const GROUPS = [
  { name: 'hair', re: /hair|ponytail/i, p: { stiffness: 1.0, dragForce: 0.4, gravityPower: 0.02, hitRadius: 0.015, colliderGroups: [0] } },
  { name: 'tail', re: /^Tail\b|^Tail\./i, p: { stiffness: 0.8, dragForce: 0.4, gravityPower: 0.02, hitRadius: 0.02, colliderGroups: [1] } },
  { name: 'bust', re: /^Bust\./i, p: { stiffness: 1.5, dragForce: 0.7, gravityPower: 0, hitRadius: 0.01 } },
  { name: 'cloth', re: /^cloth\./i, p: { stiffness: 1.0, dragForce: 0.5, gravityPower: 0.05, hitRadius: 0.02, colliderGroups: [1] } },
];
const springs = [];
for (const g of GROUPS) {
  for (const [k, chain] of chains(g.re).entries()) springs.push(spring(`${g.name}.${k}`, chain, g.p));
}
json.extensions.VRMC_springBone = { specVersion: '1.0', colliders, colliderGroups, springs };
if (!json.extensionsUsed.includes('VRMC_springBone')) json.extensionsUsed.push('VRMC_springBone');
console.log('springs:', springs.length, '| 關節總數:', springs.reduce((n, s) => n + s.joints.length, 0),
  '| 分佈:', GROUPS.map((g) => g.name + '×' + springs.filter((s) => s.name.startsWith(g.name)).length).join(', '));

let jsonOut = Buffer.from(JSON.stringify(json), 'utf8');
if (jsonOut.length % 4) jsonOut = Buffer.concat([jsonOut, Buffer.alloc(4 - (jsonOut.length % 4), 0x20)]);
const header = Buffer.alloc(20);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(20 + jsonOut.length + binChunk.length, 8);
header.writeUInt32LE(jsonOut.length, 12);
header.write('JSON', 16, 'ascii');
writeFileSync(dst, Buffer.concat([header, jsonOut, binChunk]));
console.log('已輸出:', dst);
