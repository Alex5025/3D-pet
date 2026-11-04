import { BrowserWindow, app } from 'electron';
import type { ChatSendResult, ControlStatusSnapshot, ControlTaskRecord } from '../../shared/chat';
import { t } from '../../shared/i18n';
import { normalizeWorkspacePath } from '../../shared/petGroups';
import type { ChatDispatcher, ChatQueue } from '../chatQueue';
import { createResourceScope } from '../resourceScope';
import type { PetProfile } from '../runtimeTypes';

export interface IpcControlDeps {
  readonly controlWin: BrowserWindow | null;
  readonly pets: Map<string, PetProfile>;
  readonly chatQueue: ChatQueue;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
  readonly ledgerSummary: (text: string) => string;
  readonly taskLedger: Map<string, ControlTaskRecord>;
  readonly chatDispatcher: ChatDispatcher;
  readonly scheduleControlStatus: (() => void);
  readonly buildControlStatus: () => ControlStatusSnapshot;
  readonly markLedgerRemoved: (taskId: string) => void;
  readonly win: BrowserWindow | null;
  readonly restartApp: () => void;
  readonly shutdownSync: () => void;
}

/** ipc/control 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createIpcControl(deps: IpcControlDeps) {
  const scope = createResourceScope();

  function start() {
    if (!scope.start()) return;

    /* ── 中控面板專用 IPC(sender 一律限 controlWin;系統重啟/結束另供 overlay 右鍵選單使用)──
     * 指派任務走自己的 enqueue 通道(chat-send 保持泡泡專用);一切失敗回饋走 invoke 回傳,
     * 絕不發 error 事件——renderer 對 error 無條件 endTurn,會誤終結進行中的 turn(§10 鐵律)。 */
    scope.ipc.handle('control-enqueue', (event, text: string, assignee?: string, restrictWorkspace?: string): ChatSendResult => {
      if (!deps.controlWin || event.sender !== deps.controlWin.webContents) {
        return { queued: false, position: -1, reason: t('reason.invalidRequest') };
      }
      const trimmed = String(text).slice(0, 1000).trim();
      if (!trimmed) return { queued: false, position: -1, reason: t('reason.emptyMessage') };
      let target: string | undefined;
      if (assignee !== undefined && assignee !== '') {
        const profile = deps.pets.get(String(assignee));
        if (!profile) return { queued: false, position: -1, reason: t('reason.petNotFound') };
        if (profile.enabled === false) {
          // 投給休息中寵物的綁定單會躺死或在喚醒前被 clear,直接拒收
          return { queued: false, position: -1, reason: t('reason.petResting') };
        }
        target = profile.id;
      }
      // 公用池單可限定工作區(= 發佈者指定運行路徑);必須是某寵物實際的工作區,亂傳拒收
      let restrict: string | undefined;
      if (!target && typeof restrictWorkspace === 'string' && restrictWorkspace) {
        const normalized = normalizeWorkspacePath(restrictWorkspace);
        const known = new Set(
          [...deps.pets.values()].flatMap((p) => p.projects?.map((project) => project.workspacePath) ?? [])
        );
        if (!normalized || !known.has(normalized)) {
          return { queued: false, position: -1, reason: t('reason.workspaceUnknown') };
        }
        restrict = normalized;
      }
      const result = deps.chatQueue.enqueue({
        assignee: target,
        ...(target ? { workspacePath: deps.getPet(target)?.workspacePath } : {}),
        ...(restrict ? { restrictWorkspace: restrict } : {}),
        text: trimmed,
        images: [],
        source: 'control'
      });
      if (!result.ok || !result.id) return { queued: false, position: -1, reason: result.reason };
      // 中控投的任務進帳本(status queued;綁定單即知接收者,公用池單記限定工作區)
      const record: ControlTaskRecord = {
        id: result.id,
        text: deps.ledgerSummary(trimmed),
        source: 'control',
        status: 'queued',
        enqueuedAt: Date.now()
      };
      if (target) {
        record.assignee = target;
        const profile = deps.pets.get(target);
        if (profile?.name) record.assigneeName = profile.name;
        if (profile?.workspacePath) record.workspacePath = profile.workspacePath;
      } else if (restrict) {
        record.workspacePath = restrict;
      }
      deps.taskLedger.set(record.id, record);
      // enqueue 不自動派發:綁定單派給指定寵;公用池單讓任一合格閒置寵立刻領走
      if (target) deps.chatDispatcher.dispatch(target);
      else deps.chatDispatcher.dispatchAll();
      deps.scheduleControlStatus?.();
      return { queued: true, position: result.position };
    });

    scope.ipc.handle('control-status-get', (event) => {
      if (!deps.controlWin || event.sender !== deps.controlWin.webContents) return null;
      return deps.buildControlStatus(); // 開窗初始化:晚開視窗只靠事件流會漏掉進行中的 turn
    });

    scope.ipc.handle('chat-unbound-remove', (event, taskId: string): boolean => {
      if (!deps.controlWin || event.sender !== deps.controlWin.webContents) return false;
      const removed = deps.chatQueue.removeUnbound(String(taskId)); // 內部 onChanged(undefined) 會自動重推快照
      if (removed) deps.markLedgerRemoved(String(taskId));
      return removed;
    });

    scope.ipc.on('system-restart', (event) => {
      const fromOurWindow = event.sender === deps.win?.webContents || event.sender === deps.controlWin?.webContents;
      if (!fromOurWindow) return;
      deps.restartApp();
    });

    scope.ipc.on('system-quit', (event) => {
      const fromOurWindow = event.sender === deps.win?.webContents || event.sender === deps.controlWin?.webContents;
      if (!fromOurWindow) return;
      // app.exit 不觸發 before-quit,清理要自己做(同 Tray 結束;已知坑,見 DEVLOG §22)
      deps.shutdownSync();
      app.exit(0);
    });
  }
  return {

    start,
    dispose: () => scope.dispose(),
  };
}
export type IpcControl = ReturnType<typeof createIpcControl>;
