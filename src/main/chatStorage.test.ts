import assert from 'node:assert/strict';
import { app, type BrowserWindow } from 'electron';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createChat } from './chat';
import { HistoryStore } from './historyStore';
import type { PetProfile } from './runtimeTypes';
import type { AgentEvent } from '../shared/agentEvents';

const root = realpathSync(mkdtempSync('/tmp/3D-pet/chat-storage-'));
process.env['VRM_PET_DATA_DIR'] = root;
process.env['VRM_PET_AGENT_MOCK'] = '1';
const timeout = setTimeout(() => { console.error('對話儲存整合測試逾時'); app.exit(1); }, 15000);
void app.whenReady().then(async () => {
  const history = new HistoryStore(join(root, 'runtime_data/history.sqlite'));
  history.initialize();
  const observer = new Database(history.filePath);
  const profile = { id: 'fox', name: '狐狸', enabled: true, workspacePath: root,
    projects: [{ workspacePath: root, agent: { kind: 'codex' as const } }],
  } as PetProfile;
  const events: AgentEvent[] = [];
  const win = { webContents: { send(channel: string, _id: string, event: AgentEvent) { if (channel === 'chat-event-apply') events.push(event); } } } as unknown as BrowserWindow;
  const chat = createChat({ history, win, getPet: () => profile, finishLedgerTask() {}, scheduleControlStatus() {},
    pets: new Map([[profile.id, profile]]), taskLedger: new Map(), runningTaskByPet: new Map(), motionFiles: [], motionsDir: () => root,
    projectFor: () => profile.projects![0], petRefFiles: new Map(), refKey: () => 'fox', scheduleConfigFlush() {},
  });
  const waitFor = async (check: () => boolean) => {
    const end = Date.now() + 5000;
    while (!check()) { if (Date.now() > end) throw new Error('等待對話逾時'); await new Promise(r => setTimeout(r, 10)); }
  };
  const send = (text: string) => { chat.chatQueue.enqueue({ assignee: profile.id, workspacePath: root, text, images: [], source: 'bubble' }); chat.dispatchAll(); };
  try {
    await chat.start();
    send('SLOW 測試串流');
    await waitFor(() => !!observer.prepare("SELECT 1 FROM turns WHERE status='running' AND length(reply)>0").get());
    assert.equal(events.some(event => event.kind === 'done'), false, '完成前已落盤部分串流');
    await waitFor(() => events.some(event => event.kind === 'done'));
    assert.equal((observer.prepare('SELECT status FROM turns').get() as { status: string }).status, 'completed');
    assert.ok(history.latest('fox', root)?.reply.includes('測試串流'));
    chat.clearTranscript('fox');
    assert.equal(history.latest('fox', root), null);
    assert.equal((observer.prepare('SELECT count(*) AS n FROM turns').get() as { n: number }).n, 1);
    send('SLOW 退出');
    await waitFor(() => events.filter(event => event.kind === 'text').length >= 4);
    chat.dispose();
    assert.equal((observer.prepare('SELECT status FROM turns ORDER BY at DESC LIMIT 1').get() as { status: string }).status, 'interrupted');
    assert.equal(existsSync(join(root, 'runtime_data/history.sqlite')), true);
    const stored = history.latest('fox', root);
    history.close(); history.initialize();
    assert.deepEqual(history.latest('fox', root), stored, '重啟後讀回上一輪');
    console.log('通過：Electron 原生 SQLite、實際 MockProvider 串流秒存、結束落盤、新對話與重啟回填');
  } finally {
    chat.dispose(); history.close(); observer.close(); clearTimeout(timeout);
    rmSync(root, { recursive: true, force: true });
  }
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
