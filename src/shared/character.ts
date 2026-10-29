import type { Lighting, Sway } from '../preload/index';

/** 可攜角色參數；不包含工作目錄、對話或權限。 */
export interface CharacterParameters {
  name: string;
  persona?: string;
  lighting?: Lighting;
  sway?: Sway;
  wardrobe?: Record<string, boolean>;
  defaultPose?: string;
  idleMotions?: string[];
}
export const CHARACTER_KEYS = ['name', 'persona', 'lighting', 'sway', 'wardrobe', 'defaultPose', 'idleMotions'] as const;
export interface CharacterDocument {
  schemaVersion: 1;
  id: string;
  vrmPath: string;
  modelHash: string;
  parameters: CharacterParameters;
}
export interface CharacterExport {
  schemaVersion: 1;
  modelHash: string;
  parameters: CharacterParameters;
}
export type CharacterFileResult = { ok: boolean; canceled?: boolean; message?: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function numeric(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('角色設定包含無效數值');
  return value;
}
function motion(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\\/\0]/.test(value) || !/\.vrma$/i.test(value)) throw new Error('角色設定包含無效動作檔名');
  return value;
}
/** 白名單重建；匯入與磁碟讀取使用同一驗證，未知欄位不會進入執行設定。 */
export function parseCharacterParameters(value: unknown): CharacterParameters {
  if (!record(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('角色名稱無效');
  const result: CharacterParameters = { name: value.name.trim() };
  if (value.persona !== undefined) {
    if (typeof value.persona !== 'string' || value.persona.length > 4000) throw new Error('角色個性最多 4000 字');
    result.persona = value.persona;
  }
  if (value.lighting !== undefined) {
    const l = value.lighting;
    if (!record(l) || (l.type !== 'directional' && l.type !== 'point')) throw new Error('光源類型無效');
    result.lighting = {
      type: l.type, ambient: numeric(l.ambient, 0, 7), directional: numeric(l.directional, 0, 500),
      x: numeric(l.x, -1000, 1000), y: numeric(l.y, -1000, 1000), z: numeric(l.z, -1000, 1000),
      shade: numeric(l.shade, 0, 1), temperature: l.temperature === undefined ? 6500 : numeric(l.temperature, 1800, 12000),
    };
  }
  if (value.sway !== undefined) {
    const s = value.sway;
    if (!record(s)) throw new Error('晃動設定無效');
    result.sway = { hair: numeric(s.hair, 0, 2), cloth: numeric(s.cloth, 0, 2), chest: numeric(s.chest, 0, 2), tail: numeric(s.tail, 0, 2) };
  }
  if (value.wardrobe !== undefined) {
    if (!record(value.wardrobe) || Object.keys(value.wardrobe).length > 10000) throw new Error('服裝設定無效');
    result.wardrobe = Object.create(null) as Record<string, boolean>;
    for (const [key, visible] of Object.entries(value.wardrobe)) {
      if (typeof visible !== 'boolean' || key.length > 1000) throw new Error('服裝設定無效');
      result.wardrobe[key] = visible;
    }
  }
  if (value.defaultPose !== undefined) result.defaultPose = motion(value.defaultPose);
  if (value.idleMotions !== undefined) {
    if (!Array.isArray(value.idleMotions) || value.idleMotions.length > 50) throw new Error('待機動作設定無效');
    result.idleMotions = [...new Set(value.idleMotions.map(motion))];
  }
  return result;
}
export function parseCharacterExport(value: unknown): CharacterExport {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.modelHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.modelHash)) throw new Error('角色設定版本或模型識別無效');
  return { schemaVersion: 1, modelHash: value.modelHash, parameters: parseCharacterParameters(value.parameters) };
}
