# 3D-pet — macOS 桌面 VRM 桌寵 × AI 工程助手

macOS 桌面透明疊層上的 VRM 3D 角色(Electron + three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)),同時是可以**指派工作的 AI 工程助手**:對每隻寵物綁定一個工作目錄與 agent(OpenAI Codex 或 Claude Code),在對話泡泡裡下指令,危險操作經你點頭核准,寵物還會配表情動作演給你看。

## 功能

**桌寵本體**
- 任意替換 VRM 模型(Tray 選單 / 拖放檔案),多寵物同時運行,各自獨立設定
- 視線跟隨游標、拖曳移動、右鍵旋轉、滾輪縮放,透明區域點擊穿透(像素級命中)
- 光影調整(平行光/點光源、位置墊、陰影濃度)、逐部位晃動強度(頭髮/衣服/胸部/尾巴)、服裝顯示開關
- VRMA 動作播放與開機預設姿勢;閒置自動節流省電(idle 時 renderer CPU ~8%)
- 寵物可「休息」釋放資源(WebGL context / 快取 / agent session)

**AI 助手(對話泡泡)**
- 每寵綁定 **Codex**(`codex app-server`,JSON-RPC 長駐)或 **Claude Code**(`claude -p`,CLI spawn)
- **不使用計費 API**——一律走本機 CLI 的訂閱登入
- 每寵各自的模型(動態清單)與推理力度(low~ultra)、角色個性(注入 system prompt)
- 三檔權限:唯讀 / 可寫工作目錄(泡泡跳審批,允許/拒絕)/ 全自動
- session 持久化:重啟 app 繼續上次對話;可中斷、crash 自動重連
- 回覆 Markdown 渲染(GFM,DOMPurify 消毒)、模型/力度徽章
- **寵物工具(MCP)**:agent 可自主呼叫 `pet_play_motion` / `pet_show_expression` / `pet_speak` 配合情緒表演

## 需求

- macOS(在 Apple Silicon 實測)
- Node.js 22+
- 要用 AI 功能:[Codex CLI](https://github.com/openai/codex) 與/或 [Claude Code](https://claude.com/claude-code) 已安裝並登入(訂閱帳號)

## 快速開始

```bash
npm install
npm run dev
```

- 角色出現在桌面上;滑鼠壓到角色會變成可互動,移開自動穿透。
- **右鍵角色**:選 VRM 檔、播放動作、預設姿勢、調整燈光/角色、工作設定、休息/喚醒。
- **設定面板**(右鍵 → 各「調整/設定」項):
  - 光影:光源類型/強度/位置、陰影濃度
  - 角色:個性(persona)、晃動強度、預設姿勢、服裝、位置
  - 工作:寵物名稱、AI 助手(Codex/Claude)、模型、推理力度、權限、工作目錄
- 對話:滑到角色上 → 泡泡輸入 → Enter 送出(Shift+Enter 換行)。

模型放 `models/`、動作(.vrma)放 `motions/`;運行資料在 `runtime-data/`(皆不入版控)。

## 驗證(headless,開發用)

```bash
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=1 npm run dev       # MockProvider 全鏈自驗
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=claude npm run dev  # 真 claude e2e(耗訂閱額度)
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=codex npm run dev   # 真 codex e2e(耗訂閱額度)
VRM_PET_AGENT_MOCK=1 npm run dev                                          # 假 agent 走 UI,不耗額度
npm run typecheck && npm run build
```

渲染改動另有瀏覽器驗證頁:dev server 起來後開 `http://localhost:5173/vrmtest.html`(`window.__viewer` 供自動化)。

## 文件

- [docs/DEVLOG.md](docs/DEVLOG.md) — 開發日誌:每個議題的症狀 → 根因 → 處理方式(含大量平台實證知識)
- [docs/AGENT-BRIDGE-DESIGN.md](docs/AGENT-BRIDGE-DESIGN.md) — agent 串接架構設計(AgentProvider 抽象、審批、MCP 寵物工具)
- [CLAUDE.md](CLAUDE.md) — 開發守則(渲染逐行對照 three-vrm 官方範例,不自創)

## 授權

程式碼採 [MIT License](LICENSE)。VRM 範例模型(`AvatarSample_A`)為 VRoid 官方範例,依其原始授權使用;自行放入的模型與動作檔依各自作者授權。
