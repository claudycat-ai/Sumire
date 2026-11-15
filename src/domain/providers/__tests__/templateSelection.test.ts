import { describe, expect, it } from "vitest";
import {
  describeTemplateSelection,
  ensureThinkingTags,
  isSameChoice,
  isThinkingDisabledFor,
  needsConfirm,
  planTemplateChange,
  shouldHintMaxTokens,
  templateValueForChoice,
  TEMPLATE_CHOICES,
  TEMPLATE_PRESET_INFO,
  THINKING_MAX_TOKENS_HINT,
  type TemplateSelectionState,
} from "@/domain/providers/templateSelection";
import { PROMPT_TEMPLATE_PRESETS } from "@/domain/providers/promptTemplate";
import type { ThinkingConfig } from "@/domain/providers/types";

// `template-settings-ui` spec task 1.1: テンプレートの指定についての判断の規則。

const GEMMA4_TAGS = { open: "<|channel>", close: "<channel|>" };
const THINK_TAGS = { open: "<think>", close: "</think>" };

describe("describeTemplateSelection(2.2–2.5)", () => {
  it("未設定と null は「指定なし」", () => {
    expect(describeTemplateSelection(undefined)).toEqual({ kind: "none" });
    expect(describeTemplateSelection(null)).toEqual({ kind: "none" });
  });

  it("内蔵の 4 つのプリセットは「プリセット」", () => {
    for (const name of ["gemma4", "gemma4-think", "chatml", "chatml-nothink"] as const) {
      expect(describeTemplateSelection({ preset: name })).toEqual({
        kind: "preset",
        name,
      });
    }
  });

  it("文字列と行の配列の自由記述は「自由記述」(不備なし)", () => {
    expect(describeTemplateSelection({ custom: "{{system}}{{body}}" })).toEqual({
      kind: "custom",
      invalid: false,
    });
    expect(
      describeTemplateSelection({ custom: ["<s>{{system}}", "{{body}}"] }),
    ).toEqual({ kind: "custom", invalid: false });
  });

  it("本文の差し込み口が無い自由記述と、差し込み口の重複は「自由記述」(不備あり)", () => {
    expect(describeTemplateSelection({ custom: "{{system}}" })).toEqual({
      kind: "custom",
      invalid: true,
    });
    expect(
      describeTemplateSelection({ custom: "{{body}}{{body}}" }),
    ).toEqual({ kind: "custom", invalid: true });
  });

  it("知らないプリセット名、両方の指定、文字列や数は「読めない指定」", () => {
    expect(describeTemplateSelection({ preset: "unknown-x" })).toEqual({
      kind: "unreadable",
      error: { kind: "unknownPreset", name: "unknown-x" },
    });
    expect(
      describeTemplateSelection({ preset: "gemma4", custom: "{{body}}" }),
    ).toEqual({ kind: "unreadable", error: { kind: "unreadable" } });
    expect(describeTemplateSelection("gemma4")).toEqual({
      kind: "unreadable",
      error: { kind: "unreadable" },
    });
    expect(describeTemplateSelection(1)).toEqual({
      kind: "unreadable",
      error: { kind: "unreadable" },
    });
  });
});

