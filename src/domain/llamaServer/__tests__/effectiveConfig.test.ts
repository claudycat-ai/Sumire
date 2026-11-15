import { describe, expect, it } from "vitest";
import type { AIConfig } from "@/domain/providers/types";
import { buildEffectiveConfig } from "../effectiveConfig";
import type { LlamaServerStatus } from "../types";

type ReadyStatus = Extract<LlamaServerStatus, { state: "ready" }>;

function readyStatus(overrides: Partial<ReadyStatus> = {}): ReadyStatus {
  return {
    state: "ready",
    runId: 3,
    modelPath: "D:\\models\\gemma-4-31B-it-Q5_K_M.gguf",
    contextSize: 16384,
    port: 51234,
    ...overrides,
  };
}

/** `sumire.json` の `providers["llama-server"]` に当たるセクション。 */
function section(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    provider: "llama-server",
    endpoint: "",
    model: "",
    parameters: {
      temperature: 0.7,
      topP: 0.95,
      maxTokens: 300,
      extras: { top_k: 40 },
    },
    systemPrompt: null,
    timeoutMs: 120000,
    settingsTokenBudget: 800,
    thinking: { enabled: true, tags: [{ open: "<think>", close: "</think>" }] },
    template: { preset: "gemma4-think" },
    illustration: { template: { preset: "gemma4-think" }, maxTokens: 400 },
    ...overrides,
  };
}

describe("buildEffectiveConfig: 接続先", () => {
  it("endpoint は準備完了の状態のポートから決まる", () => {
    const result = buildEffectiveConfig(section(), readyStatus({ port: 51234 }), null);
    expect(result.endpoint).toBe("http://127.0.0.1:51234/v1");
  });

  it("セクションに endpoint が書かれていても使わない", () => {
    const result = buildEffectiveConfig(
      section({ endpoint: "http://192.168.0.10:5000/v1" }),
      readyStatus({ port: 40001 }),
      null,
    );
    expect(result.endpoint).toBe("http://127.0.0.1:40001/v1");
  });
});

describe("buildEffectiveConfig: モデル名", () => {
  it("Windows の区切り(\\)のパスからファイル名を取る", () => {
    const result = buildEffectiveConfig(
      section(),
      readyStatus({ modelPath: "D:\\models\\gemma-4-31B-it-Q5_K_M.gguf" }),
      null,
    );
    expect(result.model).toBe("gemma-4-31B-it-Q5_K_M.gguf");
  });

  it("/ 区切りのパスからファイル名を取る", () => {
    const result = buildEffectiveConfig(
      section(),
      readyStatus({ modelPath: "/home/user/models/model-Q3_K_M.gguf" }),
      null,
    );
    expect(result.model).toBe("model-Q3_K_M.gguf");
  });

  it("区切りが混ざったパスでも最後の要素を取る", () => {
    const result = buildEffectiveConfig(
      section(),
      readyStatus({ modelPath: "D:/models\\sub/model.gguf" }),
      null,
    );
    expect(result.model).toBe("model.gguf");
  });

  it("区切りの無いパスはそのままモデル名になる", () => {
    const result = buildEffectiveConfig(section(), readyStatus({ modelPath: "model.gguf" }), null);
    expect(result.model).toBe("model.gguf");
  });

  it("セクションに model が書かれていても使わない", () => {
    const result = buildEffectiveConfig(
      section({ model: "japanese-stablelm-instruct-alpha-7b-v2" }),
      readyStatus({ modelPath: "D:\\models\\a.gguf" }),
      null,
    );
    expect(result.model).toBe("a.gguf");
  });
});

describe("buildEffectiveConfig: コンテキスト長", () => {
  it("実際の長さが分からないときは、指定した長さを使う", () => {
    const result = buildEffectiveConfig(section(), readyStatus({ contextSize: 16384 }), null);
    expect(result.contextWindow).toBe(16384);
  });

  it("実際の長さがあれば、指定した長さよりそちらを使う", () => {
    const result = buildEffectiveConfig(section(), readyStatus({ contextSize: 16384 }), 8192);
    expect(result.contextWindow).toBe(8192);
  });

  it("セクションに contextWindow が書かれていても使わない", () => {
    const withWindow = section({ contextWindow: 2048 });
    expect(buildEffectiveConfig(withWindow, readyStatus({ contextSize: 16384 }), null).contextWindow).toBe(
      16384,
    );
    expect(buildEffectiveConfig(withWindow, readyStatus({ contextSize: 16384 }), 8192).contextWindow).toBe(
      8192,
    );
  });

  it("別のモデルの状態で組み立て直すと、そのモデルの長さになる", () => {
    const base = section();
    const first = buildEffectiveConfig(
      base,
      readyStatus({ runId: 1, modelPath: "D:\\models\\a.gguf", contextSize: 8192 }),
      null,
    );
    const second = buildEffectiveConfig(
      base,
      readyStatus({ runId: 2, modelPath: "D:\\models\\b.gguf", contextSize: 32768, port: 40002 }),
      null,
    );
    expect(first.contextWindow).toBe(8192);
    expect(second.contextWindow).toBe(32768);
    expect(second.model).toBe("b.gguf");
    expect(second.endpoint).toBe("http://127.0.0.1:40002/v1");
  });
});

describe("buildEffectiveConfig: ほかの項目", () => {
  it("生成パラメータ・テンプレート・思考の分離・挿し絵の設定などは、セクションと同じ値で残る", () => {
    const base = section();
    const result = buildEffectiveConfig(base, readyStatus(), 8192);

    expect(result.provider).toBe("llama-server");
    expect(result.parameters).toEqual(base.parameters);
    expect(result.systemPrompt).toBe(base.systemPrompt);
    expect(result.timeoutMs).toBe(base.timeoutMs);
    expect(result.settingsTokenBudget).toBe(base.settingsTokenBudget);
    expect(result.thinking).toEqual(base.thinking);
    expect(result.template).toEqual(base.template);
    expect(result.illustration).toEqual(base.illustration);
  });

  it("3 つの項目を除けば、セクションと同じ内容になる", () => {
    const base = section({ contextWindow: 2048 });
    const result = buildEffectiveConfig(base, readyStatus(), null);

    const strip = (config: AIConfig) => {
      const { endpoint: _e, model: _m, contextWindow: _c, ...rest } = config;
      return rest;
    };
    expect(strip(result)).toEqual(strip(base));
  });

  it("セクションに無い任意の項目を、勝手に足さない", () => {
    const base: AIConfig = {
      provider: "llama-server",
      endpoint: "",
      model: "",
      parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
      systemPrompt: null,
    };
    const result = buildEffectiveConfig(base, readyStatus(), null);
    expect(Object.keys(result).sort()).toEqual(
      ["contextWindow", "endpoint", "model", "parameters", "provider", "systemPrompt"].sort(),
    );
  });

  it("新しいオブジェクトを返し、セクションを書き換えない", () => {
    const base = section({ contextWindow: 2048 });
    const snapshot = structuredClone(base);
    const result = buildEffectiveConfig(base, readyStatus(), 8192);

    expect(result).not.toBe(base);
    expect(base).toEqual(snapshot);
  });
});
