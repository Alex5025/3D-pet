import { randomUUID } from 'node:crypto';
import type { ChatImage, ChatTaskSource } from '../shared/chat';

/**
 * 對話佇列 + 派發器:turn 進行中送出的訊息排隊,turn 結束自動取下一則。
 * 純邏輯、不 import electron——headless selftest 可直接蓋;index.ts 只做接線。
 *
 * 歸屬語意(使用者定案):
 * - 泡泡投入(source:'bubble')**必定綁定**該寵物(assignee 必填,模組層強制)——從誰的泡泡進來就誰做。
 * - 中控台(source:'control',將來)可投**不綁定**任務(assignee 缺)→ 進公用池,
 *   任何「啟用中且已設工作目錄」的寵物在自己佇列空檔時領取(claim 時才寫入 assignee)。
 */

export interface QueuedTask {
  id: string;
  /** 指定執行者(petId);undefined = 不綁定,領取(claim)時寫入。 */
  assignee?: string;
  text: string;
  images: ChatImage[];
  source: ChatTaskSource;
  enqueuedAt: number;
}

/** 廣播給 UI 的摘要(不含圖片 base64,IPC 省流量)。 */
export interface QueuedTaskSummary {
  id: string;
  text: string;
  hasImages: boolean;
  source: QueuedTask['source'];
}

export interface EnqueueResult {
  ok: boolean;
  /** 0 = 該佇列原本是空的;>0 = 排在第幾位;-1 = 被拒。 */
  position: number;
  reason?: string;
}

/** 每寵綁定佇列上限。 */
const MAX_QUEUE_PER_PET = 10;
/** 公用池上限。 */
const MAX_UNBOUND_QUEUE = 20;
/** 單一佇列(逐寵/公用池)「含圖訊息的圖片總張數」上限(base64 常駐 main 記憶體,要封頂)。 */
const MAX_QUEUED_IMAGES = 8;
/** 摘要的文字截斷長度。 */
const SUMMARY_TEXT_LIMIT = 80;

export interface ChatQueue {
  enqueue(task: Omit<QueuedTask, 'id' | 'enqueuedAt'>): EnqueueResult;
  remove(petId: string, taskId: string): boolean;
  peek(petId: string): QueuedTask | undefined;
  dequeue(petId: string): QueuedTask | undefined;
  /** 只清該寵的綁定佇列;公用池不受影響(寵物休息不撤回大家都能做的單)。 */
  clear(petId: string): void;
  size(petId: string): number;
  /** 有綁定任務的寵物,依「隊首等最久優先」排序(dispatchAll 的公平順序)。 */
  petsWithTasks(): string[];
  summaries(petId: string): QueuedTaskSummary[];
  /** 領取公用池最舊的一單:寫入 assignee 後回傳;池空回 undefined。 */
  claimUnbound(petId: string): QueuedTask | undefined;
  hasUnbound(): boolean;
  unboundSummaries(): QueuedTaskSummary[];
  removeUnbound(taskId: string): boolean;
}

const toSummary = (task: QueuedTask): QueuedTaskSummary => ({
  id: task.id,
  text: task.text.length > SUMMARY_TEXT_LIMIT ? `${task.text.slice(0, SUMMARY_TEXT_LIMIT)}…` : task.text,
  hasImages: task.images.length > 0,
  source: task.source
});

const countImages = (tasks: QueuedTask[]): number => tasks.reduce((sum, item) => sum + item.images.length, 0);

