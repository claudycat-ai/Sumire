import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConfig, AIProvider, ParsedPromptTemplate } from "@/domain/providers";
import {
  DEFAULT_AI_CONFIG,
  ILLUSTRATION_TEMPLATE_PRESETS,
  resolvePromptTemplate,
} from "@/domain/providers";
import { clearContextBuilderCache } from "@/domain/context/contextBuilder";
import i18n from "@/i18n";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import type { IllustrationSettings } from "../illustrationConfig";
import {
  ILLUSTRATION_BLOCK_LABELS,
  buildIllustrationContext,
  type IllustrationContextResult,
  type SceneText,
} from "../illustrationContext";

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

function parse(custom: string): ParsedPromptTemplate {
  const resolved = resolvePromptTemplate({ custom }, ILLUSTRATION_TEMPLATE_PRESETS);
  if (resolved.kind !== "ok") {
    throw new Error(`テンプレートを解決できない: ${JSON.stringify(resolved)}`);
  }
  return resolved.template;
}

/** {{system}} の差し込み口があるテンプレート。差し込み口以外の文字列は 3 文字。 */
const TEMPLATE_WITH_SYSTEM = parse("S{{system}}U{{body}}A");
/** {{system}} の差し込み口が無いテンプレート。差し込み口以外の文字列は 2 文字。 */
const TEMPLATE_WITHOUT_SYSTEM = parse("U{{body}}A");

const INSTRUCTION = "絵にしてください";
const MAX_TOKENS = 20;
const SETTINGS_BUDGET = 30;

const L = ILLUSTRATION_BLOCK_LABELS;

function settingsOf(template: ParsedPromptTemplate = TEMPLATE_WITH_SYSTEM): IllustrationSettings {
  return {
    template,
    instruction: INSTRUCTION,
    temperature: 0.7,
    maxTokens: MAX_TOKENS,
    timeoutMs: 180000,
  };
}

function configOf(contextWindow: number): AIConfig {
  return {
    ...DEFAULT_AI_CONFIG,
    contextWindow,
    settingsTokenBudget: SETTINGS_BUDGET,
  };
}

/** 位置ごとに違う文字で n 文字の本文を作る(どちらから削られたかを見分けるため)。 */
function text(n: number, base: number): string {
  return Array.from({ length: n }, (_, i) => String.fromCodePoint(base + (i % 80))).join("");
}

function head(s: string, n: number): string {
  return Array.from(s).slice(0, Math.max(0, n)).join("");
}

function tail(s: string, n: number): string {
  const chars = Array.from(s);
  return n <= 0 ? "" : chars.slice(chars.length - n).join("");
}

function settingLabel(title: string): string {
  return `${i18n.t("category.characters")}: ${title}`;
}

function addSetting(name: string, title: string, body: string): void {
  useSettingsContextStore.getState().upsertFile({
    relativePath: `characters/${name}.md`,
    category: "characters",
    title,
    body,
  });
}

function expectOk(
  result: IllustrationContextResult,
): Extract<IllustrationContextResult, { kind: "ok" }> {
  if (result.kind !== "ok") {
    throw new Error(`ok ではない: ${JSON.stringify(result)}`);
  }
  return result;
}

/** body を見出しごとのブロックに分ける(見出し → 内容)。 */
function blocksOf(body: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of body.split("\n\n")) {
    const newline = block.indexOf("\n");
    blocks.set(block.slice(0, newline), block.slice(newline + 1));
  }
  return blocks;
}

const SCENE = "灯の下で二人が向き合う";
const SETTING_A = "主人公は旅の画家である";
const SETTING_B = "相棒は口の悪い猫だ";
const SETTING_BIG = text(40, 0x4e00);

/** 長い前の本文(200 文字)と後ろの本文(200 文字)。 */
const LONG_BEFORE = text(200, 0x3042);
const LONG_AFTER = text(200, 0x30a2);

/**
 * 予算配分 1 の R0 を、テストの側で数える。
 * 指示文はテンプレートに {{system}} があるときだけ、前後の見出しは本文があるときだけ数える。
 */
function remainder(opts: {
  window: number;
  template: ParsedPromptTemplate;
  settings: string[];
  scene: SceneText;
}): number {
  const literal = opts.template.parts
    .map((p) => (p.kind === "literal" ? p.text : ""))
    .join("");
  const instruction = opts.template.slots.has("system") ? charCount(INSTRUCTION) : 0;
  const settings =
    opts.settings.length > 0
      ? charCount(L.settings) + opts.settings.reduce((n, s) => n + charCount(s), 0)
      : 0;
  const scene = charCount(L.scene) + charCount(opts.scene.scene);
  const headings =
    (opts.scene.before ? charCount(L.before) : 0) + (opts.scene.after ? charCount(L.after) : 0);
  return (
    opts.window - instruction - charCount(literal) - settings - scene - headings - MAX_TOKENS
  );
}

