/**
 * `cloud-providers` spec task 11.2: OpenAIAdapter 関連ヘルパーの単体テスト。
 *
 * 対象は task 5.2 / 5.4 で `@internal exported for test in task 11.2` として
 * 公開された pure ヘルパー群:
 *
 *   - `parseChatSSEEvent` ... Chat 経路 SSE パース(正常 / 空 / [DONE] / JSON parse 不能の混在)
 *   - `mapHttpStatusToProviderError` ... HTTP ステータスごとの ProviderError.kind 分類
 *   - `composeSystemMessage` ... 内蔵指示と user systemPrompt の合成
 *
 * これらは既に実装済みのため TDD-style RED-then-GREEN ではなく、
 * 不変条件を永続的に守るためのレグレッションスイートとして書く。
 *
 * Requirements:
 *   Req 3.2(本文を user メッセージとして送信)
 *   Req 3.5(ストリーミング受信)
 *   Req 3.6(ネットワーク断 / config 未設定 vs 4xx/5xx の分離)
 *   Req 3.7(401 → auth)
 *   Req 3.8(429 → rateLimit)
 *
 * Boundary: providers/openai.ts のテストのみ。実装ファイルは触らない。
 *
 * `provider-http-rust` spec task 3.2 で、Chat / Completion の生成経路(Group 4)を
 * nativeFetch(`@/domain/http`、Rust 側に送らせる入口)のモックで検証する形に改めた。
 * 画面側はキーを読まず Authorization も組み立てず、`authProvider: "openai"` を渡して
 * Rust 側に付けさせること、キー未設定(missingSecret)が移行前と同じ config になること、
 * ステータス分類・タイムアウト・静かな停止が移行前のままであることを確かめる
 * (Requirements 4.2, 5.1, 5.3, 6.1, 7.2, 7.4)。
 *
 * 同 task 3.3 で、モデル一覧取得(Group 6)も同じ流儀に改めた。キーを引数に取らず
 * `authProvider: "openai"` を渡すこと、キー未設定が config になること、移行前の分類と
 * 中断時の挙動が保たれていることを確かめる(Requirements 6.2, 7.3, 7.4)。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/domain/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/http")>();
  return { ...actual, nativeFetch: vi.fn() };
});

// dev イベントの発行を検証するためにモックする(本物は invoke を呼ぶ)。
vi.mock("@/lib/devLog", () => ({ emitDevEvent: vi.fn() }));

import { nativeFetch, NativeHttpError } from "@/domain/http";
import type { NativeFetchInit } from "@/domain/http";
import { emitDevEvent } from "@/lib/devLog";
import {
  OPENAI_CONTEXT_WINDOW_MAP,
  OpenAIAdapter,
  composeSystemMessage,
  isReasoningModel,
  listOpenAIModels,
  mapHttpStatusToProviderError,
  parseChatSSEEvent,
} from "@/domain/providers/openai";
import {
  ProviderError,
  type AIConfig,
  type GenerationChunk,
  type GenerationRequest,
} from "@/domain/providers/types";

const mockNativeFetch = nativeFetch as unknown as ReturnType<
  typeof vi.fn<(url: string, init?: NativeFetchInit) => Promise<Response>>
>;
const mockEmitDevEvent = emitDevEvent as unknown as ReturnType<typeof vi.fn>;

// 内蔵指示は openai.ts 内で `INTERNAL_CHAT_INSTRUCTION` として定義されているが
// export されていない。`composeSystemMessage(null)` で再導出して定数として扱う。
// 仕様(design L264)で固定文言が決まっているので、その完全一致も別途検証する。
const INTERNAL_CHAT_INSTRUCTION = composeSystemMessage(null);
const EXPECTED_INSTRUCTION =
  "以下の本文の続きを書いてください。挨拶・要約・解説は不要です。続きの文章のみを返してください。";

describe("INTERNAL_CHAT_INSTRUCTION (固定文言)", () => {
  it("design.md L264 で要求される固定文言と完全一致する", () => {
    expect(INTERNAL_CHAT_INSTRUCTION).toBe(EXPECTED_INSTRUCTION);
  });
});

// ---------------------------------------------------------------------------
// Group 1: parseChatSSEEvent
// ---------------------------------------------------------------------------

describe("parseChatSSEEvent (Chat 経路 SSE パース)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // JSON パース失敗時の console.warn(DEV のみ)を抑止しつつ呼び出し検証可能にする
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("通常チャンク: delta.content を textDelta として返し finishReason は undefined", () => {
    const event = `data: {"choices":[{"delta":{"content":"hello"}}]}`;
    const result = parseChatSSEEvent(event);
    expect(result).toEqual({ textDelta: "hello", finishReason: undefined });
  });

  it("delta.content が空 + finish_reason: stop → textDelta='' + finishReason='stop'", () => {
    const event = `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`;
    const result = parseChatSSEEvent(event);
    expect(result).toEqual({ textDelta: "", finishReason: "stop" });
  });

  it("[DONE] sentinel を返す", () => {
    const event = `data: [DONE]`;
    expect(parseChatSSEEvent(event)).toBe("DONE");
  });

  it("空の data: 行のみ → null(スキップ)", () => {
    const event = `data: `;
    expect(parseChatSSEEvent(event)).toBeNull();
  });

  it("data: 行が一つも無い(コメント等のみ) → null", () => {
    const event = `: heartbeat\nevent: ping`;
    expect(parseChatSSEEvent(event)).toBeNull();
  });

  it("JSON パース不能 → null + DEV 時に console.warn が呼ばれる", () => {
    const event = `data: {malformed`;
    const result = parseChatSSEEvent(event);
    expect(result).toBeNull();
    // import.meta.env.DEV は vitest 上では truthy 扱いになるため warn が呼ばれる
    expect(warnSpy).toHaveBeenCalled();
  });

  it("複数の data: 行があるとき最初の行が採用される", () => {
    const event = [
      `data: {"choices":[{"delta":{"content":"first"}}]}`,
      `data: {"choices":[{"delta":{"content":"second"}}]}`,
    ].join("\n");
    const result = parseChatSSEEvent(event);
    expect(result).toEqual({ textDelta: "first", finishReason: undefined });
  });

  it("finish_reason マッピング: 'length' → 'length'", () => {
    const event = `data: {"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}`;
    expect(parseChatSSEEvent(event)).toEqual({
      textDelta: "x",
      finishReason: "length",
    });
  });

  it("finish_reason マッピング: null → undefined(content 付き)", () => {
    const event = `data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}`;
    expect(parseChatSSEEvent(event)).toEqual({
      textDelta: "x",
      finishReason: undefined,
    });
  });

  it("finish_reason マッピング: 未指定 → undefined", () => {
    const event = `data: {"choices":[{"delta":{"content":"x"}}]}`;
    expect(parseChatSSEEvent(event)).toEqual({
      textDelta: "x",
      finishReason: undefined,
    });
  });

  it("finish_reason マッピング: 'content_filter' など未知値 → 'error'", () => {
    const event = `data: {"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}`;
    expect(parseChatSSEEvent(event)).toEqual({
      textDelta: "x",
      finishReason: "error",
    });
  });

  it("delta.content 欠落 + finish_reason 無し → null", () => {
    const event = `data: {"choices":[{"delta":{}}]}`;
    expect(parseChatSSEEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group 2: mapHttpStatusToProviderError
// ---------------------------------------------------------------------------

describe("mapHttpStatusToProviderError (HTTP ステータス → ProviderError 分類)", () => {
  it("401 → kind: 'auth' / 「API キーが無効です」", () => {
    const err = mapHttpStatusToProviderError(401, "Unauthorized", null);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("API キーが無効です");
    expect(err.message).toContain("HTTP 401");
  });

  it("429 → kind: 'rateLimit' / 「レート制限に達しました」", () => {
    const err = mapHttpStatusToProviderError(429, "Too Many Requests", null);
    expect(err.kind).toBe("rateLimit");
    expect(err.message).toContain("レート制限に達しました");
    expect(err.message).toContain("HTTP 429");
  });

  it("500 → kind: 'http' / message が 'HTTP 500' で始まる", () => {
    const err = mapHttpStatusToProviderError(500, "Internal Server Error", null);
    expect(err.kind).toBe("http");
    expect(err.message).toMatch(/^HTTP 500/);
  });

  it("503 → kind: 'http'(401/429 以外の 5xx は全て http)", () => {
    const err = mapHttpStatusToProviderError(503, "Service Unavailable", null);
    expect(err.kind).toBe("http");
    expect(err.message).toMatch(/^HTTP 503/);
  });

  it("400 → kind: 'http'(401/429 以外の 4xx も http)", () => {
    const err = mapHttpStatusToProviderError(400, "Bad Request", null);
    expect(err.kind).toBe("http");
    expect(err.message).toMatch(/^HTTP 400/);
  });

  it("detail が non-null のとき message 末尾に \": <detail>\" が含まれる(401 経路)", () => {
    const err = mapHttpStatusToProviderError(
      401,
      "Unauthorized",
      "Invalid API key",
    );
    expect(err.kind).toBe("auth");
    expect(err.message).toContain(": Invalid API key");
  });

  it("detail が non-null のとき message 末尾に \": <detail>\" が含まれる(http 経路)", () => {
    const err = mapHttpStatusToProviderError(
      500,
      "Internal Server Error",
      "upstream timeout",
    );
    expect(err.kind).toBe("http");
    expect(err.message).toContain(": upstream timeout");
  });

  it("detail が null のとき message 末尾に detail suffix が付かない", () => {
    const err = mapHttpStatusToProviderError(429, "Too Many Requests", null);
    expect(err.message).not.toContain(": ");
  });
});

// ---------------------------------------------------------------------------
// Group 3: composeSystemMessage
// ---------------------------------------------------------------------------

describe("composeSystemMessage (内蔵指示と systemPrompt の合成)", () => {
  it("null → 内蔵指示のみ", () => {
    expect(composeSystemMessage(null)).toBe(EXPECTED_INSTRUCTION);
  });

  it("undefined → 内蔵指示のみ", () => {
    expect(composeSystemMessage(undefined)).toBe(EXPECTED_INSTRUCTION);
  });

  it("空文字列 → 内蔵指示のみ(空白扱い)", () => {
    expect(composeSystemMessage("")).toBe(EXPECTED_INSTRUCTION);
  });

  it("空白(半角)のみ → 内蔵指示のみ", () => {
    expect(composeSystemMessage("   ")).toBe(EXPECTED_INSTRUCTION);
  });

  it("改行のみ → 内蔵指示のみ", () => {
    expect(composeSystemMessage("\n\n\t  ")).toBe(EXPECTED_INSTRUCTION);
  });

  it("non-empty → 内蔵指示 + '\\n\\n' + ユーザー文", () => {
    const user = "作品固有の禁則事項: 一人称は「俺」。";
    expect(composeSystemMessage(user)).toBe(
      `${EXPECTED_INSTRUCTION}\n\n${user}`,
    );
  });

  it("non-empty(前後空白あり)→ trim された値が後ろに連結される", () => {
    const user = "  禁則事項  ";
    // 実装は `requestSystemPrompt.trim()` を使うので前後空白は除去された値が連結される
    expect(composeSystemMessage(user)).toBe(
      `${EXPECTED_INSTRUCTION}\n\n禁則事項`,
    );
  });
});

// ---------------------------------------------------------------------------
// Group 4: OpenAIAdapter.generateStream(nativeFetch 経路、provider-http-rust 3.2)
// ---------------------------------------------------------------------------
//
// HTTP は nativeFetch のモックで遮断する。モックは Web 標準の Response を返し、
// signal の abort を nativeFetch と同じく AbortError で伝える。グローバル fetch は
// 使われたら失敗するスタブにして、WebView の fetch が残っていないことを検出する。

const encoder = new TextEncoder();

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** 応答が来ないまま、signal の abort で AbortError を返す(nativeFetch の応答前中断と同じ)。 */
function pendingUntilAbort(init?: NativeFetchInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

/**
 * テストから本文を流し込める SSE 応答。signal の abort で本文ストリームを
 * AbortError にする(nativeFetch の応答後中断と同じ)。
 */
function controllableSse(init?: NativeFetchInit) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  init?.signal?.addEventListener(
    "abort",
    () => {
      try {
        controller.error(abortError());
      } catch {
        // closed 済み
      }
    },
    { once: true },
  );
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
  };
}

