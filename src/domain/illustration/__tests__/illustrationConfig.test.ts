import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_PRESETS,
  resolvePromptTemplate,
} from "@/domain/providers";
import {
  DEFAULT_ILLUSTRATION_INSTRUCTION,
  ILLUSTRATION_DEFAULTS,
  resolveIllustrationConfig,
  type IllustrationSettings,
} from "../illustrationConfig";

/** 解決が ok であることを確かめ、設定を取り出す。 */
function okSettings(raw: unknown): IllustrationSettings {
  const result = resolveIllustrationConfig(raw);
  if (result.kind !== "ok") {
    throw new Error(`ok を期待したが ${JSON.stringify(result)}`);
  }
  return result.settings;
}

const PRESET = { preset: "gemma4-think" };

describe("resolveIllustrationConfig: 設定の有無と形(規則 1〜3)", () => {
  it("undefined / null は missingTemplate", () => {
    expect(resolveIllustrationConfig(undefined)).toEqual({
      kind: "error",
      error: { kind: "missingTemplate" },
    });
    expect(resolveIllustrationConfig(null)).toEqual({
      kind: "error",
      error: { kind: "missingTemplate" },
    });
  });

  it.each([
    ["文字列", "gemma4-think"],
    ["数", 1],
    ["真偽値", true],
    ["配列", [{ template: PRESET }]],
  ])("オブジェクトでない値(%s)は unreadable", (_label, raw) => {
    expect(resolveIllustrationConfig(raw)).toEqual({
      kind: "error",
      error: { kind: "unreadable" },
    });
  });

  it("template が無い・null なら missingTemplate", () => {
    expect(resolveIllustrationConfig({})).toEqual({
      kind: "error",
      error: { kind: "missingTemplate" },
    });
    expect(resolveIllustrationConfig({ temperature: 0.5 })).toEqual({
      kind: "error",
      error: { kind: "missingTemplate" },
    });
    expect(resolveIllustrationConfig({ template: null })).toEqual({
      kind: "error",
      error: { kind: "missingTemplate" },
    });
  });
});

describe("resolveIllustrationConfig: テンプレート(規則 4)", () => {
  it("プリセットを挿し絵用の表で解決する", () => {
    const settings = okSettings({ template: PRESET });
    const expected = resolvePromptTemplate(PRESET, ILLUSTRATION_TEMPLATE_PRESETS);
    expect(expected.kind).toBe("ok");
    if (expected.kind !== "ok") return;
    expect(settings.template).toEqual(expected.template);
    // 挿し絵用の表なので {{settings}} の差し込み口は無い
    expect(settings.template.slots.has("settings")).toBe(false);
    expect(settings.template.source).toEqual({
      kind: "preset",
      name: "gemma4-think",
    });
  });

  it("自由記述(文字列の配列)も受け付ける", () => {
    const settings = okSettings({
      template: { custom: ["<s>{{system}}", "{{body}}"] },
    });
    expect(settings.template.source).toEqual({ kind: "custom" });
    expect(settings.template.slots.has("body")).toBe(true);
  });

  it.each([
    ["読めない形", { template: "gemma4" }, { kind: "unreadable" }],
    [
      "知らないプリセット",
      { template: { preset: "llama3" } },
      { kind: "unknownPreset", name: "llama3" },
    ],
    ["{{body}} が無い", { template: { custom: "{{system}}" } }, { kind: "missingBody" }],
    [
      "差し込み口の重複",
      { template: { custom: "{{body}}{{body}}" } },
      { kind: "duplicateSlot", slot: "body" },
    ],
  ])("テンプレートの不備(%s)は種類を保って template で返る", (_label, raw, error) => {
    expect(resolveIllustrationConfig(raw)).toEqual({
      kind: "error",
      error: { kind: "template", error },
    });
  });
});