beforeEach(() => {
  clearContextBuilderCache();
  mocks.countTokens.mockReset();
  mocks.countTokens.mockImplementation(async (s) => charCount(s));
  mocks.getProvider.mockReset();
  mocks.getProvider.mockImplementation(() => fakeProvider());
  useSettingsContextStore.getState().clear();
});

describe("ILLUSTRATION_BLOCK_LABELS", () => {
  it("見出しは design.md の文字列 (2.7)", () => {
    expect(ILLUSTRATION_BLOCK_LABELS).toEqual({
      settings: "【設定】",
      before: "【場面より前の本文】",
      scene: "【挿し絵にする場面】",
      after: "【場面より後の本文】",
    });
  });
});

describe("buildIllustrationContext: 見出しと並び (2.1, 2.7)", () => {
  it("設定 → 前 → 場面 → 後 の順に、見出し\\n内容 のブロックを空行でつなぐ", async () => {
    addSetting("a", "画家", SETTING_A);
    addSetting("b", "猫", SETTING_B);

    const result = expectOk(
      await buildIllustrationContext({
        aiConfig: configOf(2048),
        settings: settingsOf(),
        scene: { scene: SCENE, before: "夜が来た。", after: "朝になった。" },
      }),
    );

    expect(result.body).toBe(
      [
        `【設定】\n${SETTING_A}\n${SETTING_B}`,
        "【場面より前の本文】\n夜が来た。",
        `【挿し絵にする場面】\n${SCENE}`,
        "【場面より後の本文】\n朝になった。",
      ].join("\n\n"),
    );
    expect(result.systemPrompt).toBe(INSTRUCTION);
    expect(result.droppedSettings).toEqual([]);
  });

  it("設定が 0 件、前後が空なら、場面のブロックだけを出す", async () => {
    const result = expectOk(
      await buildIllustrationContext({
        aiConfig: configOf(2048),
        settings: settingsOf(),
        scene: { scene: SCENE, before: "", after: "" },
      }),
    );

    expect(result.body).toBe(`【挿し絵にする場面】\n${SCENE}`);
  });

  it("空のブロックは見出しごと出さない(前だけ空、後ろだけ空、空白だけ)", async () => {
    addSetting("a", "画家", SETTING_A);

    const noBefore = expectOk(
      await buildIllustrationContext({
        aiConfig: configOf(2048),
        settings: settingsOf(),
        scene: { scene: SCENE, before: "", after: "朝になった。" },
      }),
    );
    expect(noBefore.body).toBe(
      [`【設定】\n${SETTING_A}`, `【挿し絵にする場面】\n${SCENE}`, "【場面より後の本文】\n朝になった。"].join(
        "\n\n",
      ),
    );

    const noAfter = expectOk(
      await buildIllustrationContext({
        aiConfig: configOf(2048),
        settings: settingsOf(),
        scene: { scene: SCENE, before: "夜が来た。", after: "\n　\n" },
      }),
    );
    expect(noAfter.body).toBe(
      [`【設定】\n${SETTING_A}`, "【場面より前の本文】\n夜が来た。", `【挿し絵にする場面】\n${SCENE}`].join(
        "\n\n",
      ),
    );
  });

  it("削った結果が空になったブロックも出さない", async () => {
    const scene: SceneText = { scene: SCENE, before: LONG_BEFORE, after: LONG_AFTER };
    // R0 がちょうど 0 になる窓: 前後とも何も入らない。
    const window =
      remainder({ window: 0, template: TEMPLATE_WITH_SYSTEM, settings: [], scene }) * -1;

    const result = expectOk(
      await buildIllustrationContext({
        aiConfig: configOf(window),
        settings: settingsOf(),
        scene,
      }),
    );

    expect(result.body).toBe(`【挿し絵にする場面】\n${SCENE}`);
  });
});

