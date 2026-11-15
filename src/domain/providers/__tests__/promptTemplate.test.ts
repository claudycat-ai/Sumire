/**
 * `prompt-template` spec のプロンプトテンプレートの単体テスト。
 *
 * - task 1.1: `resolvePromptTemplate` の解決規則 1〜7、`renderPromptTemplate` の描画規則、
 *   `templateLiteralText`、内蔵プリセット 4 つの中身(design.md「promptTemplate」)
 *
 * Requirements: 1.2, 1.4, 2.1, 2.2, 2.3, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.2, 4.3, 4.4
 */
import { describe, expect, it } from "vitest";

import * as PublicProviders from "@/domain/providers";
import { DEFAULT_AI_CONFIG, type AIConfig } from "@/domain/providers";
import {
  ILLUSTRATION_TEMPLATE_PRESETS,
  PROMPT_TEMPLATE_PRESETS,
  renderPromptTemplate,
  resolvePromptTemplate,
  templateLiteralText,
  type ParsedPromptTemplate,
  type PromptTemplateContents,
  type PromptTemplatePresetName,
  type PromptTemplateResolution,
} from "@/domain/providers/promptTemplate";

const CONTENTS: PromptTemplateContents = {
  system: "SYS",
  settings: "SET",
  body: "BODY",
};

/** 解決結果が ok であることを確かめ、解決済みのテンプレートを返す。 */
function expectOk(resolution: PromptTemplateResolution): ParsedPromptTemplate {
  expect(resolution.kind).toBe("ok");
  if (resolution.kind !== "ok") {
    throw new Error("ok に解決しなかった");
  }
  return resolution.template;
}

/** design.md「プリセットの中身」の表(`\n` は改行)。 */
const EXPECTED_PRESETS: Record<PromptTemplatePresetName, string> = {
  gemma4:
    "<|turn>system\n{{system}}<turn|>\n<|turn>user\n{{settings}}<turn|>\n<|turn>model\n<|channel>thought\n<channel|>{{body}}",
  "gemma4-think":
    "<|turn>system\n<|think|>{{system}}<turn|>\n<|turn>user\n{{settings}}\n\n{{body}}<turn|>\n<|turn>model\n",
  chatml:
    "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{settings}}<|im_end|>\n<|im_start|>assistant\n{{body}}",
  "chatml-nothink":
    "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{settings}}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n{{body}}",
};

const PRESET_NAMES = Object.keys(EXPECTED_PRESETS) as PromptTemplatePresetName[];

/** 差し込み口の表記を内容に置き換えた期待値を作る。 */
function fill(template: string, contents: PromptTemplateContents): string {
  return template
    .replace("{{system}}", contents.system)
    .replace("{{settings}}", contents.settings)
    .replace("{{body}}", contents.body);
}

describe("内蔵プリセット", () => {
  it("プリセットは gemma4 / gemma4-think / chatml / chatml-nothink の 4 つで、中身が表のとおり(2.1, 2.2)", () => {
    expect(PROMPT_TEMPLATE_PRESETS).toEqual(EXPECTED_PRESETS);
  });

  it.each(PRESET_NAMES)(
    "%s は ok に解決し、本文の差し込み口を 1 つだけ含み、出典がプリセットになる(2.3)",
    (name) => {
      const template = expectOk(resolvePromptTemplate({ preset: name }));
      expect(template.source).toEqual({ kind: "preset", name });
      expect(template.slots).toEqual(new Set(["system", "settings", "body"]));
      const bodySlots = template.parts.filter(
        (part) => part.kind === "slot" && part.slot === "body",
      );
      expect(bodySlots).toHaveLength(1);
    },
  );

  it.each(PRESET_NAMES)("%s の描画結果が表と一致する(2.3)", (name) => {
    const template = expectOk(resolvePromptTemplate({ preset: name }));
    expect(renderPromptTemplate(template, CONTENTS)).toBe(
      fill(EXPECTED_PRESETS[name], CONTENTS),
    );
  });

  it.each(["gemma4", "chatml", "chatml-nothink"] as const)(
    "思考なしの %s は本文で終わり、本文の後ろに何も置かない(2.5)",
    (name) => {
      const template = expectOk(resolvePromptTemplate({ preset: name }));
      expect(renderPromptTemplate(template, CONTENTS).endsWith("BODY")).toBe(true);
      expect(template.parts[template.parts.length - 1]).toEqual({
        kind: "slot",
        slot: "body",
      });
    },
  );

  it("gemma4-think は本文を user の番に置き、モデルの番の開始で終える(2.6)", () => {
    const template = expectOk(resolvePromptTemplate({ preset: "gemma4-think" }));
    const rendered = renderPromptTemplate(template, CONTENTS);
    expect(rendered.endsWith("<|turn>user\nSET\n\nBODY<turn|>\n<|turn>model\n")).toBe(true);
  });

  it("gemma4-think で設定が空なら、user の番が改行 2 つ + 本文で始まる(3.4)", () => {
    const template = expectOk(resolvePromptTemplate({ preset: "gemma4-think" }));
    const rendered = renderPromptTemplate(template, { ...CONTENTS, settings: "" });
    expect(rendered).toContain("<|turn>user\n\n\nBODY<turn|>");
  });

  it.each(PRESET_NAMES)(
    "%s の差し込み口以外の文字列だけがつながって返り、差し込み口の表記を含まない",
    (name) => {
      const template = expectOk(resolvePromptTemplate({ preset: name }));
      const literal = templateLiteralText(template);
      expect(literal).toBe(
        fill(EXPECTED_PRESETS[name], { system: "", settings: "", body: "" }),
      );
      expect(literal).not.toContain("{{system}}");
      expect(literal).not.toContain("{{settings}}");
      expect(literal).not.toContain("{{body}}");
    },
  );

  it("プリセットの名前は大文字小文字を区別する完全一致(4.2)", () => {
    expect(resolvePromptTemplate({ preset: "Gemma4" })).toEqual({
      kind: "error",
      error: { kind: "unknownPreset", name: "Gemma4" },
    });
  });
});

