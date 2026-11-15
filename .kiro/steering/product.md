# Product Overview

Sumire(すみれ)は、ローカル LLM とクラウド AI を切り替えながら日本語 Web 小説を執筆するための Tauri 製デスクトップアプリ。AI を「優秀な共著者」として使い、Copilot 風の Tab 採用 UX で続きを提案する。

詳細仕様は `docs/spec/vision.md` 参照。

## Core Capabilities

- **インライン続き提案 + Tab 採用**: カーソル位置にゴーストテキストで続きを表示、Tab で採用、Esc で却下、Shift+Enter で再生成。
- **本文起点の文脈構築**: 中間表現(ノードグラフ等)を経由せず、本文 + メモ(キャラ・世界観)からプロンプトを組む。
- **OpenAI 互換 HTTP API による推論サーバー抽象**: ローカル推論サーバー(text-generation-webui / Ollama / LM Studio 等)を横断的に扱う。アプリ本体は推論ロジックを持たない。推論サーバーは、書き手が自分で起動したものにつなぐほか、Sumire が llama.cpp の `llama-server` を子プロセスとして起動・停止するプロバイダも選べる(モデルとコンテキスト長を Sumire の中で切り替えられる)。どちらも推論は独立プロセスのまま。
- **プロジェクト=一作品の Markdown + JSON 構成**: ベンダーロックインを避け、人間可読な保存形式。

## Target Use Cases

- 自分の手で日本語 Web 小説を書きたい書き手の日次連載執筆ワークフロー(章=エピソード単位)。
- 全自動 AI 生成サービスでは物足りず、ローカル/クラウド推論を試行錯誤しながら使い分けたい層。

## Value Proposition

書く**前**(アイデア構造化)ではなく書く**最中**(続きの提案)に重心を置く。同ジャンルの先行プロダクトとの本質的な違いはここにある。

新機能追加判断時の差別化軸 4 本(Tab UX / 本文起点 / OpenAI 互換 / 日本語 Web 小説特化)と、明示的に取らない方向性(AI へのキャラ付与、ノードグラフ式アウトライナー、チャット型 UI を主動線にする、汎用のモデル管理、`llama-server` の同梱等)の正は **`docs/spec/vision.md`** および **`docs/spec/roadmap.md`** に置く。本書はそれらへの入口。

---
_Focus on patterns and purpose, not exhaustive feature lists_
