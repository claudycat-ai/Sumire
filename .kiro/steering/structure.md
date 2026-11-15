# Project Structure

ディレクトリ構成と命名規約のパターン集。詳細仕様は `docs/spec/architecture.md` 参照。

## Organization Philosophy

**レイヤー分割 + ドメイン分離**:

```
src/
├─ components/     # UI Layer(React コンポーネント、ペイン単位)
├─ stores/         # State Layer(Zustand stores)
├─ domain/         # Domain Layer(プロバイダ抽象、ファイル CRUD、コンテキスト構築)
├─ editor/         # Editor 拡張(CodeMirror 拡張 + suggestion UX)
├─ lib/            # 汎用ユーティリティ
└─ App.tsx, main.tsx
```

各レイヤーは下位にのみ依存する(DIP)。UI → State → Domain → Adapter の単方向。

## Directory Patterns

### UI Layer

**Location**: `src/components/`
**Purpose**: ペイン単位の React コンポーネント。子ディレクトリで責務を切る(`editor/`, `memo/`, `project/`, `settings/`, `welcome/`, `snapshot/`, `ui/`)。`ui/` は再利用可能な primitive(Button、Toast 等)。
**Example**: `src/components/editor/ChapterEditor.tsx` が章本文エディタの container。

### State Layer

**Location**: `src/stores/`
**Purpose**: Zustand store。1 ファイル = 1 ドメインの状態。`useXxxStore` の命名で export し、状態とアクションを同居させる。
**Example**: `src/stores/suggestionStore.ts`(提案 UX の state)、`src/stores/aiConfigStore.ts`(AI 設定キャッシュ)。

### Domain Layer

**Location**: `src/domain/`
**Purpose**: プロバイダ抽象、ファイル CRUD、プロンプト構築などフレームワーク非依存のロジック。サブドメインごとにディレクトリ(`providers/`, `project/`, `memo/`, `snapshot/`, `context/`, `llamaServer/`)、`types.ts` で型を集約、`xxxApi.ts` で外部 I/O ラッパー、`index.ts` で公開 API。
**Example**: `src/domain/providers/openaiCompatible.ts` が OpenAI 互換アダプタ実装。

### Editor 拡張

**Location**: `src/editor/`
**Purpose**: CodeMirror 6 拡張群と提案 UX のステートマシン。単機能は 1 ファイル、複雑な機能は子ディレクトリで分割。
**Example**: `src/editor/suggestion/` 配下に state / lifecycle / keymap / decorator / scroll / controller を分離。

### Rust 側 commands

**Location**: `src-tauri/src/commands/`
**Purpose**: Tauri commands(フロントから呼べる関数)を機能単位に分割。`lib.rs` で `invoke_handler!` に登録。
**Example**: `src-tauri/src/commands/recent.rs`(最近のプロジェクト履歴)、`commands/snapshot.rs`(スナップショット)、`commands/llama_server.rs`(`llama-server` の子プロセスの監督)、`commands/preferences.rs`(アプリ側の設定 `preferences.json` の読み書きと gguf の一覧)。

Rust からフロントへの知らせは Tauri のイベント(`llama-server-status`)で送り、フロントは `domain/llamaServer/llamaServerApi.ts` のラッパーで購読する。

### Specs / Docs

**Location**: `docs/spec/` + `.kiro/`
**Purpose**: 仕様書とプロジェクト知識の住み分け。
- `docs/spec/`: 恒久的な仕様書(vision / UX / アーキテクチャ / ロードマップ / 磨き込みバックログ)。読み順は `docs/spec/README.md` 参照。
- `.kiro/steering/`: 永続的なプロジェクト知識(本ファイル群)。docs/spec の要約 + 参照ポインタ。
- `.kiro/specs/<feature>/`: 個別機能の作業領域(requirements / design / tasks)。完了したら凍結 or 削除。作業記録なので、公開しているリポジトリには含めていない。

## Naming Conventions

- **TS files**: `camelCase.ts`(モジュール)、`PascalCase.tsx`(React コンポーネント)
- **Rust files**: `snake_case.rs`
- **Tauri commands**: `snake_case`、動詞 + 対象(`read_project`, `save_snapshot`)。例外: HTTP 中継の `http_request` / `http_cancel`(`docs/spec/architecture.md` の命名規約参照)
- **Zustand stores**: `useXxxStore`
- **保存ファイル形式**: 本文・メモ・設定は Markdown(フロントマター付きも可)、メタデータは JSON
- **設定の置き場**: 作品ごとの設定はプロジェクトの `sumire.json`、PC に固有の設定(`llama-server` のパスやモデルごとのコンテキスト長)はアプリデータディレクトリの `preferences.json`

## Import Organization

```typescript
import { foo } from "react";              // 外部
import { Button } from "@/components/ui/Button";  // 絶対パス(@/ = src/)
import { local } from "./local";          // 同一ディレクトリのみ相対
```

**Path Aliases**:
- `@/`: `src/` 直下にマップ(`vite.config.ts` / `tsconfig.json` 参照)

## Code Organization Principles

- **レイヤー単方向依存**: UI が Domain を直接触ってもよいが、Domain は UI を知らない。
- **store はドメインごとに薄く切る**: 単一巨大 store にしない。
- **CodeMirror 拡張は副作用と state を内包**: View/State の役割を分けてユニット化。
- **Tauri command 追加時は Rust 側 + フロント側の wrapper を必ずペアで**: 型整合は手で揃える(現状は自動生成しない)。

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
