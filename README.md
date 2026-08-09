# 3D-pet — 住在桌面上的 AI 工程團隊

**繁體中文** | [English](README.en.md) | [日本語](README.ja.md)

macOS 桌面透明疊層上的 VRM 3D 桌寵(Electron + three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm))——但牠們不只是裝飾。**每隻寵物都綁著一個真正的 coding agent**(OpenAI Codex 或 Claude Code)與一個工作目錄:對泡泡說一句話,寵物就去改 code、跑測試、寫文件,危險操作先回頭問你,做完還配表情動作向你回報。

養一隻是桌寵,養一群就是工程團隊。

## 為什麼特別

- **桌寵會做事**——不是聊天玩具。每寵各自的 agent、模型、推理力度、角色個性與工作目錄;拖檔案給牠當參考資料、貼圖片給牠看,牠在你的 repo 裡實際動手。
- **不燒 API 費**——一律走本機 CLI 的訂閱登入(Codex CLI / Claude Code),沒有 API key,沒有帳單驚喜。
- **多寵協作**——對話有佇列(輸入永不鎖、排隊接續),任務可投給指定寵物或丟進公用任務池由有空的寵物認領;
- **中控面板**一頁總覽全部寵物的狀態、代答審批、集中指派。
- **權限收得住**——三檔權限(唯讀/可寫需審批/全自動),審批拒絕時還能附上修改方向讓 AI 同輪修正;Codex 沙盒策略由主程序直接管理,不經 AI、不跑任意腳本。
- **桌寵該有的完成度**——像素級點擊穿透(透明處滑鼠直接穿過去)、視線跟隨、拖曳/旋轉/縮放、待機動作隨機播放;**物理晃動逐部位可調**:頭髮、衣襬、尾巴各自的搖曳強度分開調校,狐狸尾巴的蓬鬆搖擺是可以自己調出來的。閒置自動節流、電池/過熱降頻、鎖屏全停,常駐也不吃電。
- **四語介面**——繁中/英/日/韓,預設跟隨系統,AI 的回覆語言也跟著切。

## 功能總覽

**桌寵本體**
- 任意替換 VRM 模型(Tray 選單/拖放到接收窗),多寵同時運行、各自獨立設定
- 視線跟隨游標、拖曳移動、右鍵旋轉、滾輪縮放;透明區域點擊穿透(像素級命中)
- 光影(平行光/點光源/陰影)、**逐部位物理晃動強度**(頭髮/衣服/胸部/尾巴,spring bone 物理各自獨立調)、服裝顯示開關(可脫???)
- VRMA 動作播放、開機預設姿勢、待機動作(勾一組,20~60 秒隨機播放)
- 功率檔位:閒置節流 + `powerMonitor` 聯動(電池/過熱降頻、鎖屏/睡眠全停、ProMotion 螢幕鎖回 60Hz 設計值)
- 寵物可「休息」釋放資源(WebGL context/快取/agent session),要用再喚醒

**AI 助手(對話泡泡)**
- 每寵綁定 **Codex**(`codex app-server`,JSON-RPC 長駐)或 **Claude Code**(CLI spawn);模型動態清單、推理力度 low~ultra、角色個性注入 system prompt
- **對話佇列**:執行中輸入框不鎖,訊息排隊自動接續;每則可撤回
- 回覆 Markdown 渲染(GFM、DOMPurify 消毒)、模型/力度徽章、外側狀態膠囊(執行中/等審批/完成,已讀才消失)
- **圖片訊息**:PNG/JPEG/WebP 直接貼進輸入框(最多 4 張、單張 8 MiB),AI 可讀
- **拖放參考檔案**:檔案/資料夾拖向寵物,放進亮起的接收窗——絕對路徑注入對話,AI 知道去哪查
- **泡泡好用細節**:圖釘常駐展開、左右邊緣拖曳調寬(雙擊還原自動)、寬度隨內容伸縮、多寵擁擠時自動縮上限
- session 持久化(重啟接續上次對話)、可中斷、crash 自動重連、「＋ 新對話」一鍵清空
- **寵物工具(MCP)**:agent 自主呼叫 `pet_play_motion` / `pet_show_expression` / `pet_speak`,邊做事邊表演

