import { BrowserWindow, app, dialog } from 'electron';
import { t } from '../../shared/i18n';
import { appPrompt } from '../appPrompt';
import { createResourceScope } from '../resourceScope';
import type { PetProfile } from '../runtimeTypes';

export interface IpcReferencesDeps {
  readonly dropWindows: Map<string, BrowserWindow>;
  readonly win: BrowserWindow | null;
  readonly pets: Map<string, PetProfile>;
  readonly addReferencePaths: (petId: string, paths: string[]) => Promise<void>;
  readonly petRefFiles: Map<string, { path: string; isDir: boolean; }[]>;
  readonly refKey: (id: string, workspacePath?: string | undefined) => string;
  readonly sendRefFiles: (petId: string) => void;
}

/** ipc/references 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createIpcReferences(deps: IpcReferencesDeps) {
  const scope = createResourceScope();

  async function start() {
    if (!scope.start()) return;

    scope.ipc.on('ref-files-add', (event, petId: string, paths: string[]) => {
      // 來源:疊層(保留給未來平台)或拖放接收窗
      const fromDropWin = [...deps.dropWindows.values()].some((w) => !w.isDestroyed() && w.webContents === event.sender);
      if ((!fromDropWin && event.sender !== deps.win?.webContents) || !deps.pets.has(petId) || !Array.isArray(paths)) return;
      void deps.addReferencePaths(petId, paths);
    });

    scope.ipc.handle('choose-ref-files', async (event, petId: string): Promise<void> => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(petId)) return;
      app.focus({ steal: true });
      let properties: Electron.OpenDialogOptions['properties'];
      if (process.platform === 'darwin') {
        properties = ['openFile', 'openDirectory', 'multiSelections'];
      } else {
        // Windows/Linux 的 native dialog 不能同時選檔案與資料夾，先讓使用者選模式。
        const choice = await appPrompt({
          message: t('dialog.chooseReferences'),
          buttons: [t('dialog.chooseFiles'), t('dialog.chooseFolder'), t('quit.cancel')],
          cancelId: 2,
        });
        if (choice.response === 2) return;
        properties = choice.response === 0 ? ['openFile', 'multiSelections'] : ['openDirectory'];
      }
      const result = await dialog.showOpenDialog({
        title: t('dialog.chooseReferences'),
        buttonLabel: t('common.select'),
        properties,
      });
      if (!result.canceled) await deps.addReferencePaths(petId, result.filePaths);
    });

    scope.ipc.on('ref-files-remove', (event, petId: string, path: string) => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.petRefFiles.has(deps.refKey(petId))) return;
      deps.petRefFiles.set(deps.refKey(petId), (deps.petRefFiles.get(deps.refKey(petId)) ?? []).filter((item) => item.path !== path));
      deps.sendRefFiles(petId);
    });
  }
  return {

    start,
    dispose: () => scope.dispose(),
  };
}
export type IpcReferences = ReturnType<typeof createIpcReferences>;
