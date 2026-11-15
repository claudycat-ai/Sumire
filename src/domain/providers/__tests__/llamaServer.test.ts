/**
 * LlamaServerAdapter のテスト(`llama-server-provider` spec task 3.3)。
 *
 * - countTokens は `/tokenize`(接続先の `/v1` を除いた先)に本文を送り、`tokens` の長さを返す。
 *   HTTP の失敗・形の違う応答では、OpenAI 互換アダプタと同じ文字数からの推定に落ちる。
 * - 生成は OpenAI 互換アダプタのものをそのまま使う。同じ入力で送信本文が一致すること、
 *   `finish_reason: "length"` の最後のチャンクを上限到達として返すことを確かめる。
 * - プロバイダの生成口(`getProvider`)が `llama-server` でこのアダプタを返す。
 *
 * Boundary: providers/llamaServer.ts と registry.ts。HTTP は nativeFetch のモックで遮断する。
 *
 * Requirements: 7.4, 7.5, 8.1, 8.2, 8.6, 8.7, 8.8
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/domain/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/http")>();
  return { ...actual, nativeFetch: vi.fn() };
});

import { nativeFetch } from "@/domain/http";
import type { NativeFetchInit } from "@/domain/http";
import { LlamaServerAdapter } from "@/domain/providers/llamaServer";
import { OpenAICompatibleAdapter } from "@/domain/providers/openaiCompatible";
import {
  resolvePromptTemplate,
  type ParsedPromptTemplate,
} from "@/domain/providers/promptTemplate";
import { getProvider } from "@/domain/providers/registry";
import {
  ProviderError,
  type AIConfig,
  type AIProvider,
  type GenerationChunk,
  type GenerationRequest,
} from "@/domain/providers/types";

const mockNativeFetch = nativeFetch as unknown as ReturnType<
  typeof vi.fn<(url: string, init?: NativeFetchInit) => Promise<Response>>
>;

const baseConfig: AIConfig = {
  provider: "llama-server",
  endpoint: "http://127.0.0.1:18099/v1",
  model: "gemma-4-31B-it-Q5_K_M.gguf",
  parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
  systemPrompt: null,
  timeoutMs: 60000,
  settingsTokenBudget: 500,
  contextWindow: 16384,
};

const baseRequest: GenerationRequest = {
  systemPrompt: "あなたは小説家です。",
  contextSections: [
    { label: "キャラ", category: "characters", content: "すみれ: 主人公。" },
    { label: "世界", category: "world", content: "舞台は海辺の町。" },
  ],
  body: "吾輩は猫である。",
  parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200, extras: { top_k: 40 } },
};

const encoder = new TextEncoder();

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
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

async function collect(stream: AsyncIterable<GenerationChunk>): Promise<GenerationChunk[]> {
  const chunks: GenerationChunk[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

function parsedTemplate(raw: unknown): ParsedPromptTemplate {
  const r = resolvePromptTemplate(raw);
  if (r.kind !== "ok") throw new Error(`template did not resolve: ${JSON.stringify(r)}`);
  return r.template;
}

/** 生成を 1 回走らせて、送信先と送信内容を返す。 */
async function sentStreamCall(
  adapter: AIProvider,
  request: GenerationRequest,
): Promise<{ url: string; init: NativeFetchInit }> {
  mockNativeFetch.mockReset();
  mockNativeFetch.mockResolvedValueOnce(
    sseResponse(
      sseData({ choices: [{ text: "続き", finish_reason: "stop" }] }) + "data: [DONE]\n\n",
    ),
  );
  await collect(adapter.generateStream(request, new AbortController().signal));
  expect(mockNativeFetch).toHaveBeenCalledTimes(1);
  const [url, init] = mockNativeFetch.mock.calls[0]!;
  return { url, init: init! };
}

