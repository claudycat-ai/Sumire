// Rust 側の command(commands/preferences.rs、commands/llama_server.rs)と
// 状態のイベントの薄いラッパー。失敗は握りつぶさず、呼び出し側に伝える。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  GgufModel,
  LlamaServerStatus,
  StartLlamaServerRequest,
} from "./types";

const STATUS_EVENT = "llama-server-status";

/** `preferences.json` の中身。ファイルが無ければ `null`。 */
export function readAppPreferences(): Promise<string | null> {
  return invoke<string | null>("read_app_preferences");
}

export function writeAppPreferences(json: string): Promise<void> {
  return invoke<void>("write_app_preferences", { json });
}

/** フォルダの直下の gguf の一覧。フォルダを読めなければ、文字列のエラーで失敗する。 */
export function listGgufModels(dir: string): Promise<GgufModel[]> {
  return invoke<GgufModel[]>("list_gguf_models", { dir });
}

/** 動いているプロセスを止めてから起動する。`loading` か `failed`(`spawn`)を返す。 */
export function startLlamaServer(
  req: StartLlamaServerRequest,
): Promise<LlamaServerStatus> {
  return invoke<LlamaServerStatus>("start_llama_server", { req });
}

export function stopLlamaServer(): Promise<LlamaServerStatus> {
  return invoke<LlamaServerStatus>("stop_llama_server");
}

export function readLlamaServerStatus(): Promise<LlamaServerStatus> {
  return invoke<LlamaServerStatus>("read_llama_server_status");
}

/** 出力の末尾(古い順)。 */
export function readLlamaServerLog(): Promise<string[]> {
  return invoke<string[]>("read_llama_server_log");
}

/** 状態のイベントを購読する。戻り値は解除の関数。 */
export function subscribeLlamaServerStatus(
  handler: (status: LlamaServerStatus) => void,
): Promise<() => void> {
  return listen<LlamaServerStatus>(STATUS_EVENT, (event) => {
    handler(event.payload);
  });
}
