use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// スナップショットファイルが生成・配置されるディレクトリ名(プロジェクトルート直下)。
const HISTORY_DIR: &str = "history";

/// プロジェクト全体スナップショットの対象に含めるトップレベル項目。
/// `history/`(=履歴自身)と `.trash`(=ファイル単位のゴミ箱)は除外する。
const TOP_LEVEL_FILES: [&str; 1] = ["sumire.json"];
const TOP_LEVEL_DIRS: [&str; 5] = [
    "chapters",
    "characters",
    "worldbuilding",
    "glossary",
    "plot",
];

/// 一覧用エントリ。フロント表示で使う。
#[derive(Debug, Serialize)]
pub struct SnapshotEntry {
    /// `history/` 内のファイル名(例: "2026-04-28T15-30-00.json")。
    pub name: String,
    /// 仕様上の保存タイムスタンプ(JSON 中の "timestamp" を信頼。読めない場合はファイル名から推定)。
    pub timestamp: String,
    /// 含まれるファイル数。プレビュー表示の参考に。
    pub file_count: usize,
}

/// プロジェクト全体のスナップショットを `history/<timestamp>.json` として保存する。
///
/// - `project_path`: プロジェクトルート
/// - `timestamp`: ローカルタイム由来の `YYYY-MM-DDTHH-mm-ss` 文字列(フロント側で生成)
/// - `iso_timestamp`: JSON に埋める ISO8601 タイムスタンプ(タイムゾーン付き)
/// - `max_keep`: 保持件数。0 以下なら削除しない
///
/// 保存後、`history/` 内のスナップショットを mtime 順に並べ、`max_keep` を超える古いものを削除する。
#[tauri::command]
pub fn save_snapshot(
    project_path: String,
    timestamp: String,
    iso_timestamp: String,
    max_keep: i32,
) -> Result<String, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!(
            "プロジェクトフォルダが存在しません: {}",
            root.display()
        ));
    }

    let history_dir = root.join(HISTORY_DIR);
    fs::create_dir_all(&history_dir).map_err(|e| {
        format!("history フォルダの作成に失敗しました: {}", e)
    })?;

    // ファイル名のサニタイズ(":" や "/" が混入していたら拒否)
    if timestamp.contains('/') || timestamp.contains('\\') || timestamp.contains(':') {
        return Err("不正なタイムスタンプ文字列です".to_string());
    }
    let snapshot_path = history_dir.join(format!("{}.json", timestamp));

    let mut files = Map::new();
    collect_top_level_files(&root, &mut files)?;
    collect_top_level_dirs(&root, &mut files)?;

    let body = json!({
        "snapshotVersion": "1.0",
        "timestamp": iso_timestamp,
        "files": Value::Object(files),
    });

    let serialized = serde_json::to_string_pretty(&body)
        .map_err(|e| format!("スナップショットの直列化に失敗しました: {}", e))?;
    fs::write(&snapshot_path, serialized)
        .map_err(|e| format!("スナップショットの書き込みに失敗しました: {}", e))?;

    // 保持件数の超過分を削除
    if max_keep > 0 {
        prune_old_snapshots(&history_dir, max_keep as usize)?;
    }

    Ok(snapshot_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string())
}

/// プロジェクトの `history/*.json` 一覧を新しい順で返す。
#[tauri::command]
pub fn list_snapshots(project_path: String) -> Result<Vec<SnapshotEntry>, String> {
    let history_dir = PathBuf::from(&project_path).join(HISTORY_DIR);
    if !history_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<SnapshotEntry> = Vec::new();
    let read_dir = fs::read_dir(&history_dir)
        .map_err(|e| format!("{} の読み込みに失敗しました: {}", history_dir.display(), e))?;

    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let (timestamp, file_count) = read_meta_only(&path).unwrap_or_else(|| {
            (
                stem_to_iso_fallback(&name),
                0,
            )
        });
        entries.push(SnapshotEntry {
            name,
            timestamp,
            file_count,
        });
    }
    // ファイル名(=ローカルタイム文字列)の降順で新しい順に並べる
    entries.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(entries)
}