describe("resolveIllustrationConfig: 数値(規則 5)", () => {
  it("既定値は温度 0.7・最大トークン 4096・タイムアウト 180 秒", () => {
    expect(ILLUSTRATION_DEFAULTS).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
      timeoutMs: 180000,
    });
    const settings = okSettings({ template: PRESET });
    expect(settings.temperature).toBe(0.7);
    expect(settings.maxTokens).toBe(4096);
    expect(settings.timeoutMs).toBe(180000);
  });

  it("有効な値で上書きする", () => {
    const settings = okSettings({
      template: PRESET,
      temperature: 0.3,
      maxTokens: 8192,
      timeoutMs: 60000,
    });
    expect(settings.temperature).toBe(0.3);
    expect(settings.maxTokens).toBe(8192);
    expect(settings.timeoutMs).toBe(60000);
  });

  it("温度 0 は採る", () => {
    expect(okSettings({ template: PRESET, temperature: 0 }).temperature).toBe(0);
  });

  it.each([
    ["文字列", "0.5"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
  ])("温度が不正(%s)なら黙って既定値", (_label, value) => {
    expect(okSettings({ template: PRESET, temperature: value }).temperature).toBe(
      0.7,
    );
  });

  it.each([
    ["0", 0],
    ["負の数", -1],
    ["文字列", "4096"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("最大トークン・タイムアウトが不正(%s)なら黙って既定値", (_label, value) => {
    const settings = okSettings({
      template: PRESET,
      maxTokens: value,
      timeoutMs: value,
    });
    expect(settings.maxTokens).toBe(4096);
    expect(settings.timeoutMs).toBe(180000);
  });
});

describe("resolveIllustrationConfig: 指示文(規則 6)", () => {
  it("省略すると内蔵の指示文", () => {
    expect(okSettings({ template: PRESET }).instruction).toBe(
      DEFAULT_ILLUSTRATION_INSTRUCTION,
    );
  });

  it("文字列で上書きする", () => {
    expect(
      okSettings({ template: PRESET, instruction: "情景を短くまとめてください。" })
        .instruction,
    ).toBe("情景を短くまとめてください。");
  });

  it("文字列の配列は改行でつなぐ", () => {
    expect(
      okSettings({
        template: PRESET,
        instruction: ["一行目の指示。", "二行目の指示。"],
      }).instruction,
    ).toBe("一行目の指示。\n二行目の指示。");
  });

  it.each([
    ["空の文字列", ""],
    ["空白だけ(全角空白と改行を含む)", " 　\n\t"],
    ["空の配列", []],
    ["空白だけの配列", ["", " "]],
  ])("空(%s)なら内蔵の指示文", (_label, value) => {
    expect(okSettings({ template: PRESET, instruction: value }).instruction).toBe(
      DEFAULT_ILLUSTRATION_INSTRUCTION,
    );
  });

  it.each([
    ["数", 1],
    ["オブジェクト", { text: "指示" }],
    ["文字列でない要素を含む配列", ["指示", 1]],
    ["null", null],
  ])("読めない形(%s)なら内蔵の指示文", (_label, value) => {
    expect(okSettings({ template: PRESET, instruction: value }).instruction).toBe(
      DEFAULT_ILLUSTRATION_INSTRUCTION,
    );
  });
});

describe("resolveIllustrationConfig: ほかのキー(規則 7)", () => {
  it("知らないキーは無視して解決する", () => {
    const withExtra = okSettings({
      template: PRESET,
      topP: 0.1,
      extras: { top_k: 20 },
      unknown: "x",
    });
    expect(withExtra).toEqual(okSettings({ template: PRESET }));
    expect(Object.keys(withExtra).sort()).toEqual(
      ["instruction", "maxTokens", "temperature", "template", "timeoutMs"].sort(),
    );
  });
});

describe("DEFAULT_ILLUSTRATION_INSTRUCTION", () => {
  it("design.md の文面どおり", () => {
    expect(DEFAULT_ILLUSTRATION_INSTRUCTION).toBe(
      [
        "あなたは小説の挿し絵づくりを手伝うアシスタントです。【挿し絵にする場面】に書かれた場面を、一枚の絵として描くための情景文にまとめてください。【設定】と、場面より前と後の本文は、場面を理解するための材料です。",
        "",
        "- 本文の続きを書いたり、本文を書き換えたりしないでください。",
        "- 人物の位置関係・動作・視線・表情・姿勢、場所、時間・天気・光、絵に必要な小道具、構図(視点、距離感、前景と背景)のうち、本文から読み取れるものを書いてください。",
        "- 人物の外見や衣装は、本文か【設定】に書かれているものだけを書いてください。書かれていない外見・衣装・小物・場所の細部を創作してはいけません。",
        "- 心情は、表情・姿勢・視線・手の動き・距離感など、絵で見える形に置き換えて書いてください。",
        "- 出力は日本語の地の文の情景文だけにしてください。見出し、箇条書き、前置き、説明は書かないでください。",
      ].join("\n"),
    );
  });
});
