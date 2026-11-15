/**
 * `provider-http-rust` spec task 2.4: nativeFetch 単体テスト。
 *
 * Rust 側(`src-tauri/src/commands/http.rs`)の `http_request` / `http_cancel` と
 * Channel を `@tauri-apps/api/core` のモックで差し替え、イベント列から組み立てた
 * Response・中断・エラー変換を確かめる。
 *
 * Requirements: 3.1, 3.3, 3.4, 4.1, 5.1, 5.2, 5.3(開始時エラーは 2.3, 7.4 の前提)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => {
  // 本物の Channel は IPC のコールバック登録を行うので、受け取ったハンドラを
  // 持つだけの代役にする。テストはこのハンドラを直接呼んでイベントを流す。
  class Channel<T> {
    onmessage: (message: T) => void;
    constructor(onmessage?: (message: T) => void) {
      this.onmessage = onmessage ?? (() => {});
    }
  }
  return { invoke: vi.fn(), Channel };
});

import { invoke } from "@tauri-apps/api/core";
import { nativeFetch, NativeHttpError } from "@/domain/http";
import type {
  HttpEvent,
  HttpRequestPayload,
  NativeHttpStartErrorKind,
} from "@/domain/http";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

interface StartedRequest {
  req: HttpRequestPayload;
  onEvent: { onmessage: (event: HttpEvent) => void };
  /** `http_request` の応答(ID)を返す。 */
  resolveId: (id: number) => void;
  /** `http_request` を開始時エラーで失敗させる。 */
  rejectStart: (error: unknown) => void;
}

let started: StartedRequest[];

beforeEach(() => {
  started = [];
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "http_request") {
      return new Promise((resolve, reject) => {
        started.push({
          req: args.req as HttpRequestPayload,
          onEvent: args.onEvent as StartedRequest["onEvent"],
          resolveId: resolve,
          rejectStart: reject,
        });
      });
    }
    if (cmd === "http_cancel") return Promise.resolve(undefined);
    throw new Error(`unexpected command: ${cmd}`);
  });
});

function lastStarted(): StartedRequest {
  const s = started[started.length - 1];
  if (!s) throw new Error("http_request was not invoked");
  return s;
}

function emit(event: HttpEvent): void {
  lastStarted().onEvent.onmessage(event);
}

function bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function cancelCalls(): unknown[] {
  return mockInvoke.mock.calls
    .filter(([cmd]) => cmd === "http_cancel")
    .map(([, args]) => args);
}

