# はじめに

## 3D-pet とは

3D-pet は macOS 向けの VRM デスクトップペットシステムです。各ペットに Codex または Claude Code、作業ディレクトリ、モデル、推論レベル、権限、性格を設定できます。会話だけでなく、コード編集、テスト実行、ドキュメント作成も行えます。

## 必要環境

- macOS（Apple Silicon で動作確認済み）
- Node.js 22 以降
- npm
- 次のうち少なくとも一つをインストールしてログイン済みであること：
  - OpenAI Codex CLI
  - Claude Code CLI
- 利用権限を確認した `.vrm` モデルと `.vrma` モーション

AI 機能はローカル CLI のサブスクリプション認証を利用します。API キーを repository に保存しないでください。

## インストールと起動

```bash
git clone <YOUR_GITLAB_PROJECT_URL>
cd 3D-pet
npm install
npm run dev
```

起動すると透明なデスクトップオーバーレイにキャラクターが表示されます。ポインターをペットに重ねると操作でき、離すと透明部分へのクリックは背後のアプリへ通過します。

## 初期設定

1. ペットを右クリックするか Tray メニューを開きます。
2. **設定 → 作業（AI アシスタント）**を開きます。
3. Codex または Claude Code を選択します。
4. モデル、推論レベル、権限を設定します。
5. 作業ディレクトリを選ぶか、新規ペット用の既定ディレクトリを使用します。
6. 必要に応じてペットの性格を設定します。
7. VRM を `models/` に置くか、メニューから選択します。

## 基本操作

| 操作 | 動作 |
|---|---|
| 左ドラッグ | ペットを移動 |
| 右ドラッグ | ペットを回転 |
| マウスホイール | ペットを拡大・縮小 |
| ペットにホバー | 会話バブルを表示 |
| Enter | メッセージを送信 |
| Shift+Enter | 改行 |
| 光る受信ウィンドウへドロップ | 参照追加、VRM 交換、VRMA 再生 |

## 動作確認

```bash
npm run typecheck
npm run build
```

サブスクリプション枠を消費せず agent パイプラインを確認するには：

```bash
VRM_PET_DATA_DIR=$(mktemp -d) VRM_PET_AGENT_SELFTEST=1 npm run dev
```

## 次に読むページ

- [ユーザーガイド](User-Guide-ja)
- [アーキテクチャと開発](Architecture-ja)
