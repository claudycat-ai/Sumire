import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AIConfig,
  AIProvider,
  ParsedPromptTemplate,
} from "@/domain/providers";
import {
  DEFAULT_AI_CONFIG,
  resolvePromptTemplate,
  templateLiteralText,
} from "@/domain/providers";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import {
  buildContext,
  buildGenerationRequest,
  clearContextBuilderCache,
} from "../contextBuilder";

// トークン数の計測は、プロバイダの取得を差し替えて「文字数 = トークン数」に固定する。
const mocks = vi.hoisted(() => ({
  countTokens: vi.fn<(text: string) => Promise<number>>(),
  getProvider: vi.fn<(config: AIConfig) => AIProvider>(),
}));

vi.mock("@/domain/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/providers")>();
  return { ...actual, getProvider: mocks.getProvider };
});

function charCount(text: string): number {
  return Array.from(text).length;
}

function fakeProvider(): AIProvider {
  return {
    generateStream: () => {
      throw new Error("generateStream は使わない");
    },
    generate: () => Promise.reject(new Error("generate は使わない")),
    countTokens: mocks.countTokens,
  };
}

const WINDOW = 100;
const SETTINGS_BUDGET = 30;
const MAX_TOKENS = 20;

const aiConfig: AIConfig = {
  ...DEFAULT_AI_CONFIG,
  contextWindow: WINDOW,
  settingsTokenBudget: SETTINGS_BUDGET,
  parameters: { ...DEFAULT_AI_CONFIG.parameters, maxTokens: MAX_TOKENS },
};

/** システムプロンプト。 */
const SYSTEM_PROMPT = "続きを書いてください";
/** 設定ファイルの本文。 */
const SETTING_BODY = "主人公は旅の画家である";
/** 100 文字の本文(先頭から削られたかを見分けるため、位置ごとに違う文字にする)。 */
const BODY = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x3042 + (i % 80))).join("");

function parse(raw: unknown): ParsedPromptTemplate {
  const resolved = resolvePromptTemplate(raw);
  if (resolved.kind !== "ok") {
    throw new Error(`テンプレートを解決できない: ${JSON.stringify(resolved)}`);
  }
  return resolved.template;
}

/** 本文の末尾 n 文字。 */
function tail(n: number): string {
  const chars = Array.from(BODY);
  return n <= 0 ? "" : chars.slice(chars.length - n).join("");
}

beforeEach(() => {
  clearContextBuilderCache();
  mocks.countTokens.mockReset();
  mocks.countTokens.mockImplementation(async (text) => charCount(text));
  mocks.getProvider.mockReset();
  mocks.getProvider.mockImplementation(() => fakeProvider());
  useSettingsContextStore.getState().clear();
  useSettingsContextStore.getState().upsertFile({
    relativePath: "characters/hero.md",
    category: "characters",
    title: "主人公",
    body: SETTING_BODY,
  });
});