/** 保留中の Promise のコールバック(invoke の then など)を流す。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function expectAbortError(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toSatisfy(
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
}

async function expectNetworkError(
  p: Promise<unknown>,
  message: string,
): Promise<void> {
  await expect(p).rejects.toSatisfy(
    (e: unknown) =>
      e instanceof NativeHttpError && e.kind === "network" && e.message === message,
  );
}

describe("nativeFetch: http_request の呼び方", () => {
  it("init を省略すると GET・空ヘッダー・本文なし・認証なしで送る", () => {
    void nativeFetch("http://127.0.0.1:5000/v1/models");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("http_request", {
      req: {
        method: "GET",
        url: "http://127.0.0.1:5000/v1/models",
        headers: {},
        body: null,
        authProvider: null,
      },
      onEvent: expect.any(Object),
    });
  });

  it("method・headers・body・authProvider をそのまま渡す", () => {
    void nativeFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"stream":true}',
      authProvider: "openai",
    });

    expect(lastStarted().req).toEqual({
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      headers: { "Content-Type": "application/json" },
      body: '{"stream":true}',
      authProvider: "openai",
    });
  });
});

describe("nativeFetch: Response の組み立て (Req 3.1, 3.3, 5.3)", () => {
  it("response イベントで resolve し、チャンクを本文に流し、end で閉じる", async () => {
    const p = nativeFetch("http://x/v1/completions", { method: "POST" });
    lastStarted().resolveId(1);
    emit({ event: "response", data: { status: 200, statusText: "OK" } });

    // 本文の完了を待たずに Response が返る。
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.ok).toBe(true);

    emit({ event: "chunk", data: { bytes: bytes("data: あ\n\n") } });
    emit({ event: "chunk", data: { bytes: bytes("data: [DONE]\n\n") } });
    emit({ event: "end" });

    expect(await res.text()).toBe("data: あ\n\ndata: [DONE]\n\n");
    expect(cancelCalls()).toEqual([]);
  });

  it("non-2xx も resolve し、ステータスと本文をそのまま返す", async () => {
    const p = nativeFetch("https://api.openai.com/v1/models");
    lastStarted().resolveId(1);
    emit({ event: "response", data: { status: 401, statusText: "Unauthorized" } });
    emit({ event: "chunk", data: { bytes: bytes('{"error":"bad key"}') } });
    emit({ event: "end" });

    const res = await p;
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe('{"error":"bad key"}');
  });

  it.each([204, 205, 304])("ステータス %i は本文を null にする", async (status) => {
    const p = nativeFetch("http://x/v1");
    lastStarted().resolveId(1);
    emit({ event: "response", data: { status, statusText: "" } });
    emit({ event: "end" });

    const res = await p;
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
  });

  it("チャンクイベント 1 件ごとに、本文ストリームからその分が読める (Req 3.4)", async () => {
    const p = nativeFetch("http://x/v1/completions");
    lastStarted().resolveId(1);
    emit({ event: "response", data: { status: 200, statusText: "OK" } });
    const res = await p;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // 次のチャンクを流す前に、直前のチャンクがもう読めていること(溜め込まない)。
    for (const text of ["data: 一\n\n", "data: 二\n\n", "data: 三\n\n"]) {
      emit({ event: "chunk", data: { bytes: bytes(text) } });
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(decoder.decode(value)).toBe(text);
    }

    emit({ event: "end" });
    expect((await reader.read()).done).toBe(true);
  });

  it("Response が表せないステータスは network で reject し、送信を中断する", async () => {
    const p = nativeFetch("http://x/v1");
    lastStarted().resolveId(5);
    emit({ event: "response", data: { status: 600, statusText: "" } });

    await expect(p).rejects.toSatisfy(
      (e: unknown) => e instanceof NativeHttpError && e.kind === "network",
    );
    expect(cancelCalls()).toEqual([{ id: 5 }]);
  });
});

describe("nativeFetch: エラー変換 (Req 5.2, 2.3, 7.4)", () => {
  it.each<NativeHttpStartErrorKind>([
    "invalidUrl",
    "missingSecret",
    "secretUnavailable",
    "unsupportedAuth",
    "authHostNotAllowed",
    "invalidHeader",
  ])("開始時エラー %s を同じ kind の NativeHttpError で reject する", async (kind) => {
    const p = nativeFetch("http://x/v1", { authProvider: "openai" });
    lastStarted().rejectStart({ kind, message: "detail" });

    await expect(p).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NativeHttpError && e.kind === kind && e.message === "detail",
    );
    expect(cancelCalls()).toEqual([]);
  });

  it("開始時エラーの形でない reject は、そのまま伝える", async () => {
    const p = nativeFetch("http://x/v1");
    lastStarted().rejectStart("invalid args `req` for command `http_request`");

    await expect(p).rejects.toBe("invalid args `req` for command `http_request`");
  });

  it("response 前の error イベント(接続失敗)は network で reject する", async () => {
    const p = nativeFetch("http://127.0.0.1:1/v1");
    lastStarted().resolveId(1);
    emit({ event: "error", data: { message: "connection refused" } });

    await expectNetworkError(p, "connection refused");
    expect(cancelCalls()).toEqual([]);
  });

  it("response 後の error イベントは、本文ストリームを network で error にする", async () => {
    const p = nativeFetch("http://x/v1/completions");
    lastStarted().resolveId(1);
    emit({ event: "response", data: { status: 200, statusText: "OK" } });
    const res = await p;
    const reader = res.body!.getReader();

    emit({ event: "chunk", data: { bytes: bytes("data: 途中\n\n") } });
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: 途中\n\n");

    // 未読のチャンクは error で捨てられる(Streams の error() の仕様。Web の fetch と同じ)。
    emit({ event: "error", data: { message: "connection reset" } });
    await expectNetworkError(reader.read(), "connection reset");
    expect(cancelCalls()).toEqual([]);
  });
});

describe("nativeFetch: AbortSignal (Req 4.1, 5.1)", () => {
  it("開始前に abort 済みなら invoke せずに AbortError で reject する", async () => {
    const controller = new AbortController();
    controller.abort();

    await expectAbortError(nativeFetch("http://x/v1", { signal: controller.signal }));
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("ID を受け取る前の abort は直ちに reject し、ID を受け取った直後に 1 回だけ中断する", async () => {
    const controller = new AbortController();
    const p = nativeFetch("http://x/v1", { signal: controller.signal });

    controller.abort();
    await expectAbortError(p);
    expect(cancelCalls()).toEqual([]);

    lastStarted().resolveId(7);
    await flush();
    expect(cancelCalls()).toEqual([{ id: 7 }]);

    // 中断の瞬間に送られていたイベントが届いても無視する。
    emit({ event: "response", data: { status: 200, statusText: "OK" } });
    emit({ event: "end" });
    await flush();
    expect(cancelCalls()).toEqual([{ id: 7 }]);
  });

  it("ID を受け取る前に abort し、その後に開始時エラーになったら中断は呼ばない", async () => {
    const controller = new AbortController();
    const p = nativeFetch("http://x/v1", { signal: controller.signal });

    controller.abort();
    lastStarted().rejectStart({ kind: "missingSecret", message: "openai" });

    await expectAbortError(p);
    await flush();
    expect(cancelCalls()).toEqual([]);
  });

  it("response 前の abort は AbortError で reject し、中断を 1 回だけ呼ぶ", async () => {
    const controller = new AbortController();
    const p = nativeFetch("http://x/v1", { signal: controller.signal });
    lastStarted().resolveId(3);
    await flush();

    controller.abort();
    await expectAbortError(p);
    expect(cancelCalls()).toEqual([{ id: 3 }]);

    // abort 後に届いた response は無視する(reject のまま)。
    emit({ event: "response", data: { status: 200, statusText: "OK" } });
    await flush();
    expect(cancelCalls()).toEqual([{ id: 3 }]);
  });

  it("response 後の abort は本文ストリームを AbortError で error にし、中断を 1 回だけ呼ぶ", async () => {
    const controller = new AbortController();
    const p = nativeFetch("http://x/v1/completions", { signal: controller.signal });
    lastStarted().resolveId(4);
    emit({ event: "response", data: { status: 200, statusText: "OK" } });
    const res = await p;
    const reader = res.body!.getReader();

    emit({ event: "chunk", data: { bytes: bytes("data: 一\n\n") } });
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: 一\n\n");

    controller.abort();
    await expectAbortError(reader.read());
    expect(cancelCalls()).toEqual([{ id: 4 }]);

    // 中断の瞬間に送られていたイベントが届いても無視する(例外にならない)。
    expect(() => {
      emit({ event: "chunk", data: { bytes: bytes("data: 二\n\n") } });
      emit({ event: "end" });
    }).not.toThrow();
    controller.abort();
    expect(cancelCalls()).toEqual([{ id: 4 }]);
  });

  it("end の後の abort では中断を呼ばず、本文はそのまま読める", async () => {
    const controller = new AbortController();
    const p = nativeFetch("http://x/v1", { signal: controller.signal });
    lastStarted().resolveId(2);
    emit({ event: "response", data: { status: 200, statusText: "OK" } });
    emit({ event: "chunk", data: { bytes: bytes("{}") } });
    emit({ event: "end" });
    const res = await p;

    controller.abort();
    expect(await res.text()).toBe("{}");
    expect(cancelCalls()).toEqual([]);
  });

  it("本文ストリームを読み手が cancel したら中断を 1 回だけ呼び、その後の abort では呼ばない", async () => {
    const controller = new AbortController();
    const p = nativeFetch("http://x/v1", { signal: controller.signal });
    lastStarted().resolveId(9);
    emit({ event: "response", data: { status: 200, statusText: "OK" } });
    const res = await p;

    await res.body!.cancel();
    expect(cancelCalls()).toEqual([{ id: 9 }]);

    controller.abort();
    emit({ event: "chunk", data: { bytes: bytes("late") } });
    expect(cancelCalls()).toEqual([{ id: 9 }]);
  });
});