describe("buildIllustrationContext: 前後の本文の配分 (2.3, 2.4)", () => {
  it("前後とも長いとき、後ろは R0 の 1/4 まで末尾から、前は残り全部まで先頭から削り、前が後ろより多い", async () => {
    addSetting("a", "画家", SETTING_A);
    const scene: SceneText = { scene: SCENE, before: LONG_BEFORE, after: LONG_AFTER };
    const window = 200;
    const r0 = remainder({ window, template: TEMPLATE_WITH_SYSTEM, settings: [SETTING_A], scene });
    const afterBudget = Math.floor(r0 / 4);

    const result = expectOk(
      await buildIllustrationContext({ aiConfig: configOf(window), settings: settingsOf(), scene }),
    );
    const blocks = blocksOf(result.body);

    // 後ろは場面に近い先頭を残し、遠い末尾から削られる。
    expect(blocks.get(L.after)).toBe(head(LONG_AFTER, afterBudget));
    // 前は場面に近い末尾を残し、遠い先頭から削られる。
    expect(blocks.get(L.before)).toBe(tail(LONG_BEFORE, r0 - afterBudget));
    expect(charCount(blocks.get(L.after)!)).toBeLessThanOrEqual(Math.floor(r0 / 4));
    expect(charCount(blocks.get(L.before)!)).toBeGreaterThan(charCount(blocks.get(L.after)!));
    // 場面は削らない。
    expect(blocks.get(L.scene)).toBe(SCENE);
  });

  it("後ろが短いときは後ろを全部入れ、前は残り全部まで入れる", async () => {
    const after = "朝になった。";
    const scene: SceneText = { scene: SCENE, before: LONG_BEFORE, after };
    const window = 200;
    const r0 = remainder({ window, template: TEMPLATE_WITH_SYSTEM, settings: [], scene });
    expect(charCount(after)).toBeLessThan(Math.floor(r0 / 4));

    const result = expectOk(
      await buildIllustrationContext({ aiConfig: configOf(window), settings: settingsOf(), scene }),
    );
    const blocks = blocksOf(result.body);

    expect(blocks.get(L.after)).toBe(after);
    expect(blocks.get(L.before)).toBe(tail(LONG_BEFORE, r0 - charCount(after)));
  });

  it("前が短くても、後ろは R0 の 1/4 を超えない", async () => {
    const before = "夜が来た。";
    const scene: SceneText = { scene: SCENE, before, after: LONG_AFTER };
    const window = 200;
    const r0 = remainder({ window, template: TEMPLATE_WITH_SYSTEM, settings: [], scene });

    const result = expectOk(
      await buildIllustrationContext({ aiConfig: configOf(window), settings: settingsOf(), scene }),
    );
    const blocks = blocksOf(result.body);

    expect(blocks.get(L.before)).toBe(before);
    expect(blocks.get(L.after)).toBe(head(LONG_AFTER, Math.floor(r0 / 4)));
  });

  it("前後とも収まるときは削らない", async () => {
    const scene: SceneText = { scene: SCENE, before: "夜が来た。", after: "朝になった。" };

    const result = expectOk(
      await buildIllustrationContext({ aiConfig: configOf(2048), settings: settingsOf(), scene }),
    );
    const blocks = blocksOf(result.body);

    expect(blocks.get(L.before)).toBe("夜が来た。");
    expect(blocks.get(L.after)).toBe("朝になった。");
  });
});

describe("buildIllustrationContext: 指示文の数え方", () => {
  it("テンプレートに {{system}} の差し込み口が無ければ、指示文を数えず、その分だけ本文が増える", async () => {
    const scene: SceneText = { scene: SCENE, before: LONG_BEFORE, after: LONG_AFTER };
    const window = 200;
    const r0 = remainder({ window, template: TEMPLATE_WITHOUT_SYSTEM, settings: [], scene });
    const r0WithSystem = remainder({ window, template: TEMPLATE_WITH_SYSTEM, settings: [], scene });
    // 指示文(8)とテンプレートの文字列の差(1)の分だけ多い。
    expect(r0 - r0WithSystem).toBe(charCount(INSTRUCTION) + 1);

    const result = expectOk(
      await buildIllustrationContext({
        aiConfig: configOf(window),
        settings: settingsOf(TEMPLATE_WITHOUT_SYSTEM),
        scene,
      }),
    );
    const blocks = blocksOf(result.body);
    const afterBudget = Math.floor(r0 / 4);

    expect(blocks.get(L.after)).toBe(head(LONG_AFTER, afterBudget));
    expect(blocks.get(L.before)).toBe(tail(LONG_BEFORE, r0 - afterBudget));
    // 返す指示文は入力のまま。
    expect(result.systemPrompt).toBe(INSTRUCTION);
    expect(mocks.countTokens).not.toHaveBeenCalledWith(INSTRUCTION);
  });

  it("テンプレートに {{system}} の差し込み口があれば、指示文を数える", async () => {
    const scene: SceneText = { scene: SCENE, before: LONG_BEFORE, after: "" };
    const window = 200;
    const r0 = remainder({ window, template: TEMPLATE_WITH_SYSTEM, settings: [], scene });

    const result = expectOk(
      await buildIllustrationContext({ aiConfig: configOf(window), settings: settingsOf(), scene }),
    );

    expect(blocksOf(result.body).get(L.before)).toBe(tail(LONG_BEFORE, r0));
    expect(mocks.countTokens).toHaveBeenCalledWith(INSTRUCTION);
  });
});

