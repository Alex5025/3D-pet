# 系統盤點:流程與 API

> 用途:重新設計介面前的地圖。先看清楚「有哪些能力、資料怎麼流」,再決定畫面怎麼擺。
> 產生時間 2026-08-10,對應 commit `7436023`。改了 IPC 或事件請順手更新這份。
> 搭配 [DESIGN-TODO.md](../DESIGN-TODO.md) 一起看。

## 0. 三十秒版

四個行程角色、三個視窗、一條 agent 管線:

```
┌─ main(Electron 主行程,1749 行)───────────────────────────────┐
│  設定落盤 · Tray 選單 · 游標輪詢 · 功率檔位 · 拖曳偵測          │
│  chatQueue(逐寵 FIFO)→ dispatcher → bridge → Provider        │
│                                    ↘ petToolsHub(MCP 回連)   │
└───────┬─────────────┬──────────────┬──────────────────────────┘
    IPC │             │              │
   ┌────▼────┐  ┌─────▼─────┐  ┌─────▼──────┐
   │ overlay │  │ settings  │  │  control   │
   │(疊層)  │  │(逐寵設定)│  │(中控面板) │
   │ 寵物+泡泡│  │ 四分頁    │  │ 三分頁     │
   └─────────┘  └───────────┘  └────────────┘
```

- **overlay** = `index.html` → `main.ts`(多寵 runtime)+ `viewer.ts`(渲染)+ `speechBubble.ts`(對話)
- **settings** = `settings.html` → `settings.ts`,一次只操作「選中的那隻」
- **control** = `control.html` → `control.ts`,一次看全部寵物

---

## 1. 使用者流程(User Flows)

### F1. 開機到看見寵物
`npm run start` → main 讀 `runtime-data/app.json`(寵物 id 清單、選中者、語言、預設工作根目錄)
→ 逐一讀 `runtime-data/pets/<id>.json` → 建疊層視窗 → renderer 對每隻 `enabled` 的寵物建 runtime
→ `getBootVrm` 取模型 buffer → 載入 → 套 state/lighting/sway/wardrobe → `getDefaultPose` 播開機姿勢
→ pull `getChatQueue` 與 `getChatTranscript` 回填泡泡。

**畫面涉及**:疊層(角色)。**設計缺口**:沒有載入中的視覺回饋。

### F2. 跟寵物說一句話(核心流程)
```
hover 寵物 → 泡泡展開 → 打字 → Enter
  → chatSend(invoke,回 {queued, position, reason})
  → chatQueue 入列 → dispatcher 判斷可跑就發 turnStart
  → bridge.chatSend → Provider(codex/claude)
  → 串流事件:thinking / tool / text / approval / done|error
  → main 合併 text(33ms)→ chat-event-apply → 泡泡渲染
  → done 時 persistTranscript 落盤(供下次重啟回填)
```
**關鍵約定**:每個 turn 恰有一個終結事件(`done` 或 `error`);`approvalResolved` 不是終結事件。
**畫面涉及**:泡泡(輸入/回覆/狀態列/狀態膠囊/佇列清單)。

### F3. 審批(危險操作)
Provider 要動手 → `approval` 事件 → **泡泡與中控同時**顯示 → 任一邊回答 → `chat-approval`
→ 另一邊收到 `approvalResolved` 收合 → turn 繼續。拒絕時可附回饋文字,同一輪內修正做法。
**畫面涉及**:泡泡審批區、中控審批列。**設計缺口**:兩邊樣式與資訊量不一致。

### F4. 排隊與公用池
- 泡泡送出 → **必須綁定**該寵(`assignee` = petId)
- 中控發佈 → 可綁定,也可不綁 → 進**公用池**(可限定工作區),空閒且已設工作目錄的寵物自動認領
- 綁定佇列永遠優先於公用池;休息只清綁定佇列,公用池不受影響
**畫面涉及**:泡泡佇列清單、中控發佈卡片、任務帳本。

### F5. 換模型 / 調外觀
Tray 或設定面板角色分頁 → `choose-vrm` → main 開檔案對話框 → `readFileSync` → `vrm-buffer` 推 buffer
→ renderer `loader.parse`(不依賴路徑)→ deepDispose 舊模型 → 套用外觀設定。
外觀四類:**lighting**(光源/色溫/陰影)、**sway**(逐部位物理)、**wardrobe**(材質顯示)、**state**(位置/旋轉/縮放)。
**設計缺口**:沒有模型選擇器(20+ 隻只能逐一開檔案對話框試)。

### F6. 拖放參考檔案
main 的 `dragMonitor` 偵測系統拖曳開始 → 向 renderer 要各寵螢幕矩形(`pet-rects-request`/`pet-rects`)
→ 在寵物位置開「接收窗」(疊層本身收不到 OS 拖放,見 DEVLOG §35)→ 放開 → `ref-files-add`
→ 路徑列在泡泡最下方並注入對話(當次有效,不落盤)。

### F7. 休息 / 喚醒 / 重啟 / 結束
- **休息**:釋放 WebGL context、快取、agent session、清綁定佇列(`updatePetMeta { enabled:false }` 的固有副作用)
- **單寵熱重啟**:`pet-runtime-restart` → renderer 重建該寵 runtime(沿用記憶體中的最新 transform)
- **整體重啟**:`system-restart` → main 觸發 `scripts/restart-pet-system.sh`(PID 檔 → SIGTERM → 重跑)
- **結束**:Tray/中控走 `app.exit`(不經 before-quit);⌘Q 走 before-quit → **二次確認**

### F8. 全域設定
語言(四語,即時廣播三視窗)、新寵物預設工作根目錄。都在**中控的全域分頁**,不進逐寵設定。

---

## 2. IPC API 全表

