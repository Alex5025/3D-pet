// 寵物工具 MCP 腳本(stdio):由 codex(thread config)/claude(--mcp-config)掛載,
// 提供 pet_play_motion / pet_show_expression / pet_speak 三個工具,
// 呼叫經本機 socket 轉給 Electron main 的 petToolsHub 執行。
// env:VRM_PET_TOOLS_SOCKET / VRM_PET_TOOLS_TOKEN / VRM_PET_PET_ID
import { createInterface } from 'node:readline';
import { connect } from 'node:net';

const SOCKET = process.env.VRM_PET_TOOLS_SOCKET;
const TOKEN = process.env.VRM_PET_TOOLS_TOKEN;
const PET_ID = process.env.VRM_PET_PET_ID;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function askHub(tool, args) {
  return new Promise((resolve) => {
    const socket = connect(SOCKET);
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 10000);
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
    socket.write(JSON.stringify({ token: TOKEN, petId: PET_ID, tool, args }) + '\n');
  });
}

/** 動作/表情清單開機時跟 hub 拿,埋進工具 schema 的 enum(agent 不會亂猜名字)。 */
const manifest = await askHub('__manifest', {});
const motions = manifest?.motions ?? [];
const expressions = manifest?.expressions ?? ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'];

const TOOLS = [
  {
    name: 'pet_play_motion',
    description: '讓桌寵播放一個全身動作(VRMA)。配合對話情境使用,例如打招呼、完成任務時。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: motions, description: '動作檔名' } },
      required: ['name']
    }
  },
  {
    name: 'pet_show_expression',
    description: '切換桌寵的臉部表情。回答開心的事用 happy,遇到問題用 sad/angry,驚訝用 surprised,neutral 恢復平常臉。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: expressions, description: '表情名' } },
      required: ['name']
    }
  },
  {
    name: 'pet_speak',
    description: '把一句話直接顯示在桌寵的對話泡泡上(適合中途回報進度或撒嬌)。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要顯示的話(80 字內)' } },
      required: ['text']
    }
  }
];

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pettools', version: '0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const reply = await askHub(name, msg.params?.arguments ?? {});
    const text = reply?.ok ? String(reply.result ?? 'ok') : `失敗:${reply?.error ?? '無法連上桌寵'}`;
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: !reply?.ok } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
