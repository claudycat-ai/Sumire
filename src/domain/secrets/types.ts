// SecretStore は `ProviderId` を直接 account 識別子として扱う(2026-05-10 の
// silent-failure バグ修正で `provider:openai` から `openai` ベースに切替)。
//
// Rust 側 (`src-tauri/src/commands/secrets.rs`) が target_name を
// `Sumire.{provider}_api_key` に組み立てる責務を持つので、
// フロント側は ProviderId を素のまま渡すだけ。
//
// 将来 Anthropic / Gemini を追加する際は `ProviderId` 拡張で自動対応する。

export type {};
