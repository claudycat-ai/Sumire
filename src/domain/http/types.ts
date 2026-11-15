/**
 * 画面側の HTTP 入口(`nativeFetch`)の型と、Rust 側 `commands::http` との IPC 契約。
 *
 * IPC の形(`HttpRequestPayload` / `HttpEvent` / `HttpStartErrorPayload`)は
 * `src-tauri/src/commands/http.rs` の serde 属性と手で揃えている。どちらかを変える
 * ときは、Rust 側のシリアライズのテスト(`event_serializes_with_event_and_data` 等)
 * と一緒に直す。
 */
import type { ProviderId } from "@/domain/providers/types";

export interface NativeFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** 指定すると、そのプロバイダの保存済みキーを Rust 側で付与する。 */
  authProvider?: ProviderId;
}

/**
 * `NativeHttpError` の種別。`network` 以外は開始時エラー(HTTP を送る前に判定され、
 * 何も送られていない)。
 */
export type NativeHttpErrorKind =
  | "invalidUrl"
  | "missingSecret"
  | "secretUnavailable"
  | "unsupportedAuth"
  | "invalidHeader"
  | "network";

/** 開始時エラーの種別(Rust 側 `HttpStartError` のバリアント)。 */
export type NativeHttpStartErrorKind = Exclude<NativeHttpErrorKind, "network">;

/**
 * `http_request` の `req` 引数(Rust 側 `HttpRequest`)。
 * `headers` は Rust 側で必須なので、指定が無くても `{}` を送る。
 */
export interface HttpRequestPayload {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string | null;
  authProvider: ProviderId | null;
}

/** `http_request` が reject したときの値(Rust 側 `HttpStartError`)。 */
export interface HttpStartErrorPayload {
  kind: NativeHttpStartErrorKind;
  message: string;
}

/**
 * Channel で届くイベント(Rust 側 `HttpEvent`)。
 * 順序は `response` → `chunk`* → `end`。接続失敗は `error` だけが届き、受信中の
 * 失敗は `response` → `chunk`* → `error` になる。
 */
export type HttpEvent =
  | { event: "response"; data: { status: number; statusText: string } }
  | { event: "chunk"; data: { bytes: number[] } }
  | { event: "end" }
  | { event: "error"; data: { message: string } };
