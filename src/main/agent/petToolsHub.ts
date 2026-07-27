import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * 寵物工具中樞(v3):petToolsServer.mjs(由各 CLI 以 MCP 掛載)經本機 socket 回連這裡,
 * 把 agent 的工具呼叫(播動作/切表情/說話)轉成對桌寵的實際操作。
 * 一個 app 一個 hub;petId 由 MCP 腳本的 env 帶進來(每寵各自的 MCP 設定)。
 */

export interface PetToolsDeps {
  /** 播放 motions/ 裡的動作檔(呼叫端已驗白名單,這裡再驗一次)。 */
  playMotion(petId: string, file: string): Promise<boolean>;
  /** 切換情緒表情(happy/angry/sad/relaxed/surprised/neutral)。 */
  showExpression(petId: string, name: string): boolean;
  /** 文字顯示到該寵的泡泡回覆區。 */
  speak(petId: string, text: string): boolean;
  /** 可用動作檔清單(工具 enum 用)。 */
  listMotions(): string[];
}

export interface PetToolsHub {
  readonly socketPath: string;
  readonly token: string;
  readonly scriptPath: string;
  dispose(): void;
}

export const PET_EXPRESSIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'] as const;

export function createPetToolsHub(deps: PetToolsDeps): PetToolsHub {
  const token = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'vrm-pet-tools-'));
  const socketPath = join(dir, 'tools.sock');
  const scriptPath = join(app.getAppPath(), 'src/main/agent/petToolsServer.mjs');

  const server: Server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      void (async () => {
        let reply: Record<string, unknown> = { ok: false, error: '無效請求' };
        try {
          const msg = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
          if (msg['token'] !== token) {
            socket.destroy();
            return;
          }
          const petId = String(msg['petId'] ?? '');
          const args = (msg['args'] ?? {}) as Record<string, unknown>;
          switch (msg['tool']) {
            case '__manifest': // MCP 腳本開機時查:動作清單進工具 enum
              reply = { ok: true, motions: deps.listMotions(), expressions: PET_EXPRESSIONS };
              break;
            case 'pet_play_motion': {
              const ok = await deps.playMotion(petId, String(args['name'] ?? ''));
              reply = ok ? { ok: true, result: '動作播放中' } : { ok: false, error: '找不到這個動作' };
              break;
            }
            case 'pet_show_expression': {
              const ok = deps.showExpression(petId, String(args['name'] ?? ''));
              reply = ok ? { ok: true, result: '表情已切換' } : { ok: false, error: '不支援的表情' };
              break;
            }
            case 'pet_speak': {
              const ok = deps.speak(petId, String(args['text'] ?? ''));
              reply = ok ? { ok: true, result: '已顯示在泡泡' } : { ok: false, error: '泡泡不可用' };
              break;
            }
            default:
              reply = { ok: false, error: `未知工具 ${String(msg['tool'])}` };
          }
        } catch {
          /* 保底回 error reply */
        }
        socket.write(JSON.stringify(reply) + '\n');
      })();
    });
  });
  server.listen(socketPath);

  return {
    socketPath,
    token,
    scriptPath,
    dispose() {
      server.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp 檔,留著無害 */ }
    }
  };
}
