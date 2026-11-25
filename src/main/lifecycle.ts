import { app } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { t } from '../shared/i18n';
import { appPrompt } from './appPrompt';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface LifecycleDeps {
  readonly stopBackground: () => void;
  readonly stopAgents: () => void;
  readonly closeWindows: () => void;
  readonly persistConfigSync: () => void;
  readonly pets: Map<string, PetProfile>;
}

/** lifecycle 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createLifecycle(deps: LifecycleDeps) {
  const scope = createResourceScope();

  let shuttingDown = false;
  function shutdownSync(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    // 每項各自隔離：某個外部程序或 watcher 清理失敗，不可阻止設定落盤與 app 結束／重啟。
    const cleanup = (label: string, action: () => void): void => {
      try { action(); } catch (error) { console.log(`[main] ${label} cleanup failed`, error); }
    };
    cleanup('background', deps.stopBackground);
    cleanup('agents', deps.stopAgents);
    cleanup('config', deps.persistConfigSync);
    cleanup('windows', deps.closeWindows);
  }

  function restartApp(): void {
    deps.persistConfigSync();
    shutdownSync();
    if (app.isPackaged) {
      app.relaunch();
    } else {
      const scriptPath = join(app.getAppPath(), 'scripts/restart-dev.mjs');
      const child = spawn('node', [scriptPath, String(process.pid), app.getAppPath()], {
        cwd: app.getAppPath(), detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
    }
    app.exit(0);
  }

  /* ⌘Q 誤觸防護:Tray 與中控的「結束」走 app.exit(明確的點擊,不經這裡),
   * before-quit 只會由 ⌘Q 與系統選單觸發——正好是會手滑的那條路,補一道確認。
   * 用非同步 dialog:同步版會卡住 event loop,登出/關機時整台機器等在這裡。 */
  let quitPromptOpen = false;
  function start() {
    if (!scope.start()) return;

    if (process.env['ELECTRON_RENDERER_URL'] && !app.isPackaged && process.platform !== 'win32') {
      // 開發啟動器要求重啟時先保存資料；Vite 結束後無法再載入離開確認視窗。
      scope.listen(process, 'SIGTERM', () => { shutdownSync(); app.exit(0); });
    }

    scope.listen(app, 'window-all-closed', () => { /* 常駐 */ });

    scope.listen(app, 'before-quit', (event: Electron.Event) => {
      if (quitPromptOpen) { event.preventDefault(); return; } // 連按 ⌘Q 不疊開對話框
      event.preventDefault();
      quitPromptOpen = true;
      app.focus({ steal: true }); // 背景 app(dock 隱藏)的 dialog 會被壓在其他視窗底下
      const awake = [...deps.pets.values()].filter((profile) => profile.enabled).length;
      void appPrompt({
        buttons: [t('quit.cancel'), t('quit.confirm')],
        cancelId: 0, // Esc / ⌘. 等同取消
        message: t('quit.message'),
        detail: t('quit.detail', { n: awake }),
      }).then(({ response }) => {
        quitPromptOpen = false;
        // 確認後走 app.exit(同 Tray 慣例):不再回到 before-quit,清理自己做
        if (response === 1) { shutdownSync(); app.exit(0); }
      }).catch(() => { quitPromptOpen = false; });
    });
  }
  return {
    get restartApp() { return restartApp; },
    get shutdownSync() { return shutdownSync; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Lifecycle = ReturnType<typeof createLifecycle>;
