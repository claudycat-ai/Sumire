# Technology Stack

技術選定の詳細経緯と契約は `docs/spec/architecture.md` 参照。本ファイルは恒久的な技術判断のサマリ。

## Architecture

Tauri アプリ(フロント + Rust ネイティブ) + 推論サーバー(独立プロセス) の構成。アプリと推論サーバーは OpenAI 互換 HTTP API で通信する。推論エンジンをアプリのプロセス内には組み込まない。

```
[Sumire (Tauri)] ─HTTP─▶ [推論サーバー (text-generation-webui 等 / Sumire が起動した llama-server)]
   ├─ Frontend (React + TS、CodeMirror 6)
   └─ Native (Rust、Tauri commands) ← HTTP はここから出す。llama-server の子プロセスもここが起動・停止する
```

推論サーバーを誰が起動・停止するかは、プロバイダごとに違う。

- **OpenAI 互換プロバイダ**: 書き手が起動・停止する。Sumire は管理しない。
- **`llama-server` プロバイダ**: Sumire が、書き手の指した `llama-server` を子プロセスとして起動・停止する。起動するのは最初の提案要求のときで、プロジェクトを開いただけでは起動しない。Sumire がどう終わっても残さない(通常の終了時に止め、Windows ではジョブオブジェクトで強制終了にも備える)。

常時のヘルスチェックはしない(`llama-server` の準備完了を待つ間だけ `/health` を見る)。接続喪失・`llama-server` の失敗や終了はトーストで伝え、本文編集は継続可能。詳細は `docs/spec/architecture.md`「推論サーバーの管理」「llama-server プロバイダ」。

## Core Technologies

- **Language**: TypeScript(フロント)、Rust(ネイティブ層、最小限)
- **Framework**: Tauri 2 + React 19
- **Editor**: CodeMirror 6(`@codemirror/lang-markdown` + 自作 ruby decoration / suggestion 拡張)
- **Runtime**: pnpm 10 / Node 20+ / Rust stable

## Key Libraries

- `react-resizable-panels`: 3 カラムレイアウト
- `zustand`: 状態管理(stores ごと)
- `tailwindcss` + `clsx` + `tailwind-merge`: UI スタイリング
- `@tauri-apps/plugin-dialog` / `plugin-opener`: OS 連携
- `win32job`(Rust、Windows だけ): Sumire が起動した `llama-server` を、Sumire の強制終了・異常終了でも残さないためのジョブオブジェクト

詳細な依存リストは `package.json` 参照。

## Development Standards

### IPC 境界(フロント / Rust 責務分担)

- **ファイル I/O 系は Rust 側に集約**(パス制御とエラーハンドリングの一貫性)
- **HTTP リクエストは Rust 側が担う**。フロントのアダプタは `nativeFetch`(`src/domain/http/`)を `fetch` と同じ形で呼び、Rust 側(`http_request` / `http_cancel`、reqwest)が送受信・中断して、チャンクを Channel で流す。SSE の解釈・エラー分類・タイムアウト判定はフロントのアダプタに残す
  - 理由: 推論サーバー(text-generation-webui v4.x 等)のアクセス元制限で、リリースビルドの Origin `http://tauri.localhost` からの WebView `fetch` が CORS で拒否されるため。あわせて、API キーを画面側に渡さないため(キーは Rust 側で付与し、キーについてフロントが読めるのは存在確認 `has_secret` だけ)
  - 採らなかった代替案(推論サーバー側の `--listen` / `--public-api`、tauri-plugin-http)とその理由は `docs/spec/architecture.md` の「IPC 境界」節を参照

Tauri commands は snake_case + 動詞 + 対象(`read_project`, `save_snapshot` 等)。

### 設計上の不変条件

- **AI プロバイダはアダプタパターン**で差し替え可能。共通インターフェースは `AIProvider.generate(request)` で「テキストの続きを返す」契約に固定(チャット応答ではない)。
- **文脈管理(ContextBuilder)は独立モジュール**。プロバイダ非依存。
- **保存形式は人間可読**(Markdown + JSON)。ベンダーロックイン回避。
- **アプリ本体は推論ロジックを持たない**。すべて別プロセスの推論サーバーに委譲(Sumire が起動する `llama-server` も別プロセス)。

### Type Safety

TypeScript strict mode。`tsconfig.json` 参照。

### Code Quality

- 不要な抽象化・先回り設計をしない(CLAUDE.md グローバル方針 + ローカル方針)
- コメントは「なぜ」が非自明な箇所のみ。「何を」は識別子と diff で読む。

## Development Environment

### Common Commands

```bash
pnpm tauri dev      # 開発(ホットリロード + ネイティブビルド)
pnpm tauri build    # 本番ビルド(単体 exe + msi/nsis インストーラ)
npx tsc --noEmit    # 型チェック
cd src-tauri && cargo check   # Rust 側型チェック
```

## Key Technical Decisions

詳細と理由は `docs/spec/architecture.md` が正。本書では決定の見出しのみ列挙する。

- **Chat ではなく Completion を使う**(`OpenAICompatibleAdapter` は `/v1/completions` を叩く)
- **プロンプトに自動ラベルを付けない**(`ContextSection.label` はログ用、直列化では未使用)
- **アプリデータは OS 標準ディレクトリ配下の `Sumire/`**(プロジェクトデータはユーザー指定フォルダ、Markdown + JSON)
- **PC に固有の設定はアプリ側の `preferences.json` に置く**(`llama-server` のパス・モデルのフォルダ・モデルごとのコンテキスト長。`sumire.json` には書かない)
- **`llama-server` の起動引数は最小限**(`--ctx-size` を必ず明示、`--fit` は渡さない、ポートは起動のたびに空きを選ぶ)

---
_Document standards and patterns, not every dependency_
