import { contextBridge, ipcRenderer } from 'electron';
import type { AgentBinding, AgentEvent, AgentKind } from '../shared/agentEvents';

export type { AgentBinding, AgentEvent, AgentKind };

export interface AgentModelInfo {
  id: string;
  label: string;
  efforts: string[];
  isDefault?: boolean;
}

export interface PetState {
  x: number;
  y: number;
  z: number;
  rotY: number;
  camZ: number;
}

export interface Lighting {
  type: 'directional' | 'point';
  ambient: number;
  directional: number;
  x: number;
  y: number;
  z: number;
  shade: number;
}

export interface Sway {
  hair: number;
  cloth: number;
  chest: number;
  tail: number;
}

export interface WardrobeItem {
  key: string;
  label: string;
}

export interface PetProfile {
  id: string;
  name: string;
  enabled: boolean;
  workspacePath?: string;
  /** 舊欄位,已遷移為 agent。 */
  codexSessionId?: string;
  agent?: AgentBinding;
  /** 角色個性設定(自由文字):注入 agent 對話的 system prompt;v3 的表演風格也會用它。 */
  persona?: string;
  vrmPath?: string;
  state?: PetState;
  lighting?: Lighting;
  sway?: Sway;
  wardrobe?: Record<string, boolean>;
  defaultPose?: string;
}

