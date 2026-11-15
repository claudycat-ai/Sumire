use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use super::recent::sumire_data_dir;

/// モデルのフォルダにある gguf ファイル 1 つ分。
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufModel {
    pub file_name: String,
    pub size_bytes: u64,
}

/// `<アプリデータディレクトリ>/preferences.json` のパスを返す。
fn preferences_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(sumire_data_dir(app)?.join("preferences.json"))
}

fn read_preferences_at(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("preferences.json の読み込みに失敗しました: {}", e)),
    }
}

fn write_preferences_at(path: &Path, json: &str) -> Result<(), String> {
    // 書いている途中で落ちても、元のファイルが半端な中身にならないよう、
    // 同じフォルダの一時ファイルに書き切ってから置き換える。
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)
        .map_err(|e| format!("preferences.json の書き込みに失敗しました: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("preferences.json の書き込みに失敗しました: {}", e)
    })
}

fn list_gguf_models_in(dir: &Path) -> Result<Vec<GgufModel>, String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("モデルのフォルダを読めませんでした: {}", e))?;
    let mut models = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("モデルのフォルダを読めませんでした: {}", e))?;
        let path = entry.path();
        let is_gguf = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"));
        if !is_gguf {
            continue;
        }
        // リンク先がファイルならモデルとして扱うので、entry.metadata() ではなくリンクを辿る。
        // 情報を取れないもの(切れたリンクなど)は、一覧から外すだけにする。
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        models.push(GgufModel {
            file_name: entry.file_name().to_string_lossy().into_owned(),
            size_bytes: metadata.len(),
        });
    }
    sort_models(&mut models);
    Ok(models)
}

