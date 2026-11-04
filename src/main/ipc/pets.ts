import { BrowserWindow } from 'electron';
import type { AgentBridge } from '../agent/bridge';
import { registerAppearanceIpc } from '../appearanceIpc';
import { appPrompt } from '../appPrompt';
import { registerPetIpc } from '../petIpc';
import { createResourceScope } from '../resourceScope';
import type { AppRegistry, PetProfile } from '../runtimeTypes';

export interface IpcPetsDeps {
  readonly win: BrowserWindow | null;
  readonly settingsWin: BrowserWindow | null;
  readonly controlWin: BrowserWindow | null;
  readonly pets: Map<string, PetProfile>;
  readonly registry: AppRegistry;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
  readonly bridge: AgentBridge | null;
  readonly updatePet: (id: string, patch: Partial<PetProfile>) => PetProfile | null;
  readonly setPetEnabled: (id: string, enabled: boolean) => Promise<PetProfile | null>;
  readonly serializeCharacter: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly createNewPet: () => Promise<PetProfile>;
  readonly removePet: (id: string) => boolean;
  readonly selectPet: (id: string) => PetProfile | null;
  readonly sendPetProfiles: () => void;
  readonly avatarIcons: Map<string, { front: string; side: string; }>;
  readonly wardrobeLists: Map<string, { key: string; label: string; }[]>;
  readonly dataDir: () => string;
  readonly defaultVrmPath: () => string;
}

/** ipc/pets 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createIpcPets(deps: IpcPetsDeps) {
  const scope = createResourceScope();

  async function start() {
    if (!scope.start()) return;

    // 寵物 CRUD 與中繼資料 IPC 已抽到 petIpc.ts(update-pet-meta 的欄位白名單在那裡)
    scope.add(registerPetIpc({
      authorized: (event) => event.sender === deps.win?.webContents || event.sender === deps.settingsWin?.webContents || event.sender === deps.controlWin?.webContents,
      listPets: () => [...deps.pets.values()],
      selectedPetId: () => deps.registry.selectedPetId,
      getPet: deps.getPet,
      updatePet: async (id, patch) => {
        const { enabled, ...metadata } = patch;
        if (metadata.agent && deps.bridge?.petStates().some((state) => state.petId === id && state.running && state.workspacePath === deps.getPet(id)?.workspacePath)) return deps.getPet(id);
        if (Object.keys(metadata).length) deps.updatePet(id, metadata);
        return enabled === undefined ? deps.getPet(id) : deps.setPetEnabled(id, enabled);
      },
      createNewPet: () => deps.serializeCharacter(async () => {
        try { return await deps.createNewPet(); }
        catch (error) {
          await appPrompt({ message: String(error), buttons: ['確定'], cancelId: 0 });
          return deps.getPet()!;
        }
      }),
      removePet: (id) => deps.serializeCharacter(async () => deps.removePet(id)),
      selectPet: deps.selectPet,
      sendPetProfiles: deps.sendPetProfiles,
      closePetSession: (id) => {
        if (!deps.bridge?.petStates().some((state) => state.petId === id && state.running && state.workspacePath === deps.getPet(id)?.workspacePath)) void deps.bridge?.closePetSession(id, deps.getPet(id)?.workspacePath);
      },
    }));

    // 外觀 IPC(位置/光影/晃動/服裝/頭像/預設姿勢/模型讀檔)已抽到 appearanceIpc.ts
    scope.add(registerAppearanceIpc({
      overlay: () => deps.win,
      settings: () => deps.settingsWin,
      getPet: deps.getPet,
      updatePet: deps.updatePet,
      hasPet: (id) => deps.pets.has(id),
      avatarIcons: deps.avatarIcons,
      wardrobeLists: deps.wardrobeLists,
      dataDir: deps.dataDir,
      defaultVrmPath: deps.defaultVrmPath,
    }));
  }
  return {

    start,
    dispose: () => scope.dispose(),
  };
}
export type IpcPets = ReturnType<typeof createIpcPets>;