export interface PetCollection {
  pets: PetProfile[];
  selectedPetId: string;
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const api = {
  setInteractive: (value: boolean) => ipcRenderer.send('set-interactive', value),
  setInputMode: (value: boolean): Promise<void> => ipcRenderer.invoke('set-input-mode', value),
  onCursor: (callback: (point: { x: number; y: number }) => void) =>
    ipcRenderer.on('cursor', (_event, point) => callback(point)),

  getPetCollection: (): Promise<PetCollection> => ipcRenderer.invoke('get-pet-collection'),
  createPet: (): Promise<PetProfile> => ipcRenderer.invoke('create-pet'),
  removePet: (petId: string): Promise<boolean> => ipcRenderer.invoke('remove-pet', petId),
  selectPet: (petId: string): Promise<PetProfile | null> => ipcRenderer.invoke('select-pet', petId),
  updatePetMeta: (
    petId: string,
    patch: Pick<Partial<PetProfile>, 'name' | 'enabled' | 'agent' | 'persona'>
  ): Promise<PetProfile | null> => ipcRenderer.invoke('update-pet-meta', petId, patch),
  onPetProfiles: (callback: (pets: PetProfile[], selectedPetId: string) => void) =>
    ipcRenderer.on('pet-profiles-apply', (_event, pets, selectedPetId) => callback(pets, selectedPetId)),
  onSelectedPet: (callback: (petId: string) => void) =>
    ipcRenderer.on('selected-pet-apply', (_event, petId) => callback(petId)),

  getState: (petId: string): Promise<Partial<PetState> | null> => ipcRenderer.invoke('get-state', petId),
  saveState: (petId: string, state: PetState) => ipcRenderer.send('save-state', petId, state),
  setPetState: (petId: string, state: PetState) => ipcRenderer.send('set-state', petId, state),
  onState: (callback: (petId: string, state: Partial<PetState>) => void) =>
    ipcRenderer.on('apply-state', (_event, petId, state) => callback(petId, state)),

  showMenu: (petId: string) => ipcRenderer.send('show-menu', petId),
  onSwitchTab: (callback: (tab: string) => void) =>
    ipcRenderer.on('switch-tab', (_event, tab) => callback(tab)),

  chooseWorkspace: (petId: string): Promise<string | null> =>
    ipcRenderer.invoke('choose-workspace', petId),

  listAgentModels: (kind: AgentKind): Promise<AgentModelInfo[]> =>
    ipcRenderer.invoke('agent-models', kind),
  chatSend: (petId: string, text: string) => ipcRenderer.send('chat-send', petId, text),
  chatCancel: (petId: string) => ipcRenderer.send('chat-cancel', petId),
  chatApproval: (petId: string, requestId: string, allow: boolean) =>
    ipcRenderer.send('chat-approval', petId, requestId, allow),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onChatEvent: (callback: (petId: string, event: AgentEvent) => void) =>
    ipcRenderer.on('chat-event-apply', (_event, petId, agentEvent) => callback(petId, agentEvent)),

  onVrm: (callback: (petId: string, buffer: ArrayBuffer) => void) =>
    ipcRenderer.on('vrm-buffer', (_event, petId, bytes: Uint8Array) =>
      callback(petId, toArrayBuffer(bytes))
    ),
  getBootVrm: async (petId: string): Promise<ArrayBuffer | null> => {
    const bytes: Uint8Array | null = await ipcRenderer.invoke('get-boot-vrm', petId);
    return bytes ? toArrayBuffer(bytes) : null;
  },
  onVRMA: (callback: (petId: string, buffer: ArrayBuffer) => void) =>
    ipcRenderer.on('vrma-play', (_event, petId, bytes: Uint8Array) =>
      callback(petId, toArrayBuffer(bytes))
    ),
  onVRMAStop: (callback: (petId: string) => void) =>
    ipcRenderer.on('vrma-stop', (_event, petId) => callback(petId)),
  onExpression: (callback: (petId: string, name: string) => void) =>
    ipcRenderer.on('expression-apply', (_event, petId, name) => callback(petId, name)),
  getDefaultPose: async (petId: string): Promise<ArrayBuffer | null> => {
    const bytes: Uint8Array | null = await ipcRenderer.invoke('get-default-pose', petId);
    return bytes ? toArrayBuffer(bytes) : null;
  },
  getMotionList: (): Promise<string[]> => ipcRenderer.invoke('motion-list'),
  setDefaultPose: (petId: string, file: string | null) =>
    ipcRenderer.send('set-default-pose', petId, file),

  getSway: (petId: string): Promise<Partial<Sway> | null> => ipcRenderer.invoke('get-sway', petId),
  setSway: (petId: string, sway: Sway) => ipcRenderer.send('set-sway', petId, sway),
  onSway: (callback: (petId: string, sway: Partial<Sway>) => void) =>
    ipcRenderer.on('apply-sway', (_event, petId, sway) => callback(petId, sway)),

  sendWardrobeList: (petId: string, list: WardrobeItem[]) =>
    ipcRenderer.send('wardrobe-list', petId, list),
  getWardrobe: (petId: string): Promise<{ list: WardrobeItem[]; states: Record<string, boolean> }> =>
    ipcRenderer.invoke('get-wardrobe', petId),
  setWardrobe: (petId: string, key: string, visible: boolean) =>
    ipcRenderer.send('set-wardrobe', petId, key, visible),
  onWardrobe: (callback: (petId: string, states: Record<string, boolean>) => void) =>
    ipcRenderer.on('apply-wardrobe', (_event, petId, states) => callback(petId, states)),
  onWardrobeList: (callback: (petId: string, list: WardrobeItem[]) => void) =>
    ipcRenderer.on('wardrobe-list-apply', (_event, petId, list) => callback(petId, list)),

  sendAvatarIcons: (petId: string, icons: { front: string; side: string }) =>
    ipcRenderer.send('avatar-icons', petId, icons),
  onAvatarIcons: (callback: (petId: string, icons: { front: string; side: string }) => void) =>
    ipcRenderer.on('avatar-icons-apply', (_event, petId, icons) => callback(petId, icons)),

  getLighting: (petId: string): Promise<Partial<Lighting> | null> =>
    ipcRenderer.invoke('get-lighting', petId),
  setLighting: (petId: string, lighting: Lighting) =>
    ipcRenderer.send('set-lighting', petId, lighting),
  onLighting: (callback: (petId: string, lighting: Partial<Lighting>) => void) =>
    ipcRenderer.on('apply-lighting', (_event, petId, lighting) => callback(petId, lighting))
};

contextBridge.exposeInMainWorld('pet', api);

export type PetApi = typeof api;
declare global {
  interface Window {
    pet: PetApi;
  }
}
