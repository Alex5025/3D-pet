import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const root = process.platform === 'win32' ? join(tmpdir(), '3D-pet') : '/tmp/3D-pet';
await mkdir(root, { recursive: true });
const scratch = await mkdtemp(join(root, 'screen-preview-'));
try {
  await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { createSpeechBubble } from './src/renderer/speechBubble';
    import { setLocale } from './src/shared/i18n';
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f1f5f9'; ctx.fillRect(0, 0, 960, 540);
    ctx.fillStyle = '#162234'; ctx.font = 'bold 38px sans-serif'; ctx.fillText('AI SCREEN PREVIEW', 60, 85);
    ctx.fillStyle = '#e53935'; ctx.fillRect(120, 190, 180, 140);
    ctx.fillStyle = '#1565c0'; ctx.beginPath(); ctx.arc(550, 260, 80, 0, Math.PI * 2); ctx.fill();
    window.fixture = { mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1], name: 'screen-preview.png' };
    window.sent = [];
    window.bubble = createSpeechBubble({ petName: '螢幕預覽測試', workspacePath: '/tmp/3D-pet',
      onCaptureScreen: async () => ({ ok: true, image: window.fixture }),
      onSend: (text, images) => { window.sent.push({ text, images }); window.bubble.clearComposer(); },
    });
    window.setTestLocale = locale => { setLocale(locale); window.bubble.applyLocale(); };
    window.bubble.showAt(500, 620);
  ` }, bundle: true, platform: 'browser', format: 'iife', outfile: join(scratch, 'renderer.js') });
  await writeFile(join(scratch, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>body{background:#80848e;margin:0}</style></head><body><script src="renderer.js"></script></body></html>');
  await writeFile(join(scratch, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron');
    const assert = require('node:assert/strict');
    const { writeFileSync, mkdirSync } = require('node:fs');
    const profile = ${JSON.stringify(join(scratch, 'profile'))}; mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
    const timeout = setTimeout(() => { console.error('預覽測試逾時'); app.exit(1); }, 15000);
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ width: 1040, height: 820, show: false, webPreferences: { contextIsolation: true } });
      window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message); });
      const run = expression => window.webContents.executeJavaScript(expression);
      const imageCount = () => run("document.querySelectorAll('.bubble-screen-preview img').length");
      try {
        await window.loadFile(${JSON.stringify(join(scratch, 'index.html'))});
        await run("document.querySelector('.bubble-capture').click()");
        await run("bubble.input.value='下一個問題'; bubble.beginTurn('看看我的螢幕'); bubble.setScreenPreview(fixture); bubble.appendText('我看到了紅色長方形與藍色圓形。'); bubble.endTurn(true)");
        assert.equal(await imageCount(), 1);
        assert.equal(await run("document.querySelector('.bubble-screen-preview img').src"), await run("document.querySelector('.bubble-images:not(.bubble-screen-preview) img').src"));
        assert.equal(await run('bubble.input.value'), '下一個問題', 'AI 預覽保留草稿');
        await new Promise(resolve => setTimeout(resolve, 100));
        const rect = await run("(()=>{const r=bubble.element.getBoundingClientRect();return {x:Math.floor(r.x)-20,y:Math.floor(r.y)-20,width:Math.ceil(r.width)+40,height:Math.ceil(r.height)+40};})()");
        writeFileSync(${JSON.stringify(join(root, 'ai-screen-preview.png'))}, (await window.webContents.capturePage(rect)).toPNG());
        await run("bubble.input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
        assert.equal(await run('sent[0].images.length'), 1, '只送使用者附件，不重送 AI 截圖');
        assert.equal(await imageCount(), 1, '清空輸入框與完成回覆均保留 AI 預覽');
        await run("setTestLocale('en')");
        assert.equal(await run("document.querySelector('.bubble-screen-preview span').textContent"), '📷 Latest AI screenshot');
        await run("bubble.setScreenPreview({...fixture, name:'new-screen.png'})");
        assert.equal(await imageCount(), 1);
        assert.equal(await run("document.querySelector('.bubble-screen-preview img').alt"), 'new-screen.png');
        await run("bubble.beginTurn('下一輪')"); assert.equal(await imageCount(), 0);
        await run("bubble.endTurn(true); bubble.restoreTranscript({user:'剛才的畫面',reply:'',at:Date.now(),screenPreview:fixture})");
        assert.equal(await imageCount(), 1, '即使回覆為空也能回填截圖');
        await run('bubble.resetProject()'); assert.equal(await imageCount(), 0);
        await run("bubble.setScreenPreview(fixture); document.querySelector('.bubble-agent-info > button:last-child').click()");
        assert.equal(await imageCount(), 0, '新對話清空截圖');
        await run('bubble.setScreenPreview(fixture); bubble.destroy()'); assert.equal(await imageCount(), 0);
        console.log('通過：AI 截圖與貼圖共用預覽、草稿與附件隔離、完成保留、最新圖替換、回填與清除');
        clearTimeout(timeout); app.exit(0);
      } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
    });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [join(scratch, 'main.cjs')], { env, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
} finally { await rm(scratch, { recursive: true, force: true }); }