/// 指定スナップショットを文字列として返す(JSON 全文)。フロント側でパースする。
#[tauri::command]
pub fn read_snapshot(project_path: String, name: String) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') {
        return Err("不正なスナップショット名です".to_string());
    }
    let path = PathBuf::from(&project_path).join(HISTORY_DIR).join(&name);
    if !path.is_file() {
        return Err(format!("スナップショットが見つかりません: {}", path.display()));
    }
    fs::read_to_string(&path)
        .map_err(|e| format!("スナップショットの読み込みに失敗しました: {}", e))
}

fn collect_top_level_files(
    root: &Path,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    for name in TOP_LEVEL_FILES {
        let p = root.join(name);
        if p.is_file() {
            let content = fs::read_to_string(&p)
                .map_err(|e| format!("{} の読み込みに失敗しました: {}", p.display(), e))?;
            out.insert(name.to_string(), Value::String(content));
        }
    }
    // memo.md は存在すれば含める
    let memo = root.join("memo.md");
    if memo.is_file() {
        let content = fs::read_to_string(&memo)
            .map_err(|e| format!("memo.md の読み込みに失敗しました: {}", e))?;
        out.insert("memo.md".to_string(), Value::String(content));
    }
    Ok(())
}

fn collect_top_level_dirs(
    root: &Path,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    for dir in TOP_LEVEL_DIRS {
        let dir_path = root.join(dir);
        if !dir_path.is_dir() {
            continue;
        }
        collect_dir_recursive(&dir_path, dir, out)?;
    }
    Ok(())
}

fn collect_dir_recursive(
    dir: &Path,
    rel_prefix: &str,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    let read_dir = fs::read_dir(dir)
        .map_err(|e| format!("{} の読み込みに失敗しました: {}", dir.display(), e))?;
    for entry in read_dir.flatten() {
        let p = entry.path();
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // ゴミ箱は除外
        if name == ".trash" {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };
        if p.is_dir() {
            collect_dir_recursive(&p, &rel, out)?;
        } else if p.is_file() {
            // .md のみ対象(設定や章は markdown 前提)
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let content = fs::read_to_string(&p)
                .map_err(|e| format!("{} の読み込みに失敗しました: {}", p.display(), e))?;
            out.insert(rel, Value::String(content));
        }
    }
    Ok(())
}

fn prune_old_snapshots(history_dir: &Path, max_keep: usize) -> Result<(), String> {
    let read_dir = fs::read_dir(history_dir)
        .map_err(|e| format!("{} の読み込みに失敗しました: {}", history_dir.display(), e))?;
    let mut snapshots: Vec<PathBuf> = read_dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("json")
        })
        .collect();
    // ファイル名(ローカルタイム)で降順、新しいものが先頭
    snapshots.sort_by(|a, b| {
        let an = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let bn = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        bn.cmp(an)
    });
    for old in snapshots.into_iter().skip(max_keep) {
        let _ = fs::remove_file(&old);
    }
    Ok(())
}

/// スナップショット JSON の冒頭を読み、timestamp / files 数だけ取り出す(ファイル全体の読み込みを避ける軽量版)。
fn read_meta_only(path: &Path) -> Option<(String, usize)> {
    let text = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let ts = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    let count = v
        .get("files")
        .and_then(|f| f.as_object())
        .map(|m| m.len())
        .unwrap_or(0);
    Some((ts, count))
}

/// JSON が読めない場合のフォールバック: ファイル名 stem(タイムスタンプ風)を ISO 風に整形する。
/// 例: "2026-04-28T15-30-00.json" → "2026-04-28T15:30:00"
fn stem_to_iso_fallback(file_name: &str) -> String {
    let stem = file_name.trim_end_matches(".json");
    // T の右側の `-` を `:` に置換(時刻部のみ)。日付部は影響しないように左右で分ける。
    if let Some(t_idx) = stem.find('T') {
        let (date, time) = stem.split_at(t_idx);
        // time は "Thh-mm-ss"
        let restored = time.replacen('-', ":", 2);
        format!("{}{}", date, restored)
    } else {
        stem.to_string()
    }
}
