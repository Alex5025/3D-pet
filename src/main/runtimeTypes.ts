import type { PetProject } from '../shared/projects';
import type { AgentBinding } from '../shared/agentEvents';

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
  /** 色溫(Kelvin);舊設定檔沒有此欄,renderer 端視為 6500 中性白。 */
  temperature?: number;
}

export interface Sway {
  hair: number;
  cloth: number;
  chest: number;
  tail: number;
}

export interface PetProfile {
  projects?: PetProject[];
  personaVersion?: string;
  characterId?: string;
  characterReady?: boolean;
  characterLoaded?: boolean;
  characterRevision?: number;
  characterError?: string;
  id: string;
  name: string;
  enabled: boolean;
  workspacePath?: string;
  /** 舊欄位,已遷移為 agent(保留不刪,循遷移慣例)。 */
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
  /** 待機動作(motions/ 檔名):以隨機間隔從中挑一個播放。 */
  idleMotions?: string[];
}

export interface AppRegistry {
  schemaVersion: 2;
  selectedPetId: string;
  petIds: string[];
  /** 預設工作目錄的根位置(全域);未設定時用 ~/Documents/PetWorkspaces。 */
  defaultWorkspaceRoot?: string;
  /** UI 語言(四語代碼);未設定 = 跟隨系統(app.getLocale())。 */
  locale?: string;
}

