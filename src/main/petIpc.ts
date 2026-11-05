import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AgentBinding } from '../shared/agentEvents';

/* 寵物本身的 IPC(清單/新增/刪除/選取/中繼資料)。
 * 從 index.ts 的 whenReady 巨型閉包抽出來;依賴以 deps 傳入。
 * update-pet-meta 的欄位驗證是這裡的重點——來自 renderer 的 patch 一律逐欄白名單,
 * 不整包 Object.assign(避免前端傳什麼就寫進設定檔)。 */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface PetMetaPatch {
  name?: string;
  enabled?: boolean;
  persona?: string;
  idleMotions?: string[];
  agent?: AgentBinding;
}

export interface PetIpcDeps<TProfile extends { name: string; agent?: AgentBinding }> {
  authorized: (event: IpcMainInvokeEvent) => boolean;
  listPets: () => TProfile[];
  selectedPetId: () => string;
  getPet: (id: string) => TProfile | null;
  updatePet: (id: string, patch: Partial<TProfile>) => TProfile | null | Promise<TProfile | null>;
  createNewPet: () => TProfile | Promise<TProfile>;
  removePet: (id: string) => boolean | Promise<boolean>;
  selectPet: (id: string) => TProfile | null;
  /** 廣播寵物清單給各視窗。 */
  sendPetProfiles: () => void;
  /** 設定變更時中斷並釋放 session；保留設定內的對話 ID 供下次恢復。 */
  closePetSession: (id: string) => void | Promise<void>;
}

/** 把 renderer 送來的 patch 過濾成只含合法欄位的更新;回傳 null 代表沒有可套用的變更。
 *  抽成純函式便於自驗——這是唯一從 renderer 寫進設定檔的通道。 */
export function sanitizePetMeta<TProfile extends { name: string; agent?: AgentBinding }>(
  profile: TProfile,
  patch: PetMetaPatch,
): { next: Partial<TProfile>; closeSession: boolean } {
  const next: Record<string, unknown> = {};
  let closeSession = false;
  if (typeof patch.name === 'string') next['name'] = patch.name.trim() || profile.name;
  if (typeof patch.enabled === 'boolean') next['enabled'] = patch.enabled;
  if (typeof patch.persona === 'string') next['persona'] = patch.persona.trim().slice(0, 4000) || undefined;
  if (Array.isArray(patch.idleMotions)) {
    const files = [...new Set(patch.idleMotions.filter((file): file is string => typeof file === 'string'))].slice(0, 50);
    next['idleMotions'] = files.length ? files : undefined;
  }
  if (patch.agent && (patch.agent.kind === 'codex' || patch.agent.kind === 'claude' || patch.agent.kind === 'agy')) {
    const sessionId = typeof patch.agent.sessionId === 'string' ? patch.agent.sessionId.trim() : '';
    const model = typeof patch.agent.model === 'string' ? patch.agent.model.trim() : '';
    const effort = typeof patch.agent.effort === 'string' && EFFORTS.includes(patch.agent.effort)
      ? patch.agent.effort : '';
    let permission = patch.agent.permission === 'plan' || patch.agent.permission === 'ask'
      || patch.agent.permission === 'auto' ? patch.agent.permission : undefined;
    // agy(Antigravity)headless 無互動審批機制,ask 擋在白名單層(UI 也已過濾,這裡是最後防線)
    if (patch.agent.kind === 'agy' && permission === 'ask') permission = undefined;
    next['agent'] = {
      kind: patch.agent.kind,
      ...(sessionId ? { sessionId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(permission ? { permission } : {})
    };
    // 設定變更即停止使用舊設定的 turn；同家保留 sessionId，下次送出恢復對話。
    closeSession = (profile.agent?.kind ?? 'codex') !== patch.agent.kind
      || (!!profile.agent?.sessionId && !sessionId)
      || (profile.agent?.model ?? '') !== model
      || (profile.agent?.effort ?? '') !== effort
      || profile.agent?.permission !== permission;
  }
  return { next: next as Partial<TProfile>, closeSession };
}

export function registerPetIpc<TProfile extends { name: string; agent?: AgentBinding; characterId?: string }>(
  deps: PetIpcDeps<TProfile>
): () => void {
  ipcMain.handle('get-pet-collection', () => ({
    pets: deps.listPets(),
    selectedPetId: deps.selectedPetId()
  }));
  ipcMain.handle('create-pet', (event) => {
    if (!deps.authorized(event)) throw new Error('未授權視窗');
    return deps.createNewPet();
  });
  ipcMain.handle('remove-pet', (_event, id: string) => deps.removePet(id));
  ipcMain.handle('select-pet', (_event, id: string) => deps.selectPet(id));
  ipcMain.handle('update-pet-meta', async (event, id: string, patch: PetMetaPatch, characterId?: string) => {
    if (!deps.authorized(event) || !patch || typeof patch !== 'object') return null;
    const profile = deps.getPet(id);
    if (!profile || (characterId && profile.characterId !== characterId)) return null;
    const { next, closeSession } = sanitizePetMeta(profile, patch);
    const updated = await deps.updatePet(id, next); // enabled=false 時的快取釋放已內建於 updatePet
    deps.sendPetProfiles();
    if (updated && closeSession) await deps.closePetSession(id);
    return updated;
  });

  return () => {
    for (const channel of ['get-pet-collection', 'create-pet', 'remove-pet', 'select-pet', 'update-pet-meta']) {
      ipcMain.removeHandler(channel);
    }
  };
}
