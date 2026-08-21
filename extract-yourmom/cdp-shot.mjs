// headless Chrome CDP 驅動:載入 vrmtest.html → 換載指定 VRM → 截圖
// 用法: node cdp-shot.mjs <vrmUrlPath> <outPng> [evalJs] [extraWaitMs]
import { writeFileSync } from 'node:fs';

const [vrmPath, outPng, evalJs, extraWaitMs] = process.argv.slice(2);
const port = 9333;

async function findTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('找不到 Chrome CDP target');
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page eval 失敗: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
}

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(process.env.CDP_W ?? 700), height: Number(process.env.CDP_H ?? 900),
  deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: process.env.CDP_URL ?? 'http://localhost:5199/vrmtest.html' });
await new Promise((r) => setTimeout(r, 1500));

// 等預設模型載完(hud 出現 loaded),再換載目標
for (let i = 0; i < 40; i++) {
  const hud = await evaluate(`document.getElementById('hud').textContent`);
  if (/loaded/.test(hud)) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (vrmPath && vrmPath !== '-') {
  await evaluate(`__viewer.loadFromUrl(${JSON.stringify(vrmPath)}).then(()=>'ok')`);
  await new Promise((r) => setTimeout(r, 1000));
}
if (evalJs && evalJs !== '-') {
  const v = await evaluate(evalJs);
  if (v !== undefined) console.log('eval:', JSON.stringify(v));
}
await new Promise((r) => setTimeout(r, Number(extraWaitMs ?? 500)));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
console.log('screenshot →', outPng);
ws.close();
process.exit(0);
