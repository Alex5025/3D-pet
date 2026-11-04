import { BrowserWindow, app } from 'electron';
import { createResourceScope } from '../resourceScope';

export interface IpcOverlayDeps {
  readonly win: BrowserWindow | null;
  readonly setInteractive: (value: boolean) => void;
  readonly syncOverlayMouseEvents: () => void;
  readonly setInputMode: (value: boolean) => void;
}

/** ipc/overlay 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createIpcOverlay(deps: IpcOverlayDeps) {
  const scope = createResourceScope();

  function start() {
    if (!scope.start()) return;

    scope.ipc.on('set-interactive', (event, value: boolean) => {
      if (!deps.win || event.sender !== deps.win.webContents) return;
      deps.setInteractive(value);
      deps.syncOverlayMouseEvents();
    });

    scope.ipc.handle('set-input-mode', (event, value: boolean) => {
      if (!deps.win || event.sender !== deps.win.webContents) return;
      deps.setInputMode(value);
      deps.win.setFocusable(value);
      deps.syncOverlayMouseEvents();
      if (value) {
        app.focus({ steal: true });
        deps.win.focus();
      }
    });
  }
  return {

    start,
    dispose: () => scope.dispose(),
  };
}
export type IpcOverlay = ReturnType<typeof createIpcOverlay>;
