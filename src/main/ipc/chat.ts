import { BrowserWindow, shell } from 'electron';
import type { HistoryStore } from '../historyStore';
import { RETENTION_MS } from '../../../scripts/storage-layout.mjs';
import type { ChatImage, ChatSendResult, ChatTranscript, ScreenCaptureResult } from '../../shared/chat';
import { captureScreen } from '../screenCapture';
import { t } from '../../shared/i18n';
import type { PetProject } from '../../shared/projects';
import type { AgentBridge } from '../agent/bridge';
import type { ChatDispatcher, ChatQueue } from '../chatQueue';
import { createResourceScope } from '../resourceScope';
import type { PetProfile } from '../runtimeTypes';

export interface IpcChatDeps {
  readonly win: BrowserWindow | null;
  readonly pets: Map<string, PetProfile>;
  readonly projectFor: (profile: PetProfile, path?: string | undefined) => PetProject | undefined;
  readonly getPet: (id?: string | undefined) => PetProfile | null;
  readonly chatKey: (id: string, path?: string | undefined) => string;
  readonly chatRevisions: Map<string, number>;
  readonly bridge: AgentBridge | null;
  readonly liveTranscripts: Map<string, { user: string; reply: string; workspacePath?: string | undefined; screenPreview?: ChatImage; }>;
  readonly completedTranscripts: Map<string, ChatTranscript>;
  readonly history: HistoryStore;
  readonly settingsWin: BrowserWindow | null;
  readonly controlWin: BrowserWindow | null;
  readonly petRefFiles: Map<string, { path: string; isDir: boolean; }[]>;
  readonly refKey: (id: string, workspacePath?: string | undefined) => string;
  readonly sendRefFiles: (petId: string) => void;
  readonly chatQueue: ChatQueue;
  readonly clearTranscript: (petId: string, rotate?: boolean) => void;
  readonly newSession: (petId: string) => boolean;
  readonly updatePet: (id: string, patch: Partial<PetProfile>) => PetProfile | null;
  readonly sendPetProfiles: () => void;
  readonly chatDispatcher: ChatDispatcher;
  readonly markLedgerRemoved: (taskId: string) => void;
}