**多寵協作(中控面板)**
- 逐寵狀態列表(休息/閒置/工作中/等審批),依最後活動排序
- 集中指派:投給指定寵物,或發到**公用任務池**(可限定工作區)由有空的寵物認領;任務帳本追蹤 queued→running→done 全生命週期
- 審批代答:泡泡與中控同步收合,不用追著寵物跑
- 沙盒設定分頁:逐寵調整 Codex 核准策略/沙盒模式/網路存取——由 Electron main 直寫工作目錄的 `.codex/config.toml`,不經 AI
- 介面語言下拉(繁中/英/日/韓)

**安全設計**
- 三檔權限:唯讀/可寫工作目錄(泡泡跳審批)/全自動;拒絕可附回饋,AI 同輪修正做法
- `workspace-write` 通常仍保護 `.git`;commit/push 需明確同意或在可信專案短暫開完整存取(有二次確認)
- 新寵物自動建立專屬工作目錄(`~/Documents/PetWorkspaces/<寵物名>_<時間戳>/`),不污染別的專案

## 需求

- macOS(Apple Silicon 實測)
- Node.js 22+
- 要用 AI 功能:[Codex CLI](https://github.com/openai/codex) 與/或 [Claude Code](https://claude.com/claude-code) 已安裝並登入(訂閱帳號)

## 快速開始

```bash
npm install
npm run dev
```

- 角色出現在桌面;滑鼠壓到角色變可互動,移開自動穿透。
- **對話**:滑到角色上 → 泡泡輸入 → Enter 送出(Shift+Enter 換行);執行中繼續打字會自動排隊。
- **右鍵角色(或 Tray 圖示)**:切換/新增寵物、選 VRM 檔、角色動作、設定、**中控面板**、沙盒設定、重置位置、休息/喚醒、重啟寵物或整個系統。
- **設定面板**分頁:光影/角色(名稱、個性、晃動、服裝)/動作(預設姿勢、待機動作)/工作(agent、模型、力度、權限、工作目錄)。

模型放 `models/`、動作(.vrma)放 `motions/`;運行資料在 `runtime-data/`(皆不入版控)。

> `.codex/config.toml` 可能包含專案沙盒策略與本機路徑,提交前請確認內容適合分享;憑證、token、API key 不得寫入 repository。

## 開發與驗證

```bash
npm run typecheck && npm run build

VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=1 npm run dev       # MockProvider 全鏈自驗
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=claude npm run dev  # 真 claude e2e(耗訂閱額度)
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=codex npm run dev   # 真 codex e2e(耗訂閱額度)
VRM_PET_AGENT_MOCK=1 npm run dev                                          # 假 agent 走 UI,不耗額度
VRM_PET_AGENT_DEBUG=1 npm run dev                                         # dump agent argv/payload
VRM_PET_PERF_LOG=1 npm run dev                                            # 效能量測(疊層無 DevTools 的通道)
```

瀏覽器驗證頁(dev server 起來後):`/vrmtest.html` 驗渲染(`window.__viewer`)、`/bubbletest.html` 驗泡泡(`window.__bubble`)。

## 文件

- [docs/DEVLOG.md](docs/DEVLOG.md) — 開發日誌:每個議題的症狀 → 根因 → 處理(含大量 macOS 疊層視窗的平台實證知識)
- [docs/AGENT-BRIDGE-DESIGN.md](docs/AGENT-BRIDGE-DESIGN.md) — agent 串接架構(AgentProvider 抽象、審批、佇列、MCP 寵物工具)
- [CLAUDE.md](CLAUDE.md) — 開發守則(渲染逐行對照 three-vrm 官方範例,不自創)

## 授權

程式碼採 [MIT License](LICENSE)。VRM 範例模型(`AvatarSample_A`)為 VRoid 官方範例,依其原始授權使用;自行放入的模型與動作檔依各自作者授權。
