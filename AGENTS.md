# 儲存庫貢獻指南

## 專案結構與模組配置

本專案是以 Electron、TypeScript、Three.js 與 `@pixiv/three-vrm` 製作的 macOS VRM 桌寵。Electron 分為三個入口：

- `src/main/index.ts`：管理視窗、系統匣、檔案選擇、設定儲存與 IPC。
- `src/preload/index.ts`：透過 `contextBridge` 向渲染程序暴露受限 API。
- `src/renderer/`：`viewer.ts` 存放共用渲染邏輯，`main.ts` 處理桌面疊層，HTML 檔提供設定與手動測試入口。
- `models/`、`motions/`：存放範例 `.vrm` 模型與 `.vrma` 動作；`docs/DEVLOG.md` 記錄實作歷程及平台行為。

`out/` 是建置產物，`node_modules/` 是安裝的相依套件；請勿手動修改。

## 建置、測試與開發指令

首次安裝或需要乾淨環境時執行 `npm ci`。

```bash
npm run dev        # 透過 electron-vite 啟動；predev 會先終止殘留行程
npm run typecheck  # 執行 TypeScript 嚴格型別檢查，不產生檔案
npm run build      # 將主程序、預載程序與渲染程序建置至 out/
```

## 程式風格與命名規範

沿用現有 TypeScript 風格：兩個空格縮排、單引號、分號，多行結構保留尾逗號。變數與函式使用 `camelCase`，介面使用 `PascalCase`。維持嚴格型別與預載程序的安全邊界，避免 `any`。專案目前未設定格式化或靜態檢查工具，請比照周邊程式碼。回覆、註解及貢獻說明使用繁體中文。

`viewer.ts` 的載入器、渲染迴圈、動畫與資源釋放遵循 pixiv/three-vrm 官方範例；調整前先核對官方做法，並維持桌面疊層與測試頁共用邏輯。

## 測試指南

目前沒有自動化測試框架或覆蓋率門檻。提交前至少執行 `npm run typecheck` 與 `npm run build`。修改渲染程序時，啟動開發伺服器並開啟 `vrmtest.html`，依範圍驗證模型載入與替換、透明度、動作及互動；頁面提供 `window.__viewer` 供自動化操作。

## 提交與合併請求規範

提交訊息使用中文、簡潔描述結果，可採 `docs(DEVLOG): ...`、`perf: ...` 等範圍格式；每個提交僅包含同一目的。合併請求應說明行為差異、列出驗證指令並連結相關議題。涉及可見介面或渲染變更時附截圖或錄影，並明確註記 macOS 特定行為及資產、設定異動。

## 設定與資產安全

`config.json` 是本機執行狀態，勿提交電腦專屬路徑。除非是必要測試資產且已確認再散布條款，否則不要加入大型模型或動作檔。
