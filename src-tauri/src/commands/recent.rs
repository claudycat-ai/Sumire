use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Sumire のアプリデータディレクトリを返す。無ければ作成する。
///
/// 配置規約: 各 OS の標準データディレクトリの下に `Sumire/` を切る。
/// - Windows: `%LOCALAPPDATA%\Sumire\`
/// - macOS:   `~/Library/Application Support/Sumire/`
/// - Linux:   `~/.local/share/Sumire/`
pub(crate) fn sumire_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("アプリデータディレクトリを特定できませんでした: {}", e))?;
    let dir = base.join("Sumire");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("アプリデータディレクトリの作成に失敗しました: {}", e))?;
    }
    Ok(dir)
}

/// `<アプリデータディレクトリ>/recent.json` のパスを返す。親ディレクトリが無ければ作成する。
fn recent_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(sumire_data_dir(app)?.join("recent.json"))
}

/// 旧 `~/.sumire/recent.json` から新パスへ自動移行する。
///
/// 既に新パスにファイルがある場合は何もしない(2 重移行防止)。旧パスの recent.json を
/// 新パスへ移動し、空になった旧 `~/.sumire/` ディレクトリも削除する(他ファイルがあれば残す)。
/// 失敗しても起動は止めない(ログ相当の Err 文字列は呼び出し側で握る)。
fn migrate_legacy_recent(new_path: &PathBuf) -> Result<(), String> {
    if new_path.exists() {
        return Ok(());
    }
    let home = legacy_home()?;
    let legacy_dir = home.join(".sumire");
    let legacy_file = legacy_dir.join("recent.json");
    if !legacy_file.exists() {
        return Ok(());
    }
    fs::rename(&legacy_file, new_path)
        .map_err(|e| format!("旧 recent.json の移行に失敗しました: {}", e))?;
    // 旧ディレクトリが空なら削除する。中身が残っていれば触らない。
    if let Ok(mut entries) = fs::read_dir(&legacy_dir) {
        if entries.next().is_none() {
            let _ = fs::remove_dir(&legacy_dir);
        }
    }
    Ok(())
}

/// 旧パス(`~/.sumire/`)を解決するためのホームディレクトリ取得。移行用途のみ。
fn legacy_home() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        return Ok(p);
    }
    if let Some(p) = std::env::var_os("HOME").map(PathBuf::from) {
        return Ok(p);
    }
    Err("ホームディレクトリが特定できませんでした".to_string())
}

/// `recent.json` の内容を文字列として返す。ファイルが無い場合は空配列の JSON を返す。
#[tauri::command]
pub fn read_recent_projects(app: tauri::AppHandle) -> Result<String, String> {
    let path = recent_file_path(&app)?;
    // 旧パスからの移行は最初の読み込み時に試みる(失敗しても起動は継続)
    let _ = migrate_legacy_recent(&path);
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path)
        .map_err(|e| format!("recent.json の読み込みに失敗しました: {}", e))
}

/// `recent.json` を書き出す。フロント側で組み立てた JSON 文字列を受け取る。
#[tauri::command]
pub fn write_recent_projects(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = recent_file_path(&app)?;
    fs::write(&path, &json)
        .map_err(|e| format!("recent.json の書き込みに失敗しました: {}", e))
}