describe("buildContext: テンプレートなし(回帰)", () => {
  it("本文枠は 窓 - システム - 設定 - 生成余地 のままで、本文は先頭から削られ、template は 0 (prompt-template 5.1)", async () => {
    const systemTokens = charCount(SYSTEM_PROMPT);
    const settingTokens = charCount(SETTING_BODY);
    const bodyBudget = WINDOW - systemTokens - settingTokens - MAX_TOKENS;

    const built = await buildContext({
      body: BODY,
      systemPrompt: SYSTEM_PROMPT,
      aiConfig,
      maxTokens: MAX_TOKENS,
    });

    expect(built.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(built.contextSections).toHaveLength(1);
    expect(built.contextSections[0].content).toBe(SETTING_BODY);
    expect(built.body).toBe(tail(bodyBudget));
    expect(built.usedTokens).toEqual({
      system: systemTokens,
      sections: settingTokens,
      body: bodyBudget,
      reserved: MAX_TOKENS,
      window: WINDOW,
      template: 0,
    });
  });

  it("buildGenerationRequest の第 4 引数を省いても同じ結果になる (prompt-template 5.1)", async () => {
    const viaBuild = await buildContext({
      body: BODY,
      systemPrompt: SYSTEM_PROMPT,
      aiConfig,
      maxTokens: MAX_TOKENS,
    });
    clearContextBuilderCache();
    const viaRequest = await buildGenerationRequest(aiConfig, SYSTEM_PROMPT, BODY);

    expect(viaRequest).toEqual({
      systemPrompt: viaBuild.systemPrompt,
      contextSections: viaBuild.contextSections,
      body: viaBuild.body,
      usedTokens: viaBuild.usedTokens,
    });
  });
});

describe("buildContext: テンプレートあり", () => {
  const fullTemplate = parse({
    custom: "<s>{{system}}</s>\n<u>{{settings}}</u>\n<m>{{body}}",
  });

  it("本文枠がテンプレートの文字列の分だけ小さくなり、本文は先頭から削られる (prompt-template 5.1, 5.2)", async () => {
    const literal = templateLiteralText(fullTemplate);
    const templateTokens = charCount(literal);
    const systemTokens = charCount(SYSTEM_PROMPT);
    const settingTokens = charCount(SETTING_BODY);
    const bodyBudget =
      WINDOW - systemTokens - settingTokens - templateTokens - MAX_TOKENS;

    const built = await buildGenerationRequest(
      aiConfig,
      SYSTEM_PROMPT,
      BODY,
      fullTemplate,
    );

    expect(templateTokens).toBeGreaterThan(0);
    expect(built.body).toBe(tail(bodyBudget));
    expect(built.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(built.contextSections.map((s) => s.content)).toEqual([SETTING_BODY]);
    expect(built.usedTokens).toEqual({
      system: systemTokens,
      sections: settingTokens,
      body: bodyBudget,
      reserved: MAX_TOKENS,
      window: WINDOW,
      template: templateTokens,
    });
  });

  it("テンプレートの文字列は削らない。窓を超えるほど長くても全部数え、本文枠は 0 になる (prompt-template 5.3)", async () => {
    const longLiteral = "前置き".repeat(40); // 120 文字 > 窓
    const template = parse({ custom: `${longLiteral}{{body}}` });

    const built = await buildContext({
      body: BODY,
      systemPrompt: SYSTEM_PROMPT,
      aiConfig,
      maxTokens: MAX_TOKENS,
      promptTemplate: template,
    });

    expect(built.usedTokens.template).toBe(charCount(longLiteral));
    expect(built.body).toBe("");
    expect(built.usedTokens.body).toBe(0);
  });

  it("テンプレートの文字列の計測は同じ文字列ならキャッシュを使う (prompt-template 5.1)", async () => {
    const literal = templateLiteralText(fullTemplate);

    await buildGenerationRequest(aiConfig, SYSTEM_PROMPT, BODY, fullTemplate);
    await buildGenerationRequest(aiConfig, SYSTEM_PROMPT, BODY, fullTemplate);

    const literalCalls = mocks.countTokens.mock.calls.filter(
      ([text]) => text === literal,
    );
    expect(literalCalls).toHaveLength(1);
  });
});

describe("buildContext: 差し込み口を省いたテンプレート", () => {
  it("{{system}} と {{settings}} が無ければ、システムプロンプトを数えず設定を詰めない (prompt-template 3.3)", async () => {
    const template = parse({ custom: "<m>{{body}}" });
    const templateTokens = charCount(templateLiteralText(template));
    const bodyBudget = WINDOW - templateTokens - MAX_TOKENS;

    const built = await buildGenerationRequest(
      aiConfig,
      SYSTEM_PROMPT,
      BODY,
      template,
    );

    expect(built.contextSections).toEqual([]);
    expect(built.body).toBe(tail(bodyBudget));
    expect(built.usedTokens).toEqual({
      system: 0,
      sections: 0,
      body: bodyBudget,
      reserved: MAX_TOKENS,
      window: WINDOW,
      template: templateTokens,
    });
    expect(mocks.countTokens).not.toHaveBeenCalledWith(SYSTEM_PROMPT);
    expect(mocks.countTokens).not.toHaveBeenCalledWith(SETTING_BODY);
  });

  it("{{settings}} だけ省けば、システムプロンプトは数えて設定は詰めない (prompt-template 3.3)", async () => {
    const template = parse({ custom: "<s>{{system}}</s><m>{{body}}" });
    const systemTokens = charCount(SYSTEM_PROMPT);
    const templateTokens = charCount(templateLiteralText(template));
    const bodyBudget = WINDOW - systemTokens - templateTokens - MAX_TOKENS;

    const built = await buildContext({
      body: BODY,
      systemPrompt: SYSTEM_PROMPT,
      aiConfig,
      maxTokens: MAX_TOKENS,
      promptTemplate: template,
    });

    expect(built.contextSections).toEqual([]);
    expect(built.usedTokens.system).toBe(systemTokens);
    expect(built.usedTokens.sections).toBe(0);
    expect(built.body).toBe(tail(bodyBudget));
  });
});
