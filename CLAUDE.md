# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概要

macOS 桌面 VRM 桌寵(Electron + three.js + @pixiv/three-vrm)。2026-07-20 全刪重建為最小版本,核心功能只有一個:**隨意替換任何 VRM 檔**(Tray 選單對話框或拖放)。舊功能不要擅自加回。

## 最高原則:照官方範例做

渲染程式碼**逐行對照 pixiv/three-vrm 官方 examples**(`node_modules/@pixiv/three-vrm/` 上游 repo 的 `examples/basic.html` 與 `examples/dnd.html`),不自創架構、不 trial-and-error。要改渲染相關行為,先讀官方範例再動手;`viewer.ts` 內的註解標明了每段對應哪個官方範例。

## 常用指令

```bash
npm run dev        # electron-vite dev(predev 會先 pkill 殘留的 Electron 行程)
npm run build      # electron-vite build → out/
npm run typecheck  # tsc --noEmit
```

沒有測試框架與 lint。渲染改動的驗證方式:在瀏覽器開 `vrmtest.html` 自行驗證(dev server 跑起來後開 `<ELECTRON_RENDERER_URL>/vrmtest.html`),使用者只看最終結果。驗證頁掛了 `window.__viewer` 供自動化呼叫載入/替換路徑。注意:殘留的 Electron 行程會佔住 dev server,`predev` 已自動 pkill,但手動驗證時也要留意。

## 架構

electron-vite 三段式(`electron.vite.config.ts`):main / preload / renderer,輸出到 `out/`。

- **`src/renderer/viewer.ts`** — 核心。唯一的 VRM 渲染邏輯(相機/燈光/迴圈 = 官方 basic.html;buffer 解析替換 + deepDispose 舊模型 = 官方 dnd.html)。overlay 與 vrmtest 兩個入口**共用這一份**,保證瀏覽器驗證看到的渲染與 app 內完全相同——改渲染只改這裡。
- **`src/renderer/main.ts`** — 桌面疊層入口(`index.html`):透明背景,預設載入 `public/AvatarSample_A.vrm`,接主行程推來的 VRM buffer 或拖放檔案來替換;raycast 判斷游標是否壓在角色上,切換視窗互動/穿透。
- **`src/renderer/vrmtest.html`** — 瀏覽器驗證頁,唯一差別是背景不透明。
- **`src/main/index.ts`** — 全螢幕透明置頂疊層視窗(無框、click-through、不搶焦點、macOS 上 type: panel + dock 隱藏)、Tray 選單(選 VRM 檔/結束)、選過的 VRM 路徑存 userData 的 `config.json` 下次自動載入。
- **`src/preload/index.ts`** — contextBridge 暴露 `window.pet`(`setInteractive` / `onCursor` / `onVrm`)。

## 平台實證知識(勿改回去)

- click-through 視窗在 macOS 收不到被動 mousemove——所以主行程每 30ms 輪詢 `screen.getCursorScreenPoint()` 推給 renderer 做 raycast 命中判斷。
- 背景 app(dock 隱藏)開 dialog 會被壓在其他視窗底下——`chooseVrm()` 先 `app.focus({ steal: true })`。
- 疊層視窗開不了 DevTools——renderer 的 console 經 `console-message` 事件轉發到終端機。
- VRM 檔經 IPC 傳遞用 buffer(主行程 `readFileSync` 後 send),renderer 走官方 `loader.parse` 路徑,不依賴檔案路徑。

## 慣例

- 回覆與註解使用繁體中文。
- TypeScript strict;無 lint 設定,風格比照現有檔案。
