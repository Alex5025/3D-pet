import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import YAML from 'yaml';
const require = createRequire(import.meta.url);
mkdirSync('/tmp/3D-pet', { recursive: true });
const root = realpathSync(mkdtempSync('/tmp/3D-pet/storage-startup-'));
const legacy = join(root, 'runtime-data');
const shared = join(root, 'shared/characters.yaml');
mkdirSync(join(legacy, 'transcripts'), { recursive: true }); mkdirSync(join(root, 'shared'));
const model = resolve('models/AvatarSample_A.vrm');
const hash = value => createHash('sha256').update(value).digest('hex');
writeFileSync(shared, YAML.stringify({ schemaVersion: 3, characters: [{ schemaVersion: 1, id: 'storage-test', modelHash: hash(readFileSync(model)), vrmPath: model, parameters: { name: '儲存測試' } }] }));
const config = { schemaVersion: 2, initialized: true, port: 54329, charactersPath: shared, selectedPetId: 'storage-test',
  pets: [{ id: 'storage-test', name: '儲存測試', enabled: true, workspacePath: root, projects: [{ workspacePath: root, agent: { kind: 'codex', sessionId: 'previous-session', effort: 'low' } }] }] };
writeFileSync(join(legacy, 'app.yaml'), YAML.stringify(config));
writeFileSync(join(legacy, 'transcripts', `${hash(JSON.stringify(['storage-test', root]))}.json`), JSON.stringify({ user: '遷移前問題', reply: '遷移前回覆', at: Date.now() }));
const original = readFileSync(join(legacy, 'app.yaml'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let child, socket;
async function launch() {
  let port;
  let errors = '';
  child = spawn(require('electron'), ['.', '--remote-debugging-port=0'], {
    cwd: process.cwd(), env: { ...process.env, VRM_PET_DATA_DIR: root, VRM_PET_SHARED_CHARACTERS: shared, VRM_PET_AGENT_MOCK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', chunk => { errors += chunk; port ??= /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(errors)?.[1]; });
  child.stdout.on('data', chunk => { errors += chunk; });
  const deadline = Date.now() + 25000;
  let target;
  while (!target && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(errors);
    if (port) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => /index\.html/.test(t.url)); } catch {} }
    if (!target) await sleep(100);
  }
  if (!target) throw new Error(`啟動逾時：${errors}`);
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', event => { const result = JSON.parse(event.data); const request = pending.get(result.id); if (request) { pending.delete(result.id); request(result); } });
  const evaluate = async expression => {
    const id = ++seq;
    const reply = new Promise(resolve => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const response = await Promise.race([reply, sleep(10000).then(() => { throw Error('頁面評估逾時'); })]);
    if (response.result?.exceptionDetails || response.error) throw new Error(JSON.stringify(response));
    return response.result.result.value;
  };
  while (!(await evaluate('typeof window.pet !== "undefined"'))) { if (Date.now() > deadline) throw Error('preload 逾時'); await sleep(100); }
  return evaluate;
}
async function quit(evaluate) {
  const exited = once(child, 'exit');
  void evaluate('window.pet.systemQuit()').catch(() => {});
  await Promise.race([exited, sleep(10000).then(() => { throw Error('結束逾時'); })]);
  socket.close(); socket = null; child = null;
}
try {
  let evaluate = await launch();
  assert.equal((await evaluate('window.pet.getPetCollection()')).pets[0].agent.sessionId, 'previous-session');
  assert.equal((await evaluate('window.pet.getChatTranscript("storage-test")')).reply, '遷移前回覆');
  assert.equal(readFileSync(join(legacy, 'app.yaml'), 'utf8'), original, '遷移保留原檔');
  assert.equal((await evaluate('window.pet.chatSend("storage-test", "儲存啟動驗證")')).queued, true);
  const end = Date.now() + 6000;
  let transcript;
  do { await sleep(100); transcript = await evaluate('window.pet.getChatTranscript("storage-test")'); } while ((transcript?.running || !transcript?.reply?.includes('儲存啟動驗證')) && Date.now() < end);
  assert.ok(transcript.reply.includes('儲存啟動驗證'));
  await evaluate('(async () => { const p = (await window.pet.getPetCollection()).pets[0]; return window.pet.updatePetMeta(p.id, { agent: { ...p.agent, effort: "high" } }); })()');
  await quit(evaluate);
  assert.equal(existsSync(join(root, 'runtime_data/history.sqlite')), true);
  assert.equal(existsSync(join(root, '3D-pet/instances/pet-system.pid')), true);
  let saved = YAML.parse(readFileSync(join(root, 'runtime_data/app.yaml'), 'utf8'));
  assert.equal(saved.port, 54329); assert.equal(saved.schemaVersion, 3); assert.equal(saved.pets, undefined); assert.ok(saved.charactersPath.endsWith('.sqlite'));
  // 快取刪除後，設定與 SQLite 仍完整；第二次啟動不重複覆蓋原設定。
  rmSync(join(root, '3D-pet/instances/Cache'), { recursive: true, force: true });
  evaluate = await launch();
  assert.equal((await evaluate('window.pet.getChatTranscript("storage-test")')).reply, transcript.reply);
  assert.equal((await evaluate('window.pet.getPetCollection()')).pets[0].agent.effort, 'high');
  await evaluate('window.pet.newSession("storage-test")');
  await sleep(100);
  assert.equal((await evaluate('window.pet.getPetCollection()')).pets[0].agent.sessionId, undefined);
  assert.equal(await evaluate('window.pet.getChatTranscript("storage-test")'), null);
  await quit(evaluate);
  console.log('通過：真實主程序啟動、舊資料遷移、IPC 對話與設定寫入、正常結束、刪除快取後重啟回填');
} finally {
  socket?.close(); child?.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
