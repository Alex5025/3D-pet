import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { t } from '../shared/i18n';
import { createDragMonitor, type DragMonitor } from './dragMonitor';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface DropDeps {
  readonly pets: Map<string, PetProfile>;
  readonly overlayBounds: Electron.Rectangle;
  readonly win: BrowserWindow | null;
  readonly powerTier: 'normal' | 'eco' | 'critical' | 'suspended' | null;
}

/** drop 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createDrop(deps: DropDeps) {
  const scope = createResourceScope();

  let dragMonitor: DragMonitor | null = null;
  // 開機初始化(首套必發 profile)

  /* ── 檔案拖曳 → 寵物接收窗(拖放參考檔案的正式通道)──
   * 疊層視窗(透明+panel+不可聚焦+screen-saver 層)實測收不到任何拖放事件,連從啟動就
   * 永遠可互動也一樣(2026-07 實驗)。唯一可行解仿 Finder 彈簧資料夾:偵測到檔案拖曳的
   * 瞬間,在每隻寵物位置亮出「一般屬性」(不透明/可聚焦/floating)的小接收窗,拖完即收。 */
  const dropWindows = new Map<string, BrowserWindow>();

  let dragActive = false;

  function destroyDropWindows(): void {
    for (const dropWin of dropWindows.values()) {
      if (!dropWin.isDestroyed()) dropWin.destroy();
    }
    dropWindows.clear();
  }

  const dropPage = (petId: string, name: string): string =>
    'data:text/html;charset=utf-8,' + encodeURIComponent(`
  <body style="margin:0;height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    font:12px system-ui;color:#f4f1fa;background:#38324e;border:1.5px dashed rgba(200,190,235,0.55);
    border-radius:10px;text-align:center;cursor:copy;letter-spacing:0.02em;">
    <div style="opacity:0.95;">${t('overlay.dropHint')}<br/><b style="font-size:13px;">${name.replace(/[<>&]/g, '')}</b></div>
    <script>
      addEventListener('dragover', (e) => { e.preventDefault(); document.body.style.background = '#4a4170'; });
      addEventListener('dragleave', () => { document.body.style.background = '#38324e'; });
      addEventListener('drop', (e) => {
        e.preventDefault();
        const paths = [...e.dataTransfer.files].map((f) => window.pet.getFilePath(f)).filter(Boolean);
        if (paths.length) window.pet.addRefFiles(${JSON.stringify(petId)}, paths);
      });
    <\/script>
  </body>`);

  function showDropWindows(rects: { petId: string; name: string; left: number; top: number; right: number; bottom: number; }[]): void {
    destroyDropWindows();
    for (const rect of rects) {
      const profile = deps.pets.get(rect.petId);
      if (!profile || profile.enabled === false) continue;
      const width = Math.round(Math.min(Math.max(rect.right - rect.left, 170), 480));
      const height = Math.round(Math.min(Math.max(rect.bottom - rect.top, 110), 600));
      const centerX = deps.overlayBounds.x + (rect.left + rect.right) / 2;
      const centerY = deps.overlayBounds.y + (rect.top + rect.bottom) / 2;
      const dropWin = new BrowserWindow({
        width, height,
        x: Math.round(centerX - width / 2),
        y: Math.round(centerY - height / 2),
        frame: false, resizable: false, movable: false, skipTaskbar: true, show: false,
        webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false }
      });
      dropWin.setAlwaysOnTop(true, 'floating');
      // 半透明用 setOpacity 而非 transparent 視窗——實驗證明 transparent 那組屬性收不到拖放
      dropWin.setOpacity(0.72);
      void dropWin.loadURL(dropPage(rect.petId, profile.name));
      dropWin.once('ready-to-show', () => {
        if (!dropWin.isDestroyed() && dragActive) dropWin.showInactive(); // 不搶焦點
      });
      dropWindows.set(rect.petId, dropWin);
    }
  }
  function start() {
    if (!scope.start()) return;

    scope.ipc.on('pet-rects', (event, rects: { petId: string; name: string; left: number; top: number; right: number; bottom: number; }[]) => {
      if (!deps.win || event.sender !== deps.win.webContents || !Array.isArray(rects) || !dragActive) return;
      showDropWindows(rects);
    });

    dragMonitor = createDragMonitor({
      onStart: () => {
        if (deps.powerTier === 'suspended' || ![...deps.pets.values()].some((p) => p.enabled !== false)) return;
        dragActive = true;
        deps.win?.webContents.send('pet-rects-request'); // 寵物的螢幕矩形只有 renderer 知道(投影後)
      },
      onEnd: () => {
        dragActive = false;
        // drop 事件與放開左鍵幾乎同時:緩 300ms 讓接收窗先把 drop 處理完再收
        scope.timeout(() => {
          if (!dragActive) destroyDropWindows();
        }, 300);
      }
    });
  }
  scope.add(() => { dragMonitor?.dispose(); dragMonitor = null; destroyDropWindows(); });
  return {
    get dragMonitor() { return dragMonitor; },
    get dropWindows() { return dropWindows; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Drop = ReturnType<typeof createDrop>;
