import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CharacterStore, atomicYaml, parseCharacterYaml, modelHash, signature } from './characterStore';
import { SettingsStore, migrateSettings, type MigrationChoices } from './settingsStore';
import { createChatQueue, createChatDispatcher } from './chatQueue';
import { createAgentBridge } from './agent/bridge';
import { createMockProvider } from './agent/mockProvider';
import type { AgentBinding } from '../shared/agentEvents';

async function run(): Promise<void> {
  mkdirSync('/tmp/3D-pet', { recursive: true });
  const root = mkdtempSync('/tmp/3D-pet/shared-tests-');
  const shared = join(root, 'global', 'characters.yaml');
  const model = join(root, 'fox.vrm'); writeFileSync(model, 'test model');
  const hash = modelHash(readFileSync(model));
  const x = join(root, 'X'); const y = join(root, 'Y'); mkdirSync(x); mkdirSync(y);
  const legacy = join(root, 'legacy'); const runtime = join(legacy, 'runtime-data');
  mkdirSync(join(runtime, 'pets'), { recursive: true });
  writeFileSync(join(runtime, 'app.json'), JSON.stringify({ schemaVersion: 2, petIds: ['one', 'two'], selectedPetId: 'one' }));
  for (const [id, path] of [['one', x], ['two', y]]) writeFileSync(join(runtime, 'pets', `${id}.json`), JSON.stringify({ id, name: '小狐狸', enabled: false, workspacePath: path, vrmPath: model, persona: id, agent: { kind: 'codex', sessionId: `old-${id}` } }));
  let decisions = 0;
  const choices: MigrationChoices = { model: async () => model, parameters: async () => { decisions++; return 'existing'; } };
  const instanceA = new SettingsStore(join(root, 'A', 'runtime-data', 'app.yaml'));
  const a = await migrateSettings(instanceA, model, shared, choices, legacy);
  const id = a.pets[0]!.id;
  assert.equal(decisions, 1);
  assert.equal(a.pets.length, 1);
  assert.equal(a.pets[0]!.projects.length, 2);
  assert.ok(a.pets[0]!.projects.every((p) => !p.agent?.sessionId));
  assert.equal(existsSync(join(runtime, 'app.json')), true, '正式基準不可改動');
  const sharedText = readFileSync(shared, 'utf8');
  assert.ok(!sharedText.includes('workspacePath') && !sharedText.includes('sessionId'));
  const b = await migrateSettings(new SettingsStore(join(root, 'B', 'runtime-data', 'app.yaml')), model, shared, choices, legacy);
  assert.equal(decisions, 1, '新世界引用已定案的共用角色，不重新詢問基準差異');
  assert.equal(a.pets[0]!.id, b.pets[0]!.id);
  assert.equal(readFileSync(shared, 'utf8'), sharedText);
  const storeA = new CharacterStore(shared); const storeB = new CharacterStore(shared);
  assert.equal(storeA.get(id), undefined);
  storeA.loadForWake(); storeB.loadForWake();
  const before = signature(shared);
  storeA.resolve(model, hash, { name: '不覆寫' }, true, id); storeA.flush();
  assert.equal(signature(shared), before, '喚醒不寫共用檔');
  storeA.update(id, { name: '小狐狸', persona: '共用更新' }); storeA.flush();
  assert.equal(storeB.get(id)?.parameters.persona, 'one', '其他世界未喚醒不熱更新');
  storeB.loadForWake(); assert.equal(storeB.get(id)?.parameters.persona, '共用更新');
  storeA.loadForWake(); storeB.update(id, { name: '小狐狸', persona: '先儲存' }); storeB.flush();
  storeA.update(id, { name: '小狐狸', persona: '舊版本' });
  assert.throws(() => storeA.flush(), /外部修改/);
  storeB.update(id, { name: '小狐狸', persona: '鎖測試' });
  writeFileSync(`${shared}.lock`, String(process.pid));
  assert.throws(() => storeB.flush(), /其他實例/);
  const { unlinkSync } = await import('node:fs'); unlinkSync(`${shared}.lock`); storeB.flush();
  assert.throws(() => storeB.resolve(model, hash, { name: '重複' }, false, 'duplicate'), /已屬於/);
  // 正常啟動不讀角色檔；即使壞掉仍可取得本地專案清單，喚醒才回報錯誤。
  writeFileSync(shared, 'characters: [');
  assert.equal((await migrateSettings(new SettingsStore(instanceA.filePath), model, shared, choices)).pets.length, 1);
  assert.throws(() => new CharacterStore(shared).loadForWake());
  writeFileSync(shared, sharedText);
  const cancelled = new SettingsStore(join(root, 'cancelled', 'runtime-data', 'app.yaml'));
  await assert.rejects(migrateSettings(cancelled, model, join(root, 'cancel-shared.yaml'), { ...choices, parameters: async () => 'cancel' }, legacy), /取消/);
  assert.equal(existsSync(join(root, 'cancel-shared.yaml')), false);
  const bootRaw = parseCharacterYaml(readFileSync(instanceA.filePath, 'utf8')) as object;
  atomicYaml(instanceA.filePath, { ...bootRaw, port: 5174 });
  assert.throws(() => instanceA.save({ locale: 'en' }), /外部修改/);

  // 真正透過 bridge + dispatcher 驗證串行、固定任務目錄與 session 分離。
  const mock = createMockProvider('codex');
  const agents = new Map<string, AgentBinding>();
  let selected = x;
  const events: Array<{ path?: string; kind: string }> = [];
  const starts: string[] = [];
  const originalStart = mock.startSession;
  mock.startSession = async (opts) => { starts.push(opts.workdir); return originalStart(opts); };
  const queue = createChatQueue();
  const bridge = createAgentBridge({
    getPet: (_id, path = selected) => [x, y].includes(path) ? { id: 'fox', workspacePath: path, agent: agents.get(path), persona: '共用個性' } : null,
    updatePet: (_id, patch, path = selected) => agents.set(path, patch.agent),
    send: (_id, event, path) => events.push({ path, kind: event.kind }),
    providers: { codex: mock, claude: createMockProvider('claude'), agy: createMockProvider('agy') },
    onTurnFinished: () => dispatcher.dispatchAll(),
  });
  const dispatcher = createChatDispatcher({ queue, canAccept: (id) => bridge.canAccept(id), unboundCandidates: () => ['fox'],
    workspaceOf: () => selected, workspacesOf: () => [x, y], runTask: (id, task) => bridge.chatSend(id, task.text, [], task.workspacePath) });
  const waitUntil = async (predicate: () => boolean) => {
    const end = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > end) throw new Error('測試逾時'); await new Promise((r) => setTimeout(r, 10)); }
  };
  queue.enqueue({ assignee: 'fox', workspacePath: x, text: 'SLOW X', images: [], source: 'bubble' }); dispatcher.dispatchAll();
  selected = y;
  queue.enqueue({ assignee: 'fox', workspacePath: y, text: 'Y', images: [], source: 'bubble' }); dispatcher.dispatchAll();
  assert.equal(queue.size('fox'), 1, '同一隻寵物不能同時執行兩個專案');
  await waitUntil(() => events.filter((e) => e.kind === 'done').length === 2);
  assert.deepEqual(starts, [x, y]);
  assert.notEqual(agents.get(x)?.sessionId, agents.get(y)?.sessionId);
  assert.ok(events.some((e) => e.path === x) && events.some((e) => e.path === y));
  queue.enqueue({ text: '公用 X', images: [], source: 'control', restrictWorkspace: x }); dispatcher.dispatchAll();
  await waitUntil(() => events.filter((e) => e.kind === 'done').length === 3);
  assert.equal(starts.length, 2, '回到 X 沿用 X session，不用 Y session');
  queue.enqueue({ assignee: 'fox', workspacePath: x, text: 'APPROVAL', images: [], source: 'bubble' }); dispatcher.dispatchAll();
  await waitUntil(() => !!bridge.petStates()[0]?.pendingApproval);
  const request = bridge.petStates()[0]!.pendingApproval!.requestId;
  bridge.respondApproval('fox', request, true, undefined, y);
  assert.ok(bridge.petStates()[0]?.awaitingApproval, '錯誤專案不能批准');
  bridge.respondApproval('fox', request, true, undefined, x);
  await waitUntil(() => events.filter((e) => e.kind === 'done').length === 4);
  await bridge.dispose();
  console.log('通過：共用角色、跨世界版本與鎖、遷移選擇、多專案串行、固定目錄、session 與審批隔離');
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
