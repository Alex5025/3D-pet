import { BrowserWindow } from 'electron';
import type { ControlPetStatus, ControlStatusSnapshot, ControlTaskRecord } from '../shared/chat';
import type { AgentBridge } from './agent/bridge';
import type { ChatQueue } from './chatQueue';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface ControlDeps {
  readonly bridge: AgentBridge | null;
  readonly pets: Map<string, PetProfile>;
  readonly chatQueue: ChatQueue;
  readonly controlWin: BrowserWindow | null;
}

/** control 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createControl(deps: ControlDeps) {
  const scope = createResourceScope();

  /* ── 中控任務帳本:只追蹤中控投的任務(泡泡對話不進帳本);記憶體保留、不落盤,重啟即清空。
   * 佇列的單被領走就消失,「誰收到/在哪執行/執行狀態」的全生命週期靠這份紀錄。 ── */
  const taskLedger = new Map<string, ControlTaskRecord>();

  /** petId → 進行中的帳本任務 id(done/error 事件對回任務用;泡泡任務不在帳本,不會進這張表)。 */
  const runningTaskByPet = new Map<string, string>();

  const LEDGER_FINISHED_CAP = 50;

  const ledgerSummary = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

  function finishLedgerTask(petId: string, ok: boolean): void {
    const taskId = runningTaskByPet.get(petId);
    if (!taskId) return;
    runningTaskByPet.delete(petId);
    const record = taskLedger.get(taskId);
    if (!record) return;
    record.status = ok ? 'done' : 'failed';
    record.finishedAt = Date.now();
    // 已終結(含已移除)超過上限 → 砍最舊,帳本不無限長大
    const finished = [...taskLedger.values()].filter((r) => r.finishedAt !== undefined);
    if (finished.length > LEDGER_FINISHED_CAP) {
      finished.sort((a, b) => a.finishedAt! - b.finishedAt!);
      for (const old of finished.slice(0, finished.length - LEDGER_FINISHED_CAP)) taskLedger.delete(old.id);
    }
  }

  function markLedgerRemoved(taskId: string): void {
    const record = taskLedger.get(taskId);
    if (record?.status === 'queued') {
      record.status = 'removed';
      record.finishedAt = Date.now();
    }
  }

  /* ── 中控面板快照:全量組裝、50ms trailing debounce 推播 ──
   * 中控吃整份快照而非逐寵事件差分——量小(寵物十數隻、佇列 ≤10/寵),全量重繪省心且天然避開漏接。 */
  function buildControlStatus(): ControlStatusSnapshot {
    const agentStates = new Map((deps.bridge?.petStates() ?? []).map((s) => [s.petId, s]));
    const petsStatus: ControlPetStatus[] = [...deps.pets.values()].map((profile) => {
      const agent = agentStates.get(profile.id);
      const phase: ControlPetStatus['phase'] = profile.enabled === false
        ? 'resting'
        : agent?.pendingApproval ? 'awaitingApproval' : agent?.running ? 'working' : 'idle';
      return {
        petId: profile.id,
        projects: profile.projects?.map((p) => p.workspacePath) ?? [],
        runningWorkspacePath: agent?.running ? agent.workspacePath : undefined,
        name: profile.name,
        enabled: profile.enabled !== false,
        ...(profile.workspacePath ? { workspacePath: profile.workspacePath } : {}),
        phase,
        lastActivity: agent?.lastActivity ?? 0, // 從未對話 = 0(renderer 排最後)
        queue: deps.chatQueue.summaries(profile.id),
        ...(agent?.pendingApproval ? { pendingApproval: agent.pendingApproval } : {})
      };
    });
    // 帳本:未終結在前,各自新→舊;排序歸 main(帳本是 main 的資料),清醒/休息分組歸 renderer(顯示邏輯)
    const tasks = [...taskLedger.values()].sort((a, b) => {
      const aFinished = a.finishedAt !== undefined ? 1 : 0;
      const bFinished = b.finishedAt !== undefined ? 1 : 0;
      if (aFinished !== bFinished) return aFinished - bFinished;
      return b.enqueuedAt - a.enqueuedAt;
    });
    return { pets: petsStatus, tasks };
  }

  let controlStatusTimer: NodeJS.Timeout | null = null;

  const scheduleControlStatus = () => {
    if (!deps.controlWin || controlStatusTimer) return;
    controlStatusTimer = scope.timeout(() => {
      controlStatusTimer = null;
      deps.controlWin?.webContents.send('control-status-apply', buildControlStatus());
    }, 50);
  };
  function start() {
    if (!scope.start()) return;

  }
  return {
    get scheduleControlStatus() { return scheduleControlStatus; },
    get finishLedgerTask() { return finishLedgerTask; },
    get taskLedger() { return taskLedger; },
    get runningTaskByPet() { return runningTaskByPet; },
    get markLedgerRemoved() { return markLedgerRemoved; },
    get ledgerSummary() { return ledgerSummary; },
    get buildControlStatus() { return buildControlStatus; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Control = ReturnType<typeof createControl>;