describe("自由記述のテンプレート", () => {
  it("文字列と行の配列(改行でつなぐ)が同じ結果になる(3.1)", () => {
    const lines = [
      "<|turn>system",
      "{{system}}<turn|>",
      "<|turn>user",
      "{{settings}}<turn|>",
      "<|turn>model",
      "<|channel>thought",
      "<channel|>{{body}}",
    ];
    const fromArray = expectOk(resolvePromptTemplate({ custom: lines }));
    const fromString = expectOk(resolvePromptTemplate({ custom: lines.join("\n") }));
    expect(fromArray).toEqual(fromString);
    expect(fromArray.source).toEqual({ kind: "custom" });
    expect(renderPromptTemplate(fromArray, CONTENTS)).toBe(
      renderPromptTemplate(fromString, CONTENTS),
    );
    // 配列から作ったものは gemma4 プリセットと同じ文字列になる
    expect(renderPromptTemplate(fromArray, CONTENTS)).toBe(
      fill(EXPECTED_PRESETS.gemma4, CONTENTS),
    );
  });

  it("差し込み口以外の文字列(未知の {{x}}・空白・CRLF を含む)を書き換えない(3.2)", () => {
    const raw = "  {{x}} {{ system }}\r\n{{system}}\t{{body}} ";
    const template = expectOk(resolvePromptTemplate({ custom: raw }));
    expect(renderPromptTemplate(template, CONTENTS)).toBe(
      "  {{x}} {{ system }}\r\nSYS\tBODY ",
    );
    expect(templateLiteralText(template)).toBe("  {{x}} {{ system }}\r\n\t ");
  });

  it("{{system}} / {{settings}} を省くと、その内容は出力に含まれない(3.3)", () => {
    const template = expectOk(resolvePromptTemplate({ custom: "[{{body}}]" }));
    expect(template.slots).toEqual(new Set(["body"]));
    const rendered = renderPromptTemplate(template, CONTENTS);
    expect(rendered).toBe("[BODY]");
    expect(rendered).not.toContain("SYS");
    expect(rendered).not.toContain("SET");
  });

  it("設定が空でも描画でき、設定の差し込み口は空になる(3.4)", () => {
    const template = expectOk(
      resolvePromptTemplate({ custom: "{{system}}|{{settings}}|{{body}}" }),
    );
    expect(renderPromptTemplate(template, { ...CONTENTS, settings: "" })).toBe(
      "SYS||BODY",
    );
  });

  it("本文の差し込み口の後ろに文字があっても受け付ける(3.5)", () => {
    const template = expectOk(
      resolvePromptTemplate({ custom: "user: {{body}}\nmodel:\n" }),
    );
    expect(renderPromptTemplate(template, CONTENTS)).toBe("user: BODY\nmodel:\n");
  });

  it("内容の中の {{settings}} などを再解釈しない(1.2)", () => {
    const template = expectOk(
      resolvePromptTemplate({ custom: "{{system}}/{{settings}}/{{body}}" }),
    );
    const rendered = renderPromptTemplate(template, {
      system: "{{body}}",
      settings: "$&",
      body: "本文に {{settings}} と {{system}} がある",
    });
    expect(rendered).toBe("{{body}}/$&/本文に {{settings}} と {{system}} がある");
  });

  it("差し込み口だけのテンプレートは本文そのものになり、文字を付け足さない(1.2)", () => {
    const template = expectOk(resolvePromptTemplate({ custom: "{{body}}" }));
    expect(renderPromptTemplate(template, CONTENTS)).toBe("BODY");
    expect(templateLiteralText(template)).toBe("");
  });

  it("preset と custom 以外のキーは無視する", () => {
    expectOk(resolvePromptTemplate({ custom: "{{body}}", note: 1 }));
    expectOk(resolvePromptTemplate({ preset: "chatml", note: "x" }));
  });
});

