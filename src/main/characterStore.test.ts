import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterStore, atomicYaml, parseCharacterYaml, modelHash, signature, writeCharacters } from './characterStore';
import { SettingsStore, migrateSettings, type MigrationChoices } from './settingsStore';
import { createChatQueue, createChatDispatcher } from './chatQueue';
import { createAgentBridge } from './agent/bridge';
import { createMockProvider } from './agent/mockProvider';
import type { AgentBinding } from '../shared/agentEvents';

async function run(): Promise<void> {
  const scratch = join(tmpdir(), '3D-pet');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'shared-tests-'));
  const shared = join(root, 'global', 'characters.yaml');
  const model = join(root, 'fox.vrm'); writeFileSync(model, 'test model');
  const hash = modelHash(readFileSync(model));
  const x = join(root, 'X'); const y = join(root, 'Y'); mkdirSync(x); mkdirSync(y);
  const legacy = join(root, 'legacy'); const runtime = join(legacy, 'runtime-data');
  mkdirSync(join(runtime, 'pets'), { recursive: true });
  writeFileSync(join(runtime, 'app.json'), JSON.stringify({ schemaVersion: 2, petIds: ['one', 'two'], selectedPetId: 'one' }));
  for (const [id, path] of [['one', x], ['two', y]]) writeFileSync(join(runtime, 'pets', `${id}.json`), JSON.stringify({ id, name: id === 'one' ? '小狐狸' : '八重神子', wardrobe: { coat: id === 'one' }, lighting: { type: 'directional', ambient: 1.8, directional: id === 'one' ? 1.05 : 1, x: 0, y: 1, z: 2, shade: id === 'one' ? 0.25 : 0.15, temperature: id === 'one' ? 7000 : 6500 }, enabled: false, workspacePath: path, vrmPath: model, persona: id, agent: { kind: 'codex', sessionId: `old-${id}` } }));
  let decisions = 0;
  const choices: MigrationChoices = { model: async () => model, parameters: async () => { decisions++; return 'existing'; } };
  // 舊工作區已刪除時仍能遷移，保留綁定、session 與對話內容，且不重建目錄。
  const missingRuntime = join(root, 'missing', 'runtime-data');
  const missingWorkspace = join(root, 'removed-workspace');
  mkdirSync(join(missingRuntime, 'transcripts'), { recursive: true });
  writeFileSync(join(missingRuntime, 'config.json'), JSON.stringify({
    id: 'missing-pet', name: '離線角色', enabled: false, vrmPath: model,
    workspacePath: missingWorkspace, agent: { kind: 'codex', sessionId: 'keep-session' },
  }));
  const transcript = JSON.stringify({ user: '保留對話', reply: '保留回覆', at: Date.now() });
  writeFileSync(join(missingRuntime, 'transcripts', 'missing-pet.json'), transcript);
  const missingStore = new SettingsStore(join(missingRuntime, 'app.yaml'));
  const missing = await migrateSettings(missingStore, model, join(root, 'missing-characters.yaml'), choices);
  assert.equal(missing.pets[0]?.workspacePath, missingWorkspace);
  assert.equal(missing.pets[0]?.projects[0]?.agent?.sessionId, 'keep-session');
  assert.equal(existsSync(missingWorkspace), false);
  const transcriptKey = modelHash(Buffer.from(JSON.stringify(['missing-pet', missingWorkspace])));
  assert.equal(readFileSync(join(missingRuntime, 'transcripts', `${transcriptKey}.json`), 'utf8'), transcript);
  assert.deepEqual(await migrateSettings(new SettingsStore(missingStore.filePath), model, missing.charactersPath, choices), missing);
  const instanceA = new SettingsStore(join(root, 'A', 'runtime-data', 'app.yaml'));
  const a = await migrateSettings(instanceA, model, shared, choices, legacy);
  const id = a.pets[0]!.id;
  assert.equal(decisions, 0);
  assert.equal(a.pets.length, 2);
  assert.equal(a.pets[0]!.projects.length, 1);
  assert.deepEqual(a.pets.map((p) => p.id), ['one', 'two']);
  assert.ok(a.pets[0]!.projects.every((p) => !p.agent?.sessionId));
  assert.equal(existsSync(join(runtime, 'app.json')), true, '正式基準不可改動');
  const sharedText = readFileSync(shared, 'utf8');
  assert.ok(!sharedText.includes('workspacePath') && !sharedText.includes('sessionId'));
  const b = await migrateSettings(new SettingsStore(join(root, 'B', 'runtime-data', 'app.yaml')), model, shared, choices, legacy);
  assert.equal(decisions, 0, '新世界引用已定案的共用角色，不重新詢問基準差異');
  assert.equal(a.pets[0]!.id, b.pets[0]!.id);
  assert.equal(readFileSync(shared, 'utf8'), sharedText);
  const storeA = new CharacterStore(shared); const storeB = new CharacterStore(shared);
  assert.equal(storeA.get(id), undefined);
  storeA.loadForWake(); storeB.loadForWake();
  assert.equal(storeA.get('one')?.parameters.lighting?.temperature, 7000);
  assert.equal(storeA.get('two')?.parameters.lighting?.temperature, 6500);
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
  storeB.flush();
  const independent = storeB.resolve(model, hash, { name: '另一隻', wardrobe: { coat: true } }, false, 'independent');
  storeB.flush(); storeB.loadForWake();
  assert.equal(storeB.get('two')?.parameters.name, '八重神子');
  assert.equal(storeB.get('two')?.parameters.persona, 'two');
  assert.equal(storeB.get('two')?.parameters.wardrobe?.coat, false);
  independent.parameters.wardrobe!.coat = false;
  assert.equal(storeB.get('independent')?.parameters.wardrobe?.coat, true, '重新載入後不共享舊物件');
  assert.throws(() => writeCharacters(shared, signature(shared), [storeB.get(id)!, storeB.get(id)!]), /ID 重複/);
  const replacement = join(root, 'replacement.vrm'); writeFileSync(replacement, 'different model');
  storeB.resolve(replacement, modelHash(readFileSync(replacement)), { name: '不覆寫' }, true, id);
  storeB.update(id, { ...storeB.get(id)!.parameters, name: '改名小狐狸' }); storeB.flush();
  assert.equal(storeB.get(id)?.id, id);
  assert.equal(storeB.get('two')?.vrmPath, realpathSync(model));
  assert.equal(storeB.get('two')?.parameters.name, '八重神子');
  // 外部個性與本地光影可合併，且後續儲存不可把舊個性寫回。
  const mergePath = join(root, 'merge.yaml');
  atomicYaml(mergePath, { schemaVersion: 3, characters: storeB.all() });
  const localStore = new CharacterStore(mergePath); localStore.loadForWake();
  const externalStore = new CharacterStore(mergePath); externalStore.loadForWake();
  externalStore.update(id, { ...externalStore.get(id)!.parameters, persona: '外部新增個性' });
  externalStore.update('two', { ...externalStore.get('two')!.parameters, persona: '另一角色外部個性' });
  externalStore.flush();
  localStore.update(id, { ...localStore.get(id)!.parameters, wardrobe: { coat: false } }); localStore.flush();
  localStore.update(id, { ...localStore.get(id)!.parameters, name: '本地改名' }); localStore.flush();
  assert.notEqual(localStore.get(id)!.parameters.persona, '外部新增個性', '不熱更新執行中個性');
  const verified = new CharacterStore(mergePath); verified.loadForWake();
  assert.equal(verified.get(id)!.parameters.persona, '外部新增個性');
  assert.equal(verified.get(id)!.parameters.name, '本地改名');
  assert.equal(verified.get(id)!.parameters.wardrobe!.coat, false);
  assert.equal(verified.get('two')!.parameters.persona, '另一角色外部個性');
  const beforeConflict = readFileSync(verified.filePath);
  localStore.update(id, { ...localStore.get(id)!.parameters, persona: '本地不同個性' });
  assert.throws(() => localStore.flush(), /同一欄位/);
  assert.deepEqual(readFileSync(verified.filePath), beforeConflict);
  // 正常啟動不讀角色檔；即使壞掉仍可取得本地專案清單，喚醒才回報錯誤。
  const databaseBackup = readFileSync(storeB.filePath);
  writeFileSync(storeB.filePath, 'not a database');
  assert.equal((await migrateSettings(new SettingsStore(instanceA.filePath), model, shared, choices)).pets.length, 2);
  assert.throws(() => new CharacterStore(shared).loadForWake());
  writeFileSync(storeB.filePath, databaseBackup);
  // 同 ID 的真正版本衝突仍可取消，來源及共用檔皆不可被改動。
  const cancelRuntime = join(root, 'cancelled', 'runtime-data');
  cpSync(runtime, cancelRuntime, { recursive: true });
  const cancelShared = join(root, 'cancel-shared.yaml');
  const cancelDocs = new CharacterStore(shared); cancelDocs.loadForWake();
  atomicYaml(cancelShared, { schemaVersion: 3, characters: cancelDocs.all().map((d) => ({ ...d, parameters: { ...d.parameters, persona: 'conflict' } })) });
  const beforeCancel = readFileSync(cancelShared, 'utf8');
  await assert.rejects(migrateSettings(new SettingsStore(join(cancelRuntime, 'app.yaml')), model, cancelShared, { ...choices, parameters: async () => 'cancel' }), /取消/);
  assert.equal(readFileSync(cancelShared, 'utf8'), beforeCancel);
  assert.ok(existsSync(join(cancelRuntime, 'app.json')));
  // 無 ID 的舊資料在不同工作樹初始化時得到相同 ID。
  const noId = join(root, 'no-id'); mkdirSync(noId);
  writeFileSync(join(noId, 'config.json'), JSON.stringify({ name: '無 ID', vrmPath: model, workspacePath: x }));
  const noIdShared = join(root, 'no-id-shared.yaml');
  const migrateNoId = (world: string) => migrateSettings(new SettingsStore(join(root, world, 'runtime-data', 'app.yaml')), model, noIdShared, choices, noId);
  assert.equal((await migrateNoId('no-id-A')).pets[0]!.id, (await migrateNoId('no-id-B')).pets[0]!.id);
  const bootRaw = parseCharacterYaml(readFileSync(instanceA.filePath, 'utf8')) as object;
  const local = instanceA.load();
  local.pets[0]!.projects[0]!.agent = { kind: 'codex', model: 'another-ai-model' };
  const sharedBeforeAI = readFileSync(shared, 'utf8');
  instanceA.save({ pets: local.pets });
  assert.equal(instanceA.load().pets[0]!.id, id);
  assert.equal(readFileSync(shared, 'utf8'), sharedBeforeAI);
  atomicYaml(instanceA.filePath, { ...bootRaw, port: 5174 });
  instanceA.save({ locale: 'en' });
  assert.equal(instanceA.snapshot().port, 5173);
  assert.equal(instanceA.load().port, 5174);
  assert.equal(instanceA.load().locale, 'en');

  // 新工作樹從已遷移基準複製專案，不改基準資料庫、不繼承 Session。
  const baselineDatabase = join(root, 'A', 'runtime-data', 'history.sqlite');
  const beforeBaseline = readFileSync(baselineDatabase);
  const fromSqlite = await migrateSettings(new SettingsStore(join(root, 'C', 'runtime-data', 'app.yaml')),
    model, shared, choices, join(root, 'A'));
  assert.deepEqual(fromSqlite.pets.map(pet => pet.id), instanceA.load().pets.map(pet => pet.id));
  assert.ok(fromSqlite.pets.every(pet => !pet.enabled && pet.projects.every(project => !project.agent?.sessionId)));
  assert.deepEqual(readFileSync(baselineDatabase), beforeBaseline);

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
  // 正在執行時換設定：等舊 turn 收尾，才允許下一則使用保留的 session。
  queue.enqueue({ assignee: 'fox', workspacePath: x, text: 'SLOW CHANGE', images: [], source: 'bubble' }); dispatcher.dispatchAll();
  await waitUntil(() => mock.log.some((line) => line.endsWith(':SLOW CHANGE')));
  agents.set(x, { ...agents.get(x)!, model: 'new-model', effort: 'high', permission: 'auto' });
  const closing = bridge.closePetSession('fox', x);
  assert.equal(bridge.canAccept('fox'), false);
  await closing;
  assert.equal(bridge.canAccept('fox'), true);
  assert.equal(events.filter((e) => e.kind === 'done').length, 5, '舊 turn 已終結才完成關閉');
  assert.equal(agents.get(x)?.model, 'new-model');
  assert.ok(agents.get(x)?.sessionId, '切設定保留對話 ID');
  await bridge.dispose();
  console.log('通過：共用角色、跨世界版本與鎖、遷移選擇、多專案串行、固定目錄、session 與審批隔離');
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
