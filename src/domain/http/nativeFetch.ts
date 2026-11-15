/**
 * `fetch` と同じ呼び方で、HTTP を Rust 側(`commands::http`)に送らせる入口。
 *
 * WebView の `fetch` は推論サーバーのアクセス元制限(Origin / CORS)に阻まれるうえ、
 * キーを付けるには画面側でキーの値を持つ必要がある。そこで送受信は Rust 側に任せ、
 * ここでは Channel で届くイベントを Web 標準の `Response` に組み立てるだけにする。
 * アダプタは `fetch` を差し替えるだけで、SSE の解釈やステータスの分類を変えずに済む。
 *
 * - キーの値はこのモジュールを通らない。`authProvider` で付与を頼むだけ。
 * - プロバイダの概念(SSE、エラー文言)は持たない。開始時エラーは種別付きの
 *   `NativeHttpError` で返し、`ProviderError` への変換はアダプタ側が行う。
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  HttpEvent,
  HttpRequestPayload,
  HttpStartErrorPayload,
  NativeFetchInit,
  NativeHttpErrorKind,
  NativeHttpStartErrorKind,
} from "./types";

export class NativeHttpError extends Error {
  readonly kind: NativeHttpErrorKind;

  constructor(kind: NativeHttpErrorKind, message: string) {
    super(message);
    this.name = "NativeHttpError";
    this.kind = kind;
  }
}

/** Fetch 標準で本文を持てないステータス(`new Response` に本文を渡すと例外になる)。 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const START_ERROR_KINDS: ReadonlySet<string> = new Set<NativeHttpStartErrorKind>([
  "invalidUrl",
  "missingSecret",
  "secretUnavailable",
  "unsupportedAuth",
  "invalidHeader",
]);

function isStartErrorPayload(e: unknown): e is HttpStartErrorPayload {
  if (typeof e !== "object" || e === null) return false;
  const { kind, message } = e as Record<string, unknown>;
  return typeof kind === "string" && START_ERROR_KINDS.has(kind) && typeof message === "string";
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Rust 側で HTTP リクエストを送り、応答を `Response` で返す。
 *
 * - 応答開始(ステータス)の時点で resolve する。本文は届いたチャンクをその場で
 *   流す `ReadableStream` で、溜め込まない(Req 3.1, 3.4)。
 * - 開始時エラーは同じ種別の `NativeHttpError`、応答前の接続失敗は `network` で
 *   reject する。応答後の失敗は本文ストリームを `network` で error にする(Req 5.2)。
 * - `signal` の abort は、応答前なら `AbortError` で reject、応答後なら本文
 *   ストリームを `AbortError` で error にし、Rust 側の送信を `http_cancel` で
 *   ちょうど 1 回中断する(Req 4.1, 5.1)。
 */
export async function nativeFetch(url: string, init: NativeFetchInit = {}): Promise<Response> {
  const { signal } = init;
  if (signal?.aborted) throw abortError();

  const req: HttpRequestPayload = {
    method: init.method ?? "GET",
    url,
    headers: init.headers ?? {},
    body: init.body ?? null,
    authProvider: init.authProvider ?? null,
  };

  return new Promise<Response>((resolve, reject) => {
    // pending: 応答待ち / streaming: 本文の受信中 / settled: 終了・失敗・中断済み。
    // settled の後に届くイベントは無視する(中断の瞬間に送られていた分が届きうる)。
    let phase: "pending" | "streaming" | "settled" = "pending";
    let body: ReadableStreamDefaultController<Uint8Array> | null = null;
    let requestId: number | null = null;
    // ID より先に中断を決めた場合、ID が届いた時点で中断する。
    let cancelWanted = false;
    let cancelSent = false;

    const cancelRequest = () => {
      if (requestId === null) {
        cancelWanted = true;
        return;
      }
      if (cancelSent) return;
      cancelSent = true;
      // 中断の失敗(終了済みの ID 等)は呼び出し側に伝えることがない。
      invoke<void>("http_cancel", { id: requestId }).catch(() => {});
    };

    const settle = () => {
      phase = "settled";
      signal?.removeEventListener("abort", onAbort);
    };

    /** 応答前なら reject、応答後なら本文ストリームを error にする。 */
    const fail = (error: unknown) => {
      if (phase === "pending") reject(error);
      else body?.error(error);
      settle();
    };

    function onAbort() {
      if (phase === "settled") return;
      fail(abortError());
      cancelRequest();
    }

    const openResponse = (status: number, statusText: string) => {
      const stream = NULL_BODY_STATUSES.has(status)
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
            // 読み手が本文を捨てたら、残りを受け取る理由がないので送信も止める。
            cancel() {
              if (phase === "settled") return;
              settle();
              cancelRequest();
            },
          });
      let response: Response;
      try {
        response = new Response(stream, { status, statusText });
      } catch (e) {
        // 200-599 の外など、Response で表せないステータス。
        fail(new NativeHttpError("network", `unsupported response status ${status}: ${String(e)}`));
        cancelRequest();
        return;
      }
      phase = "streaming";
      resolve(response);
    };

    const onEvent = (event: HttpEvent) => {
      if (phase === "settled") return;
      switch (event.event) {
        case "response":
          if (phase === "pending") openResponse(event.data.status, event.data.statusText);
          return;
        case "chunk":
          body?.enqueue(new Uint8Array(event.data.bytes));
          return;
        case "end":
          if (phase === "pending") {
            fail(new NativeHttpError("network", "connection closed before response"));
            return;
          }
          body?.close();
          settle();
          return;
        case "error":
          fail(new NativeHttpError("network", event.data.message));
          return;
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    invoke<number>("http_request", { req, onEvent: new Channel<HttpEvent>(onEvent) }).then(
      (id) => {
        requestId = id;
        if (cancelWanted) cancelRequest();
      },
      (e: unknown) => {
        // 中断済みなら reject 済み。送信タスクも起動していないので中断も要らない。
        if (phase === "settled") return;
        settle();
        // IPC 自体の失敗(引数の不一致など)は開始時エラーの形をしていない。
        // 接続失敗と取り違えないよう、そのまま伝える。
        reject(isStartErrorPayload(e) ? new NativeHttpError(e.kind, e.message) : e);
      },
    );
  });
}
