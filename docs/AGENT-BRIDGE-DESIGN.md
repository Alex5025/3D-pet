# 對話泡泡 ⇄ Agent 串接機制設計(v2)

狀態:**設計定稿,尚未實作**(2026-07-24;v2 改版 2026-07-27)。
目標:泡泡輸入框送出的訊息,依每隻寵物的設定交給 **Codex** 或 **Claude Code** 的 agent runtime 執行,回覆與過程狀態串流回泡泡;多寵物長對話、可中斷、審批(approval)、重啟後恢復、與寵物生命週期(休眠/刪除)整合。

> v2 相對 v1 的核心改變:引入 **AgentProvider 抽象**——消費端(泡泡/IPC/持久化)只依賴統一介面,各家後端可獨立演進。Codex **v1 直接走 app-server(JSON-RPC 長駐)**,exec 僅為 fallback、預設不實作(exec 與 app-server 內部零共用,過渡工是白工;風險由 v0 gate 把關);Claude 受「**不使用計費 API**」硬性約束(使用者定案),走 **`claude -p` CLI spawn**(訂閱認證),Agent SDK(需 API key)排除。

---

## 1. 兩種整合哲學(選型依據)

| | 單發 CLI(`codex exec --json` / `claude -p --output-format stream-json`) | 長駐 runtime(`codex app-server` / Claude Agent SDK) |
|---|---|---|
| 定位(官方) | scripts / CI / 單次任務 | 自訂 GUI client 深度整合 |
| 多輪對話 | resume 旗標,自己管理 | Thread/Session 原生模型 |
| 多寵物並行 | 自己管 process 池 | 原生(Codex: Thread;Claude: 並行 query) |
| Cancel | 殺 process | 原生(`turn/interrupt` / `q.interrupt()`) |
| Approval(工具執行前確認) | ❌ 非互動模式,不適合 | ✅ 原生(app-server approval request / SDK `canUseTool` callback) |
| 工程複雜度 | ⭐⭐ | ⭐⭐⭐⭐(Codex 要管 JSON-RPC id map、重連;Claude SDK 較低,library 直嵌) |
| 適合本專案 | v0 煙霧測試、fallback、mock | **正式架構** |

判斷:桌寵的終局需求(多寵各自 workspace + 持續對話 + streaming + cancel + approval + 重啟恢復)**全部落在長駐 runtime 的使用場景**。若先做 exec 版再重構,會先自己堆出 ProcessManager/SessionManager/CancellationManager/ApprovalManager 然後全部丟掉。因此:**介面直接按 session 模型設計**,provider 內部實作可以分期(見 §8),消費端(泡泡/IPC/持久化)永不重寫。

※ Claude 這邊的長駐選項(Agent SDK)因「**不使用計費 API**」的硬性約束被排除(SDK 需 `ANTHROPIC_API_KEY`,不吃 CLI 訂閱登入)——ClaudeProvider 以 `claude -p` spawn 實作,靠 `--resume` 補上 session 延續,詳見 §4。

## 2. 架構

```
Renderer(泡泡)                Electron Main                        Agent Runtime
┌────────────────┐   IPC    ┌──────────────────────┐
│ Enter 送出      │─chat-send→│ AgentBridge           │
│ 串流回覆/狀態    │←chat-event│  ├ CodexProvider ─────┼─ stdio JSON-RPC → codex app-server(長駐)
│ 審批 UI(v2)    │─approval─→│  │                     │      ├ Thread A ← 🐱 寵物A(/project/foo)
│ Esc 中斷        │─cancel──→│  └ ClaudeProvider ────┼─ spawn → claude -p(訂閱認證,--resume 續 session)
└────────────────┘           └──────────────────────┘      ├ Session B ← 🦊 寵物B(/project/bar)
```

- 一切 agent 邏輯在 **main**(renderer 無 node 權限);泡泡只認統一事件。
- 每寵物 → 一個 provider session(Codex Thread 或 Claude SDK session),互不干擾;`cwd = profile.workspacePath`。

## 3. AgentProvider 抽象(消費端唯一依賴)

