use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// プロジェクト内ファイルツリー表示で扱うエントリ。
#[derive(Debug, Serialize)]
pub struct FileEntry {
    /// プロジェクトルートからの相対パス(POSIX 区切り)。例: "chapters/001-prologue.md"
    pub relative_path: String,
    /// 表示用ファイル名(拡張子含む)。
    pub name: String,
}

/// プロジェクト直下のサブディレクトリを列挙して、その中の Markdown ファイル一覧を返す。
///
/// `.trash/` 以下は除外する(削除済みファイル)。
/// 結果はサブディレクトリ単位でグループ化されたフラットなリスト。
/// 並び順はファイル名昇順。
#[tauri::command]
pub fn list_project_files(
    project_path: String,
    subdir: String,
) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!(
            "プロジェクトフォルダが存在しません: {}",
            root.display()
        ));
    }

    let target = root.join(&subdir);
    if !target.is_dir() {
        // サブディレクトリがまだ作られていない場合は空リスト
        return Ok(Vec::new());
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(&target)
        .map_err(|e| format!("{} の読み込みに失敗しました: {}", target.display(), e))?;

    for entry in read_dir.flatten() {
        let path = entry.path();

        // .trash/ ディレクトリは無視
        if path.is_dir() {
            continue;
        }
        // Markdown ファイルのみ対象
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        // POSIX 区切りで相対パスを構築
        let relative_path = format!("{}/{}", subdir.trim_end_matches('/'), name);

        entries.push(FileEntry {
            relative_path,
            name,
        });
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// プロジェクトルートからの相対パスでファイルの内容を文字列として読み込む。
///
/// パストラバーサル防止のため、解決後のパスがプロジェクトルート配下にあることを検証する。
#[tauri::command]
pub fn read_file_text(project_path: String, relative_path: String) -> Result<String, String> {
    let root = PathBuf::from(&project_path);
    let canonical_root = canonicalize_or_err(&root)?;

    let target = root.join(relative_path.replace('\\', "/"));
    let canonical_target = canonicalize_or_err(&target)?;

    if !canonical_target.starts_with(&canonical_root) {
        return Err("プロジェクトフォルダ外のファイルは読み込めません".to_string());
    }

    fs::read_to_string(&canonical_target)
        .map_err(|e| format!("ファイルの読み込みに失敗しました: {}", e))
}

/// プロジェクトルートからの相対パスでファイルに文字列を書き込む(上書き)。
///
/// MVP では直接上書きを採用する。書き込み途中のクラッシュで中途半端なファイルが残る
/// 可能性はあるが、Ctrl+S スナップショットからの復元で対応する想定。
/// 将来的にはテンポラリファイル経由のアトミック書き込みに切り替える。
///
/// 書き込み先の親ディレクトリは存在している必要がある(create_project で生成される
/// 標準サブディレクトリ以外にファイルを書く想定はない)。
/// パストラバーサル防止のため、書き込み先がプロジェクトルート配下にあることを検証する。
#[tauri::command]
pub fn write_file_text(
    project_path: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    let canonical_root = canonicalize_or_err(&root)?;

    let target = root.join(relative_path.replace('\\', "/"));

    // 書き込み先の親ディレクトリで canonicalize する(target 自体は新規ファイルでも成立するように)
    let parent = target
        .parent()
        .ok_or_else(|| "ファイルの親ディレクトリが解決できません".to_string())?;
    let canonical_parent = canonicalize_or_err(parent)?;

    if !canonical_parent.starts_with(&canonical_root) {
        return Err("プロジェクトフォルダ外のファイルは書き込めません".to_string());
    }

    let final_path = canonical_parent.join(
        target
            .file_name()
            .ok_or_else(|| "ファイル名が解決できません".to_string())?,
    );

    fs::write(&final_path, content)
        .map_err(|e| format!("ファイルの書き込みに失敗しました: {}", e))
}

fn canonicalize_or_err(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| {
        format!(
            "パスの解決に失敗しました ({}): {}",
            path.display(),
            e
        )
    })
}
