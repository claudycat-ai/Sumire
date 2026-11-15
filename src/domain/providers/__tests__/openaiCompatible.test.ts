/**
 * OpenAICompatibleAdapter のテスト。
 *
 * - countTokens の回帰テスト。
 *   背景: text-generation-webui の `/v1/internal/token-count` が返すレスポンスは
 *   { length: number } の形式(`tokens` キーは存在しない)。
 *   旧実装は `data.tokens` を見ていたため、常に number 判定 false → estimate
 *   fallback (1 文字 × 1.5) に落ちて、ContextBuilder の bodyBudget 計算が崩れ、
 *   本文を実トークン換算で 1/3 程度にしか詰められない事象があった。
 *   「正しい length フィールドからトークン数を取り出す」契約と、失敗時に推定値へ
 *   落ちる契約(provider-http-rust Req 5.5)を固定する。
 * - generateStream の通信経路(`provider-http-rust` spec task 3.1)。
 *   HTTP は `@/domain/http` の nativeFetch(Rust 側に送らせる入口)を通ること、
 *   SSE の逐次反映・ステータス分類・タイムアウト・静かな停止・開始時エラーの
 *   config 変換が移行前と同じであることを確かめる。
 *
 * Boundary: providers/openaiCompatible.ts のみ対象。HTTP は nativeFetch のモックで遮断
 * する(モックは Web 標準の Response を返し、signal の abort を nativeFetch と同じく
 * AbortError で伝える)。グローバル fetch は使われたら失敗するスタブにしておく。
 *
 * Requirements: 1.1, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 5.1, 5.2, 5.4, 5.5
 *
 * - テンプレートで包んだプロンプトの送信(`prompt-template` spec task 2.1)。
 *   解決済みのテンプレートがあれば差し込み口に内容を入れた `prompt` を送り、
 *   無ければ今の素の連結のまま送ること、送信本文にテンプレートのキーを含めないことを確かめる。
 *   Requirements(prompt-template): 1.1, 1.3, 1.4, 4.5
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/domain/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/http")>();
  return { ...actual, nativeFetch: vi.fn() };
});

import { nativeFetch, NativeHttpError } from "@/domain/http";
import type { NativeFetchInit } from "@/domain/http";
import { OpenAICompatibleAdapter } from "@/domain/providers/openaiCompatible";
import {
  resolvePromptTemplate,
  type ParsedPromptTemplate,
} from "@/domain/providers/promptTemplate";
import {
  ProviderError,
  type AIConfig,
  type GenerationChunk,
  type GenerationRequest,
} from "@/domain/providers/types";

const mockNativeFetch = nativeFetch as unknown as ReturnType<
  typeof vi.fn<(url: string, init?: NativeFetchInit) => Promise<Response>>
>;

const baseConfig: AIConfig = {
  provider: "openai-compatible",
  endpoint: "http://127.0.0.1:5000/v1",
  model: "japanese-stablelm-instruct-alpha-7b-v2",
  parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
  systemPrompt: null,
  timeoutMs: 60000,
  settingsTokenBudget: 500,
  contextWindow: 2048,
};

const baseRequest: GenerationRequest = {
  systemPrompt: "",
  contextSections: [],
  body: "吾輩は猫である。",
  parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
};

const encoder = new TextEncoder();

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
    close: () => controller.close(),
    error: (e: unknown) => controller.error(e),
  };
}

function sseResponse(text: string): Response {
  return new Response(encoder.encode(text), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
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
  vi.restoreAllMocks();
});

describe("OpenAICompatibleAdapter.countTokens", () => {
  it("/v1/internal/token-count の length フィールドから整数のトークン数を返す", async () => {
    // text-generation-webui の実レスポンス形式: { length: N }
    mockNativeFetch.mockResolvedValue(jsonResponse({ length: 42 }));

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const n = await adapter.countTokens("吾輩は猫である。");

    expect(n).toBe(42);
    expect(mockNativeFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mockNativeFetch.mock.calls[0]!;
    expect(calledUrl).toBe("http://127.0.0.1:5000/v1/internal/token-count");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body ?? "")).toEqual({ text: "吾輩は猫である。" });
    // ローカル推論サーバーにはキーを付けない
    expect(init?.authProvider).toBeUndefined();
  });

  it("length が 0 でも 0 を返す(空文字計測の境界ケース)", async () => {
    mockNativeFetch.mockResolvedValue(jsonResponse({ length: 0 }));

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const n = await adapter.countTokens("");

    expect(n).toBe(0);
  });

  it("API が 404 などで失敗した場合は estimate fallback (文字数 * 1.5) に落ちる", async () => {
    mockNativeFetch.mockResolvedValue(new Response("not found", { status: 404 }));

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    // 「あいうえお」は 5 文字 → ceil(5 * 1.5) = 8
    const n = await adapter.countTokens("あいうえお");

    expect(n).toBe(8);
  });

  it("接続できない(network)場合も推定値に落ち、例外を出さない(5.5)", async () => {
    mockNativeFetch.mockRejectedValue(new NativeHttpError("network", "connection refused"));

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    await expect(adapter.countTokens("あいうえお")).resolves.toBe(8);
  });

  it("開始時エラー(invalidUrl)でも推定値に落ち、例外を出さない(5.5)", async () => {
    mockNativeFetch.mockRejectedValue(new NativeHttpError("invalidUrl", "unsupported scheme"));

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    await expect(adapter.countTokens("あいうえお")).resolves.toBe(8);
  });
});

describe("OpenAICompatibleAdapter.generateStream", () => {
  it("nativeFetch で /completions に SSE を要求し、受信したチャンクを順に返す(1.1, 3.1, 3.2)", async () => {
    mockNativeFetch.mockResolvedValue(
      sseResponse(
        sseData({ choices: [{ text: "吾輩は", finish_reason: null }] }) +
          // CRLF 区切りのサーバーも受け付ける
          `data: ${JSON.stringify({ choices: [{ text: "猫で", finish_reason: null }] })}\r\n\r\n` +
          sseData({ choices: [{ text: "ある。", finish_reason: "length" }] }) +
          "data: [DONE]\n\n" +
          sseData({ choices: [{ text: "DONE の後は読まない" }] }),
      ),
    );

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const chunks = await collect(
      adapter.generateStream(baseRequest, new AbortController().signal),
    );

    expect(chunks).toEqual([
      { textDelta: "吾輩は", finishReason: undefined },
      { textDelta: "猫で", finishReason: undefined },
      { textDelta: "ある。", finishReason: "length" },
    ]);
    expect(mockNativeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockNativeFetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5000/v1/completions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    expect(init?.authProvider).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init?.body ?? "");
    expect(body).toMatchObject({
      model: baseConfig.model,
      prompt: "吾輩は猫である。",
      stream: true,
      max_tokens: 200,
    });
  });

  it("思考の分離の設定を持つ設定でも、/completions のリクエスト本文に含めない(thinking-output 5.7)", async () => {
    mockNativeFetch.mockResolvedValue(
      sseResponse(
        sseData({ choices: [{ text: "続き", finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      ),
    );
    const config: AIConfig = {
      ...baseConfig,
      thinking: {
        enabled: true,
        tags: [
          { open: "<think>", close: "</think>" },
          { open: "<thinking>", close: "</thinking>" },
        ],
      },
    };

    const adapter = new OpenAICompatibleAdapter(config);
    await collect(
      adapter.generateStream(
        { ...baseRequest, parameters: config.parameters },
        new AbortController().signal,
      ),
    );

    expect(mockNativeFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockNativeFetch.mock.calls[0]!;
    const rawBody = init?.body ?? "";
    expect(JSON.parse(rawBody)).not.toHaveProperty("thinking");
    // 入れ子のどこにもタグの組が紛れ込まない
    expect(rawBody).not.toContain("</think>");
    expect(rawBody).not.toContain("</thinking>");
  });

  it("届いた分をその場で返す(本文の終了を待たない)(3.1)", async () => {
    let sse!: ReturnType<typeof controllableSse>;
    mockNativeFetch.mockImplementation(async (_url, init) => {
      sse = controllableSse(init);
      return sse.response;
    });

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const iter = adapter
      .generateStream(baseRequest, new AbortController().signal)
      [Symbol.asyncIterator]();

    const first = iter.next();
    await vi.waitFor(() => expect(sse).toBeDefined());
    sse.push(sseData({ choices: [{ text: "一つ目", finish_reason: null }] }));
    await expect(first).resolves.toEqual({
      done: false,
      value: { textDelta: "一つ目", finishReason: undefined },
    });

    const second = iter.next();
    sse.push(sseData({ choices: [{ text: "二つ目", finish_reason: "stop" }] }));
    await expect(second).resolves.toEqual({
      done: false,
      value: { textDelta: "二つ目", finishReason: "stop" },
    });

    const third = iter.next();
    sse.push("data: [DONE]\n\n");
    await expect(third).resolves.toEqual({ done: true, value: undefined });
  });

  it("[DONE] を送らずに閉じても、残りのバッファを有効なチャンクとして返す(3.3)", async () => {
    mockNativeFetch.mockResolvedValue(
      sseResponse(
        sseData({ choices: [{ text: "前半" }] }) +
          // 末尾の区切り(\n\n)なしで閉じる
          `data: ${JSON.stringify({ choices: [{ text: "後半", finish_reason: "stop" }] })}`,
      ),
    );

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const chunks = await collect(
      adapter.generateStream(baseRequest, new AbortController().signal),
    );

    expect(chunks.map((c) => c.textDelta)).toEqual(["前半", "後半"]);
    expect(chunks[1]?.finishReason).toBe("stop");
  });

  it("non-2xx は http として、サーバーの詳細を含めて投げる", async () => {
    mockNativeFetch.mockResolvedValue(
      new Response("model not loaded", { status: 500, statusText: "Internal Server Error" }),
    );

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const err = await catchError(
      collect(adapter.generateStream(baseRequest, new AbortController().signal)),
    );

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("http");
    expect((err as ProviderError).message).toBe(
      "HTTP 500 Internal Server Error: model not loaded",
    );
  });

  it("本文の無い 2xx 応答は parse として投げる(5.4)", async () => {
    mockNativeFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const err = await catchError(
      collect(adapter.generateStream(baseRequest, new AbortController().signal)),
    );

    expect((err as ProviderError).kind).toBe("parse");
  });

  it("スキームが http / https 以外(invalidUrl)は config として投げる(2.3)", async () => {
    const cause = new NativeHttpError("invalidUrl", "unsupported scheme: ftp");
    mockNativeFetch.mockRejectedValue(cause);

    const adapter = new OpenAICompatibleAdapter({
      ...baseConfig,
      endpoint: "ftp://127.0.0.1:5000/v1",
    });
    const err = await catchError(
      collect(adapter.generateStream(baseRequest, new AbortController().signal)),
    );

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("config");
    expect((err as ProviderError).message).toBe(
      "エンドポイントの URL が不正です(http / https のみ対応): unsupported scheme: ftp",
    );
    expect((err as ProviderError).cause).toBe(cause);
  });

  it("その他の開始時エラー(invalidHeader)も config として投げる", async () => {
    mockNativeFetch.mockRejectedValue(new NativeHttpError("invalidHeader", "X-Bad"));

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const err = await catchError(
      collect(adapter.generateStream(baseRequest, new AbortController().signal)),
    );

    expect((err as ProviderError).kind).toBe("config");
  });

  it("接続失敗(network)は「推論サーバーに接続できません」の network として投げる(5.2)", async () => {
    const cause = new NativeHttpError("network", "connection refused");
    mockNativeFetch.mockRejectedValue(cause);

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const err = await catchError(
      collect(adapter.generateStream(baseRequest, new AbortController().signal)),
    );

    expect((err as ProviderError).kind).toBe("network");
    expect((err as ProviderError).message).toBe(
      "推論サーバーに接続できません (http://127.0.0.1:5000/v1/completions)",
    );
    expect((err as ProviderError).cause).toBe(cause);
  });

  it("開始時エラーの形でない IPC の reject も network として投げる", async () => {
    mockNativeFetch.mockRejectedValue("command http_request not found");

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const err = await catchError(
      collect(adapter.generateStream(baseRequest, new AbortController().signal)),
    );

    expect((err as ProviderError).kind).toBe("network");
  });

  it("受信中の切断は「ストリーム受信中にエラーが発生しました」の network として投げる(5.2)", async () => {
    let sse!: ReturnType<typeof controllableSse>;
    mockNativeFetch.mockImplementation(async (_url, init) => {
      sse = controllableSse(init);
      return sse.response;
    });

    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const iter = adapter
      .generateStream(baseRequest, new AbortController().signal)
      [Symbol.asyncIterator]();

    const first = iter.next();
    await vi.waitFor(() => expect(sse).toBeDefined());
    sse.push(sseData({ choices: [{ text: "途中まで" }] }));
    await expect(first).resolves.toMatchObject({ value: { textDelta: "途中まで" } });

    const next = iter.next();
    sse.error(new NativeHttpError("network", "connection reset"));
    const err = await catchError(next);
    expect((err as ProviderError).kind).toBe("network");
    expect((err as ProviderError).message).toBe("ストリーム受信中にエラーが発生しました");
  });

  it("応答前に外部 signal で止めると、例外なしで静かに終わる(4.2)", async () => {
    mockNativeFetch.mockImplementation((_url, init) => pendingUntilAbort(init));

    const outer = new AbortController();
    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const done = collect(adapter.generateStream(baseRequest, outer.signal));
    await vi.waitFor(() => expect(mockNativeFetch).toHaveBeenCalledTimes(1));
    outer.abort();

    await expect(done).resolves.toEqual([]);
    // nativeFetch には内部 controller の signal が渡り、外部の停止が伝わっている
    expect(mockNativeFetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("受信中に外部 signal で止めると、反映を止めて静かに終わる(4.1, 4.2)", async () => {
    let sse!: ReturnType<typeof controllableSse>;
    mockNativeFetch.mockImplementation(async (_url, init) => {
      sse = controllableSse(init);
      return sse.response;
    });

    const outer = new AbortController();
    const adapter = new OpenAICompatibleAdapter(baseConfig);
    const iter = adapter.generateStream(baseRequest, outer.signal)[Symbol.asyncIterator]();

    const first = iter.next();
    await vi.waitFor(() => expect(sse).toBeDefined());
    sse.push(sseData({ choices: [{ text: "ここまで" }] }));
    await expect(first).resolves.toMatchObject({ value: { textDelta: "ここまで" } });

    const next = iter.next();
    outer.abort();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });

  it("応答前に内部タイマーが切れると timeout として投げる(5.1)", async () => {
    mockNativeFetch.mockImplementation((_url, init) => pendingUntilAbort(init));

    const adapter = new OpenAICompatibleAdapter({ ...baseConfig, timeoutMs: 20 });
    const err = await catchError(
      collect(adapter.generateStream(baseRequest, new AbortController().signal)),
    );

    expect((err as ProviderError).kind).toBe("timeout");
    expect((err as ProviderError).message).toBe("応答がタイムアウトしました (20ms)");
  });

  it("受信中に内部タイマーが切れても timeout として投げる(5.1)", async () => {
    let sse!: ReturnType<typeof controllableSse>;
    mockNativeFetch.mockImplementation(async (_url, init) => {
      sse = controllableSse(init);
      return sse.response;
    });

    const adapter = new OpenAICompatibleAdapter({ ...baseConfig, timeoutMs: 200 });
    const iter = adapter
      .generateStream(baseRequest, new AbortController().signal)
      [Symbol.asyncIterator]();

    const first = iter.next();
    await vi.waitFor(() => expect(sse).toBeDefined());
    sse.push(sseData({ choices: [{ text: "少しだけ" }] }));
    await expect(first).resolves.toMatchObject({ value: { textDelta: "少しだけ" } });

    // 以降は何も送らず、タイマーに任せる
    const err = await catchError(iter.next());
    expect((err as ProviderError).kind).toBe("timeout");
    expect((err as ProviderError).message).toBe("応答がタイムアウトしました (200ms)");
  });
});

/** テストで使うテンプレートを解決する。解決に失敗したらテストの前提が崩れているので落とす。 */
function parsedTemplate(raw: unknown): ParsedPromptTemplate {
  const r = resolvePromptTemplate(raw);
  if (r.kind !== "ok") throw new Error(`template did not resolve: ${JSON.stringify(r)}`);
  return r.template;
}