```ts
interface AgentProvider {
  readonly kind: 'codex' | 'claude';
  /** 開新對話或恢復既有對話;回傳 provider 端 session/thread id */
  startSession(opts: { workdir: string; resumeId?: string }): Promise<string>;
  /** 送一句話,串流回統一事件;一個 session 同時只允許一個進行中 turn */
  sendMessage(sessionId: string, text: string): AsyncIterable<AgentEvent>;
  /** 中斷該 session 進行中的 turn */
  cancel(sessionId: string): Promise<void>;
  /** 回覆 approval 請求(v2) */
  respondApproval(sessionId: string, requestId: string, allow: boolean): Promise<void>;
  /** 釋放單一 session(寵物休眠/刪除) */
  closeSession(sessionId: string): Promise<void>;
  /** 整個 provider 收攤(app 退出) */
  dispose(): Promise<void>;
}

type AgentEvent =
  | { kind: 'session'; sessionId: string }                    // 回存 profile.agent.sessionId
  | { kind: 'thinking' }
  | { kind: 'tool'; name: string }                            // 「正在執行 ○○」
  | { kind: 'text'; text: string }                            // 增量或整段回覆文字
  | { kind: 'approval'; requestId: string; description: string } // v2:泡泡顯示 允許/拒絕
  | { kind: 'done'; ok: boolean }
  | { kind: 'error'; message: string };
```

泡泡、IPC、session 持久化、審批 UI 全部只依賴這個介面——**加第三家、或把某家內部從 CLI 換成 server,消費端零改動**。

## 4. 兩個 Provider 規格

### CodexProvider

**目標形態:`codex app-server --listen stdio://`(雙向 JSON-RPC,官方給自訂 client 的介面)**

- Bridge 啟動一個長駐 app-server 子行程(lazy:第一隻 codex 寵物開口才啟動);`initialize` 交握。
- 對映:`startSession` → `thread/start`(或 resume 既有 threadId);`sendMessage` → `turn/start` + 訂閱 `item/agentMessage/delta` 等通知 → 統一事件;`cancel` → `turn/interrupt`;approval request ↔ `respondApproval`。
- 要管理:JSON-RPC request id ↔ response 對應、notification 路由(threadId → 寵物)、**crash 偵測 → 重啟 → thread resume**(對映我們 §10 的 render-process-gone 保險絲精神)。
- 協定屬進階整合、升版面較大 → 全部 JSON-RPC 細節封在 `CodexProvider` 內,版本相容問題不外洩。

**v1 直接做 app-server,不經 exec 過渡**(使用者定案 2026-07-27):X1(exec)與 X2(app-server)的 provider 內部幾乎零共用——單發 process + JSONL vs 長駐 JSON-RPC(id 對應、通知路由、重連),先做 exec 的工都是丟掉的,且 approval/cancel 語意 v2 還要再換一次。app-server 的協定風險由 **v0 煙霧測試把關**:v0 驗證通過 → v1 直上 X2;v0 發現 app-server 不可用/形狀差太多 → 才退回 exec 形態並回報重新決策。

**exec 形態(fallback,預設不實作)**

- 僅當 app-server 不可用時的退路,以及手動除錯工具(`codex exec --json --skip-git-repo-check <prompt>`)。
- 若真要實作,舊 spike 的坑:**spawn 後立即 `child.stdin.end()`**(codex 等 stdin EOF,不關永久卡死);事件形狀以實測輸出校對。此形態無 approval、cancel = 殺 process。

### ClaudeProvider

**硬性約束(使用者定案 2026-07-27):不使用計費 API——Claude 整合必須走本機 Claude Code CLI 的訂閱登入。**

因此排除 Claude Agent SDK(官方文件明載需 `ANTHROPIC_API_KEY`、API 計費、不沿用 CLI 訂閱憑證)。**正式形態 = spawn `claude` CLI 本體**,直接吃已登入的訂閱帳號:

- 指令:`claude -p <prompt> --output-format stream-json --verbose`;resume 用 `--resume <sessionId>`;`cwd = workspacePath`。
- 事件對映:`{"type":"system","subtype":"init","session_id"}` → `session`;`{"type":"assistant", message.content[]}` → `text`/`tool`;`{"type":"result", is_error}` → `done`。確切形狀以 v0 煙霧測試校對。
- **cancel** = 殺該 turn 的 process(SIGTERM → 1s → SIGKILL);session 由 `--resume` 延續,殺 process 不丟對話。
- v1 純問答:`--allowedTools` 最小集(不執行工具)。
- **審批(v2)**:headless 模式的官方途徑是 `--permission-prompt-tool`——把權限詢問導向一個 MCP 工具,由我們接住轉成 `approval` 事件。確切用法列入 v2 前的煙霧測試。
- **寵物工具(v3)仍可行,不需要 SDK**:寫一個小型 **stdio MCP server**(隨 app 附帶的 node 腳本),經 `--mcp-config` 掛給 CLI;該 server 收到 `pet_change_pose`/`pet_play_motion`/`pet_show_expression` 等呼叫時,透過本機 socket/IPC 回連 Electron main → renderer 播 VRMA/表情。比 SDK 的 in-process 版多一層,但完全走訂閱認證。
- 若日後官方讓 Agent SDK 支援訂閱憑證,ClaudeProvider **內部**可換成 SDK(interrupt/canUseTool/in-process MCP 都更順)——provider 抽象保證外面零改動。

