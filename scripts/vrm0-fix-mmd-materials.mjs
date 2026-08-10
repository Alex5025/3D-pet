// MMD 轉制的 VRM0 材質修復:mmd_tools 把貼圖接在 emissiveTexture 上(baseColor 為黑),
// 改接成 baseColorTexture + MToon 材質屬性,渲染才會有顏色與卡通描邊。
import { readFileSync, writeFileSync } from 'node:fs';
const [src, dst] = process.argv.slice(2);
const buf = readFileSync(src);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const bin = buf.subarray(20 + jsonLen);

const vp = json.extensions.VRM.materialProperties;
let fixed = 0;
json.materials.forEach((m, i) => {
  const tex = m.emissiveTexture?.index;
  if (tex === undefined) return;
  m.pbrMetallicRoughness = {
    baseColorFactor: [1, 1, 1, 1],
    baseColorTexture: { index: tex, texCoord: 0 },
    metallicFactor: 0,
    roughnessFactor: 0.9,
  };
  delete m.emissiveTexture;
  delete m.emissiveFactor;
  m.extensions = { ...(m.extensions ?? {}), KHR_materials_unlit: {} };
  m.alphaMode = m.alphaMode ?? 'OPAQUE';
  // VRM0 MToon:主貼圖與陰影貼圖同一張,參數比照可用版本
  vp[i] = {
    name: m.name, shader: 'VRM/MToon', renderQueue: 2450,
    keywordMap: { _ALPHATEST_ON: true, SELFSHADOW_ON: true },
    tagMap: { RenderType: 'Opaque' },
    floatProperties: {
      _BlendMode: 0, _BumpScale: 1, _CullMode: m.doubleSided ? 0 : 2, _Cutoff: 0.5,
      _DebugMode: 0, _DstBlend: 0, _IndirectLightIntensity: 0.1, _LightColorAttenuation: 0,
      _MToonVersion: 0, _OutlineColorMode: 0, _OutlineCullMode: 1, _OutlineLightingMix: 1,
      _OutlineScaledMaxDistance: 1, _OutlineWidth: 0.5, _OutlineWidthMode: 0,
      _ReceiveShadowRate: 1, _RimFresnelPower: 0, _RimLift: 0, _RimLightingMix: 0,
      _ShadeShift: 0, _ShadeToony: 0.9, _ShadingGradeRate: 1, _SrcBlend: 1, _ZWrite: 1,
      _UvAnimRotation: 0, _UvAnimScrollX: 0, _UvAnimScrollY: 0,
    },
    vectorProperties: {
      _Color: [1, 1, 1, 1], _EmissionColor: [0, 0, 0, 1], _OutlineColor: [0, 0, 0, 1],
      _ShadeColor: [1, 1, 1, 1], _MainTex: [0, 0, 1, 1], _ShadeTexture: [0, 0, 1, 1],
      _BumpMap: [0, 0, 1, 1], _EmissionMap: [0, 0, 1, 1], _OutlineWidthTexture: [0, 0, 1, 1],
      _ReceiveShadowTexture: [0, 0, 1, 1], _RimColor: [0, 0, 0, 0], _RimTexture: [0, 0, 1, 1],
      _ShadingGradeTexture: [0, 0, 1, 1], _SphereAdd: [0, 0, 1, 1], _UvAnimMaskTexture: [0, 0, 1, 1],
    },
    textureProperties: { _MainTex: tex, _ShadeTexture: tex },
  };
  fixed++;
});
console.log('修復材質:', fixed, '/', json.materials.length);

let out = Buffer.from(JSON.stringify(json), 'utf8');
if (out.length % 4) out = Buffer.concat([out, Buffer.alloc(4 - (out.length % 4), 0x20)]);
const h = Buffer.alloc(20);
h.write('glTF', 0, 'ascii'); h.writeUInt32LE(2, 4);
h.writeUInt32LE(20 + out.length + bin.length, 8);
h.writeUInt32LE(out.length, 12); h.write('JSON', 16, 'ascii');
writeFileSync(dst, Buffer.concat([h, out, bin]));
console.log('已輸出:', dst);
