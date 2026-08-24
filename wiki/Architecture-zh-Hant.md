# 架構與開發

## 技術棧

- Electron 33
- TypeScript（strict）
- electron-vite / Vite
- Three.js
- `@pixiv/three-vrm`
- `@pixiv/three-vrm-animation`
- marked + DOMPurify

## 程序邊界

| 入口 | 責任 |
|---|---|
| `src/main/index.ts` | 視窗、Tray、設定、檔案、功率管理、IPC 與 agent 生命週期 |
| `src/preload/index.ts` | 透過 `contextBridge` 提供最小權限 API |
| `src/renderer/main.ts` | 多寵 runtime、互動、命中測試與泡泡協調 |
| `src/renderer/viewer.ts` | Three.js／VRM 載入、渲染、動畫與資源釋放 |
| `src/main/agent/` | Codex／Claude／Mock provider、審批與 session bridge |
| `src/main/platform.ts` | 平台能力、疊層視窗選項、named pipe／Unix socket 與打包 helper 路徑 |
| `src/shared/` | 跨程序型別、i18n、聊天與沙盒資料結構 |

## Agent 架構

`AgentBridge` 對 renderer 提供一致事件流，並把實作交給 `AgentProvider`：

- Codex：長駐 `codex app-server`，以 JSON-RPC 管理 thread、turn、審批與 steer。
- Claude：每輪啟動 CLI，透過 session ID resume；權限詢問由本機 MCP socket 橋接。
- Mock：供 headless selftest 與 UI 測試。

每個 turn 必須恰有一個 `done` 或 `error` 終結事件。Bridge 管理同時執行上限、取消、watchdog、crash recovery 與 session 回存。

## Renderer 設計原則

`viewer.ts` 盡量沿用 pixiv/three-vrm 官方範例順序。每隻寵物擁有獨立 viewer/runtime，讓模型、相機、動畫與釋放邏輯保持清楚。透明區域的 click-through 以骨骼包圍盒初篩，再用 alpha probe 做像素級命中。

## 資料與安全

- `runtime-data/`：本機 profile、PID 與執行狀態，不納入版控。
- `models/`、`motions/`：本機角色與動作資產。
- 安裝版設定放在系統 `userData`；Agent helper 以 `extraResources` 放在 asar 外。
- Renderer 不直接取得 Node.js 權限。
- 沙盒設定 IPC 只接受固定 enum／boolean，main 再驗證工作目錄與符號連結。
- 憑證、token、API key 不得進入 repository。

## 開發指令

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run pack
npm run dist:win
npm run dist:mac
npm run check:secrets
```

## 測試入口

- `/vrmtest.html`：模型、透明度、動作與互動。
- `/bubbletest.html`：泡泡 Markdown、附件、審批與佇列。
- `VRM_PET_AGENT_SELFTEST=1`：MockProvider 全鏈自驗。
- `VRM_PET_AGENT_SELFTEST=codex|claude|agy`：真實 CLI e2e，會消耗訂閱額度。

GitHub Actions 分別在 macOS 與 Windows runner 建置平台產物。Windows 使用 NSIS x64，macOS 使用 DMG/ZIP；正式公開發行另需 Authenticode 與 Developer ID/notarization。

## 貢獻規範

- 兩個空格縮排、單引號、分號與尾逗號。
- 維持 strict 型別，不使用 `any`。
- 修改 renderer 後至少執行 typecheck、build 與相關手動頁面驗證。
- 不提交本機路徑、runtime 資料或未確認散布權的模型。
