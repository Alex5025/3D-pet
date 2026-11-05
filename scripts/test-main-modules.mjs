import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

// 模擬 Electron 邊界，直接執行正式模組；不啟動日常桌寵或讀取其設定。
const root = process.platform === 'win32' ? join(tmpdir(), '3D-pet') : '/tmp/3D-pet';
await mkdir(root, { recursive: true });
const scratch = await mkdtemp(join(root, 'main-modules-'));
const mock = `
import { EventEmitter } from 'node:events';
export const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (name, handler) => {
  if (ipcMain.handlers.has(name)) throw new Error('重複 handle: ' + name);
  ipcMain.handlers.set(name, handler);
};
ipcMain.removeHandler = name => ipcMain.handlers.delete(name);
export const app = Object.assign(new EventEmitter(), {
  focus() {}, getLocale: () => 'zh-TW', getPath: () => '/tmp/3D-pet', getAppPath: () => process.cwd(), isPackaged: false,
});
export const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 } }),
  getCursorScreenPoint: () => ({ x: 10, y: 20 }),
});
export const powerMonitor = Object.assign(new EventEmitter(), {
  isOnBatteryPower: () => false, getCurrentThermalState: () => 'nominal',
});
export class BrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super(); this.options = options; this.destroyed = false; this.bounds = options;
    this.webContents = Object.assign(new EventEmitter(), {
      send: (...args) => this.sent.push(args), reload: () => { this.reloaded = true; },
    });
    this.sent = []; BrowserWindow.instances.push(this);
  }
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  focus() {} show() {} showInactive() {} setTitle() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
  setFocusable(value) { this.focusable = value; }
  setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
  getBounds() { return this.bounds; } setBounds(bounds) { this.bounds = bounds; }
  setOpacity() {} loadFile() { return Promise.resolve(); } loadURL() { return Promise.resolve(); }
}
export const dialog = {};
export const shell = {};
export const Menu = {};
export const nativeImage = {};
export class Tray {}
`;
const modules = ['windows', 'resourceScope', 'power', 'lifecycle', 'motions', 'characters', 'drop'];
const ipcNames = ['overlay', 'pets', 'references', 'chat', 'settings', 'control', 'menu'];
const entry = [...modules.map(n => `export * from './src/main/${n}';`), ...ipcNames.map(n => `export * from './src/main/ipc/${n}';`), `export * from 'electron';`].join('\n');
try {
  const output = join(scratch, 'modules.cjs');
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, outfile: output,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'electron-test', setup(b) {
      b.onResolve({ filter: /[./]dragMonitor$/ }, () => ({ path: 'dragMonitor', namespace: 'mock-drag' }));
      b.onLoad({ filter: /.*/, namespace: 'mock-drag' }, () => ({ contents: 'export const createDragMonitor = () => ({ setActive() {}, dispose() {} });', loader: 'js' }));
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mock, loader: 'js' }));
    } }],
  });
  const api = createRequire(import.meta.url)(output);
  const defaults = new Proxy({}, { get: () => () => undefined });
  const names = ipcNames.map(n => 'createIpc' + n[0].toUpperCase() + n.slice(1));
  const expected = JSON.parse(await readFile(new URL('./fixtures/main-ipc-channels.json', import.meta.url), 'utf8'));
  // pet-rects 由拖放服務註冊，其餘通道由 IPC 模組註冊。
  for (let run = 0; run < 2; run++) {
    const services = [...names.map(name => api[name](defaults)), api.createDrop(defaults)];
    for (const service of services) { await service.start(); await service.start(); }
    const registered = [
      ...[...api.ipcMain.handlers.keys()].map(name => ({ kind: 'handle', name })),
      ...api.ipcMain.eventNames().map(name => ({ kind: 'on', name })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(registered, expected, 'IPC 名稱與註冊類型不得改變');
    for (const name of api.ipcMain.eventNames()) assert.equal(api.ipcMain.listenerCount(name), 1);
    for (const service of services.reverse()) { service.dispose(); service.dispose(); }
    assert.equal(api.ipcMain.handlers.size, 0);
    assert.equal(api.ipcMain.eventNames().length, 0);
  }
  // 執行中的泡泡設定也必須保存，並在新設定寫入後等待舊 session 關閉。
  const activePet = { id: 'fox', name: '狐狸', workspacePath: '/project', agent: { kind: 'codex', sessionId: 'existing' } };
  const sharedMotions = join(scratch, 'shared-motions');
  await mkdir(sharedMotions);
  const poseData = Buffer.from('共用預設姿勢');
  await writeFile(join(sharedMotions, 'default.vrma'), poseData);
  activePet.defaultPose = 'default.vrma';
  const petWindow = { webContents: {} };
  const changes = [];
  const petIpc = api.createIpcPets(new Proxy({
    win: petWindow, getPet: () => activePet, motionsDir: () => sharedMotions,
    updatePet: (_id, patch) => { Object.assign(activePet, patch); changes.push('saved'); return activePet; },
    sendPetProfiles: () => changes.push('broadcast'),
    bridge: {
      petStates: () => [{ petId: 'fox', workspacePath: '/project', running: true }],
      closePetSession: async () => { assert.equal(activePet.agent.model, 'new-model'); await Promise.resolve(); changes.push('closed'); },
    },
  }, { get(target, key) { return key in target ? target[key] : defaults[key]; } }));
  await petIpc.start();
  const readPose = api.ipcMain.handlers.get('get-default-pose');
  assert.deepEqual(await readPose({}, 'fox'), poseData, '啟動姿勢必須讀共用動作目錄，不依賴 worktree 資料目錄');
  activePet.defaultPose = undefined;
  assert.equal(await readPose({}, 'fox'), null, '未指定姿勢不載入');
  activePet.defaultPose = 'missing.vrma';
  assert.equal(await readPose({}, 'fox'), null, '缺少動作不阻止模型啟動');

  await api.ipcMain.handlers.get('update-pet-meta')({ sender: petWindow.webContents }, 'fox', {
    agent: { kind: 'codex', sessionId: 'existing', model: 'new-model', effort: 'high', permission: 'auto' },
  });
  assert.deepEqual(changes, ['saved', 'broadcast', 'closed']);
  assert.equal(activePet.agent.effort, 'high');
  assert.equal(activePet.agent.permission, 'auto');
  changes.length = 0;
  await api.ipcMain.handlers.get('update-pet-meta')({ sender: petWindow.webContents }, 'fox', { agent: { ...activePet.agent } });
  assert.deepEqual(changes, ['saved', 'broadcast'], '重選相同設定不中斷');
  petIpc.dispose();
  const registry = { selectedPetId: 'fox' };
  const windows = api.createWindows({ registry, selectPet() {} });
  assert.equal(api.BrowserWindow.instances.length, 0, '建立服務不開視窗');
  const overlay = windows.createOverlay();
  assert.equal(windows.createOverlay(), overlay, '不重複建立疊層');
  const calls = [];
  const settings = api.createIpcSettings(new Proxy({
    get win() { return windows.win; }, get settingsWin() { return windows.settingsWin; },
    get controlWin() { return windows.controlWin; }, pets: new Map([['fox', {}]]),
    chooseVrm: async (...args) => { calls.push(args); },
    chooseWorkspace: async (...args) => { calls.push(args); },
  }, { get(target, key) { return key in target ? target[key] : defaults[key]; } }));
  await settings.start();
  const workspace = api.ipcMain.handlers.get('choose-workspace');
  await workspace({ sender: overlay.webContents }, 'fox');
  assert.deepEqual(calls.pop(), ['fox', undefined], '泡泡可立即選工作目錄');
  await workspace({ sender: {} }, 'fox');
  assert.equal(calls.length, 0);
  const choose = api.ipcMain.handlers.get('choose-vrm');
  await choose({ sender: overlay.webContents }, 'fox');
  assert.deepEqual(calls.pop(), ['fox', undefined], '疊層不作為 sheet 父窗');
  windows.openSettings('char', 'fox');
  const first = windows.settingsWin;
  await choose({ sender: first.webContents }, 'fox');
  assert.deepEqual(calls.pop(), ['fox', first]);
  await choose({ sender: overlay.webContents }, 'fox');
  assert.deepEqual(calls.pop(), ['fox', undefined]);
  windows.openControlPanel();
  assert.equal(first.isDestroyed(), true);
  assert.equal(windows.settingsWin, null);
  await choose({ sender: first.webContents }, 'fox');
  await choose({ sender: {} }, 'fox');
  await choose({ sender: overlay.webContents }, 'missing');
  assert.equal(calls.length, 0, '舊視窗、未知 sender 與無效角色不可選模型');
  const control = windows.controlWin;
  windows.openSettings();
  assert.equal(control.isDestroyed(), true);
  await choose({ sender: windows.settingsWin.webContents }, 'fox');
  assert.equal(calls.pop()[1], windows.settingsWin, '重開後使用新視窗授權');
  windows.setInputMode(true); windows.setInteractive(true); windows.syncOverlayMouseEvents();
  assert.equal(overlay.ignoreMouse, false);
  overlay.webContents.emit('render-process-gone', {}, { reason: 'test' });
  assert.equal(overlay.ignoreMouse, true);
  assert.equal(overlay.focusable, false);
  assert.equal(overlay.reloaded, true);
  overlay.destroy();
  await choose({ sender: overlay.webContents }, 'fox');
  assert.equal(calls.length, 0, '已關閉疊層不可操作');
  settings.dispose(); windows.dispose();

  const powerWindow = new api.BrowserWindow({ x: 0, y: 0, width: 800, height: 600 });
  for (let run = 0; run < 2; run++) {
    const power = api.createPower({ win: powerWindow, pets: new Map([['fox', { enabled: true }]]), dragMonitor: null });
    await power.start(); await power.start();
    assert.equal(api.screen.listenerCount('display-added'), 1);
    assert.equal(api.powerMonitor.listenerCount('suspend'), 1);
    api.powerMonitor.emit('suspend');
    assert.equal(power.isIdleMotionPaused(), true);
    api.powerMonitor.emit('resume');
    assert.equal(power.isIdleMotionPaused(), false);
    power.dispose(); power.dispose();
    assert.equal(api.screen.eventNames().length, 0);
    assert.equal(api.powerMonitor.eventNames().length, 0);
    assert.equal(powerWindow.webContents.listenerCount('did-finish-load'), 0);
  }
  // 真正建立檔案 watcher，確認清理關閉且不留下回呼。
  const motionDir = join(scratch, 'motions'); await mkdir(motionDir);
  let refreshes = 0;
  for (let run = 0; run < 2; run++) {
    const motions = api.createMotions({ motionsDir: () => motionDir, pets: new Map(), refreshTray: () => refreshes++ });
    await motions.start(); await motions.start();
    assert.ok(motions.motionsWatcher);
    motions.dispose(); motions.dispose();
    assert.equal(motions.motionsWatcher, null);
  }
  await writeFile(join(motionDir, 'test.vrma'), 'test');

  let fired = 0;
  const scope = api.createResourceScope();
  const emitter = new EventEmitter();
  const foreign = () => {};
  api.ipcMain.on('foreign', foreign);
  scope.ipc.on('foreign', () => fired++);
  scope.timeout(() => fired++, 5);
  scope.interval(() => fired++, 5);
  scope.listen(emitter, 'test', () => fired++);
  scope.dispose(); scope.dispose();
  emitter.emit('test'); api.ipcMain.emit('foreign');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(fired, 0); assert.equal(refreshes, 0);
  assert.equal(api.ipcMain.listenerCount('foreign'), 1, '只移除自身監聽器');
  api.ipcMain.removeListener('foreign', foreign);

  // 真正讀寫隔離 YAML，涵蓋角色服務的喚醒、立即儲存與外部個性重新載入。
  const runtime = join(scratch, 'runtime-data');
  const project = join(scratch, 'project');
  await mkdir(runtime); await mkdir(project);
  const model = join(scratch, 'model.vrm'); await writeFile(model, 'fixture');
  const charactersPath = join(scratch, 'characters.yaml');
  const stored = { schemaVersion: 3, characters: [{ schemaVersion: 1, id: 'fox',
    modelHash: createHash('sha256').update('fixture').digest('hex'), vrmPath: model,
    parameters: { name: '測試角色', persona: '原個性' } }] };
  await writeFile(charactersPath, YAML.stringify(stored));
  await writeFile(join(runtime, 'app.yaml'), YAML.stringify({ schemaVersion: 2, initialized: true, port: 52749,
    charactersPath, selectedPetId: 'fox', pets: [{ id: 'fox', name: '測試角色', enabled: true,
      workspacePath: project, projects: [{ workspacePath: project }] }] }));
  const characterService = api.createCharacters(new Proxy({
    history: undefined, runtimeDataDir: () => runtime, defaultVrmPath: () => model, modelsDir: () => scratch,
    bridge: null, win: null, settingsWin: null, controlWin: null,
  }, { get(target, key) { return key in target ? target[key] : defaults[key]; } }));
  characterService.prepareStore(); await characterService.loadConfig();
  await characterService.initializeCharacters();
  assert.equal(characterService.getPet('fox').characterReady, true);
  assert.equal(characterService.getPet('fox').persona, '原個性');
  characterService.updatePet('fox', { persona: '即時更新' });
  assert.equal(YAML.parse(await readFile(charactersPath, 'utf8')).characters[0].parameters.persona, '即時更新');
  await characterService.setPetEnabled('fox', false);
  assert.equal(characterService.getPet('fox').characterReady, false);
  stored.characters[0].parameters.persona = '外部個性';
  await writeFile(charactersPath, YAML.stringify(stored));
  await characterService.setPetEnabled('fox', true);
  assert.equal(characterService.getPet('fox').persona, '外部個性');
  assert.equal(characterService.getPet('fox').characterReady, true);
  characterService.dispose();

  const order = [];
  const lifecycle = api.createLifecycle({
    pets: new Map(), stopBackground() { order.push('background'); throw new Error('預期測試錯誤'); },
    stopAgents() { order.push('agents'); }, persistConfigSync() { order.push('save'); },
    closeWindows() { order.push('windows'); },
  });
  lifecycle.start(); lifecycle.start();
  lifecycle.shutdownSync(); lifecycle.shutdownSync(); lifecycle.dispose();
  assert.deepEqual(order, ['background', 'agents', 'save', 'windows']);
  assert.equal(api.app.listenerCount('before-quit'), 0);
  console.log('通過：IPC 契約、重複註冊／清理、視窗重新授權、崩潰恢復、省電監聽、動作 watcher 與結束儲存');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