/// ファイル名の、大文字小文字を無視した昇順に並べる。
///
/// 左ペインに出る一覧なので、エクスプローラーの並びに近づける。小文字にして同じになる
/// 名前どうしは、元の名前の順で決めて、列挙の順に左右されないようにする。
fn sort_models(models: &mut [GgufModel]) {
    models.sort_by(|a, b| {
        a.file_name
            .to_lowercase()
            .cmp(&b.file_name.to_lowercase())
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
}

/// `preferences.json` の内容を文字列として返す。ファイルが無い場合は `None`。
#[tauri::command]
pub fn read_app_preferences(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_preferences_at(&preferences_file_path(&app)?)
}

/// `preferences.json` を書き出す。フロント側で組み立てた JSON 文字列を受け取る。
#[tauri::command]
pub fn write_app_preferences(app: tauri::AppHandle, json: String) -> Result<(), String> {
    write_preferences_at(&preferences_file_path(&app)?, &json)
}

/// フォルダの直下にある gguf ファイルを、大文字小文字を無視したファイル名の昇順で返す。
#[tauri::command]
pub fn list_gguf_models(dir: String) -> Result<Vec<GgufModel>, String> {
    list_gguf_models_in(Path::new(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// テストごとに別の一時フォルダを作り、スコープを抜けたら消す。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static SEQ: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "sumire-preferences-test-{}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst),
                label
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn read_returns_none_when_file_is_missing() {
        let tmp = TempDir::new("read-missing");
        let path = tmp.path().join("preferences.json");
        assert_eq!(read_preferences_at(&path), Ok(None));
    }

    #[test]
    fn write_then_read_returns_the_same_string() {
        let tmp = TempDir::new("roundtrip");
        let path = tmp.path().join("preferences.json");
        let json = "{\n  \"llamaServer\": { \"modelsDir\": \"C:\\\\models\\\\日本語\" }\n}\n";
        write_preferences_at(&path, json).unwrap();
        assert_eq!(read_preferences_at(&path), Ok(Some(json.to_string())));
    }

    #[test]
    fn write_replaces_existing_file_and_leaves_no_temp_file() {
        let tmp = TempDir::new("replace");
        let path = tmp.path().join("preferences.json");
        write_preferences_at(&path, "{\"a\":1}").unwrap();
        write_preferences_at(&path, "{\"a\":2}").unwrap();
        assert_eq!(
            read_preferences_at(&path),
            Ok(Some("{\"a\":2}".to_string()))
        );
        let names: Vec<String> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["preferences.json".to_string()]);
    }

    #[test]
    fn list_returns_only_direct_gguf_files_sorted_by_name() {
        let tmp = TempDir::new("list");
        let dir = tmp.path();
        fs::write(dir.join("b-model.Q4_K_M.gguf"), b"12345").unwrap();
        fs::write(dir.join("a-model.Q3_K_M.GGUF"), b"123").unwrap();
        fs::write(dir.join("c-model.Gguf"), b"").unwrap();
        // NTFS の列挙順は mb → m_x、返す順は m_x → mb。並べ替えの呼び出しを外すと落ちる。
        fs::write(dir.join("mb.gguf"), b"1").unwrap();
        fs::write(dir.join("m_x.gguf"), b"12").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::write(dir.join("model.gguf.part"), b"x").unwrap();
        fs::write(dir.join("gguf"), b"x").unwrap();
        // 名前が .gguf で終わるディレクトリは、モデルではない。
        fs::create_dir(dir.join("folder.gguf")).unwrap();
        fs::create_dir(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("nested.gguf"), b"x").unwrap();

        let models = list_gguf_models_in(dir).unwrap();
        assert_eq!(
            models,
            vec![
                GgufModel {
                    file_name: "a-model.Q3_K_M.GGUF".to_string(),
                    size_bytes: 3,
                },
                GgufModel {
                    file_name: "b-model.Q4_K_M.gguf".to_string(),
                    size_bytes: 5,
                },
                GgufModel {
                    file_name: "c-model.Gguf".to_string(),
                    size_bytes: 0,
                },
                GgufModel {
                    file_name: "m_x.gguf".to_string(),
                    size_bytes: 2,
                },
                GgufModel {
                    file_name: "mb.gguf".to_string(),
                    size_bytes: 1,
                },
            ]
        );
    }

    fn model(file_name: &str) -> GgufModel {
        GgufModel {
            file_name: file_name.to_string(),
            size_bytes: 0,
        }
    }

    fn names(models: &[GgufModel]) -> Vec<&str> {
        models.iter().map(|m| m.file_name.as_str()).collect()
    }

    // ファイルシステムの列挙は最初から名前順のことがあり(NTFS)、フォルダ越しのテストでは
    // 並べ替えを固定できない。入力の順を自分で決められる形で試す。
    #[test]
    fn sort_orders_names_ignoring_case() {
        let mut models = vec![
            model("gemma.Q8_0.gguf"),
            model("Zeta.gguf"),
            model("alpha.gguf"),
            model("Beta.gguf"),
        ];
        sort_models(&mut models);
        // バイト順なら大文字の Beta / Zeta が先に来る。
        assert_eq!(
            names(&models),
            vec!["alpha.gguf", "Beta.gguf", "gemma.Q8_0.gguf", "Zeta.gguf"]
        );
    }

    #[test]
    fn sort_breaks_case_only_ties_by_original_name() {
        let expected = vec!["MODEL.gguf", "Model.gguf", "model.GGUF", "model.gguf"];
        let mut forward = vec![
            model("model.gguf"),
            model("model.GGUF"),
            model("Model.gguf"),
            model("MODEL.gguf"),
        ];
        sort_models(&mut forward);
        assert_eq!(names(&forward), expected);

        let mut backward = vec![
            model("MODEL.gguf"),
            model("Model.gguf"),
            model("model.GGUF"),
            model("model.gguf"),
        ];
        backward.reverse();
        backward.swap(0, 2);
        sort_models(&mut backward);
        assert_eq!(names(&backward), expected);
    }

    #[test]
    fn list_returns_empty_for_folder_without_gguf() {
        let tmp = TempDir::new("list-empty");
        assert_eq!(list_gguf_models_in(tmp.path()), Ok(vec![]));
    }

    #[test]
    fn list_fails_for_missing_folder() {
        let tmp = TempDir::new("list-missing");
        let missing = tmp.path().join("no-such-folder");
        assert!(list_gguf_models_in(&missing).is_err());
    }

    #[test]
    fn list_fails_when_path_is_a_file() {
        let tmp = TempDir::new("list-file");
        let file = tmp.path().join("model.gguf");
        fs::write(&file, b"x").unwrap();
        assert!(list_gguf_models_in(&file).is_err());
    }

    #[test]
    fn gguf_model_serializes_in_camel_case() {
        let model = GgufModel {
            file_name: "m.gguf".to_string(),
            size_bytes: 42,
        };
        assert_eq!(
            serde_json::to_string(&model).unwrap(),
            "{\"fileName\":\"m.gguf\",\"sizeBytes\":42}"
        );
    }
}
