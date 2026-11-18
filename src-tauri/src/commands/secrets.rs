// OS の secure credential storage(Windows Credential Manager / macOS Keychain /
// Linux Secret Service)に API キーを保管するための Tauri commands。
//
// 設計の要点:
// - **target name を `Sumire.{provider}_api_key` で固定**。`keyring-core` の `Entry::new_with_modifiers`
//   に `target` modifier を渡すことで、Store 側のデリミタ規則に依存せず識別子
//   文字列を直接固定する。
// - `keyring-core` のデフォルトストアは process グローバル。起動時に
//   `set_default_store` で `windows-native-keyring-store` を一度だけ登録する
//   (`OnceLock` で重複登録を防ぐ)。
// - 2026-05-10 に、set_password が Ok を返すのに何も保存されない失敗に当たり、
//   `keyring-core` + `windows-native-keyring-store` に替えて直した。当時は
//   「target 名の `:` が原因」「keyring v3 は Windows で動かない」と見立てたが、
//   2026-11-18 に確かめ直して、どちらも外れていた。`:` を含む名前でも保存できる。
//   keyring v3 は既定の feature が無く、`windows-native` を付けないと mock の
//   保存先(OS に何も保存しない)を使う。症状はこれと一致する。いまの構成は保存先を
//   `set_default_store` で明示するので、この罠には当たらない。
// - provider 名は英数字 + ハイフンのみ受け付ける。target 名の形をそろえるための
//   防御で、`:` で保存に失敗するからではない。
// - キーの値の読み出しは command ではない `read_secret` に閉じ、WebView には
//   値を渡さない(provider-http-rust Req 7.1)。値を返す command は公開しない。
//   画面側は `has_secret` で設定済みかどうかだけを知る(Req 7.3)。
// - `has_secret` は空文字のキーを未設定として扱う。HTTP 中継(`commands::http`)が
//   空文字のキーを MissingSecret にするのと揃えるため。
// - read_secret は「キー未存在」をエラーではなく `Ok(None)` で表現する
//   (Req 2.6 の「失敗内容を通知しつつ編集を阻害しない」フローに直結)。
// - delete_secret も「キー未存在」は冪等扱いで `Ok(())` を返す。
// - keyring 由来のエラーは UI に出す前に `to_string()` で String 化して返す。

use std::collections::HashMap;
use std::sync::OnceLock;

use keyring_core::{Entry, Error as KeyringError};

/// keyring の service 名 + target name の prefix。
const SERVICE: &str = "Sumire";

/// `keyring-core` のデフォルトストアの登録結果(process 内で一度だけ実行)。
static REGISTER_RESULT: OnceLock<Result<(), String>> = OnceLock::new();

/// `keyring-core` のデフォルトストアに OS ネイティブストアを登録する。
/// 二度目以降の呼び出しは初回結果をキャッシュして即返す。
fn ensure_default_store() -> Result<(), String> {
    let outcome = REGISTER_RESULT.get_or_init(register_native_store);
    match outcome {
        Ok(()) => Ok(()),
        Err(msg) => Err(msg.clone()),
    }
}

#[cfg(target_os = "windows")]
fn register_native_store() -> Result<(), String> {
    match windows_native_keyring_store::Store::new() {
        Ok(store) => {
            keyring_core::set_default_store(store);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(target_os = "windows"))]
fn register_native_store() -> Result<(), String> {
    // 現状 Sumire は Windows 主体。macOS / Linux サポートは future work。
    Err("OS keychain backend is not configured for this platform".to_string())
}

/// provider 識別子が安全な文字種だけで構成されているかを防御的に検証する。
///
/// target name の形(`Sumire.{provider}_api_key`)をそろえるため、
/// 英数字とハイフン `-` のみ許容し、空文字も拒否する。
/// (2026-05-10 には `:` で保存に失敗すると考えて入れたが、2026-11-18 に
/// 確かめ直して、`:` は原因ではなかった。ファイル冒頭のコメントを参照)
fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.is_empty() {
        return Err("invalid provider: must not be empty".to_string());
    }
    if !provider
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!(
            "invalid provider: only ASCII alphanumeric and '-' are allowed (got: {provider:?})"
        ));
    }
    Ok(())
}

/// keyring の固定 target_name を組み立てる。
/// `provider="openai"` → `"Sumire.openai_api_key"`。
fn target_name_for(provider: &str) -> String {
    format!("{SERVICE}.{provider}_api_key")
}

/// keyring_core::Entry を構築する小さなヘルパ。set / read / delete で使い回す。
///
/// `Entry::new_with_modifiers` に `target` modifier を渡すことで Store 側の
/// 識別子組み立て規則を上書きし、target を直接固定値に揃える。
/// service / user 引数は target が指定されていれば識別には使われないが、
/// backend によっては metadata 列(認証情報マネージャの username 等)に
/// 保持されるので意味のある値を渡す。
fn entry_for(provider: &str) -> Result<Entry, String> {
    ensure_default_store()?;
    let target = target_name_for(provider);
    let user = format!("{provider}_api_key");
    let mut modifiers: HashMap<&str, &str> = HashMap::new();
    modifiers.insert("target", &target);
    Entry::new_with_modifiers(SERVICE, &user, &modifiers).map_err(|e| e.to_string())
}

