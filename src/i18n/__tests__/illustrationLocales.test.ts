import { describe, expect, it } from "vitest";
import ja from "@/i18n/locales/ja.json";
import en from "@/i18n/locales/en.json";

// illustration-prompt spec が持つ文言のキーが、ja / en の両方にそろっていることを確かめる。
// 本 spec のキーの範囲(toast.illustration* / toast.suggestionIllustrationBusy /
// status.illustrationGenerating)だけを比べる。

type Section = Record<string, string>;
type Locale = { toast: Section; status: Section };

const EXPECTED_KEYS = [
  "status.illustrationGenerating",
  "toast.illustrationAppended",
  "toast.illustrationBusy",
  "toast.illustrationConfigUnreadable",
  "toast.illustrationEmpty",
  "toast.illustrationFailed",
  "toast.illustrationNoScene",
  "toast.illustrationProviderUnsupported",
  "toast.illustrationSceneTooLong",
  "toast.illustrationSettingsDropped",
  "toast.illustrationSuggestionBusy",
  "toast.illustrationTemplateDuplicateSlot",
  "toast.illustrationTemplateMissing",
  "toast.illustrationTemplateMissingBody",
  "toast.illustrationTemplatePresetUnknown",
  "toast.illustrationTemplateUnreadable",
  "toast.illustrationThinkingMaxTokens",
  "toast.illustrationThinkingUnfinished",
  "toast.illustrationTruncated",
  "toast.suggestionIllustrationBusy",
].sort();

function isSpecKey(section: string, key: string): boolean {
  if (section === "toast") {
    return key.startsWith("illustration") || key === "suggestionIllustrationBusy";
  }
  return section === "status" && key === "illustrationGenerating";
}

function specEntries(locale: Locale): Map<string, string> {
  const entries = new Map<string, string>();
  for (const section of ["toast", "status"] as const) {
    for (const [key, value] of Object.entries(locale[section])) {
      if (isSpecKey(section, key)) entries.set(`${section}.${key}`, value);
    }
  }
  return entries;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

const jaEntries = specEntries(ja as Locale);
const enEntries = specEntries(en as Locale);

describe("illustration-prompt の文言", () => {
  it("ja に本 spec のキーがすべてある", () => {
    expect([...jaEntries.keys()].sort()).toEqual(EXPECTED_KEYS);
  });

  it("en に本 spec のキーがすべてある", () => {
    expect([...enEntries.keys()].sort()).toEqual(EXPECTED_KEYS);
  });

  it("ja と en で本 spec のキーの集合が一致する", () => {
    expect([...enEntries.keys()].sort()).toEqual([...jaEntries.keys()].sort());
  });

  it("ja と en で同じキーの補間値の名前がそろっている", () => {
    for (const [key, jaText] of jaEntries) {
      const enText = enEntries.get(key) ?? "";
      expect({ key, vars: placeholders(enText) }).toEqual({
        key,
        vars: placeholders(jaText),
      });
    }
  });

  it("どの文言も空でない", () => {
    for (const [key, text] of [...jaEntries, ...enEntries]) {
      expect({ key, empty: text.trim() === "" }).toEqual({ key, empty: false });
    }
  });

  it("補間値を使う文言は、決めた名前で補間値を受け取る", () => {
    const vars = (key: string) => placeholders(jaEntries.get(key) ?? "");
    expect(vars("status.illustrationGenerating")).toEqual(["seconds"]);
    expect(vars("toast.illustrationSettingsDropped")).toEqual(["names"]);
    expect(vars("toast.illustrationFailed")).toEqual(["message"]);
    expect(vars("toast.illustrationTemplatePresetUnknown")).toEqual(["name"]);
    expect(vars("toast.illustrationTemplateMissingBody")).toEqual(["slot"]);
    expect(vars("toast.illustrationTemplateDuplicateSlot")).toEqual(["slot"]);
  });
});