describe("resolvePromptTemplate の不備", () => {
  it("undefined と null は「テンプレートなし」になる(1.4)", () => {
    expect(resolvePromptTemplate(undefined)).toEqual({ kind: "none" });
    expect(resolvePromptTemplate(null)).toEqual({ kind: "none" });
  });

  it.each([
    ["文字列", "gemma4"],
    ["数値", 1],
    ["真偽値", true],
    ["配列", [{ preset: "gemma4" }]],
    ["空オブジェクト(どちらも無い)", {}],
    ["preset と custom の両方", { preset: "gemma4", custom: "{{body}}" }],
    ["preset が文字列でない", { preset: 1 }],
    ["preset が null", { preset: null }],
    ["custom が数値", { custom: 1 }],
    ["custom の配列に文字列でない要素", { custom: ["{{body}}", 1] }],
    ["custom が null", { custom: null }],
    ["custom がオブジェクト", { custom: { text: "{{body}}" } }],
  ])("%s → unreadable(4.4)", (_label, raw) => {
    expect(resolvePromptTemplate(raw)).toEqual({
      kind: "error",
      error: { kind: "unreadable" },
    });
  });

  it("未知のプリセット名 → unknownPreset(名前つき)(4.2)", () => {
    expect(resolvePromptTemplate({ preset: "llama3" })).toEqual({
      kind: "error",
      error: { kind: "unknownPreset", name: "llama3" },
    });
  });

  it("{{body}} が無い → missingBody(4.3)", () => {
    expect(resolvePromptTemplate({ custom: "{{system}}{{settings}}" })).toEqual({
      kind: "error",
      error: { kind: "missingBody" },
    });
  });

  it("空配列は空文字列として扱い、missingBody になる(4.3)", () => {
    expect(resolvePromptTemplate({ custom: [] })).toEqual({
      kind: "error",
      error: { kind: "missingBody" },
    });
  });

  it("差し込み口が 2 つ以上 → duplicateSlot(重複した差し込み口の名前つき)(4.3)", () => {
    expect(resolvePromptTemplate({ custom: "{{body}}{{body}}" })).toEqual({
      kind: "error",
      error: { kind: "duplicateSlot", slot: "body" },
    });
    expect(
      resolvePromptTemplate({ custom: "{{settings}}{{body}}{{settings}}" }),
    ).toEqual({
      kind: "error",
      error: { kind: "duplicateSlot", slot: "settings" },
    });
  });

  it("重複が複数あるときは、最初に見つかった重複の名前を返す(4.3)", () => {
    expect(
      resolvePromptTemplate({
        custom: "{{body}}{{system}}{{system}}{{body}}",
      }),
    ).toEqual({
      kind: "error",
      error: { kind: "duplicateSlot", slot: "system" },
    });
  });

  it("本文なしと重複の両方に当たるときは duplicateSlot を先に判定する(4.3)", () => {
    expect(resolvePromptTemplate({ custom: "{{system}}{{system}}" })).toEqual({
      kind: "error",
      error: { kind: "duplicateSlot", slot: "system" },
    });
  });
});

/**
 * `illustration-prompt` spec task 1.1: 挿し絵用のプリセット表と、表を選べる解決。
 * Requirements(illustration-prompt): 2.8, 6.3, 6.4, 6.7
 */