function sseResponse(text: string): Response {
  return new Response(encoder.encode(text), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(iter: AsyncIterable<GenerationChunk>): Promise<GenerationChunk[]> {
  const out: GenerationChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

async function catchError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

describe("OpenAIAdapter.generateStream (nativeFetch 経路)", () => {
  const baseConfig: AIConfig = {
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
    systemPrompt: null,
    timeoutMs: 10000,
    contextWindow: 128000,
  };

  const baseRequest: GenerationRequest = {
    systemPrompt: "",
    contextSections: [],
    body: "むかしむかし、",
    parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
  };

  /** Chat 経路と Completion 経路(モデル名末尾 `-instruct`)の両方で同じ契約を確かめる。 */
  const paths = [
    {
      path: "chat",
      model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
      sse: (text: string, finish: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }] })}\n\n`,
    },
    {
      path: "completion",
      model: "gpt-3.5-turbo-instruct",
      url: "https://api.openai.com/v1/completions",
      sse: (text: string, finish: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ text, finish_reason: finish }] })}\n\n`,
    },
  ] as const;

  beforeEach(() => {
    mockNativeFetch.mockReset();
    mockEmitDevEvent.mockReset();
    // 通信は nativeFetch だけを通る。WebView の fetch に流れたら失敗させる。
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("global fetch must not be used"))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("config.endpoint が空ならコンストラクタで ProviderError('config') を投げる", () => {
    expect(() => new OpenAIAdapter({ ...baseConfig, endpoint: "" })).toThrow(
      ProviderError,
    );
  });

  it("generate(接続テストの経路)は渡された設定のエンドポイントへ nativeFetch で送り、種別付きのエラーを返す(6.1)", async () => {
    // 接続テストは保存前の入力値で組んだ設定を使う。その endpoint にそのまま送ること。
    const unsaved: AIConfig = { ...baseConfig, endpoint: "https://proxy.example.test/v1/" };
    mockNativeFetch.mockResolvedValueOnce(
      sseResponse(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "length" }] })}\n\n`,
      ),
    );
    await expect(new OpenAIAdapter(unsaved).generate(baseRequest)).resolves.toEqual({
      text: "OK",
      finishReason: "length",
    });
    expect(mockNativeFetch.mock.calls[0]![0]).toBe(
      "https://proxy.example.test/v1/chat/completions",
    );
    expect(mockNativeFetch.mock.calls[0]![1]?.authProvider).toBe("openai");

    mockNativeFetch.mockResolvedValueOnce(
      new Response("", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(new OpenAIAdapter(unsaved).generate(baseRequest)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "auth",
    });
  });

  describe.each(paths)("$path 経路", ({ path, model, url, sse }) => {
    const config: AIConfig = { ...baseConfig, model };

    it("Authorization を組み立てず、authProvider: openai を指定して nativeFetch で送る(7.2)", async () => {
      mockNativeFetch.mockResolvedValue(
        sseResponse(sse("むかし") + sse("むかし", "stop") + "data: [DONE]\n\n"),
      );

      const adapter = new OpenAIAdapter(config);
      const chunks = await collect(
        adapter.generateStream(baseRequest, new AbortController().signal),
      );

      expect(chunks).toEqual([
        { textDelta: "むかし", finishReason: undefined },
        { textDelta: "むかし", finishReason: "stop" },
      ]);
      expect(mockNativeFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = mockNativeFetch.mock.calls[0]!;
      expect(calledUrl).toBe(url);
      expect(init?.method).toBe("POST");
      // 画面側はキーに触れない。ヘッダーは内容の種類だけ。
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      });
      expect(init?.authProvider).toBe("openai");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(init?.body ?? "");
      // 出力上限などのパラメータの送り分けは「リクエスト本文のパラメータ」の describe で確かめる。
      expect(body).toMatchObject({ model, stream: true });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("送信を始めるときに generate.start の dev イベントを出す", async () => {
      mockNativeFetch.mockResolvedValue(sseResponse("data: [DONE]\n\n"));

      const adapter = new OpenAIAdapter(config);
      await collect(adapter.generateStream(baseRequest, new AbortController().signal));

      expect(mockEmitDevEvent).toHaveBeenCalledWith("generate.start", {
        provider: "openai",
        path,
        model,
      });
      // start は nativeFetch より前に出る(移行前と同じく、送信を試みる時点の記録)
      expect(mockEmitDevEvent.mock.invocationCallOrder[0]).toBeLessThan(
        mockNativeFetch.mock.invocationCallOrder[0]!,
      );
    });

    it("キー未設定(missingSecret)は「OpenAI API キーが設定されていません」の config にし、generate.error を出す(7.4)", async () => {
      const cause = new NativeHttpError("missingSecret", "openai");
      mockNativeFetch.mockRejectedValue(cause);

      const adapter = new OpenAIAdapter(config);
      const err = await catchError(
        collect(adapter.generateStream(baseRequest, new AbortController().signal)),
      );

      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("config");
      expect((err as ProviderError).message).toBe("OpenAI API キーが設定されていません");
      expect((err as ProviderError).cause).toBe(cause);
      expect(mockEmitDevEvent).toHaveBeenCalledWith("generate.error", {
        provider: "openai",
        path,
        kind: "config",
        message: "OpenAI API キーが設定されていません",
      });
    });

    it("その他の開始時エラー(secretUnavailable)も config として投げる", async () => {
      mockNativeFetch.mockRejectedValue(
        new NativeHttpError("secretUnavailable", "keychain locked"),
      );

      const adapter = new OpenAIAdapter(config);
      const err = await catchError(
        collect(adapter.generateStream(baseRequest, new AbortController().signal)),
      );

      expect((err as ProviderError).kind).toBe("config");
      expect((err as ProviderError).message).toBe(
        "API キーを読み出せませんでした: keychain locked",
      );
    });

    it.each([
      { status: 401, statusText: "Unauthorized", kind: "auth", prefix: "API キーが無効です (HTTP 401 Unauthorized)" },
      { status: 429, statusText: "Too Many Requests", kind: "rateLimit", prefix: "レート制限に達しました (HTTP 429 Too Many Requests)" },
      { status: 500, statusText: "Internal Server Error", kind: "http", prefix: "HTTP 500 Internal Server Error" },
    ])(
      "HTTP $status は $kind に分類し、サーバーの詳細を含める(5.3)",
      async ({ status, statusText, kind, prefix }) => {
        mockNativeFetch.mockResolvedValue(
          new Response("server detail", { status, statusText }),
        );

        const adapter = new OpenAIAdapter(config);
        const err = await catchError(
          collect(adapter.generateStream(baseRequest, new AbortController().signal)),
        );

        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).kind).toBe(kind);
        expect((err as ProviderError).message).toBe(`${prefix}: server detail`);
      },
    );

    it("接続失敗(network)は「OpenAI API に接続できません」の network として投げる", async () => {
      const cause = new NativeHttpError("network", "connection refused");
      mockNativeFetch.mockRejectedValue(cause);

      const adapter = new OpenAIAdapter(config);
      const err = await catchError(
        collect(adapter.generateStream(baseRequest, new AbortController().signal)),
      );

      expect((err as ProviderError).kind).toBe("network");
      expect((err as ProviderError).message).toBe(`OpenAI API に接続できません (${url})`);
      expect((err as ProviderError).cause).toBe(cause);
      // キー未設定以外では generate.error を出さない(移行前と同じ)
      expect(mockEmitDevEvent).not.toHaveBeenCalledWith("generate.error", expect.anything());
    });

    it("応答前に外部 signal で止めると、例外なしで静かに終わる(4.2)", async () => {
      mockNativeFetch.mockImplementation((_url, init) => pendingUntilAbort(init));

      const outer = new AbortController();
      const adapter = new OpenAIAdapter(config);
      const done = collect(adapter.generateStream(baseRequest, outer.signal));
      await vi.waitFor(() => expect(mockNativeFetch).toHaveBeenCalledTimes(1));
      outer.abort();

      await expect(done).resolves.toEqual([]);
      expect(mockNativeFetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    });

    it("受信中に外部 signal で止めると、反映を止めて静かに終わる(4.2)", async () => {
      let stream!: ReturnType<typeof controllableSse>;
      mockNativeFetch.mockImplementation(async (_url, init) => {
        stream = controllableSse(init);
        return stream.response;
      });

      const outer = new AbortController();
      const adapter = new OpenAIAdapter(config);
      const iter = adapter.generateStream(baseRequest, outer.signal)[Symbol.asyncIterator]();

      const first = iter.next();
      await vi.waitFor(() => expect(stream).toBeDefined());
      stream.push(sse("ここまで"));
      await expect(first).resolves.toMatchObject({ value: { textDelta: "ここまで" } });

      const next = iter.next();
      outer.abort();
      await expect(next).resolves.toEqual({ done: true, value: undefined });
    });

    it("応答前に内部タイマーが切れると timeout として投げる(5.1)", async () => {
      mockNativeFetch.mockImplementation((_url, init) => pendingUntilAbort(init));

      const adapter = new OpenAIAdapter({ ...config, timeoutMs: 20 });
      const err = await catchError(
        collect(adapter.generateStream(baseRequest, new AbortController().signal)),
      );

      expect((err as ProviderError).kind).toBe("timeout");
      expect((err as ProviderError).message).toBe("応答がタイムアウトしました (20ms)");
    });

    it("受信中に内部タイマーが切れても timeout として投げる(5.1)", async () => {
      let stream!: ReturnType<typeof controllableSse>;
      mockNativeFetch.mockImplementation(async (_url, init) => {
        stream = controllableSse(init);
        return stream.response;
      });

      const adapter = new OpenAIAdapter({ ...config, timeoutMs: 200 });
      const iter = adapter
        .generateStream(baseRequest, new AbortController().signal)
        [Symbol.asyncIterator]();

      const first = iter.next();
      await vi.waitFor(() => expect(stream).toBeDefined());
      stream.push(sse("少しだけ"));
      await expect(first).resolves.toMatchObject({ value: { textDelta: "少しだけ" } });

      const err = await catchError(iter.next());
      expect((err as ProviderError).kind).toBe("timeout");
      expect((err as ProviderError).message).toBe("応答がタイムアウトしました (200ms)");
    });
  });
});

// ---------------------------------------------------------------------------
// リクエスト本文のパラメータ(モデル系統ごとの送り分け)
// ---------------------------------------------------------------------------
//
// gpt-5 系などの推論モデルは `max_tokens` を受け付けず(HTTP 400)、`temperature` /
// `top_p` も既定値以外を拒否することがある。Chat 経路は全モデルで
// `max_completion_tokens` を送り(公式に `max_tokens` は deprecated)、推論モデルには
// `temperature` / `top_p` を送らない。Completion 経路(`/v1/completions`)には
// `max_completion_tokens` が無いので `max_tokens` のまま。
// 判断の経緯は docs/spec/polish-backlog.md の「gpt-5 系モデルで生成が HTTP 400 になる」。

describe("isReasoningModel (推論モデルの判定)", () => {
  it.each([
    "gpt-5",
    "gpt-5-mini",
    "gpt-5.5",
    "gpt-5-chat-latest",
    "GPT-5.2",
    "gpt-6-astra",
    "gpt-10",
    "o1",
    "o3-mini",
    "o4-mini",
  ])("%s は推論モデル", (model) => {
    expect(isReasoningModel(model)).toBe(true);
  });

  it.each([
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-instruct",
    "chatgpt-4o-latest",
    "omni-moderation-latest",
    "my-gpt-5",
    "",
  ])("%s は推論モデルではない", (model) => {
    expect(isReasoningModel(model)).toBe(false);
  });
});

describe("OpenAIAdapter リクエスト本文のパラメータ", () => {
  const request: GenerationRequest = {
    systemPrompt: "",
    contextSections: [],
    body: "むかしむかし、",
    parameters: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
  };

  function configFor(model: string): AIConfig {
    return {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model,
      parameters: request.parameters,
      systemPrompt: null,
      timeoutMs: 10000,
      contextWindow: 128000,
    };
  }

  /** 1 回生成して、nativeFetch に渡った本文を JSON で返す。 */
  async function sentBody(
    model: string,
    req: GenerationRequest = request,
  ): Promise<Record<string, unknown>> {
    mockNativeFetch.mockResolvedValue(sseResponse("data: [DONE]\n\n"));
    await collect(
      new OpenAIAdapter(configFor(model)).generateStream(req, new AbortController().signal),
    );
    return JSON.parse(mockNativeFetch.mock.calls[0]![1]?.body ?? "");
  }

  beforeEach(() => {
    mockNativeFetch.mockReset();
  });

  it.each(["gpt-4o", "gpt-4o-mini", "gpt-4.1"])(
    "Chat 経路の非推論モデル(%s)は max_completion_tokens・temperature・top_p を送り、max_tokens は送らない",
    async (model) => {
      const body = await sentBody(model);
      expect(body).toMatchObject({
        max_completion_tokens: 100,
        temperature: 0.7,
        top_p: 0.9,
      });
      expect(body).not.toHaveProperty("max_tokens");
    },
  );

  it.each(["gpt-5", "gpt-5.5", "o3-mini"])(
    "Chat 経路の推論モデル(%s)は max_completion_tokens だけを送り、max_tokens・temperature・top_p は送らない",
    async (model) => {
      const body = await sentBody(model);
      expect(body).toMatchObject({ max_completion_tokens: 100 });
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
    },
  );

  it("推論モデルでも extras に書いた値はそのまま送る(サーバ固有パラメータの素通し口)", async () => {
    const body = await sentBody("gpt-5.5", {
      ...request,
      parameters: {
        ...request.parameters,
        extras: { temperature: 1, reasoning_effort: "none" },
      },
    });
    expect(body).toMatchObject({
      max_completion_tokens: 100,
      temperature: 1,
      reasoning_effort: "none",
    });
    expect(body).not.toHaveProperty("top_p");
  });

  it("Completion 経路(-instruct)は max_tokens・temperature・top_p を送り、max_completion_tokens は送らない", async () => {
    const body = await sentBody("gpt-3.5-turbo-instruct");
    expect(body).toMatchObject({ max_tokens: 100, temperature: 0.7, top_p: 0.9 });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});

// ---------------------------------------------------------------------------
// Group 5: OPENAI_CONTEXT_WINDOW_MAP (task 11.5 / Req 4.5)
// ---------------------------------------------------------------------------
//
// AISettingsPane (task 7.4) でモデル選択時に contextWindow を自動補完するための
// 既知モデル → context window マップ。未知モデルは undefined を返し、
// ユーザー手動入力で contextWindow を設定する設計(design L268)。

describe("OPENAI_CONTEXT_WINDOW_MAP (Req 4.5)", () => {
  it("既知モデル(gpt-4o)で contextWindow を引ける", () => {
    expect(OPENAI_CONTEXT_WINDOW_MAP["gpt-4o"]).toBe(128000);
  });

  it("既知モデル(gpt-4o-mini)で contextWindow を引ける", () => {
    expect(OPENAI_CONTEXT_WINDOW_MAP["gpt-4o-mini"]).toBe(128000);
  });

  it("Completion 系既知モデル(gpt-3.5-turbo-instruct)で contextWindow を引ける", () => {
    expect(OPENAI_CONTEXT_WINDOW_MAP["gpt-3.5-turbo-instruct"]).toBe(4096);
  });

  it("未知モデル名は undefined を返す", () => {
    expect(OPENAI_CONTEXT_WINDOW_MAP["nonexistent-model-9000"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 6: listOpenAIModels (task 11.5 / Req 4.5、provider-http-rust 3.3)
// ---------------------------------------------------------------------------
//
// `/v1/models` を叩いてモデル ID 配列を抽出する静的ヘルパー。
// provider-http-rust 3.3 で、キーを引数に取らず nativeFetch(`authProvider: "openai"`)で
// Rust 側に送らせる形に改めた。nativeFetch をモックし(Web 標準の Response を返す)、
// グローバル fetch は使われたら失敗するスタブにして以下を検証する:
//   - 正常系: data[].id を抽出
//   - Authorization を組み立てず、authProvider: "openai" を渡す(Req 7.3)
//   - URL は <endpoint>/models、GET + Accept: application/json
//   - endpoint 未設定で ProviderError(config)(nativeFetch を呼ばない)
//   - キー未設定(missingSecret)は移行前と同じ文言の config(Req 7.4)
//   - 401 → auth / 429 → rateLimit / その他 → http / network → network /
//     中断 → 「モデル一覧取得が中断されました」/ parse 失敗 → parse(Req 6.2)
//   - id が string 以外のアイテムはフィルタされる

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
}

describe("listOpenAIModels (Req 4.5 / nativeFetch 経路)", () => {
  const ENDPOINT = "https://api.openai.com/v1";

  beforeEach(() => {
    mockNativeFetch.mockReset();
    // 通信は nativeFetch だけを通る。WebView の fetch に流れたら失敗させる。
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("global fetch must not be used"))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常レスポンスからモデル ID 配列を抽出", async () => {
    mockNativeFetch.mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [
          { id: "gpt-4o", object: "model" },
          { id: "gpt-4o-mini", object: "model" },
          { id: "gpt-3.5-turbo-instruct", object: "model" },
        ],
      }),
    );

    const models = await listOpenAIModels(ENDPOINT);
    expect(models).toEqual([
      { id: "gpt-4o" },
      { id: "gpt-4o-mini" },
      { id: "gpt-3.5-turbo-instruct" },
    ]);
  });

  it("Authorization を組み立てず、authProvider: \"openai\" を渡して Rust 側に付けさせる(7.3)", async () => {
    mockNativeFetch.mockResolvedValue(jsonResponse({ data: [] }));

    await listOpenAIModels(ENDPOINT);
    expect(mockNativeFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockNativeFetch.mock.calls[0]!;
    expect(init?.authProvider).toBe("openai");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Accept: "application/json" });
    const headerNames = Object.keys(init?.headers ?? {}).map((k) => k.toLowerCase());
    expect(headerNames).not.toContain("authorization");
  });

  it("URL が <endpoint>/models になる", async () => {
    mockNativeFetch.mockResolvedValue(jsonResponse({ data: [] }));

    await listOpenAIModels(ENDPOINT);
    expect(mockNativeFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.any(Object),
    );
  });

  it("呼び出し側の signal を nativeFetch に渡す", async () => {
    mockNativeFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const controller = new AbortController();

    await listOpenAIModels(ENDPOINT, controller.signal);
    expect(mockNativeFetch.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it("キー未設定(missingSecret)は「OpenAI API キーが設定されていません」の config にする(7.4)", async () => {
    const cause = new NativeHttpError("missingSecret", "openai");
    mockNativeFetch.mockRejectedValue(cause);

    const err = await catchError(listOpenAIModels(ENDPOINT));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("config");
    expect((err as ProviderError).message).toBe("OpenAI API キーが設定されていません");
    expect((err as ProviderError).cause).toBe(cause);
  });

  it("その他の開始時エラー(secretUnavailable)も config として投げる", async () => {
    mockNativeFetch.mockRejectedValue(
      new NativeHttpError("secretUnavailable", "keychain locked"),
    );

    const err = await catchError(listOpenAIModels(ENDPOINT));
    expect((err as ProviderError).kind).toBe("config");
    expect((err as ProviderError).message).toBe(
      "API キーを読み出せませんでした: keychain locked",
    );
  });

  it("endpoint 未設定で ProviderError(config) を投げ、通信しない", async () => {
    await expect(listOpenAIModels("")).rejects.toMatchObject({
      name: "ProviderError",
      kind: "config",
      message: "OpenAI エンドポイントが設定されていません",
    });
    expect(mockNativeFetch).not.toHaveBeenCalled();
  });

  it("401 → ProviderError(auth)", async () => {
    mockNativeFetch.mockResolvedValue(
      new Response("", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(listOpenAIModels(ENDPOINT)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "auth",
      message: "API キーが無効です (HTTP 401 Unauthorized)",
    });
  });

  it("429 → ProviderError(rateLimit)", async () => {
    mockNativeFetch.mockResolvedValue(
      new Response("", { status: 429, statusText: "Too Many Requests" }),
    );
    await expect(listOpenAIModels(ENDPOINT)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "rateLimit",
      message: "レート制限に達しました (HTTP 429 Too Many Requests)",
    });
  });

  it("その他の 4xx / 5xx → ProviderError(http)(本文を詳細に含める)", async () => {
    mockNativeFetch.mockResolvedValue(
      new Response("upstream down", { status: 503, statusText: "Service Unavailable" }),
    );
    await expect(listOpenAIModels(ENDPOINT)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "http",
      message: "HTTP 503 Service Unavailable: upstream down",
    });
  });

  it("network error → ProviderError(network)、文言は移行前のまま", async () => {
    const cause = new NativeHttpError("network", "connection refused");
    mockNativeFetch.mockRejectedValue(cause);

    const err = await catchError(listOpenAIModels(ENDPOINT));
    expect((err as ProviderError).kind).toBe("network");
    expect((err as ProviderError).message).toBe(
      "OpenAI に接続できません (https://api.openai.com/v1/models)",
    );
    expect((err as ProviderError).cause).toBe(cause);
  });

  it("呼び出し側の中断は「モデル一覧取得が中断されました」の network にする", async () => {
    mockNativeFetch.mockImplementation((_url, init) => pendingUntilAbort(init));
    const controller = new AbortController();

    const p = catchError(listOpenAIModels(ENDPOINT, controller.signal));
    controller.abort();
    const err = await p;

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("network");
    expect((err as ProviderError).message).toBe("モデル一覧取得が中断されました");
  });

  it("不正なレスポンス形式(data 配列なし)→ ProviderError(parse)", async () => {
    mockNativeFetch.mockResolvedValue(jsonResponse({ unexpected: "shape" }));
    await expect(listOpenAIModels(ENDPOINT)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "parse",
    });
  });

  it("data 内の id が string 以外のアイテムを除外", async () => {
    mockNativeFetch.mockResolvedValue(
      jsonResponse({
        data: [
          { id: "gpt-4o" },
          { id: 123 }, // not a string — filtered
          { id: null }, // not a string — filtered
          { object: "model" }, // no id — filtered
          { id: "gpt-3.5-turbo" },
        ],
      }),
    );
    const models = await listOpenAIModels(ENDPOINT);
    expect(models).toEqual([{ id: "gpt-4o" }, { id: "gpt-3.5-turbo" }]);
  });

  it("JSON パース失敗 → ProviderError(parse)", async () => {
    mockNativeFetch.mockResolvedValue(
      new Response("{not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(listOpenAIModels(ENDPOINT)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "parse",
    });
  });
});
