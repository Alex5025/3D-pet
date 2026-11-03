import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 以假 app-server 驗證實際 provider 的 RPC 與核准事件,不存取使用者筆記。
await mkdir('/tmp/3D-pet', { recursive: true });
const dir = await mkdtemp('/tmp/3D-pet/codex-approvals-');
const oldPath = process.env.PATH;
let provider;
const deadline = setTimeout(() => { console.error('FAIL: 核准測試逾時'); process.exit(1); }, 25_000);
try {
  await build({ entryPoints: ['src/main/agent/codexProvider.ts'], bundle: true,
    platform: 'node', format: 'esm', outfile: join(dir, 'provider.mjs') });
  await writeFile(join(dir, 'codex'), `#!/usr/bin/env node
const readline = require('node:readline');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let policy, threadId, expected;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize' && !msg.params.capabilities?.experimentalApi) {
    send({ id: msg.id, error: { message: 'granular requires experimentalApi' } });
    return;
  }
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    policy = msg.params.approvalPolicy;
    threadId = msg.params.threadId || 'test-thread';
    if (msg.params.sandbox !== 'workspace-write') throw Error('沙盒不符');
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === 'turn/start') {
    expected = JSON.parse(msg.params.input[0].text);
    send({ id: msg.id, result: {} });
    const autoPolicy = JSON.stringify({ granular: { sandbox_approval: false, rules: false,
      skill_approval: false, request_permissions: false, mcp_elicitations: true } });
    if (expected.permission === 'auto' ? JSON.stringify(policy) !== autoPolicy : policy !== 'untrusted') {
      send({ method: 'turn/completed', params: { threadId, turn: { status: 'failed',
        error: { message: 'MCP tool call requires approval, but approval policy is never' } } } });
    } else {
      send({ id: 100, method: 'mcpServer/elicitation/request', params: {
        threadId: expected.orphan ? 'unknown-thread' : threadId,
        serverName: 'apple-notes', mode: expected.url ? 'url' : 'form',
        message: '核准建立筆記', requestedSchema: { type: 'object',
          properties: expected.form ? { answer: { type: 'string' } } : {} } } });
    }
  } else if (msg.id === 100 && msg.result) {
    const ok = msg.result.action === expected.action &&
      (expected.action === 'accept' ? JSON.stringify(msg.result.content) === '{}' : msg.result.content === null);
    send({ method: 'turn/completed', params: { threadId,
      turn: { status: ok ? 'completed' : 'failed' } } });
  } else if (msg.method) send({ id: msg.id, result: {} });
});
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  const { createCodexProvider } = await import(pathToFileURL(join(dir, 'provider.mjs')).href);
  for (const resumeId of [undefined, 'existing-thread']) {
    provider = createCodexProvider();
    const id = await provider.startSession({ workdir: dir, permission: 'auto', resumeId });
    for (const scenario of [
      { permission: 'auto', action: 'accept', prompts: 0 },
      { permission: 'auto', action: 'accept', prompts: 0 },
      { permission: 'ask', action: 'accept', prompts: 1 },
      { permission: 'ask', action: 'decline', prompts: 1 },
      { permission: 'auto', action: 'accept', prompts: 0 },
      { permission: 'auto', action: 'decline', prompts: 1, form: true },
      { permission: 'auto', action: 'decline', prompts: 1, url: true },
      { permission: 'auto', action: 'decline', prompts: 0, orphan: true },
    ]) {
      let approvals = 0;
      let done = false;
      for await (const event of provider.sendMessage(id, JSON.stringify(scenario), { permission: scenario.permission })) {
        assert.notEqual(event.kind, 'error', JSON.stringify(event));
        if (event.kind === 'approval') {
          approvals++;
          assert.equal(event.description, '核准建立筆記');
          await provider.respondApproval(id, event.requestId, scenario.action === 'accept');
        }
        if (event.kind === 'done') done = event.ok;
      }
      assert.equal(approvals, scenario.prompts, JSON.stringify(scenario));
      assert.equal(done, true, JSON.stringify(scenario));
    }
    await provider.dispose();
    provider = undefined;
  }
  console.log('PASS: 新建／恢復、全自動零核准視窗、需核准允許／拒絕、模式切換、表單／網址及未知對話保護');
} finally {
  clearTimeout(deadline);
  await provider?.dispose();
  process.env.PATH = oldPath;
  await rm(dir, { recursive: true, force: true });
}
