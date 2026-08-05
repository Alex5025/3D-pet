import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentBinding, AgentEvent, AgentKind } from '../shared/agentEvents';
import type { ChatImage, ChatSendResult, QueuedMessageSummary } from '../shared/chat';
import type {
  ProjectSandboxSettings,
  ProjectSandboxSettingsInput,
  ProjectSandboxSettingsResult,
} from '../shared/sandboxSettings';

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
  /** 待機動作(motions/ 檔名):main 以隨機間隔從中挑一個播放。 */
  idleMotions?: string[];
}

export interface PetCollection {
  pets: PetProfile[];
  selectedPetId: string;
}

/** 參考檔案(拖放到寵物身上):絕對路徑注入 AI 對話;當次對話有效。 */
export interface RefFile {
  path: string;
  isDir: boolean;
}

/** 功率檔位(main 的 powerMonitor 推播):renderer 據此調整渲染節流;paused = 鎖屏/睡眠全停。 */
export interface PowerProfile {
  tier: string;
  paused: boolean;
  idleSkip: number;
  idleDelayMs: number;
  activeSkip: number;
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
    patch: Pick<Partial<PetProfile>, 'name' | 'enabled' | 'agent' | 'persona' | 'idleMotions'>
  ): Promise<PetProfile | null> => ipcRenderer.invoke('update-pet-meta', petId, patch),
  onPetProfiles: (callback: (pets: PetProfile[], selectedPetId: string) => void) =>
    ipcRenderer.on('pet-profiles-apply', (_event, pets, selectedPetId) => callback(pets, selectedPetId)),
  onSelectedPet: (callback: (petId: string) => void) =>
    ipcRenderer.on('selected-pet-apply', (_event, petId) => callback(petId)),
  onPetRestart: (callback: (petId: string) => void) =>
    ipcRenderer.on('pet-runtime-restart', (_event, petId) => callback(petId)),

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
  getWorkspaceRoot: (): Promise<string> => ipcRenderer.invoke('workspace-root-get'),
  chooseWorkspaceRoot: (): Promise<string> => ipcRenderer.invoke('choose-workspace-root'),
  onWorkspaceRoot: (callback: (root: string) => void) =>
    ipcRenderer.on('workspace-root-apply', (_event, root) => callback(root)),
  getProjectSandboxSettings: (petId: string): Promise<ProjectSandboxSettingsResult> =>
    ipcRenderer.invoke('sandbox-settings-get', petId),
  setProjectSandboxSettings: (
    petId: string,
    settings: ProjectSandboxSettingsInput,
  ): Promise<ProjectSandboxSettingsResult> => ipcRenderer.invoke('sandbox-settings-set', petId, settings),

  listAgentModels: (kind: AgentKind): Promise<AgentModelInfo[]> =>
    ipcRenderer.invoke('agent-models', kind),
  chatSend: (petId: string, text: string, images: ChatImage[] = []): Promise<ChatSendResult> =>
    ipcRenderer.invoke('chat-send', petId, text, images),
  removeQueuedMessage: (petId: string, taskId: string) =>
    ipcRenderer.send('chat-queue-remove', petId, taskId),
  getChatQueue: (petId: string): Promise<QueuedMessageSummary[]> =>
    ipcRenderer.invoke('chat-queue-get', petId),
  onChatQueue: (callback: (petId: string, list: QueuedMessageSummary[]) => void) =>
    ipcRenderer.on('chat-queue-apply', (_event, petId, list) => callback(petId, list)),
  chatCancel: (petId: string) => ipcRenderer.send('chat-cancel', petId),
  chatApproval: (petId: string, requestId: string, allow: boolean, feedback?: string) =>
    ipcRenderer.send('chat-approval', petId, requestId, allow, feedback),
  newSession: (petId: string) => ipcRenderer.send('new-session', petId),

  /* 參考檔案(拖放到寵物身上;當次對話有效,不落盤)。
   * Electron 33 已移除 File.path,取絕對路徑必須經 preload 的 webUtils。 */
  getFilePath: (file: File): string => webUtils.getPathForFile(file),
  addRefFiles: (petId: string, paths: string[]) => ipcRenderer.send('ref-files-add', petId, paths),
  removeRefFile: (petId: string, path: string) => ipcRenderer.send('ref-files-remove', petId, path),
  onRefFiles: (callback: (petId: string, list: RefFile[]) => void) =>
    ipcRenderer.on('ref-files-apply', (_event, petId, list) => callback(petId, list)),
  /** 檔案拖曳開始時 main 詢問各寵的螢幕矩形(要在哪裡亮接收窗)。 */
  onPetRectsRequest: (callback: () => void) => ipcRenderer.on('pet-rects-request', () => callback()),
  sendPetRects: (rects: { petId: string; name: string; left: number; top: number; right: number; bottom: number }[]) =>
    ipcRenderer.send('pet-rects', rects),

  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onChatEvent: (callback: (petId: string, event: AgentEvent) => void) =>
    ipcRenderer.on('chat-event-apply', (_event, petId, agentEvent) => callback(petId, agentEvent)),

  onPowerProfile: (callback: (profile: PowerProfile) => void) =>
    ipcRenderer.on('power-profile-apply', (_event, profile) => callback(profile)),

  onVrm: (callback: (petId: string, buffer: ArrayBuffer) => void) =>
    ipcRenderer.on('vrm-buffer', (_event, petId, bytes: Uint8Array) =>
      callback(petId, toArrayBuffer(bytes))
    ),
  getBootVrm: async (petId: string): Promise<ArrayBuffer | null> => {
    const bytes: Uint8Array | null = await ipcRenderer.invoke('get-boot-vrm', petId);
    return bytes ? toArrayBuffer(bytes) : null;
  },
  onVRMA: (callback: (petId: string, buffer: ArrayBuffer, lowPower: boolean) => void) =>
    ipcRenderer.on('vrma-play', (_event, petId, bytes: Uint8Array, lowPower?: boolean) =>
      callback(petId, toArrayBuffer(bytes), lowPower === true)
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