## 5. 資料模型

```ts
agent?: { kind: 'codex' | 'claude'; sessionId?: string }
```

- 遷移:既有 `codexSessionId` → `agent: { kind: 'codex', sessionId }`(舊欄位保留,循 v2 格式遷移慣例)。
- `session` 事件 → `updatePet(id, { agent })` 自動回存(單一變更點慣例);重啟後以 `resumeId` 恢復對話。
- 設定面板:「Codex Session ID」欄升級為 **agent 種類下拉(codex/claude)+ session ID 欄**(通常自動回存,手填為進階用途)。

## 6. IPC 契約與泡泡 UI

| 通道 | 方向 | 內容 |
|---|---|---|
| `chat-send(petId, text)` | renderer→main | main 檢查:profile 存在、workspacePath 已設、該寵無進行中 turn、全域 running 上限(4) |
| `chat-cancel(petId)` | renderer→main | 中斷 |
| `chat-approval(petId, requestId, allow)` | renderer→main | 審批回覆(v2) |
| `chat-event(petId, AgentEvent)` | main→renderer | 串流回泡泡 |

泡泡(speechBubble.ts):**Enter 送出** → 輸入框 disabled、新增回覆區(可滾動)+ 狀態列(thinking/tool 名輪播);`done` 解鎖、`error` 紅字;running 中 **Esc = cancel**;`approval` 事件 → 泡泡內顯示描述 + 允許/拒絕鈕;未設 workspacePath 就送出 → 就地提示,不進 provider;running 時泡泡不因移開游標而消失。

## 7. 生命週期與保險絲

- **寵物休眠/刪除** → `provider.closeSession(sessionId)`:掛在 `updatePet` 的 disable 副作用旁(與快取釋放同一單一入口)。
- **app 退出** → `provider.dispose()`(app-server 子行程 SIGTERM → 1s → SIGKILL):`before-quit` + Tray「結束」的 `flushConfigSync()` 旁(app.exit 不觸發 before-quit——已知坑)。
- **app-server crash** → CodexProvider 偵測 exit,標記所有 codex session 斷線、發 `error` 事件,下次 sendMessage 自動重啟 + resume。
- 30 秒無輸出 → 泡泡顯示「仍在執行…」;5 分鐘硬上限 → cancel + error。

## 8. 分期

| 期 | 範圍 |
|---|---|
| **v0(實作首日,gate)** | 兩項查證,樣本存 scratchpad:(a) **`codex app-server`**:啟動、initialize 交握、thread/start + turn/start 一問一答、turn/interrupt 的實際 RPC 形狀——**此項是 v1 的 gate**,不可用則退回 exec 形態並重新決策;(b) `claude -p --output-format stream-json` 真實輸出形狀 + `--resume` 實測(確認走訂閱、不需 API key) |
| **v1** | `AgentProvider` 介面 + AgentBridge + IPC + 泡泡回覆區;ClaudeProvider **CLI spawn 形態(C1)**;CodexProvider **直接 app-server 形態(X2)**:長駐子行程、RPC id 對應、通知路由、crash 重連;session 回存/resume;cancel(claude 殺 process / codex `turn/interrupt`);生命週期整合。純問答(claude `--allowedTools` 最小集 / codex 唯讀) |
| **v2** | approval 事件 + 泡泡審批 UI(claude `--permission-prompt-tool` / codex app-server approval);開放工具執行 + 權限策略 |
| **v3** | **in-process MCP 寵物工具**:`pet_change_pose`/`pet_play_motion`/`pet_show_expression` 等,agent 驅動桌寵表演;狀態連動(thinking 播思考動作、done 播開心) |

## 9. 驗證方法

1. **v0 查證先行**(上表)——猜格式必錯,是舊 spike 用真金白銀買來的教訓。
2. **MockProvider**(實作 `AgentProvider`、照腳本吐事件)headless 驗整條鏈:chat-send → 事件 → 泡泡渲染 → session 回存 → cancel → approval UI,不依賴真 runtime、不耗額度;也是日後回歸測試的基座。
3. 真 runtime 端到端:各問一題;resume(連兩問同 session + 重啟 app 後再問);中斷;休眠寵物時 session 被關;`npm run typecheck` + `npm run build`。