beforeEach(() => {
  mockNativeFetch.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("global fetch must not be used"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LlamaServerAdapter.countTokens", () => {
  it("接続先の /v1 を除いた先の /tokenize に本文を送り、tokens の長さを返す", async () => {
    mockNativeFetch.mockResolvedValueOnce(jsonResponse({ tokens: [105, 4368, 107] }));

    const adapter = new LlamaServerAdapter(baseConfig);
    const n = await adapter.countTokens("<|turn>model\n");

    expect(n).toBe(3);
    expect(mockNativeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockNativeFetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:18099/tokenize");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ content: "<|turn>model\n" });
  });

  it("接続先の末尾にスラッシュがあっても、同じ /tokenize に送る", async () => {
    mockNativeFetch.mockResolvedValueOnce(jsonResponse({ tokens: [1, 2] }));

    const adapter = new LlamaServerAdapter({
      ...baseConfig,
      endpoint: "http://127.0.0.1:18099/v1/",
    });
    await expect(adapter.countTokens("本文")).resolves.toBe(2);
    expect(mockNativeFetch.mock.calls[0]![0]).toBe("http://127.0.0.1:18099/tokenize");
  });

  it("接続先が /v1 で終わらないときは、そのまま /tokenize を足す", async () => {
    mockNativeFetch.mockResolvedValueOnce(jsonResponse({ tokens: [1] }));

    const adapter = new LlamaServerAdapter({
      ...baseConfig,
      endpoint: "http://127.0.0.1:18099",
    });
    await expect(adapter.countTokens("本文")).resolves.toBe(1);
    expect(mockNativeFetch.mock.calls[0]![0]).toBe("http://127.0.0.1:18099/tokenize");
  });

  it("空の tokens は 0 を返す(推定に落とさない)", async () => {
    mockNativeFetch.mockResolvedValueOnce(jsonResponse({ tokens: [] }));

    const adapter = new LlamaServerAdapter(baseConfig);
    await expect(adapter.countTokens("")).resolves.toBe(0);
  });

  it("HTTP の失敗では、文字数からの推定(× 1.5)に落ちる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockNativeFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, { status: 500 }));

    const adapter = new LlamaServerAdapter(baseConfig);
    // 8 文字 × 1.5 = 12
    await expect(adapter.countTokens("吾輩は猫である。")).resolves.toBe(12);
  });

  it("接続できないときも、推定に落ちる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockNativeFetch.mockRejectedValueOnce(new TypeError("connection refused"));

    const adapter = new LlamaServerAdapter(baseConfig);
    await expect(adapter.countTokens("吾輩は猫である。")).resolves.toBe(12);
  });

  it.each([
    ["tokens が無い", { length: 3 }],
    ["tokens が数値", { tokens: 3 }],
    ["tokens が null", { tokens: null }],
    ["応答が配列", [1, 2, 3]],
    ["応答が null", null],
  ])("形の違う応答(%s)では、推定に落ちる", async (_name, body) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockNativeFetch.mockResolvedValueOnce(jsonResponse(body));

    const adapter = new LlamaServerAdapter(baseConfig);
    await expect(adapter.countTokens("吾輩は猫である。")).resolves.toBe(12);
  });

  it("推定は OpenAI 互換アダプタと同じ値になる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockNativeFetch.mockResolvedValue(jsonResponse({}, { status: 404 }));
    const text = "𠮷野家で牛丼を食べた。";

    const llama = await new LlamaServerAdapter(baseConfig).countTokens(text);
    const compat = await new OpenAICompatibleAdapter({
      ...baseConfig,
      provider: "openai-compatible",
    }).countTokens(text);

    expect(llama).toBe(compat);
  });
});

describe("LlamaServerAdapter の生成(OpenAI 互換アダプタと同じ)", () => {
  it.each([
    ["テンプレートなし", baseRequest],
    [
      "テンプレートあり",
      { ...baseRequest, promptTemplate: parsedTemplate({ preset: "gemma4-think" }) },
    ],
  ])("%s: ストリーミングの送信本文が OpenAI 互換アダプタと一致する", async (_name, request) => {
    const compat = await sentStreamCall(
      new OpenAICompatibleAdapter({ ...baseConfig, provider: "openai-compatible" }),
      request,
    );
    const llama = await sentStreamCall(new LlamaServerAdapter(baseConfig), request);

    expect(llama.url).toBe("http://127.0.0.1:18099/v1/completions");
    expect(llama.url).toBe(compat.url);
    expect(llama.init.method).toBe(compat.init.method);
    expect(llama.init.headers).toEqual(compat.init.headers);
    // 文字列のまま比べる(キーの順序も含めて、何も足していないことを確かめる)。
    expect(llama.init.body).toBe(compat.init.body);
    expect(JSON.parse(llama.init.body as string).stream).toBe(true);
  });

  it("finish_reason が length の最後のチャンク(text は空)を、上限到達として返す", async () => {
    mockNativeFetch.mockResolvedValueOnce(
      sseResponse(
        sseData({ choices: [{ text: "吾輩は", finish_reason: null }] }) +
          sseData({ choices: [{ text: "猫", finish_reason: null }] }) +
          sseData({
            choices: [{ text: "", finish_reason: "length" }],
            usage: { completion_tokens: 2 },
            timings: { predicted_per_second: 57 },
          }) +
          "data: [DONE]\n\n",
      ),
    );

    const adapter = new LlamaServerAdapter(baseConfig);
    const chunks = await collect(
      adapter.generateStream(baseRequest, new AbortController().signal),
    );

    expect(chunks).toEqual([
      { textDelta: "吾輩は", finishReason: undefined },
      { textDelta: "猫", finishReason: undefined },
      { textDelta: "", finishReason: "length" },
    ]);
  });

  it("generate も上限到達を返す", async () => {
    mockNativeFetch.mockResolvedValueOnce(
      sseResponse(
        sseData({ choices: [{ text: "吾輩は猫", finish_reason: null }] }) +
          sseData({ choices: [{ text: "", finish_reason: "length" }] }) +
          "data: [DONE]\n\n",
      ),
    );

    const adapter = new LlamaServerAdapter(baseConfig);
    await expect(adapter.generate(baseRequest)).resolves.toEqual({
      text: "吾輩は猫",
      finishReason: "length",
    });
  });
});

describe("getProvider(llama-server)", () => {
  it("llama-server の設定で LlamaServerAdapter を返す", () => {
    const provider = getProvider({ ...baseConfig });
    expect(provider).toBeInstanceOf(LlamaServerAdapter);
  });

  it("openai-compatible の設定では LlamaServerAdapter を返さない", () => {
    const provider = getProvider({ ...baseConfig, provider: "openai-compatible" });
    expect(provider).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(provider).not.toBeInstanceOf(LlamaServerAdapter);
  });

  it("接続先が空の llama-server の設定は、設定不備のエラーになる", () => {
    expect(() => getProvider({ ...baseConfig, endpoint: "" })).toThrowError(ProviderError);
  });

  it("未知のプロバイダのエラーは、対応一覧に llama-server を含む", () => {
    const unknown = { ...baseConfig, provider: "nope" } as unknown as AIConfig;
    expect(() => getProvider(unknown)).toThrowError(/llama-server/);
  });
});
