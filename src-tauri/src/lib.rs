mod commands;

#[cfg(debug_assertions)]
use commands::dev_log::dev_append_event;
use commands::files::{list_project_files, read_file_text, write_file_text};
use commands::http::{http_cancel, http_request, HttpState};
use commands::llama_server::{
    read_llama_server_log, read_llama_server_status, start_llama_server, stop_llama_server,
    LlamaServerState,
};
use commands::preferences::{list_gguf_models, read_app_preferences, write_app_preferences};
use commands::project::{create_project, is_project_root, read_project_meta};
use commands::recent::{read_recent_projects, write_recent_projects};
use commands::secrets::{delete_secret, has_secret, set_secret};
use commands::snapshot::{list_snapshots, read_snapshot, save_snapshot};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // http_request / http_cancel が使う実行中リクエストの管理表(provider-http-rust)。
        .manage(HttpState::default())
        // llama-server の監督と、子プロセスを入れるジョブオブジェクト
        // (llama-server-provider)。
        .manage(LlamaServerState::default());

    // 通常 commands。dev_log は debug ビルドのみ追加で登録する。
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_project_meta,
        create_project,
        is_project_root,
        read_recent_projects,
        write_recent_projects,
        list_project_files,
        read_file_text,
        write_file_text,
        save_snapshot,
        list_snapshots,
        read_snapshot,
        set_secret,
        has_secret,
        delete_secret,
        http_request,
        http_cancel,
        read_app_preferences,
        write_app_preferences,
        list_gguf_models,
        start_llama_server,
        stop_llama_server,
        read_llama_server_status,
        read_llama_server_log,
    ]);

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_project_meta,
        create_project,
        is_project_root,
        read_recent_projects,
        write_recent_projects,
        list_project_files,
        read_file_text,
        write_file_text,
        save_snapshot,
        list_snapshots,
        read_snapshot,
        set_secret,
        has_secret,
        delete_secret,
        http_request,
        http_cancel,
        read_app_preferences,
        write_app_preferences,
        list_gguf_models,
        start_llama_server,
        stop_llama_server,
        read_llama_server_status,
        read_llama_server_log,
        dev_append_event,
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 通常の終了で llama-server を止める。強制終了や異常終了ではここを
            // 通らないので、そちらはジョブオブジェクトが受け持つ。
            if let tauri::RunEvent::Exit = event {
                app_handle.state::<LlamaServerState>().shutdown();
            }
        });
}
