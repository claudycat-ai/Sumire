import { describe, expect, it } from "vitest";
import ja from "@/i18n/locales/ja.json";
import en from "@/i18n/locales/en.json";
import { TEMPLATE_CHOICES } from "@/domain/providers/templateSelection";

// template-settings-ui spec が持つ文言のキー(aiSettings.template*)が、ja / en の両方に
// そろっていることを確かめる。Requirements: 1.4, 1.5, 1.6。

type Nested = { [key: string]: string | Nested };
type Locale = { aiSettings: Nested };

const EXPECTED_KEYS = [
  "aiSettings.template",
  "aiSettings.templateConfirmAction",
  "aiSettings.templateConfirmBody",
  "aiSettings.templateConfirmTitle",
  "aiSettings.templateCustomInvalidNote",
  "aiSettings.templateCustomNote",
  ...TEMPLATE_CHOICES.map((choice) => `aiSettings.templateDesc.${choice}`),
  "aiSettings.templateHelp",
  "aiSettings.templateMaxTokensHint",
  ...TEMPLATE_CHOICES.map((choice) => `aiSettings.templateOption.${choice}`),
  "aiSettings.templateOption.custom",
  "aiSettings.templateOption.unreadable",
  "aiSettings.templateTagsAdded",
  "aiSettings.templateThinkingDisabled",
  "aiSettings.templateUnreadableNote",
].sort();

/** aiSettings の下の template で始まるキーを、平らにして集める。 */
function specEntries(locale: Locale): Map<string, string> {
  const entries = new Map<string, string>();
  function walk(prefix: string, node: Nested): void {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}.${key}`;
      if (typeof value === "string") entries.set(path, value);
      else walk(path, value);
    }
  }
  for (const [key, value] of Object.entries(locale.aiSettings)) {
    if (!key.startsWith("template")) continue;
    const path = `aiSettings.${key}`;
    if (typeof value === "string") entries.set(path, value);
    else walk(path, value);
  }
  return entries;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

const jaEntries = specEntries(ja as unknown as Locale);
const enEntries = specEntries(en as unknown as Locale);

describe("template-settings-ui の文言", () => {
  it("ja に本 spec のキーがすべてある", () => {
    expect([...jaEntries.keys()].sort()).toEqual(EXPECTED_KEYS);
  });

  it("en に本 spec のキーがすべてある", () => {
    expect([...enEntries.keys()].sort()).toEqual(EXPECTED_KEYS);
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

  it("プリセットの表示名は、プリセットの名前をそのまま含む", () => {
    for (const choice of TEMPLATE_CHOICES) {
      if (choice === "none") continue;
      for (const entries of [jaEntries, enEntries]) {
        expect(entries.get(`aiSettings.templateOption.${choice}`)).toContain(
          choice,
        );
      }
    }
  });

  it("Max Tokens の案内は、境目の値を min で受け取る", () => {
    for (const entries of [jaEntries, enEntries]) {
      const text = entries.get("aiSettings.templateMaxTokensHint") ?? "";
      expect(placeholders(text)).toEqual(["min"]);
    }
  });
});
