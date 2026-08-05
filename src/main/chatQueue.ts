import { randomUUID } from 'node:crypto';
import type { ChatImage } from '../shared/chat';

/**
 * 對話佇列(逐寵 FIFO)+ 派發器:turn 進行中送出的訊息排隊,turn 結束自動取下一則。
 * 純邏輯、不 import electron——headless selftest 可直接蓋;index.ts 只做接線。
 * source 標記為將來的中控面板預留:中控指派 = enqueue(source:'control'),同一套機制。
 */

export interface QueuedTask {
  id: string;
  petId: string;
  text: string;
  images: ChatImage[];
  source: 'bubble' | 'control' | 'selftest';
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
  /** 0 = 佇列原本是空的(大概率立即派發);>0 = 排在第幾位。 */
  position: number;
  reason?: string;
}

/** 每寵佇列上限。 */
const MAX_QUEUE_PER_PET = 10;
/** 佇列中「含圖訊息的圖片總張數」上限(base64 常駐 main 記憶體,要封頂)。 */
const MAX_QUEUED_IMAGES_PER_PET = 8;
/** 摘要的文字截斷長度。 */
const SUMMARY_TEXT_LIMIT = 80;

export interface ChatQueue {
  enqueue(task: Omit<QueuedTask, 'id' | 'enqueuedAt'>): EnqueueResult;
  remove(petId: string, taskId: string): boolean;
  peek(petId: string): QueuedTask | undefined;
  dequeue(petId: string): QueuedTask | undefined;
  clear(petId: string): void;
  size(petId: string): number;
  /** 有排隊任務的寵物,依「隊首等最久優先」排序(dispatchAll 的公平順序)。 */
  petsWithTasks(): string[];
  summaries(petId: string): QueuedTaskSummary[];
}

export function createChatQueue(onChanged?: (petId: string) => void): ChatQueue {
  const queues = new Map<string, QueuedTask[]>();
  const list = (petId: string): QueuedTask[] => queues.get(petId) ?? [];
  const notify = (petId: string): void => onChanged?.(petId);

  return {
    enqueue(task) {
      const queue = list(task.petId);
      if (queue.length >= MAX_QUEUE_PER_PET) {
        return { ok: false, position: -1, reason: `佇列已滿(上限 ${MAX_QUEUE_PER_PET} 則),請稍候或移除排隊中的訊息` };
      }
      if (task.images.length) {
        const queuedImages = queue.reduce((sum, item) => sum + item.images.length, 0);
        if (queuedImages + task.images.length > MAX_QUEUED_IMAGES_PER_PET) {
          return { ok: false, position: -1, reason: `排隊中的圖片太多(上限 ${MAX_QUEUED_IMAGES_PER_PET} 張),請等前面的訊息送完` };
        }
      }
      const position = queue.length;
      queue.push({ ...task, id: randomUUID(), enqueuedAt: Date.now() });
      queues.set(task.petId, queue);
      notify(task.petId);
      return { ok: true, position };
    },
    remove(petId, taskId) {
      const queue = list(petId);
      const next = queue.filter((item) => item.id !== taskId);
      if (next.length === queue.length) return false;
      queues.set(petId, next);
      notify(petId);
      return true;
    },
    peek: (petId) => list(petId)[0],
    dequeue(petId) {
      const queue = list(petId);
      const task = queue.shift();
      if (task) notify(petId);
      return task;
    },
    clear(petId) {
      if (!list(petId).length) return;
      queues.delete(petId);
      notify(petId);
    },
    size: (petId) => list(petId).length,
    petsWithTasks() {
      return [...queues.entries()]
        .filter(([, queue]) => queue.length > 0)
        .sort(([, a], [, b]) => a[0]!.enqueuedAt - b[0]!.enqueuedAt)
        .map(([petId]) => petId);
    },
    summaries(petId) {
      return list(petId).map((task) => ({
        id: task.id,
        text: task.text.length > SUMMARY_TEXT_LIMIT ? `${task.text.slice(0, SUMMARY_TEXT_LIMIT)}…` : task.text,
        hasImages: task.images.length > 0,
        source: task.source
      }));
    }
  };
}

export interface ChatDispatcher {
  /** 嘗試派發某寵的隊首任務(不可派就什麼都不做;逐則,不迴圈——下一則由 onTurnFinished 再觸發)。 */
  dispatch(petId: string): void;
  /** 掃所有有排隊任務的寵物(全域上限釋放時用;公平順序見 petsWithTasks)。 */
  dispatchAll(): void;
}

export function createChatDispatcher(deps: {
  queue: ChatQueue;
  canAccept(petId: string): boolean;
  /** 實際執行(index.ts 綁 turnStart 事件 + bridge.chatSend)。 */
  runTask(task: QueuedTask): void;
}): ChatDispatcher {
  function dispatch(petId: string): void {
    if (!deps.canAccept(petId) || !deps.queue.peek(petId)) return;
    const task = deps.queue.dequeue(petId);
    if (task) deps.runTask(task);
  }
  return {
    dispatch,
    dispatchAll() {
      for (const petId of deps.queue.petsWithTasks()) dispatch(petId);
    }
  };
}