describe("選択肢と値(3.2, 3.6, 4.2, 4.5)", () => {
  it("選択肢は「指定なし」が先頭で、4 つのプリセットが続く", () => {
    expect(TEMPLATE_CHOICES).toEqual([
      "none",
      "gemma4",
      "gemma4-think",
      "chatml",
      "chatml-nothink",
    ]);
  });

  it("「指定なし」は undefined、プリセットは { preset: 名前 }", () => {
    expect(templateValueForChoice("none")).toBeUndefined();
    expect(templateValueForChoice("chatml")).toEqual({ preset: "chatml" });
  });

  it("isSameChoice は、指定なしどうしと同じ名前のプリセットだけで真", () => {
    expect(isSameChoice({ kind: "none" }, "none")).toBe(true);
    expect(isSameChoice({ kind: "none" }, "gemma4")).toBe(false);
    expect(isSameChoice({ kind: "preset", name: "gemma4" }, "gemma4")).toBe(true);
    expect(isSameChoice({ kind: "preset", name: "gemma4" }, "chatml")).toBe(false);
    expect(isSameChoice({ kind: "preset", name: "gemma4" }, "none")).toBe(false);
    for (const choice of TEMPLATE_CHOICES) {
      expect(isSameChoice({ kind: "custom", invalid: false }, choice)).toBe(false);
      expect(
        isSameChoice(
          { kind: "unreadable", error: { kind: "unreadable" } },
          choice,
        ),
      ).toBe(false);
    }
  });

  it("確認が要るのは、自由記述と読めない指定のときだけ", () => {
    expect(needsConfirm({ kind: "custom", invalid: false })).toBe(true);
    expect(needsConfirm({ kind: "custom", invalid: true })).toBe(true);
    expect(
      needsConfirm({ kind: "unreadable", error: { kind: "unreadable" } }),
    ).toBe(true);
    expect(needsConfirm({ kind: "none" })).toBe(false);
    expect(needsConfirm({ kind: "preset", name: "gemma4" })).toBe(false);
  });
});

describe("TEMPLATE_PRESET_INFO", () => {
  it("キーが、プリセットの表のキーと一致する", () => {
    expect(Object.keys(TEMPLATE_PRESET_INFO).sort()).toEqual(
      Object.keys(PROMPT_TEMPLATE_PRESETS).sort(),
    );
  });

  it("思考ありは gemma4-think だけで、要る組は Gemma 4 の 1 組", () => {
    expect(TEMPLATE_PRESET_INFO["gemma4-think"]).toEqual({
      thinking: true,
      requiredThinkingTags: [GEMMA4_TAGS],
    });
    for (const name of ["gemma4", "chatml", "chatml-nothink"] as const) {
      expect(TEMPLATE_PRESET_INFO[name]).toEqual({
        thinking: false,
        requiredThinkingTags: [],
      });
    }
  });
});

describe("ensureThinkingTags(5.1–5.3, 5.5)", () => {
  it("未設定に足すと、既定の組と Gemma 4 の組の 2 つになる", () => {
    expect(ensureThinkingTags(undefined, [GEMMA4_TAGS])).toEqual({
      next: { tags: [THINK_TAGS, GEMMA4_TAGS] },
      disabled: false,
    });
  });

  it("既定の組だけがあるところに足すと、後ろに付き、enabled はそのまま", () => {
    const current: ThinkingConfig = { enabled: true, tags: [THINK_TAGS] };
    expect(ensureThinkingTags(current, [GEMMA4_TAGS])).toEqual({
      next: { enabled: true, tags: [THINK_TAGS, GEMMA4_TAGS] },
      disabled: false,
    });
  });

  it("要る組がすでにあれば、書き換えない", () => {
    const current: ThinkingConfig = {
      enabled: true,
      tags: [GEMMA4_TAGS, THINK_TAGS],
    };
    expect(ensureThinkingTags(current, [GEMMA4_TAGS])).toEqual({
      next: null,
      disabled: false,
    });
  });

  it("書き手が足した別の組は、位置も中身も変わらない", () => {
    const own = { open: "[[", close: "]]" };
    const current: ThinkingConfig = { tags: [own, THINK_TAGS] };
    const result = ensureThinkingTags(current, [GEMMA4_TAGS]);
    expect(result.next).toEqual({ tags: [own, THINK_TAGS, GEMMA4_TAGS] });
  });

  it("有効な組が書き手の組だけでも、既定の組は足さない", () => {
    const own = { open: "[[", close: "]]" };
    const result = ensureThinkingTags({ tags: [own] }, [GEMMA4_TAGS]);
    expect(result.next).toEqual({ tags: [own, GEMMA4_TAGS] });
  });

  it("思考の分離が無効なら、足さずに disabled を返す", () => {
    expect(
      ensureThinkingTags({ enabled: false, tags: [THINK_TAGS] }, [GEMMA4_TAGS]),
    ).toEqual({ next: null, disabled: true });
  });

  it("要る組が空なら、書き換えない", () => {
    expect(ensureThinkingTags(undefined, [])).toEqual({
      next: null,
      disabled: false,
    });
  });

  it("空文字の組しか無いときは、その組を残して既定の組と要る組を足す", () => {
    const empty = { open: "", close: "</x>" };
    const result = ensureThinkingTags({ tags: [empty] }, [GEMMA4_TAGS]);
    expect(result.next).toEqual({ tags: [empty, THINK_TAGS, GEMMA4_TAGS] });
  });

  it("引数を書き換えず、返す設定は引数と配列や組を共有しない", () => {
    const current: ThinkingConfig = { enabled: true, tags: [THINK_TAGS] };
    const snapshot = structuredClone(current);
    const required = [GEMMA4_TAGS];
    const result = ensureThinkingTags(current, required);
    expect(current).toEqual(snapshot);
    expect(required).toEqual([GEMMA4_TAGS]);
    expect(result.next?.tags).not.toBe(current.tags);
    expect(result.next?.tags?.[0]).not.toBe(current.tags?.[0]);
    expect(result.next?.tags?.[1]).not.toBe(GEMMA4_TAGS);
  });
});

