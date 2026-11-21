import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.platform === 'win32' ? join(tmpdir(), '3D-pet') : '/tmp/3D-pet';
await mkdir(root, { recursive: true });
const scratch = await mkdtemp(join(root, 'screen-capture-'));
const mock = `
import { EventEmitter } from 'node:events';
export const state = { permission: 'granted', calls: 0, sources: [], fail: false, wait: null, display: 2 };
export const systemPreferences = { getMediaAccessStatus: () => state.permission };
export const screen = { getCursorScreenPoint: () => ({ x: -100, y: 20 }), getDisplayNearestPoint: () => ({ id: state.display }) };
export const desktopCapturer = { getSources: async options => {
  state.calls++; state.options = options;
  if (state.wait) await state.wait;
  if (state.fail) throw Error('capture failed');
  return state.sources;
} };
export const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (name, handler) => ipcMain.handlers.set(name, handler);
ipcMain.removeHandler = name => ipcMain.handlers.delete(name);
export const shell = {};
export class BrowserWindow {}
`;
try {
  const output = join(scratch, 'test.cjs');
  await build({ stdin: { contents: "export * from './src/main/screenCapture'; export * from './src/main/ipc/chat'; export * from 'electron';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'electron-mock', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mock, loader: 'js' }));
    } }],
  });
  const { captureScreen, createIpcChat, ipcMain, state } = createRequire(import.meta.url)(output);
  const source = (id, content, empty = false) => ({ display_id: String(id), thumbnail: {
    isEmpty: () => empty, toJPEG: () => Buffer.from(content),
  } });
  state.sources = [source(1, 'wrong-display'), source(2, 'target-display')];
  const captured = await captureScreen();
  assert.equal(captured.ok, true);
  assert.equal(Buffer.from(captured.image.data, 'base64').toString(), 'target-display', '多螢幕必須依 display_id 擷取游標所在畫面');
  assert.deepEqual(state.options.types, ['screen']);
  assert.equal(state.options.thumbnailSize.width, 2560);
  state.display = 9;
  assert.equal((await captureScreen()).ok, false, '多螢幕對應失敗不可靜默送出另一個螢幕');
  state.sources = [source('', 'single-display')];
  assert.equal((await captureScreen()).ok, true, '只有一個來源時允許平台缺少 display_id');
  state.sources = [source(9, '', true)];
  assert.equal((await captureScreen()).ok, false, '空畫面不作為附件');
  state.sources = [source(9, Buffer.alloc(8 * 1024 * 1024 + 1))];
  assert.equal((await captureScreen()).ok, false, '過大圖片不得交給聊天管線靜默丟棄');
  state.sources = [source(9, 'screenshot')];
  if (process.platform === 'darwin') {
    state.permission = 'denied';
    const before = state.calls;
    assert.match((await captureScreen()).reason, /螢幕.*錄製/);
    assert.equal(state.calls, before, '拒絕權限後不再次觸發截圖');
    state.permission = 'not-determined';
    assert.equal((await captureScreen()).ok, false, '未取得權限時不可把只有桌布的圖片當成成功');
    state.permission = 'granted';
  }
  state.fail = true;
  assert.equal((await captureScreen()).ok, false);
  state.fail = false;

  const win = { webContents: { mainFrame: {} } };
  const pets = new Map([['fox', { enabled: true }], ['sleeping', { enabled: false }]]);
  const service = createIpcChat({ win, pets });
  await service.start();
  const handler = ipcMain.handlers.get('chat-capture-screen');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const before = state.calls;
  for (const [request, petId] of [[{ sender: {} }, 'fox'], [{ ...event, senderFrame: {} }, 'fox'], [event, 'missing'], [event, 'sleeping']]) {
    assert.equal((await handler(request, petId)).ok, false);
  }
  assert.equal(state.calls, before, '錯誤視窗、子框架、無效或休眠角色不可擷取螢幕');
  let finish;
  state.wait = new Promise(resolve => { finish = resolve; });
  const first = handler(event, 'fox');
  assert.equal((await captureScreen()).ok, false, 'AI 與手動擷取必須共用同一個鎖');
  assert.equal((await handler(event, 'fox')).ok, false, '同時只能進行一次截圖');
  finish();
  assert.equal((await first).ok, true);
  state.wait = null;
  assert.equal((await handler(event, 'fox')).ok, true, '截圖完成後解除鎖定');
  service.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  console.log('通過：螢幕選擇、權限與空圖處理、附件大小、IPC 授權、截圖並行保護');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
