/* 右鍵選單自驗入口:stub window.pet、開一份選單;自動化經 window.__menu 操作。
 * 動作不真的打 IPC,記到 __menuActions 供斷言。 */
import { setLocale } from '../shared/i18n';
import type { PetApi, PetProfile } from '../preload/index';

const actions: unknown[][] = [];
const log = (...args: unknown[]): void => {
  actions.push(args);
};

const profiles: PetProfile[] = [
  { id: 'p1', name: '小狐狸', enabled: true, workspacePath: '/Users/alex/project/3D-pet', defaultPose: 'sit.vrma' },
  { id: 'p2', name: '小粉', enabled: true, workspacePath: '/Users/alex/work/site' },
  { id: 'p3', name: '阿黑', enabled: false, workspacePath: '/Users/alex/work/site' },
];

window.pet = {
  getPetCollection: async () => ({ pets: profiles, selectedPetId: 'p1' }),
  getMotionList: async () => ['wave.vrma', 'sit.vrma', 'dance.vrma'],
  selectPet: async (id: string) => (log('selectPet', id), null),
  playMotion: (id: string, file: string) => log('playMotion', id, file),
  stopMotion: (id: string) => log('stopMotion', id),
  setDefaultPose: (id: string, file: string | null) => log('setDefaultPose', id, file),
  openSettings: (tab: string, id: string) => log('openSettings', tab, id),
  openControlPanel: (tab?: string) => log('openControlPanel', tab),
  chooseVrmFile: async (id: string) => log('chooseVrmFile', id),
  resetPetState: (id: string) => log('resetPetState', id),
  restartPet: (id: string) => log('restartPet', id),
  updatePetMeta: async (id: string, patch: unknown) => (log('updatePetMeta', id, patch), null),
  createPet: async () => (log('createPet'), { id: 'p9', name: '新寵', enabled: true }),
  systemRestart: () => log('systemRestart'),
  systemQuit: () => log('systemQuit'),
} as unknown as PetApi;

setLocale('zh-Hant');

// stub 就緒後才載入選單模組(模組本身不碰 window.pet,保險起見仍後載)
const { showPetMenu, closePetMenu, isPetMenuOpen } = await import('./petMenu');

/** 佔位大頭照:32px 淡紫圓底 canvas,不依賴外部資源。 */
function placeholderAvatar(): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#b7a8e8';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#fff';
  ctx.font = '20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🦊', 16, 18);
  return canvas.toDataURL('image/png');
}

declare global {
  interface Window {
    __menu: {
      show: (x: number, y: number, petId?: string, avatar?: boolean) => Promise<void>;
      close: () => void;
      isOpen: () => boolean;
      actions: () => unknown[][];
    };
  }
}

window.__menu = {
  show: (x, y, petId = 'p1', avatar = true) =>
    showPetMenu(x, y, petId, avatar ? { avatar: placeholderAvatar() } : {}),
  close: closePetMenu,
  isOpen: isPetMenuOpen,
  actions: () => actions,
};

void showPetMenu(80, 80, 'p1', { avatar: placeholderAvatar() });
