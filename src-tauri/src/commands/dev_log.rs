// dev/dogfood 専用の操作ログ。
//
// フロント側の重要なライフサイクルイベント(secret 操作、provider 切替、
// generate start/end/error など)を JSON Lines 形式でプロジェクトルートの
// `dev-events.jsonl` に append する。実機 dogfood の挙動をスクショなしで
// 観察できるようにするための補助機構。
//
// 設計の要点:
// - **環境変数 `SUMIRE_DEV_LOG=1` のときだけ実際にファイルに書く**。
//   未設定または "1" 以外なら command 自体は成功(no-op)で返す。
//   「フロントは無条件 invoke、Rust 側でフィルタ」の方針。
// - 出力先はプロジェクトルートの `dev-events.jsonl`(`CARGO_MANIFEST_DIR`
//   から相対導出するのでビルド環境固定値)。`.gitignore` に追加済み。
// - **debug ビルドのみ**(`#[cfg(debug_assertions)]`)。release バイナリ
//   からは command 自体が消える。
// - フロントが既にフォーマット済の 1 行 JSON を渡す前提(`line: String`)。
//   タイムスタンプ等もフロント側で組み立てる。Rust 側はファイル append のみ。

#[cfg(debug_assertions)]
mod impl_dev {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;

    /// 出力先ファイルのパス。コンパイル時に `CARGO_MANIFEST_DIR` から導出する。
    /// `pnpm tauri dev` は `src-tauri/` で cargo を回すので、その親が
    /// プロジェクトルート(そこに `dev-events.jsonl` を書く)になる。
    fn log_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dev-events.jsonl")
    }

    fn is_enabled() -> bool {
        std::env::var("SUMIRE_DEV_LOG")
            .map(|v| v == "1")
            .unwrap_or(false)
    }

    pub(super) fn append(line: &str) -> Result<(), String> {
        if !is_enabled() {
            return Ok(());
        }
        let path = log_path();
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("dev-events.jsonl open failed ({}): {}", path.display(), e))?;
        writeln!(f, "{line}").map_err(|e| e.to_string())
    }
}

/// フロントから 1 行 JSON を受け取り、`SUMIRE_DEV_LOG=1` のときだけ
/// `dev-events.jsonl` に append する。
///
/// release ビルドでは command 自体が存在しない(`#[cfg(debug_assertions)]`)。
/// フロント側 `lib/devLog.ts` は `import.meta.env.DEV` チェックで
/// release では invoke を呼ばないので両側で安全。
#[cfg(debug_assertions)]
#[tauri::command]
pub fn dev_append_event(line: String) -> Result<(), String> {
    impl_dev::append(&line)
}
