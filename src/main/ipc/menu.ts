import { BrowserWindow, Menu, screen } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createResourceScope } from '../resourceScope';
import type { PetProfile } from '../runtimeTypes';

export interface IpcMenuDeps {
  readonly win: BrowserWindow | null;
  readonly pets: Map<string, PetProfile>;
  readonly selectPet: (id: string) => PetProfile | null;
  readonly refreshMotions: () => Promise<void>;
  readonly petMenu: (requestedId?: string | undefined) => Menu;
  readonly motionFiles: string[];
  readonly motionsDir: () => string;
  readonly openSettings: (tab?: "light" | "char" | "motion" | "project", petId?: string | undefined) => void;
  readonly openControlPanel: (tab?: "overview" | "sandbox") => void;
  readonly resetState: (petId: string) => void;
  readonly restartPet: (petId: string) => Promise<void>;
}

/** ipc/menu 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createIpcMenu(deps: IpcMenuDeps) {
  const scope = createResourceScope();

  async function start() {
    if (!scope.start()) return;

    scope.ipc.handle('get-menu-work-area', (event) => {
      const win = deps.win;
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return null;
      const bounds = win.getContentBounds();
      const { workArea } = screen.getDisplayMatching(bounds);
      const zoom = win.webContents.getZoomFactor();
      // macOS 可能把全螢幕大小的疊層往下移；以實際內容起點換算，並避開 Dock／工作列。
      return {
        x: (workArea.x - bounds.x) / zoom,
        y: (workArea.y - bounds.y) / zoom,
        width: workArea.width / zoom,
        height: workArea.height / zoom,
      };
    });

    scope.ipc.on('show-menu', (event, id: string) => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(id)) return;
      deps.selectPet(id);
      void deps.refreshMotions().then(() => deps.petMenu(id).popup({ window: deps.win! }));
    });

    /* ── 自繪右鍵選單(overlay DOM)動作 ──
     * 原生 Menu 無法套用設計語言,寵物右鍵選單改由 renderer 自繪(petMenu.ts);
     * 動作經這組 IPC 回到 main,走與 Tray 選單完全相同的函式。Tray 仍用原生 petMenu()。 */
    scope.ipc.on('menu-play-motion', async (event, petId: string, file: string) => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(petId)) return;
      await deps.refreshMotions();
      if (!deps.motionFiles.includes(file)) return; // 白名單:只接受 motions/ 裡的檔名
      try {
        deps.win.webContents.send('vrma-play', petId, await readFile(join(deps.motionsDir(), file)));
      } catch (error) {
        console.log('[main] vrma read failed', error);
      }
    });

    scope.ipc.on('menu-stop-motion', (event, petId: string) => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(petId)) return;
      deps.win.webContents.send('vrma-stop', petId);
    });

    scope.ipc.on('menu-open-settings', (event, tab: string, petId: string) => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(petId)) return;
      const valid = tab === 'light' || tab === 'char' || tab === 'motion' || tab === 'project';
      deps.openSettings(valid ? tab : 'light', petId);
    });

    scope.ipc.on('menu-open-control', (event, tab?: string) => {
      if (!deps.win || event.sender !== deps.win.webContents) return;
      deps.openControlPanel(tab === 'sandbox' ? 'sandbox' : undefined);
    });

    scope.ipc.on('menu-reset-state', (event, petId: string) => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(petId)) return;
      deps.resetState(petId);
    });

    scope.ipc.on('menu-restart-pet', (event, petId: string) => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(petId)) return;
      void deps.restartPet(petId);
    });
  }
  return {

    start,
    dispose: () => scope.dispose(),
  };
}
export type IpcMenu = ReturnType<typeof createIpcMenu>;