/** 生成を 1 回走らせて、送信本文を返す。 */
async function sentBody(
  config: AIConfig,
  request: GenerationRequest,
): Promise<{ raw: string; json: Record<string, unknown> }> {
  mockNativeFetch.mockResolvedValue(
    sseResponse(
      sseData({ choices: [{ text: "続き", finish_reason: "stop" }] }) + "data: [DONE]\n\n",
    ),
  );
  const adapter = new OpenAICompatibleAdapter(config);
  await collect(adapter.generateStream(request, new AbortController().signal));
  expect(mockNativeFetch).toHaveBeenCalledTimes(1);
  const [, init] = mockNativeFetch.mock.calls[0]!;
  const raw = init?.body ?? "";
  return { raw, json: JSON.parse(raw) as Record<string, unknown> };
}

describe("OpenAICompatibleAdapter.generateStream のプロンプトテンプレート", () => {
  // 前後に空白のあるシステムプロンプト、同じカテゴリ 2 件 + 別カテゴリ 1 件の設定、
  // 空のセクション(連結から落ちる)を含むリクエスト。
  const templatedBase: GenerationRequest = {
    systemPrompt: "  あなたは小説の続きを書く。\n",
    contextSections: [
      { label: "キャラ: すみれ", category: "characters", content: "すみれ: 主人公。\n" },
      { label: "キャラ: 空", category: "characters", content: "   " },
      { label: "キャラ: 葵", category: "characters", content: "  葵: 書き手。" },
      { label: "世界観", category: "worldbuilding", content: "舞台は東京。" },
    ],
    body: "吾輩は猫である。",
    parameters: { temperature: 0.7, topP: 0.95, maxTokens: 128, extras: { top_k: 40 } },
  };

  it("gemma4 プリセットで、システムプロンプト(前後の空白を除く)・設定(今の連結規則)・本文を差し込み口に入れた prompt を送る(prompt-template 1.1, 1.3)", async () => {
    const { json } = await sentBody(baseConfig, {
      ...templatedBase,
      promptTemplate: parsedTemplate({ preset: "gemma4" }),
    });

    expect(json.prompt).toBe(
      "<|turn>system\nあなたは小説の続きを書く。<turn|>\n" +
        "<|turn>user\nすみれ: 主人公。\n葵: 書き手。\n\n舞台は東京。<turn|>\n" +
        "<|turn>model\n<|channel>thought\n<channel|>吾輩は猫である。",
    );
  });

  it("自由記述のテンプレートで、差し込み口以外の文字列をそのまま含め、本文の後ろの文字列も送る(prompt-template 1.1)", async () => {
    const { json } = await sentBody(baseConfig, {
      ...templatedBase,
      promptTemplate: parsedTemplate({
        custom: ["[SYS]{{system}}[/SYS]", "[CTX]{{settings}}[/CTX]", "{{body}}<END>"],
      }),
    });

    expect(json.prompt).toBe(
      "[SYS]あなたは小説の続きを書く。[/SYS]\n" +
        "[CTX]すみれ: 主人公。\n葵: 書き手。\n\n舞台は東京。[/CTX]\n" +
        "吾輩は猫である。<END>",
    );
  });

  it("設定が無いときは設定の差し込み口を空にし、省略された差し込み口の内容は含めない(prompt-template 1.1, 1.3)", async () => {
    const { json } = await sentBody(baseConfig, {
      ...templatedBase,
      contextSections: [],
      promptTemplate: parsedTemplate({ custom: "<u>{{settings}}</u>{{body}}" }),
    });

    expect(json.prompt).toBe("<u></u>吾輩は猫である。");
  });

  it("テンプレートありでも、送信本文のほかの項目は変えず、テンプレートのキーを含めない(prompt-template 4.5)", async () => {
    const config: AIConfig = { ...baseConfig, template: { preset: "gemma4" } };
    const { raw, json } = await sentBody(config, {
      ...templatedBase,
      promptTemplate: parsedTemplate({ preset: "gemma4" }),
    });

    expect(Object.keys(json).sort()).toEqual(
      ["max_tokens", "model", "prompt", "stream", "temperature", "top_k", "top_p"].sort(),
    );
    expect(json).toMatchObject({
      model: baseConfig.model,
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 128,
      stream: true,
      top_k: 40,
    });
    expect(json).not.toHaveProperty("template");
    expect(json).not.toHaveProperty("promptTemplate");
    // 解決済みテンプレートの中身(出典や並び)も紛れ込まない
    expect(raw).not.toContain("preset");
    expect(raw).not.toContain("parts");
  });

  it("テンプレートが無ければ、今の素の連結のまま送る(prompt-template 1.4)", async () => {
    const { json } = await sentBody(baseConfig, templatedBase);

    expect(json.prompt).toBe(
      "あなたは小説の続きを書く。\n\n" +
        "すみれ: 主人公。\n葵: 書き手。\n\n舞台は東京。\n\n" +
        "吾輩は猫である。",
    );
  });
});