describe("planTemplateChange(5.6, 5.7)", () => {
  it("gemma4-think は、要る組を足した思考の分離の設定を返す", () => {
    expect(planTemplateChange("gemma4-think", undefined)).toEqual({
      template: { preset: "gemma4-think" },
      thinking: { tags: [THINK_TAGS, GEMMA4_TAGS] },
      tagsAdded: true,
    });
  });

  it("gemma4-think で組がすでにあれば、thinking は null で tagsAdded は偽", () => {
    expect(
      planTemplateChange("gemma4-think", { tags: [THINK_TAGS, GEMMA4_TAGS] }),
    ).toEqual({
      template: { preset: "gemma4-think" },
      thinking: null,
      tagsAdded: false,
    });
  });

  it("gemma4-think 以外と「指定なし」は、思考の分離の設定を書き換えない", () => {
    const current: ThinkingConfig = { tags: [THINK_TAGS, GEMMA4_TAGS] };
    for (const choice of ["gemma4", "chatml", "chatml-nothink"] as const) {
      expect(planTemplateChange(choice, current)).toEqual({
        template: { preset: choice },
        thinking: null,
        tagsAdded: false,
      });
    }
    expect(planTemplateChange("none", current)).toEqual({
      template: undefined,
      thinking: null,
      tagsAdded: false,
    });
    expect(planTemplateChange("none", undefined).thinking).toBeNull();
  });
});

describe("shouldHintMaxTokens(6.1–6.3)", () => {
  const think: TemplateSelectionState = { kind: "preset", name: "gemma4-think" };

  it("境目は 1000", () => {
    expect(THINKING_MAX_TOKENS_HINT).toBe(1000);
  });

  it("思考ありのプリセットで 999 は出し、1000 は出さない", () => {
    expect(shouldHintMaxTokens(think, 999)).toBe(true);
    expect(shouldHintMaxTokens(think, 1000)).toBe(false);
  });

  it("思考ありでないプリセット、指定なし、自由記述では出さない", () => {
    expect(shouldHintMaxTokens({ kind: "preset", name: "gemma4" }, 200)).toBe(false);
    expect(shouldHintMaxTokens({ kind: "none" }, 200)).toBe(false);
    expect(shouldHintMaxTokens({ kind: "custom", invalid: false }, 200)).toBe(false);
  });

  it("数でない値では出さない", () => {
    expect(shouldHintMaxTokens(think, Number.NaN)).toBe(false);
    expect(shouldHintMaxTokens(think, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("isThinkingDisabledFor(5.5)", () => {
  const think: TemplateSelectionState = { kind: "preset", name: "gemma4-think" };

  it("思考ありのプリセットで、思考の分離が無効のときだけ真", () => {
    expect(isThinkingDisabledFor(think, { enabled: false })).toBe(true);
    expect(isThinkingDisabledFor(think, { enabled: true })).toBe(false);
    expect(isThinkingDisabledFor(think, undefined)).toBe(false);
    expect(
      isThinkingDisabledFor({ kind: "preset", name: "gemma4" }, { enabled: false }),
    ).toBe(false);
    expect(isThinkingDisabledFor({ kind: "none" }, { enabled: false })).toBe(false);
  });
});