describe("buildIllustrationContext: 設定を外す・場面が長すぎる (2.4, 2.5, 2.6)", () => {
  it("予算(settingsTokenBudget)に入らない設定は外し、その名前を返す", async () => {
    addSetting("a", "画家", SETTING_A);
    addSetting("z", "年表", SETTING_BIG);

    const result = expectOk(
      await buildIllustrationContext({
        aiConfig: configOf(2048),
        settings: settingsOf(),
        scene: { scene: SCENE, before: "", after: "" },
      }),
    );

    expect(result.droppedSettings).toEqual([settingLabel("年表")]);
    expect(blocksOf(result.body).get(L.settings)).toBe(SETTING_A);
  });

  it("設定の分で窓からあふれるときは、設定を挿入順の後ろから外して生成できる", async () => {
    addSetting("a", "画家", SETTING_A);
    addSetting("b", "猫", SETTING_B);
    const scene: SceneText = { scene: SCENE, before: LONG_BEFORE, after: LONG_AFTER };
    // 両方入れると R0 = -3、後ろの 1 件を外すと R0 >= 0 になる窓。
    const withBoth = remainder({ window: 0, template: TEMPLATE_WITH_SYSTEM, settings: [SETTING_A, SETTING_B], scene });
    const window = -withBoth - 3;
    const r0 = remainder({ window, template: TEMPLATE_WITH_SYSTEM, settings: [SETTING_A], scene });
    expect(r0).toBeGreaterThanOrEqual(0);

    const result = expectOk(
      await buildIllustrationContext({ aiConfig: configOf(window), settings: settingsOf(), scene }),
    );
    const blocks = blocksOf(result.body);

    expect(result.droppedSettings).toEqual([settingLabel("猫")]);
    expect(blocks.get(L.settings)).toBe(SETTING_A);
    expect(blocks.get(L.scene)).toBe(SCENE);
    const afterBudget = Math.floor(r0 / 4);
    expect(blocks.get(L.before) ?? "").toBe(tail(LONG_BEFORE, r0 - afterBudget));
    expect(blocks.get(L.after) ?? "").toBe(head(LONG_AFTER, afterBudget));
  });

  it("予算で外した名前と、窓であふれて外した名前の両方を返す", async () => {
    addSetting("a", "画家", SETTING_A);
    addSetting("z", "年表", SETTING_BIG);
    addSetting("b", "猫", SETTING_B);
    const scene: SceneText = { scene: SCENE, before: "", after: "" };
    // a と b の両方を外さないと収まらない窓(場面だけならちょうど 0)。
    const window = -remainder({ window: 0, template: TEMPLATE_WITH_SYSTEM, settings: [], scene });

    const result = expectOk(
      await buildIllustrationContext({ aiConfig: configOf(window), settings: settingsOf(), scene }),
    );

    expect(result.droppedSettings).toEqual([
      settingLabel("年表"),
      settingLabel("猫"),
      settingLabel("画家"),
    ]);
    expect(result.body).toBe(`【挿し絵にする場面】\n${SCENE}`);
  });

  it("設定が 0 件でも場面が入らなければ sceneTooLong", async () => {
    const scene: SceneText = { scene: SCENE, before: "夜が来た。", after: "朝になった。" };
    const window = -remainder({ window: 0, template: TEMPLATE_WITH_SYSTEM, settings: [], scene }) - 1;

    const result = await buildIllustrationContext({
      aiConfig: configOf(window),
      settings: settingsOf(),
      scene,
    });

    expect(result).toEqual({ kind: "sceneTooLong" });
  });

  it("設定をすべて外しても場面が入らなければ sceneTooLong", async () => {
    addSetting("a", "画家", SETTING_A);
    addSetting("b", "猫", SETTING_B);
    const scene: SceneText = { scene: text(300, 0x4e00), before: "", after: "" };

    const result = await buildIllustrationContext({
      aiConfig: configOf(200),
      settings: settingsOf(),
      scene,
    });

    expect(result).toEqual({ kind: "sceneTooLong" });
  });
});