describe("挿し絵用のプリセット", () => {
  /** design.md「挿し絵用のプリセットの中身」の表(`\n` は改行)。 */
  const EXPECTED_ILLUSTRATION_PRESETS: Record<PromptTemplatePresetName, string> = {
    gemma4:
      "<|turn>system\n{{system}}<turn|>\n<|turn>user\n{{body}}<turn|>\n<|turn>model\n<|channel>thought\n<channel|>",
    "gemma4-think":
      "<|turn>system\n<|think|>{{system}}<turn|>\n<|turn>user\n{{body}}<turn|>\n<|turn>model\n",
    chatml:
      "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{body}}<|im_end|>\n<|im_start|>assistant\n",
    "chatml-nothink":
      "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{body}}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
  };

  /** 描画したプロンプトの終わり(モデルの番の開始。思考を止める 2 つは空の思考のあと)。 */
  const EXPECTED_ENDINGS: Record<PromptTemplatePresetName, string> = {
    gemma4: "<|turn>user\nBODY<turn|>\n<|turn>model\n<|channel>thought\n<channel|>",
    "gemma4-think": "<|turn>user\nBODY<turn|>\n<|turn>model\n",
    chatml: "<|im_start|>user\nBODY<|im_end|>\n<|im_start|>assistant\n",
    "chatml-nothink":
      "<|im_start|>user\nBODY<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
  };

  it("続き生成と同じ 4 つの名前を持ち、中身が表のとおり(6.3)", () => {
    expect(ILLUSTRATION_TEMPLATE_PRESETS).toEqual(EXPECTED_ILLUSTRATION_PRESETS);
    expect(Object.keys(ILLUSTRATION_TEMPLATE_PRESETS).sort()).toEqual(
      Object.keys(PROMPT_TEMPLATE_PRESETS).sort(),
    );
  });

  it.each(PRESET_NAMES)(
    "%s は挿し絵用の表で ok に解決し、{{settings}} を持たない(6.3)",
    (name) => {
      const template = expectOk(
        resolvePromptTemplate({ preset: name }, ILLUSTRATION_TEMPLATE_PRESETS),
      );
      expect(template.source).toEqual({ kind: "preset", name });
      expect(template.slots).toEqual(new Set(["system", "body"]));
    },
  );

  it.each(PRESET_NAMES)(
    "%s を描画すると本文が user の番にあり、モデルの番の開始で終わる(6.4)",
    (name) => {
      const template = expectOk(
        resolvePromptTemplate({ preset: name }, ILLUSTRATION_TEMPLATE_PRESETS),
      );
      const rendered = renderPromptTemplate(template, CONTENTS);
      expect(rendered.endsWith(EXPECTED_ENDINGS[name])).toBe(true);
      expect(rendered).not.toContain("SET");
    },
  );

  it.each(["gemma4", "chatml-nothink"] as const)(
    "思考を止める %s は、モデルの番の始まりに空の思考を置く(6.4)",
    (name) => {
      const template = expectOk(
        resolvePromptTemplate({ preset: name }, ILLUSTRATION_TEMPLATE_PRESETS),
      );
      const rendered = renderPromptTemplate(template, CONTENTS);
      const emptyThought =
        name === "gemma4" ? "<|channel>thought\n<channel|>" : "<think>\n\n</think>\n\n";
      expect(rendered.endsWith(emptyThought)).toBe(true);
    },
  );

  it("表を省いた解決は続き生成のプリセットを返す(2.8, 6.7)", () => {
    for (const name of PRESET_NAMES) {
      const withDefault = expectOk(resolvePromptTemplate({ preset: name }));
      const withExplicit = expectOk(
        resolvePromptTemplate({ preset: name }, PROMPT_TEMPLATE_PRESETS),
      );
      expect(withDefault).toEqual(withExplicit);
      expect(renderPromptTemplate(withDefault, CONTENTS)).toBe(
        fill(EXPECTED_PRESETS[name], CONTENTS),
      );
    }
  });

  it("解決の規則は表によらず同じ(自由記述と不備)(6.3)", () => {
    const table = ILLUSTRATION_TEMPLATE_PRESETS;
    expect(resolvePromptTemplate(undefined, table)).toEqual({ kind: "none" });
    expect(resolvePromptTemplate(null, table)).toEqual({ kind: "none" });
    expect(resolvePromptTemplate("gemma4", table)).toEqual({
      kind: "error",
      error: { kind: "unreadable" },
    });
    expect(resolvePromptTemplate({ preset: "Gemma4" }, table)).toEqual({
      kind: "error",
      error: { kind: "unknownPreset", name: "Gemma4" },
    });
    expect(resolvePromptTemplate({ custom: "{{system}}" }, table)).toEqual({
      kind: "error",
      error: { kind: "missingBody" },
    });
    expect(resolvePromptTemplate({ custom: "{{body}}{{body}}" }, table)).toEqual({
      kind: "error",
      error: { kind: "duplicateSlot", slot: "body" },
    });
    const custom = expectOk(resolvePromptTemplate({ custom: ["A", "{{body}}"] }, table));
    expect(custom.source).toEqual({ kind: "custom" });
    expect(renderPromptTemplate(custom, CONTENTS)).toBe("A\nBODY");
  });

  it("providers の公開口から import でき、AIConfig に挿し絵の設定を生の値で持てる", () => {
    expect(PublicProviders.ILLUSTRATION_TEMPLATE_PRESETS).toBe(ILLUSTRATION_TEMPLATE_PRESETS);
    const config: AIConfig = {
      ...DEFAULT_AI_CONFIG,
      illustration: { template: { preset: "gemma4-think" }, temperature: "x" },
    };
    expect(config.illustration).toEqual({
      template: { preset: "gemma4-think" },
      temperature: "x",
    });
    // 既定の AI 設定には挿し絵の設定を入れない
    expect("illustration" in DEFAULT_AI_CONFIG).toBe(false);
  });
});
