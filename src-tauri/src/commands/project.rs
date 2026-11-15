use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// プロジェクト直下に必ず作成するサブディレクトリ。
const PROJECT_SUBDIRS: [&str; 6] = [
    "chapters",
    "characters",
    "worldbuilding",
    "glossary",
    "plot",
    "history",
];

/// `sumire.json` を読み込んで、文字列としてフロントに返す。
///
/// パースはフロント側で行う(仕様: Rust は薄いファイル I/O プロキシに徹する)。
#[tauri::command]
pub fn read_project_meta(path: String) -> Result<String, String> {
    let project_root = PathBuf::from(&path);
    let meta_path = project_root.join("sumire.json");

    if !meta_path.is_file() {
        return Err(format!("sumire.json が見つかりません: {}", meta_path.display()));
    }

    fs::read_to_string(&meta_path)
        .map_err(|e| format!("sumire.json の読み込みに失敗しました: {}", e))
}

/// 親フォルダ + 子フォルダ名 + メタ JSON を受け取り、子フォルダを新規作成して
/// プロジェクト構造を生成する。成功時はプロジェクトルートのフルパスを返す。
///
/// エラーメッセージは kind プレフィックス付きで返却する:
/// - `Io: ...` — 親フォルダ未存在 / その他 IO エラー
/// - `NestedProject: ...` — 親フォルダ自身が既に Sumire プロジェクト
/// - `InvalidName: ...` — `folder_name` が空 / パス区切りを含む(防御層)
/// - `Conflict: ...` — 結合パスが既存
#[tauri::command]
pub fn create_project(
    parent_path: String,
    folder_name: String,
    meta_json: String,
) -> Result<String, String> {
    let parent = PathBuf::from(&parent_path);

    // 1. 親フォルダがディレクトリでなければ Io エラー
    if !parent.is_dir() {
        return Err(format!(
            "Io: 親フォルダが存在しません: {}",
            parent.display()
        ));
    }

    // 2. 親フォルダ自身が既にプロジェクトなら NestedProject エラー
    //    (`is_project_root` を再呼び出しせず inline 判定)
    if parent.join("sumire.json").is_file() {
        return Err(format!(
            "NestedProject: 親フォルダが既にプロジェクトです: {}",
            parent.display()
        ));
    }

    // 3. folder_name が空 / パス区切りを含むなら InvalidName エラー(防御層)
    if folder_name.is_empty() {
        return Err("InvalidName: フォルダ名が空です".to_string());
    }
    if folder_name.contains('/') || folder_name.contains('\\') {
        return Err(format!(
            "InvalidName: フォルダ名にパス区切りを含めることはできません: {}",
            folder_name
        ));
    }

    // 4. 結合
    let project_root = parent.join(&folder_name);

    // 5. 結合パスが既存なら Conflict エラー
    //    (Step 6 の create_dir でも検出されるが、明確なメッセージのため事前判定)
    if project_root.exists() {
        return Err(format!(
            "Conflict: 既にフォルダが存在します: {}",
            project_root.display()
        ));
    }

    // 6. 単発作成(create_dir_all ではなく create_dir で AlreadyExists を確実に拾う)
    if let Err(e) = fs::create_dir(&project_root) {
        return Err(if e.kind() == io::ErrorKind::AlreadyExists {
            format!(
                "Conflict: 既にフォルダが存在します: {}",
                project_root.display()
            )
        } else {
            format!(
                "Io: フォルダの作成に失敗しました: {}: {}",
                project_root.display(),
                e
            )
        });
    }

    // Step 7 以降の失敗時に project_root を巻き戻すヘルパ。
    // ベストエフォートで削除し、削除失敗時は元のエラーをそのまま返す。
    let rollback = |err: String| -> String {
        let _ = fs::remove_dir_all(&project_root);
        err
    };

    // 7. サブディレクトリを作成
    for subdir in PROJECT_SUBDIRS {
        let dir = project_root.join(subdir);
        if let Err(e) = fs::create_dir_all(&dir) {
            return Err(rollback(format!(
                "Io: {} の作成に失敗しました: {}",
                dir.display(),
                e
            )));
        }
    }

    // 8. sumire.json を書き出す
    let meta_path = project_root.join("sumire.json");
    if let Err(e) = fs::write(&meta_path, &meta_json) {
        return Err(rollback(format!(
            "Io: sumire.json の書き込みに失敗しました: {}",
            e
        )));
    }

    // 9. 空の memo.md を作成
    let memo_path = project_root.join("memo.md");
    if let Err(e) = fs::write(&memo_path, "") {
        return Err(rollback(format!(
            "Io: memo.md の作成に失敗しました: {}",
            e
        )));
    }

    // 10. プロジェクトルートのフルパスを UTF-8 化して返す
    Ok(project_root.to_string_lossy().to_string())
}

/// 指定パスがプロジェクトルート(=`sumire.json` を含むフォルダ)かを判定する。
#[tauri::command]
pub fn is_project_root(path: String) -> bool {
    let p = Path::new(&path);
    p.is_dir() && p.join("sumire.json").is_file()
}
