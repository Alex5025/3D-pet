// claude 的權限審批 MCP 腳本(stdio):由 claude -p 以 --mcp-config 啟動,
// 收到權限詢問(tools/call)時經本機 socket 回連 Electron main,等使用者在泡泡上按 允許/拒絕。
// 契約依 v2.0 煙霧測試樣本(scratchpad/agent-smoke/claude-perm-*.jsonl)。
// 注意:此檔是獨立 node 腳本(不經 bundler),由 claudeProvider 以絕對路徑掛進 mcp-config;
// 打包成 .app 時需列入 extraResources(專案目前為開發階段,直接引用原始檔)。
import { createInterface } from 'node:readline';
import { connect } from 'node:net';

const SOCKET = process.env.VRM_PET_PERM_SOCKET;
const TOKEN = process.env.VRM_PET_PERM_TOKEN;
const TURN_KEY = process.env.VRM_PET_TURN_KEY;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const deny = (id, message) =>
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message }) }] } });

/** 問 main:一條連線一個請求,回一行 JSON 後結束。 */
function askMain(payload) {
  return new Promise((resolve) => {
    const socket = connect(SOCKET);
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 10 * 60 * 1000); // 等人點頭最長 10 分鐘
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        socket.end();
        try { resolve(JSON.parse(buffer.slice(0, nl))); } catch { resolve(null); }
      }
    });
    socket.on('error', () => { clearTimeout(timer); resolve(null); });
    socket.write(JSON.stringify({ token: TOKEN, turnKey: TURN_KEY, ...payload }) + '\n');
  });
}

const rl = createInterface({ input: process.stdin });
// 宿主死了 stdin 就關:立刻退出,不留孤兒佔住繼承的 stdio(會卡死宿主的 close 事件)
rl.on('close', () => process.exit(0));
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vrmpet', version: '0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'approve', description: '桌寵權限審批', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } } } }] } });
  } else if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    const reply = await askMain({ toolName: args.tool_name, input: args.input ?? {} });
    if (!reply) return deny(msg.id, '無法連上桌寵主程式,已拒絕');
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