### 2.1 invoke(有回值,`ipcMain.handle`)

| 通道 | 呼叫端 | 用途 |
|---|---|---|
| `get-pet-collection` | 全部 | 取寵物清單與選中者 |
| `create-pet` / `remove-pet` / `select-pet` | settings/control | 寵物增刪選 |
| `update-pet-meta` | settings/control | 改名、休息/喚醒、agent 綁定、個性、待機動作 |
| `get-state` / `get-lighting` / `get-sway` / `get-wardrobe` | overlay/settings | 讀外觀設定 |
| `motion-list` / `get-default-pose` / `get-boot-vrm` | overlay/settings | 動作與模型資源 |
| `choose-vrm` / `choose-workspace` / `choose-workspace-root` | settings/control | 開檔案對話框(main 端執行) |
| `workspace-root-get` | control | 讀全域預設工作根目錄 |
| `locale-get` / `locale-pref-get` / `locale-set` | 全部 | 語言 |
| `agent-models` | settings | 依 agent kind 取模型清單(有快取) |
| `chat-send` | overlay | 送訊息;回 `{queued, position, reason}` |
| `chat-queue-get` / `chat-transcript-get` | overlay | 泡泡重建時 pull 佇列與上次對話 |
| `control-enqueue` / `control-status-get` / `chat-unbound-remove` | control | 指派任務、全量快照、公用池撤單 |
| `sandbox-settings-get` | control | 讀專案 `.codex/config.toml` |
| `set-input-mode` | overlay | 暫時開放鍵盤焦點(疊層預設不可聚焦) |

### 2.2 send(單向,`ipcMain.on`)
`set-interactive`(穿透切換)、`save-state`/`set-state`、`set-lighting`/`set-sway`/`set-wardrobe`、
`set-default-pose`、`show-menu`、`chat-cancel`/`chat-approval`/`chat-queue-remove`/`new-session`、
`ref-files-add`/`ref-files-remove`、`wardrobe-list`/`avatar-icons`/`pet-rects`(renderer → main 回報)、
`open-external`、`system-restart`/`system-quit`

### 2.3 main → renderer 推播
| 類別 | 通道 |
|---|---|
| 寵物與選取 | `pet-profiles-apply`、`selected-pet-apply`、`pet-runtime-restart` |
| 外觀 | `apply-state`、`apply-lighting`、`apply-sway`、`apply-wardrobe`、`wardrobe-list-apply`、`avatar-icons-apply` |
| 模型與動作 | `vrm-buffer`、`vrma-play`、`vrma-stop`、`expression-apply` |
| 對話 | `chat-event-apply`、`chat-queue-apply`、`ref-files-apply` |
| 中控 | `control-status-apply`(50ms debounce 全量快照) |
| 系統 | `cursor`(30ms 輪詢)、`power-profile-apply`、`locale-apply`、`switch-tab`、`workspace-root-apply`、`pet-rects-request` |

**安全慣例**:每個 handler 都驗 `event.sender`(限特定視窗)。高風險項(沙盒設定、全域根目錄)只認中控。

---

## 3. Agent 管線

```
chatQueue(逐寵 FIFO,cap 10)
  → dispatcher(公平排序:依隊首等候時間)
  → bridge(canAccept 閘門 / onTurnFinished 續派)
  → AgentProvider ─┬─ codexProvider(codex app-server,JSON-RPC 長駐)
                   ├─ claudeProvider(claude -p,每 turn spawn)
                   └─ mockProvider(自驗用)
```

**AgentEvent(9 種)**:`turnStart` · `session` · `thinking` · `tool` · `text` · `approval` · `approvalResolved` · `done` · `error`

**AgentProvider 介面**:`startSession` / `sendMessage`(串流)/ `cancel` / `closeSession`

**MCP 寵物工具**(agent 主動呼叫,經 socket 回連 `petToolsHub`):
`pet_play_motion` · `pet_show_expression` · `pet_speak`

**權限三檔**:唯讀 / 可寫工作目錄(跳審批)/ 全自動 → 各自對映 codex 的 sandbox+approvalPolicy、claude 的旗標。

---

## 4. 資料落盤

| 檔案 | 內容 | 寫入時機 |
|---|---|---|
| `runtime-data/app.json` | 寵物 id 清單、選中者、語言、預設工作根目錄 | 500ms debounce |
| `runtime-data/pets/<id>.json` | 逐寵:名稱、模型路徑、state、lighting、sway、wardrobe、agent 綁定、個性、待機動作、工作目錄 | 500ms debounce |
| `runtime-data/transcripts/<id>.json` | 上一輪對話(user + reply) | turn 結束時 |
| 工作目錄的 `.codex/config.toml` | 沙盒策略 | 中控套用時,main 直寫 |

**不落盤**:參考檔案清單、任務帳本、佇列。

---

## 5. 給重新設計的觀察

1. **能力比畫面多**:上表 27 個 invoke + 20 個 send,但 UI 只暴露了一部分;有些好功能(佇列撤單、公用池限定工作區)藏得很深。
2. **同一件事有多個入口**:改名有兩處、開新對話有三處、工作目錄有兩處——重新設計時要決定「哪裡才是正宮」。
3. **狀態來源不同步**:設定面板是「逐寵 pull」,中控是「全量快照 push」。畫面重排時要留意兩者的更新節奏(中控 50ms 全量重繪,是就地編輯的最大約束)。
4. **缺的畫面**:模型選擇器、動作預覽、對話歷史瀏覽、載入中回饋。
5. **疊層的先天限制**(重排前必讀,詳見 CLAUDE.md 平台實證):收不到被動 mousemove、收不到 OS 拖放、開不了 DevTools、`setPointerCapture` 靜默失敗。任何新互動都要繞過這四點。