/// `provider` に紐付く API キーを OS keychain に書き込む。
///
/// target name は `Sumire.{provider}_api_key`。
/// 既存の値があれば上書きされる(keyring-core の `set_password` 仕様)。
#[tauri::command]
pub fn set_secret(provider: String, value: String) -> Result<(), String> {
    validate_provider(&provider)?;
    let entry = entry_for(&provider)?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

/// `provider` に紐付く API キーを OS keychain から読み出す(Rust 内部専用)。
///
/// command ではない。キーの値を WebView に渡さないため(Req 7.1)、HTTP 中継
/// (`commands::http`)や `has_secret` など Rust 側からだけ呼ぶ。
/// キーが未登録の場合は `Ok(None)` を返す(エラーにしない)。
/// それ以外の OS / keyring 由来のエラーは `Err(String)` で返す。
/// provider の文字種検証は keychain に触れる前に行う。
pub(crate) fn read_secret(provider: &str) -> Result<Option<String>, String> {
    validate_provider(provider)?;
    let entry = entry_for(provider)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 読み出し関数の結果を「設定済みかどうか」に変換する。
///
/// 読み出しを引数で受け取るのは、実 keychain に触れずに単体テストするため。
/// 本番では `read_secret` を渡す。未設定(`Ok(None)`)と空文字のキーは `Ok(false)`
/// (空文字は HTTP 中継の MissingSecret 判定と揃える)。読み出し失敗は移行前の
/// `hasSecret`(値の読み出しの失敗をそのまま例外にしていた)と同じく `Err` のまま返す。
fn secret_exists<F>(provider: &str, read: F) -> Result<bool, String>
where
    F: FnOnce(&str) -> Result<Option<String>, String>,
{
    read(provider).map(|value| value.is_some_and(|v| !v.is_empty()))
}

/// `provider` の API キーが設定済みかどうかだけを返す command(Req 7.3)。
///
/// キーの値は WebView に渡さない。設定状態の表示(AI タブ、キー未設定バッジ)用。
#[tauri::command]
pub fn has_secret(provider: String) -> Result<bool, String> {
    secret_exists(&provider, read_secret)
}

/// `provider` に紐付く API キーを OS keychain から削除する。
///
/// キーが未登録の場合は `Ok(())` を返す(冪等)。
/// それ以外の OS / keyring 由来のエラーは `Err(String)` で返す。
#[tauri::command]
pub fn delete_secret(provider: String) -> Result<(), String> {
    validate_provider(&provider)?;
    let entry = entry_for(&provider)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_provider_accepts_alphanumeric_and_hyphen() {
        assert!(validate_provider("openai").is_ok());
        assert!(validate_provider("open-router2").is_ok());
    }

    #[test]
    fn validate_provider_rejects_empty_and_unsafe_chars() {
        assert!(validate_provider("").is_err());
        assert!(validate_provider("provider:openai").is_err());
        assert!(validate_provider("open ai").is_err());
        assert!(validate_provider("open_ai").is_err());
        assert!(validate_provider("open.ai").is_err());
    }

    #[test]
    fn read_secret_rejects_invalid_provider_before_touching_keychain() {
        // 検証は keychain アクセスより前に走るので、実 keychain に触れずに Err になる。
        let err = read_secret("provider:openai").unwrap_err();
        assert!(err.starts_with("invalid provider"), "got: {err}");
        assert!(read_secret("").is_err());
    }

    #[test]
    fn secret_exists_maps_none_to_false() {
        assert_eq!(secret_exists("openai", |_| Ok(None)), Ok(false));
    }

    #[test]
    fn secret_exists_maps_some_to_true() {
        assert_eq!(
            secret_exists("openai", |_| Ok(Some("test-value".to_string()))),
            Ok(true)
        );
    }

    #[test]
    fn secret_exists_maps_empty_value_to_false() {
        // HTTP 中継(commands::http)は空文字のキーを MissingSecret として扱う。
        // 設定状態の表示もそれと揃え、空文字は未設定とみなす。
        assert_eq!(
            secret_exists("openai", |_| Ok(Some(String::new()))),
            Ok(false)
        );
    }

    #[test]
    fn secret_exists_propagates_read_error() {
        assert_eq!(
            secret_exists("openai", |_| Err("keychain unavailable".to_string())),
            Err("keychain unavailable".to_string())
        );
    }

    #[test]
    fn secret_exists_passes_provider_to_reader() {
        let mut seen = String::new();
        let _ = secret_exists("anthropic", |p| {
            seen = p.to_string();
            Ok(None)
        });
        assert_eq!(seen, "anthropic");
    }
}
