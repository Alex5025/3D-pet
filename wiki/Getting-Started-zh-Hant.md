# 快速開始

## 這是什麼？

3D-pet 是 macOS 桌面上的 VRM 3D 桌寵系統。每隻寵物都能綁定 Codex 或 Claude Code、工作目錄、模型、推理力度與角色個性，除了陪伴，也能直接修改程式、跑測試和撰寫文件。

## 系統需求

- macOS（Apple Silicon 已實測）
- Node.js 22 或更新版本
- npm
- AI 功能至少安裝並登入其中一項：
  - OpenAI Codex CLI
  - Claude Code CLI
- 自備具合法使用權的 `.vrm` 模型與 `.vrma` 動作

本專案使用 CLI 的訂閱登入，不需要把 API key 寫進專案。

## 安裝與啟動

```bash
git clone <YOUR_GITLAB_PROJECT_URL>
cd 3D-pet
npm install
npm run dev
```

啟動後，角色會出現在桌面透明疊層。滑鼠移到角色上時可以互動，移開後透明區域會恢復點擊穿透。

## 第一次設定

1. 右鍵點擊角色或開啟 Tray 選單。
2. 選擇「設定」→「工作（AI 助手）」。
3. 選擇 Codex 或 Claude Code。
4. 設定模型、推理力度與權限。
5. 選擇工作目錄；新寵物也可以使用自動建立的預設目錄。
6. 視需要在角色設定填入寵物個性。
7. 將 `.vrm` 模型放入 `models/`，或從選單選擇模型。

## 基本操作

| 操作 | 行為 |
|---|---|
| 左鍵拖曳 | 移動寵物 |
| 右鍵拖曳 | 旋轉寵物 |
| 滾輪 | 縮放寵物 |
| 滑鼠移到寵物 | 顯示對話泡泡 |
| Enter | 送出訊息 |
| Shift+Enter | 在輸入框換行 |
| 拖放檔案到亮起的接收窗 | 加入參考檔案、替換 VRM 或播放 VRMA |

## 驗證安裝

```bash
npm run typecheck
npm run build
```

若要測試 agent 管線但不消耗訂閱額度：

```bash
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=1 npm run dev
```

## 下一步

- [使用手冊](User-Guide-zh-Hant)
- [架構與開發](Architecture-zh-Hant)
