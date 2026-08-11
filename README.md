# 3D VRM 桌寵

以 Electron、TypeScript、Three.js 與 `@pixiv/three-vrm` 製作的 macOS 桌面寵物。角色會以透明、置頂且可穿透的視窗顯示，支援多隻 VRM、VRMA 動作、角色外觀調整，以及透過 Codex 或 Claude Code 與每隻寵物對話。

## 功能

- 載入或拖放 `.vrm` 模型，並保存每隻寵物的位置、旋轉、縮放與顯示設定。
- 同時管理多隻寵物；休息中的角色會釋放 WebGL 與模型資源。
- 播放 `.vrma` 動作、設定預設姿勢、切換服裝節點及調整 Spring Bone 晃動強度。
- 調整環境光、平行光或點光源，以及角色與光源位置。
- 滑鼠視線跟隨、左鍵拖曳、右鍵旋轉、滾輪縮放及角色右鍵選單。
- 每隻寵物可綁定不同工作目錄、角色個性、Codex／Claude Code 模型、推理力度與權限等級。
- 對話支援串流 Markdown、工作區操作審批，以及讓 agent 播放動作、切換表情和顯示泡泡文字。

## 環境需求

- macOS
- Node.js 20 以上版本與 npm
- 如需 AI 對話：已安裝並登入的 `codex` 或 `claude` CLI；不使用 AI 功能時不需要安裝

## 安裝與啟動

```bash
npm ci
npm run dev
```

`npm ci` 會透過 `prepare` 將 Git hooks 路徑設為 `.githooks`。開發模式的本機設定保存在 `runtime-data/`，相關 JSON 已由 Git 忽略。

## 基本操作

- 在角色上按左鍵拖曳可移動，按右鍵拖曳可旋轉，使用滾輪可縮放。
- 在角色上按右鍵可選擇 VRM、播放動作、開啟光影／角色／工作設定，或新增及切換寵物。
- 將 `.vrm` 檔拖到角色上可替換模型。
- 將 `.vrma` 檔放入 `motions/` 後，可從右鍵選單播放或設為預設姿勢。
- 滑鼠移到角色上會顯示對話泡泡；使用 AI 前，先在「工作設定」選擇工作目錄與助手。

AI 權限預設為唯讀。若選擇「可寫工作目錄」，每次受保護操作都會在泡泡中要求核准；「全自動」不會詢問，請只用於可信任的工作目錄與任務。

## 開發指令

```bash
npm run typecheck      # TypeScript 嚴格型別檢查
npm run build          # 建置 main、preload 與 renderer
npm run check:secrets  # 掃描已暫存檔案中的疑似憑證
```

提交前的 hook 會執行密鑰掃描與型別檢查，推送前的 hook 會執行完整建置。若要掃描目前所有 Git 追蹤檔案，可執行：

```bash
node scripts/check-secrets.mjs --tracked
```

## 專案結構

```text
src/main/       Electron 主程序、設定持久化與 agent bridge
src/preload/    renderer 可使用的受限 IPC API
src/renderer/   VRM 渲染、桌面互動、設定頁與對話泡泡
models/         範例 VRM 模型
motions/        可選的 VRMA 動作
runtime-data/   開發模式本機運行資料，不納入版控
docs/           開發日誌與設計文件
```

渲染相關變更請先使用 `src/renderer/vrmtest.html` 驗證，再執行 `npm run typecheck` 與 `npm run build`。完整的架構演進與平台注意事項請參閱 [`docs/DEVLOG.md`](docs/DEVLOG.md)。

## 授權

本專案採用 [MIT License](LICENSE)。加入第三方 VRM 或 VRMA 資產前，請自行確認其再散布與使用條款。