/** onChanged 的 petId = undefined 表示公用池變更(console 之後訂閱;泡泡不顯示公用池)。 */
export function createChatQueue(onChanged?: (petId?: string) => void): ChatQueue {
  const bound = new Map<string, QueuedTask[]>();
  const unbound: QueuedTask[] = [];
  const list = (petId: string): QueuedTask[] => bound.get(petId) ?? [];

  return {
    enqueue(task) {
      if (task.source === 'bubble' && !task.assignee) {
        // 泡泡路徑必綁定——在模組層強制,不靠呼叫端自律
        return { ok: false, position: -1, reason: '泡泡訊息必須綁定寵物' };
      }
      const queue = task.assignee ? list(task.assignee) : unbound;
      const cap = task.assignee ? MAX_QUEUE_PER_PET : MAX_UNBOUND_QUEUE;
      if (queue.length >= cap) {
        return { ok: false, position: -1, reason: `佇列已滿(上限 ${cap} 則),請稍候或移除排隊中的訊息` };
      }
      if (task.images.length && countImages(queue) + task.images.length > MAX_QUEUED_IMAGES) {
        return { ok: false, position: -1, reason: `排隊中的圖片太多(上限 ${MAX_QUEUED_IMAGES} 張),請等前面的訊息送完` };
      }
      const position = queue.length;
      queue.push({ ...task, id: randomUUID(), enqueuedAt: Date.now() });
      if (task.assignee) bound.set(task.assignee, queue);
      onChanged?.(task.assignee);
      return { ok: true, position };
    },
    remove(petId, taskId) {
      const queue = list(petId);
      const next = queue.filter((item) => item.id !== taskId);
      if (next.length === queue.length) return false;
      bound.set(petId, next);
      onChanged?.(petId);
      return true;
    },
    peek: (petId) => list(petId)[0],
    dequeue(petId) {
      const task = list(petId).shift();
      if (task) onChanged?.(petId);
      return task;
    },
    clear(petId) {
      if (!list(petId).length) return;
      bound.delete(petId);
      onChanged?.(petId);
    },
    size: (petId) => list(petId).length,
    petsWithTasks() {
      return [...bound.entries()]
        .filter(([, queue]) => queue.length > 0)
        .sort(([, a], [, b]) => a[0]!.enqueuedAt - b[0]!.enqueuedAt)
        .map(([petId]) => petId);
    },
    summaries: (petId) => list(petId).map(toSummary),
    claimUnbound(petId) {
      const task = unbound.shift();
      if (!task) return undefined;
      task.assignee = petId;
      onChanged?.(undefined);
      return task;
    },
    hasUnbound: () => unbound.length > 0,
    unboundSummaries: () => unbound.map(toSummary),
    removeUnbound(taskId) {
      const index = unbound.findIndex((item) => item.id === taskId);
      if (index < 0) return false;
      unbound.splice(index, 1);
      onChanged?.(undefined);
      return true;
    }
  };
}

export interface ChatDispatcher {
  /** 嘗試派發某寵:自己的綁定佇列優先;空了才領公用池(逐則,不迴圈——下一則由 onTurnFinished 再觸發)。 */
  dispatch(petId: string): void;
  /** 掃所有寵物:先綁定佇列(公平序),再把公用池分給閒著的合格寵物。 */
  dispatchAll(): void;
}

export function createChatDispatcher(deps: {
  queue: ChatQueue;
  canAccept(petId: string): boolean;
  /** 有資格領公用池的寵物(index.ts:啟用中且已設 workspacePath)。 */
  unboundCandidates(): string[];
  /** 實際執行(index.ts 綁 turnStart 事件 + bridge.chatSend)。petId = 執行者。 */
  runTask(petId: string, task: QueuedTask): void;
}): ChatDispatcher {
  function dispatch(petId: string): void {
    if (!deps.canAccept(petId)) return;
    // 綁定佇列優先——自己的任務永遠排在領公用單之前
    if (deps.queue.peek(petId)) {
      const task = deps.queue.dequeue(petId);
      if (task) deps.runTask(petId, task);
      return;
    }
    if (deps.queue.hasUnbound() && deps.unboundCandidates().includes(petId)) {
      const task = deps.queue.claimUnbound(petId);
      if (task) deps.runTask(petId, task);
    }
  }
  return {
    dispatch,
    dispatchAll() {
      for (const petId of deps.queue.petsWithTasks()) dispatch(petId);
      // 公用池:分給還閒著(綁定佇列空)的合格寵物,每寵至多領一單
      for (const petId of deps.unboundCandidates()) {
        if (!deps.queue.hasUnbound()) break;
        if (!deps.canAccept(petId) || deps.queue.peek(petId)) continue;
        const task = deps.queue.claimUnbound(petId);
        if (task) deps.runTask(petId, task);
      }
    }
  };
}
