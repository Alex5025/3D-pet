# アーキテクチャと開発

## 技術スタック

- Electron 33
- strict TypeScript
- electron-vite / Vite
- Three.js
- `@pixiv/three-vrm` / `@pixiv/three-vrm-animation`
- marked + DOMPurify

## プロセス境界

| エントリ | 責務 |
|---|---|
| `src/main/index.ts` | Window、Tray、保存、ファイル、電力、IPC、agent lifecycle |
| `src/preload/index.ts` | `contextBridge` 経由の最小権限 API |
| `src/renderer/main.ts` | 複数ペット runtime、操作、hit test、バブル連携 |
| `src/renderer/viewer.ts` | Three.js／VRM のロード、描画、アニメーション、解放 |
| `src/main/agent/` | Codex／Claude／Mock provider、承認、session |
| `src/main/platform.ts` | platform capability、overlay 設定、named pipe／Unix socket、packaged helper path |
| `src/shared/` | IPC 間の型、i18n、chat、sandbox schema |

## Agent bridge

`AgentBridge` は共通イベントストリームを公開し、実行を `AgentProvider` に委譲します。

- Codex：`codex app-server` を常駐させ、JSON-RPC で thread、turn、承認、steer を管理。
- Claude：turn ごとに CLI を起動し、保存済み session を resume。ローカル MCP socket が権限確認を中継。
- Mock：headless selftest と UI テスト用。

各 turn は必ず一つだけ `done` または `error` で終了します。Bridge は同時実行数、キャンセル、watchdog、crash recovery、メッセージキュー、session 保存を管理します。

## Renderer の原則

`viewer.ts` は可能な限り pixiv/three-vrm 公式サンプルの順序に従います。各ペットは独立した viewer/runtime を持ち、モデル、カメラ、アニメーション、リソース解放を分離します。クリック透過判定は bone bounding box で事前判定し、alpha probe でピクセル単位の hit test を行います。

## データとセキュリティ

- `runtime-data/`：ローカル profile、PID、実行状態。Git 管理外。
- `models/`、`motions/`：ローカルアセット。
- パッケージ版の設定は system `userData` に保存し、実行する agent helper は `extraResources` で asar 外へ配置します。
- Renderer に Node.js への直接アクセスを与えません。
- Sandbox IPC は固定 enum／boolean のみ受け付け、main が workspace と symlink を検証します。
- 認証情報、token、API key、端末固有パス、再配布不可アセットを commit しないでください。

## 開発コマンド

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

## テスト画面

- `/vrmtest.html`：モデル、透明度、モーション、操作。
- `/bubbletest.html`：Markdown、画像、承認、メッセージキュー。
- `VRM_PET_AGENT_SELFTEST=1`：MockProvider の全経路。
- `VRM_PET_AGENT_SELFTEST=codex|claude|agy`：実 CLI e2e。サブスクリプション枠を消費します。

GitHub Actions は macOS／Windows の native runner で各 platform package を作成します。Windows は NSIS x64、macOS は DMG/ZIP を使用し、公開版には Authenticode と Developer ID/notarization が別途必要です。

## コントリビューション

- 2 スペース、single quote、semicolon、trailing comma。
- strict typing を維持し、`any` を避けます。
- typecheck、build、関連する手動確認を実行します。
- runtime、端末固有パス、再配布権未確認のアセットを追加しないでください。
