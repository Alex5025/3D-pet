# 對話泡泡 ⇄ Agent CLI 串接機制設計

狀態:**設計定稿,尚未實作**(2026-07-24)。
目標:泡泡輸入框送出的訊息,依每隻寵物的設定交給 **Codex CLI**(`codex`)或 **Claude Code CLI**(`claude`)執行,回覆與過程狀態串流回泡泡顯示;session 延續、可中斷、與寵物生命週期(休眠/刪除)整合。

---

## 1. 現況地基(設計立足點)

- `PetProfile` 已有 `workspacePath`(工作目錄)與 `codexSessionId`(手填欄位,尚無人消費)。
- 泡泡(`speechBubble.ts`)有輸入框與 focus 管理,但 **Enter 送出尚未接任何後端**(只有 Escape blur)。
- 專案內沒有任何 `child_process` 程式碼——乾淨起點。
- 慣例:profile 變更走 `updatePet` 單一入口;設定即時 IPC 雙向同步;資料存 `runtime-data/pets/<UUID>.json`。

## 2. 架構

```
┌─ renderer(泡泡)─┐        ┌─ main(AgentManager)─┐        ┌─ 子行程 ─┐
│ Enter 送出        │─chat-send→ 每寵一個 AgentSession │─spawn→ codex exec --json …
│ 顯示回覆/狀態/錯誤 │←chat-event─ (狀態機 + adapter 解析) │        claude -p --output-format stream-json …
└──────────────────┘        └──────────────────────┘        └──────────┘
```

- 子行程一律由 **main** spawn(renderer 無 node 權限),`cwd = profile.workspacePath`。
- **每寵物同時至多一個進行中 turn**(狀態機 `idle → running → idle | error`);不同寵物可並行,全域 running 上限 4,超過拒絕並提示。

## 3. Adapter 層(統一兩種 CLI)

```ts
interface AgentAdapter {
  kind: 'codex' | 'claude';
  buildCommand(req: { prompt: string; workdir: string; sessionId?: string }): { cmd: string; args: string[] };
  parseLine(line: string): AgentEvent[];   // JSONL → 統一事件
}

type AgentEvent =
  | { kind: 'session'; sessionId: string }   // 首個帶 session id 的事件 → 回存 profile
  | { kind: 'thinking' }                     // 泡泡:「思考中…」
  | { kind: 'tool'; name: string }           // 泡泡:「正在執行 ○○」
  | { kind: 'text'; text: string }           // 助手回覆文字
  | { kind: 'done'; ok: boolean }
  | { kind: 'error'; message: string };
```

### codex adapter

- 指令:`codex exec --json --skip-git-repo-check <prompt>`;有 sessionId 時改走 resume 形式(**確切旗標以實作期煙霧測試為準**,resume 失敗自動退回開新 session)。
- 已實證的坑(舊專案 spike,必須寫進 adapter):
  1. **spawn 後立即 `child.stdin.end()`** —— codex 會等 stdin EOF,不關會永久卡死;
  2. 事件形狀:`thread.started` / `item.started|completed`(item.type = `agent_message`/`command_execution`/`reasoning`…)/ `turn.completed` / `turn.failed`——實作前重新抓一次真實輸出校對(版本可能已變)。

### claude adapter(Claude Code CLI)

- 指令:`claude -p <prompt> --output-format stream-json --verbose`,resume 用 `--resume <sessionId>`。
- 事件對映:`{"type":"system","subtype":"init","session_id"}` → `session`;`{"type":"assistant", message.content[].text}` → `text`;`{"type":"result"}` → `done`(帶 is_error)。
- v1 純問答:以 `--allowedTools`(空/最小集)限制不執行工具;v2 再開放並設計權限策略。

### 共通

- Prompt 一律作為**單一 argv 參數**傳遞(不經 shell,無注入面)。
- stdout 按行切割餵 `parseLine`;stderr 收尾附進 `error`;非 JSON 行忽略但記 log。

## 4. 資料模型(v2 → 小幅擴充)

```ts
agent?: { kind: 'codex' | 'claude'; sessionId?: string }
```

- 遷移:既有 `codexSessionId` → `agent: { kind: 'codex', sessionId }`(舊欄位保留,遵循既有遷移慣例)。
- 設定面板:「Codex Session ID」欄升級為 **agent 種類下拉(codex/claude)+ session ID 欄**(ID 通常由系統自動回存,手填為進階用途)。
- 收到 `session` 事件 → `updatePet(id, { agent: {...} })` 自動回存(單一變更點慣例)。

## 5. IPC 契約

| 通道 | 方向 | 內容 |
|---|---|---|
| `chat-send(petId, text)` | renderer→main | 泡泡送出;main 檢查:profile 存在、workspacePath 已設、該寵非 running、全域上限 |
| `chat-abort(petId)` | renderer→main | 中斷(kill child) |
| `chat-event(petId, AgentEvent)` | main→renderer | 串流回泡泡 |

## 6. 泡泡 UI 變更(speechBubble.ts)

- **Enter 送出** → 輸入框 disabled;泡泡上方新增**回覆區**(可滾動,顯示最近一則回覆,狀態列輪播 thinking/tool 名)。
- `done` → 解鎖輸入框;`error` → 紅字;running 中 **Esc 或停止鈕 = chat-abort**。
- 未設 `workspacePath` 就送出 → 泡泡就地提示「先到工作設定選擇工作目錄」,不 spawn。
- 泡泡 hover 顯示/隱藏邏輯不變;running 時泡泡**不因移開游標而消失**(有進行中對話則保持顯示)。

## 7. 生命週期與保險絲

- **休眠/刪除寵物 → kill 其 child**:掛在 `updatePet` 的 disable 副作用旁(與快取釋放同一單一入口);kill 流程 SIGTERM → 1 秒 → SIGKILL。
- **app 退出**:`before-quit` 清全部子行程;Tray「結束」按鈕(走 `app.exit`,**不觸發 before-quit**——已知坑)在 `flushConfigSync()` 旁一併清理。
- 子行程 30 秒無輸出 → 泡泡顯示「仍在執行…」;5 分鐘硬上限 kill + error(可日後做成設定)。

## 8. 分期

| 期 | 範圍 |
|---|---|
| **v0(實作首日必做)** | 煙霧測試:兩個 CLI 各跑真實命令,JSONL 樣本存 scratchpad,校對事件形狀後才寫 parser(舊 spike 教訓:猜格式必錯) |
| **v1** | 純問答:adapter ×2、AgentManager、IPC、泡泡回覆區、session 回存與 resume、中斷、生命週期整合 |
| **v2** | 工具執行 + 權限策略(自動允許清單、危險操作確認 UI) |
| **v3** | 狀態連動角色表演:thinking 播思考動作、done 播開心表情(VRMA/表情系統現成) |

## 9. 驗證方法

1. **v0 煙霧測試**先行(見上)。
2. **mock adapter**(echo JSONL 的 shell 腳本)headless 驗整條鏈:chat-send → 事件 → 泡泡渲染 → session 回存,不依賴真 CLI、不消耗 API 額度。
3. 真 CLI 端到端:各問一題;驗 resume(連續兩問同 session);驗中斷;驗「休眠寵物時 child 被 kill」;`npm run typecheck` + `npm run build`。
