import { beforeEach, describe, expect, it, vi } from "vitest";

// `createProject` は Tauri の `invoke("create_project", { parentPath, folderName, metaJson })`
// を呼び、`metaJson` がそのまま Rust 側で `sumire.json` に書き込まれる契約。
// JSON ペイロードの形を assert することで、ファイル出力の契約をテストする。

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { createProject } from "@/domain/project/projectApi";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("createProject sumire.json 出力 (Req 1.1, 4.4)", () => {
  it("両プロバイダの contextWindow が必ず出力される", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/作品A");
    await createProject({
      parentPath: "/test/parent",
      folderName: "作品A",
      title: "作品A",
      author: "著者A",
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("create_project");
    const meta = JSON.parse((args as { metaJson: string }).metaJson);

    // contextWindow は両プロバイダで必須かつ正の数
    expect(meta.aiConfig.providers["openai-compatible"].contextWindow).toBeTypeOf("number");
    expect(meta.aiConfig.providers.openai.contextWindow).toBeTypeOf("number");
    expect(meta.aiConfig.providers["openai-compatible"].contextWindow).toBeGreaterThan(0);
    expect(meta.aiConfig.providers.openai.contextWindow).toBeGreaterThan(0);
  });

  it("aiConfig 新スキーマで書き出される(旧 ai セクションを含まない)", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/x");
    await createProject({
      parentPath: "/test/parent",
      folderName: "x",
      title: "x",
      author: "y",
    });

    const [, args] = mockInvoke.mock.calls[0];
    const meta = JSON.parse((args as { metaJson: string }).metaJson);

    expect(meta.aiConfig).toBeDefined();
    expect(meta.aiConfig.activeProvider).toBe("llama-server");
    expect(meta.aiConfig.providers["openai-compatible"]).toBeDefined();
    expect(meta.aiConfig.providers.openai).toBeDefined();
    // 旧 ai フィールドは新スキーマには出力されない
    expect(meta.ai).toBeUndefined();
  });

  it("具体値: openai-compatible.contextWindow=8192, openai.contextWindow=128000", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/y");
    await createProject({
      parentPath: "/test/parent",
      folderName: "y",
      title: "y",
      author: "z",
    });

    const [, args] = mockInvoke.mock.calls[0];
    const meta = JSON.parse((args as { metaJson: string }).metaJson);

    expect(meta.aiConfig.providers["openai-compatible"].contextWindow).toBe(8192);
    expect(meta.aiConfig.providers.openai.contextWindow).toBe(128000);
  });

  it("schemaVersion / title / author / created を含む", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/z");
    await createProject({
      parentPath: "/test/parent",
      folderName: "z",
      title: "T",
      author: "A",
    });

    const [, args] = mockInvoke.mock.calls[0];
    const meta = JSON.parse((args as { metaJson: string }).metaJson);

    expect(meta.schemaVersion).toBe("1.0");
    expect(meta.title).toBe("T");
    expect(meta.author).toBe("A");
    expect(meta.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("createProject の戻り値の meta も同じ構造を持つ", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/w");
    const result = await createProject({
      parentPath: "/test/parent",
      folderName: "w",
      title: "T",
      author: "A",
    });

    expect(result.projectPath).toBe("/test/parent/w");
    expect(result.meta.aiConfig).toBeDefined();
    expect(
      (result.meta as { aiConfig: { providers: Record<string, { contextWindow: number }> } })
        .aiConfig.providers["openai-compatible"].contextWindow,
    ).toBe(8192);
    expect(
      (result.meta as { aiConfig: { providers: Record<string, { contextWindow: number }> } })
        .aiConfig.providers.openai.contextWindow,
    ).toBe(128000);
  });
});

describe("createProject sumire.json の思考の分離の既定値 (thinking-output Req 5.10)", () => {
  it("両プロバイダのセクションに既定の thinking(有効、<think> / </think> の 1 組)が書かれる", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/t");
    await createProject({
      parentPath: "/test/parent",
      folderName: "t",
      title: "T",
      author: "A",
    });

    const [, args] = mockInvoke.mock.calls[0];
    const meta = JSON.parse((args as { metaJson: string }).metaJson);
    const expected = {
      enabled: true,
      tags: [{ open: "<think>", close: "</think>" }],
    };

    expect(meta.aiConfig.providers["openai-compatible"].thinking).toEqual(expected);
    expect(meta.aiConfig.providers.openai.thinking).toEqual(expected);
    // 推論サーバーへ素通しされる parameters(extras 含む)には入れない
    expect(meta.aiConfig.providers["openai-compatible"].parameters.thinking).toBeUndefined();
    expect(meta.aiConfig.providers.openai.parameters.thinking).toBeUndefined();
  });
});

describe("createProject sumire.json のテンプレートの指定 (prompt-template 4.8)", () => {
  it("両プロバイダのセクションに template が書かれない", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/t");
    await createProject({
      parentPath: "/test/parent",
      folderName: "t",
      title: "T",
      author: "A",
    });

    const [, args] = mockInvoke.mock.calls[0];
    const meta = JSON.parse((args as { metaJson: string }).metaJson);

    expect(meta.aiConfig.providers["openai-compatible"]).not.toHaveProperty("template");
    expect(meta.aiConfig.providers.openai).not.toHaveProperty("template");
  });
});

describe("createProject sumire.json の挿し絵の設定 (illustration-prompt 6.2)", () => {
  it("両プロバイダのセクションに illustration が書かれない", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/t");
    await createProject({
      parentPath: "/test/parent",
      folderName: "t",
      title: "T",
      author: "A",
    });

    const [, args] = mockInvoke.mock.calls[0];
    const meta = JSON.parse((args as { metaJson: string }).metaJson);

    expect(meta.aiConfig.providers["openai-compatible"]).not.toHaveProperty("illustration");
    expect(meta.aiConfig.providers.openai).not.toHaveProperty("illustration");
  });
});

describe("createProject sumire.json の llama-server のセクション (llama-server-provider 2.9)", () => {
  it("3 つのプロバイダのセクションが書かれ、llama-server は接続先・モデル名が空でコンテキスト長を持たない", async () => {
    mockInvoke.mockResolvedValueOnce("/test/parent/t");
    await createProject({
      parentPath: "/test/parent",
      folderName: "t",
      title: "T",
      author: "A",
    });

    const [, args] = mockInvoke.mock.calls[0];
    const meta = JSON.parse((args as { metaJson: string }).metaJson);

    expect(Object.keys(meta.aiConfig.providers).sort()).toEqual([
      "llama-server",
      "openai",
      "openai-compatible",
    ]);
    expect(meta.aiConfig.activeProvider).toBe("llama-server");
    expect(meta.aiConfig.providers["llama-server"]).toEqual({
      provider: "llama-server",
      endpoint: "",
      model: "",
      parameters: { temperature: 0.8, topP: 0.9, maxTokens: 4000 },
      systemPrompt: null,
      timeoutMs: 120000,
      settingsTokenBudget: 2000,
      thinking: {
        enabled: true,
        tags: [{ open: "<think>", close: "</think>" }],
      },
    });
  });
});