/** ipc/chat 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createIpcChat(deps: IpcChatDeps) {
  const scope = createResourceScope();

  async function start() {
    if (!scope.start()) return;

    scope.ipc.handle('chat-capture-screen', async (event, petId: string): Promise<ScreenCaptureResult> => {
      if (!deps.win || event.sender !== deps.win.webContents || event.senderFrame !== deps.win.webContents.mainFrame
        || !deps.pets.get(petId)?.enabled) {
        return { ok: false, reason: t('reason.invalidRequest') };
      }
      return captureScreen();
    });

    /** 開新對話(泡泡的「新對話」鈕):清掉 sessionId 並關掉 bridge 的舊 session。
     *  在 main 端做而不是讓 renderer 重組 agent 設定——後者若拿到過期 profile 會洗掉 model/力度/權限。 */
    /** 上次對話紀錄:泡泡建立時 pull(循 chat-queue-get 的慣例,推播漏接也能自癒)。 */
    scope.ipc.handle('chat-transcript-get', async (event, id: string, workspacePath?: string): Promise<ChatTranscript | null> => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(id)) return null;
      try {
        const project = deps.projectFor(deps.getPet(id)!, workspacePath);
        if (!project) return null;
        const key = deps.chatKey(id, project.workspacePath);
        const revision = deps.chatRevisions.get(key) ?? 0;
        const state = deps.bridge?.petStates().find((s) => s.petId === id && s.workspacePath === project.workspacePath);
        const extra = { revision, running: !!state?.running, pendingApproval: state?.pendingApproval ?? undefined };
        const live = deps.liveTranscripts.get(id);
        if (live?.workspacePath === project.workspacePath) return {
          user: live.user, reply: live.reply, screenPreview: live.screenPreview, at: Date.now(), ...extra,
        };
        const completed = deps.completedTranscripts.get(key);
        if (completed && completed.at >= Date.now() - RETENTION_MS) return { ...completed, ...extra };
        const stored = deps.history.latest(id, project.workspacePath);
        return stored ? { ...stored, ...extra } : null;
      } catch (error) {
        console.error('[history] 讀取失敗', error);
        deps.win?.webContents.send('chat-event-apply', id, { kind: 'tool', name: `對話紀錄讀取失敗：${String(error)}` }, workspacePath);
        return null;
      }
    });

    scope.ipc.on('new-session', (event, id: string) => {
      const fromOurWindow = event.sender === deps.win?.webContents || event.sender === deps.settingsWin?.webContents
        || event.sender === deps.controlWin?.webContents;
      if (!fromOurWindow) return;
      const selected = deps.getPet(id)?.workspacePath;
      if (deps.bridge?.petStates().some((s) => s.petId === id && s.workspacePath === selected && s.running)) return;
      try { if (!deps.newSession(id)) return; deps.clearTranscript(id, false); } // 舊歷史保留，切換目前對話索引。
      catch (error) {
        console.error('[history] 建立新對話失敗', error);
        deps.win?.webContents.send('chat-event-apply', id, { kind: 'tool', name: `建立新對話失敗：${String(error)}` }, selected);
        return;
      }
      deps.petRefFiles.delete(deps.refKey(id)); // 參考檔是「當次對話」的:開新對話一併清空
      deps.sendRefFiles(id);
      deps.chatQueue.clearProject(id, selected); // 只清目前專案的待處理對話
      void deps.bridge?.closePetSession(id, deps.getPet(id)?.workspacePath);
      deps.sendPetProfiles();
    });

    // 對話送出改 invoke:回傳 {queued, position, reason?} 讓泡泡同步得知「立即執行/已排入/被拒」。
    // 「佇列已滿」不可走 error 事件——renderer 對 error 無條件 endTurn,會誤終結進行中的 turn。
    scope.ipc.handle('chat-send', (event, petId: string, text: string, rawImages: unknown, workspacePath?: string): ChatSendResult => {
      if (!deps.win || event.sender !== deps.win.webContents || !deps.pets.has(petId)) {
        return { queued: false, position: -1, reason: t('reason.invalidRequest') };
      }
      const images: ChatImage[] = [];
      if (Array.isArray(rawImages)) {
        for (const item of rawImages.slice(0, 4)) {
          if (!item || typeof item !== 'object') continue;
          const value = item as Record<string, unknown>;
          const mimeType = value['mimeType'];
          const data = value['data'];
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mimeType))) continue;
          if (typeof data !== 'string' || data.length > 11_200_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) continue;
          images.push({
            mimeType: mimeType as ChatImage['mimeType'],
            data,
            name: typeof value['name'] === 'string' ? value['name'].slice(0, 200) : undefined,
          });
        }
      }
      const trimmed = String(text).slice(0, 1000).trim();
      if (!trimmed && !images.length) return { queued: false, position: -1, reason: t('reason.emptyMessage') };
      const profile = deps.getPet(petId)!;
      const project = deps.projectFor(profile, workspacePath);
      if (!profile.enabled || !project) return { queued: false, position: -1, reason: '角色休眠或專案未綁定' };
      const result = deps.chatQueue.enqueue({ assignee: petId, workspacePath: project.workspacePath, text: trimmed, images, source: 'bubble' });
      if (!result.ok) return { queued: false, position: -1, reason: result.reason };
      deps.chatDispatcher.dispatch(petId);
      return { queued: true, position: result.position };
    });

    scope.ipc.on('chat-queue-remove', (event, petId: string, taskId: string) => {
      const fromOurWindow = event.sender === deps.win?.webContents || event.sender === deps.controlWin?.webContents;
      if (!fromOurWindow) return; // 綁定佇列撤單:泡泡與中控共用
      if (deps.chatQueue.remove(String(petId), String(taskId))) deps.markLedgerRemoved(String(taskId));
    });

    scope.ipc.handle('chat-queue-get', (event, petId: string) => {
      if (!deps.win || event.sender !== deps.win.webContents) return [];
      return deps.chatQueue.summaries(String(petId));
    });

    scope.ipc.on('chat-cancel', (event, petId: string, workspacePath?: string) => {
      if (!deps.win || event.sender !== deps.win.webContents) return;
      deps.bridge?.chatCancel(petId, workspacePath ?? deps.getPet(petId)?.workspacePath);
    });

    scope.ipc.on('chat-approval', (event, petId: string, requestId: string, allow: boolean, feedback?: string, workspacePath?: string) => {
      // 泡泡與中控都可回覆;requestId 與掛著審批的相符性由 bridge 把關(雙 UI race 在源頭擋)
      const fromOurWindow = event.sender === deps.win?.webContents || event.sender === deps.controlWin?.webContents;
      if (!fromOurWindow) return;
      deps.bridge?.respondApproval(
        petId,
        String(requestId),
        allow === true,
        typeof feedback === 'string' ? feedback.trim().slice(0, 1000) : undefined,
        workspacePath,
      );
    });

    scope.ipc.on('open-external', (event, url: string) => {
      if (!deps.win || event.sender !== deps.win.webContents) return;
      if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url);
    });
  }
  return {

    start,
    dispose: () => scope.dispose(),
  };
}
export type IpcChat = ReturnType<typeof createIpcChat>;
