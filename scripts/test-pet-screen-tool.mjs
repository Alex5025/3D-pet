import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.platform === 'win32' ? join(tmpdir(), '3D-pet') : '/tmp/3D-pet';
await mkdir(root, { recursive: true });
const scratch = await realpath(await mkdtemp(join(root, 'pet-screen-')));
const clients = [];
const services = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw Error('等待測試狀態逾時'); await sleep(10); }
}
function client(hub, petId = 'fox', token = hub.token) {
  const child = spawn(process.execPath, [hub.scriptPath], { env: { ...process.env,
    VRM_PET_TOOLS_SOCKET: hub.socketPath, VRM_PET_TOOLS_TOKEN: token, VRM_PET_PET_ID: petId }, stdio: ['pipe', 'pipe', 'inherit'] });
  clients.push(child);
  const pending = new Map();
  let seq = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP 逾時：${method}`)); }, 8000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { request, capture: () => request('tools/call', { name: 'pet_capture_screen', arguments: {} }) };
}

try {
  const output = join(scratch, 'modules.cjs');
  await build({ stdin: { contents: "export * from './src/main/chat'; export * from './src/main/ipc/chat'; export * from './src/main/agent/petToolsHub'; export * from './src/main/screenCapture'; export { ipcMain } from 'electron';", resolveDir: process.cwd(), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'test-boundaries', setup(b) {
      b.onResolve({ filter: /\/runtimeStorage$/ }, () => ({ path: 'runtime', namespace: 'mock' }));
      b.onResolve({ filter: /\/screenCapture$/ }, () => ({ path: 'capture', namespace: 'mock' }));
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents: path === 'runtime'
        ? `import { mkdtempSync } from 'node:fs'; import { join } from 'node:path'; export const agentTempDirectory = prefix => mkdtempSync(join(${JSON.stringify(scratch)}, prefix));`
        : path === 'capture'
          ? `export const captureState = { calls: 0, wait: null, result: null }; export async function captureScreen() { captureState.calls++; if (captureState.wait) await captureState.wait; return captureState.result; }`
          : `import { EventEmitter } from 'node:events'; export class BrowserWindow {} export const ipcMain = new EventEmitter(); ipcMain.handlers = new Map(); ipcMain.handle = (name, handler) => ipcMain.handlers.set(name, handler); ipcMain.removeHandler = name => ipcMain.handlers.delete(name); export const shell = {}; export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(process.cwd())} };`,
      }));
    } }],
  });
  const { createPetToolsHub, createChat, createIpcChat, ipcMain, captureState } = createRequire(import.meta.url)(output);
  // 超過 socket 單一區塊，確認圖片沒有被當成字串或截斷。
  const image = { mimeType: 'image/png', data: Buffer.alloc(200_000, 123).toString('base64') };
  let captureCalls = 0;
  let denied = false;
  const hub = createPetToolsHub({ listMotions: () => [], playMotion: async () => true, showExpression: () => true, speak: () => true,
    captureScreen: async petId => { captureCalls++; return denied || petId !== 'fox'
      ? { ok: false, reason: '測試：沒有螢幕錄製權限' } : { ok: true, image }; },
  });
  services.push(hub);
  const mcp = client(hub);
  assert.equal((await mcp.request('initialize', { protocolVersion: '2024-11-05' })).result.capabilities.tools !== undefined, true);
  const tools = (await mcp.request('tools/list')).result.tools;
  const schema = tools.find(tool => tool.name === 'pet_capture_screen');
  assert.ok(schema);
  assert.equal(schema.annotations.readOnlyHint, true);
  const result = (await mcp.capture()).result;
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.find(item => item.type === 'image'), { type: 'image', ...image });
  assert.equal(captureCalls, 1);
  denied = true;
  const failure = (await mcp.capture()).result;
  assert.equal(failure.isError, true);
  assert.equal(failure.content.some(item => item.type === 'image'), false);
  assert.match(failure.content[0].text, /螢幕錄製權限/);
  assert.equal((await mcp.request('tools/call', { name: 'unknown', arguments: {} })).error.code, -32602);
  const calls = captureCalls;
  const forged = client(hub, 'fox', 'wrong-token');
  assert.equal((await forged.request('tools/list')).result.tools.some(tool => tool.name === 'pet_capture_screen'), false);
  assert.ok((await forged.capture()).error);
  assert.equal(captureCalls, calls, '錯誤 token 不得觸發擷取');

  // 真實 chat/bridge/hub 管線，只有 OS 擷取與 AI 回覆使用替身。
  process.env.VRM_PET_AGENT_MOCK = '1';
  captureState.result = { ok: true, image };
  const profile = { id: 'fox', enabled: true, workspacePath: scratch, agent: { kind: 'codex' }, projects: [{ workspacePath: scratch, agent: { kind: 'codex' } }] };
  const events = [];
  const storedTurns = [];
  const deps = {
    win: { webContents: { send(channel, petId, event, workspacePath, revision) { if (channel === 'chat-event-apply') events.push({ petId, workspacePath, revision, ...event }); } } },
    history: { conversation: () => 'conversation', saveTurn(turn) { storedTurns.push({ ...turn }); }, latest: () => null },
    getPet: id => id === 'fox' ? profile : null, pets: new Map([['fox', profile]]),
    finishLedgerTask() {}, scheduleControlStatus() {}, taskLedger: new Map(), runningTaskByPet: new Map(), motionFiles: [], motionsDir: () => scratch,
    projectFor: (_profile, path) => !path || path === scratch ? profile.projects[0] : undefined,
    petRefFiles: new Map(), refKey: () => 'fox', scheduleConfigFlush() {},
  };
  const chat = createChat(deps);
  services.push(chat);
  await chat.start();
  const ipc = createIpcChat({ ...deps, ...chat });
  services.push(ipc);
  await ipc.start();
  const readTranscript = path => ipcMain.handlers.get('chat-transcript-get')({ sender: deps.win.webContents }, 'fox', path ?? scratch);
  const liveMcp = client(chat.petToolsHub);
  assert.equal((await liveMcp.capture()).result.isError, true);
  assert.equal(captureState.calls, 0, '閒置時不擷取畫面');
  chat.chatQueue.enqueue({ assignee: 'fox', workspacePath: scratch, text: 'SLOW 畫面測試', images: [], source: 'bubble' });
  chat.dispatchAll();
  await waitFor(() => chat.bridge.petStates().some(state => state.running));
  assert.equal((await liveMcp.capture()).result.isError, false);
  assert.ok(events.some(event => event.kind === 'tool' && event.name === '正在查看螢幕…'));
  assert.ok(events.some(event => event.kind === 'tool' && event.name === '已取得螢幕畫面'));
  const preview = events.find(event => event.kind === 'screenCapture');
  assert.deepEqual(preview.image, image, '泡泡預覽與 AI 工具拿到相同圖片');
  assert.equal(preview.petId, 'fox');
  assert.equal(preview.workspacePath, scratch);
  assert.ok(preview.revision > 0);
  assert.deepEqual((await readTranscript()).screenPreview, image, '執行中重建泡泡可回填預覽');
  assert.equal(await readTranscript('/other-project'), null, '不向其他專案回填截圖');
  captureState.result = { ok: false, reason: '測試：擷取失敗' };
  assert.equal((await liveMcp.capture()).result.isError, true);
  assert.equal(events.filter(event => event.kind === 'screenCapture').length, 1, '失敗不推送圖片事件');
  captureState.result = { ok: true, image };
  profile.enabled = false;
  assert.equal((await liveMcp.capture()).result.isError, true);
  assert.equal(captureState.calls, 2, '休眠時不可擷取');
  profile.enabled = true;
  const otherPet = client(chat.petToolsHub, 'missing');
  assert.equal((await otherPet.capture()).result.isError, true);
  assert.equal(captureState.calls, 2, '不明角色不可擷取');
  let release;
  captureState.wait = new Promise(resolve => { release = resolve; });
  const pending = liveMcp.capture();
  await waitFor(() => captureState.calls === 3);
  chat.bridge.chatCancel('fox', scratch);
  await waitFor(() => !chat.liveTranscripts.has('fox'));
  release();
  const cancelled = (await pending).result;
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.content.some(item => item.type === 'image'), false, '取消後丟棄尚未返回的畫面');
  assert.equal(events.filter(event => event.kind === 'screenCapture').length, 1, '取消後不推送新預覽');
  assert.deepEqual((await readTranscript()).screenPreview, image, '回覆結束後保留當輪成功的預覽');
  assert.ok(storedTurns.every(turn => !('screenPreview' in turn)), '預覽圖片不寫入對話資料庫');
  chat.clearTranscript('fox', false);
  assert.equal(await readTranscript(), null, '新對話清除記憶體中的預覽');
  console.log('通過：MCP 圖片回傳與泡泡預覽同步、專案隔離、執行中／完成回填、錯誤與取消清理');
} finally {
  for (const child of clients) { child.stdin.end(); child.kill(); }
  for (const service of services.reverse()) service.dispose();
  await rm(scratch, { recursive: true, force: true });
}
