import { describe, expect, it } from "vitest";
import ja from "@/i18n/locales/ja.json";
import en from "@/i18n/locales/en.json";

// llama-server-provider spec が持つ文言のキーが、ja / en の両方にそろっていることを確かめる。
// 本 spec のキーの範囲(llamaServer.* / toast.llamaServer*)だけを比べる。
// 画面での名前 aiProvider.llama-server はタスク 1.1 の持ち分なので、ここでは見ない。

type Section = Record<string, string>;
type Locale = { toast: Section; llamaServer?: Section };

const EXPECTED_KEYS = [
  "llamaServer.browse",
  "llamaServer.contextSize",
  "llamaServer.contextSizeInvalid",
  "llamaServer.contextSizeUnset",
  "llamaServer.executablePath",
  "llamaServer.exitCodeUnknown",
  "llamaServer.extraArgs",
  "llamaServer.extraArgsHelp",
  "llamaServer.failureExited",
  "llamaServer.failureSpawn",
  "llamaServer.modelsDir",
  "llamaServer.modelsDirNoGguf",
  "llamaServer.modelsDirUnreadable",
  "llamaServer.modelsDirUnset",
  "llamaServer.modelsEmpty",
  "llamaServer.refreshModels",
  "llamaServer.serverLog",
  "llamaServer.serverLogRefresh",
  "llamaServer.serverLogUnreadable",
  "llamaServer.stateFailed",
  "llamaServer.stateLoading",
  "llamaServer.stateReady",
  "llamaServer.stateStopped",
  "llamaServer.stop",
  "toast.llamaServerContextMismatch",
  "toast.llamaServerExited",
  "toast.llamaServerLoadFailed",
  "toast.llamaServerLoading",
  "toast.llamaServerModelMissing",
  "toast.llamaServerNoContextSize",
  "toast.llamaServerNoExecutable",
  "toast.llamaServerNoModel",
  "toast.llamaServerPreferencesSaveFailed",
  "toast.llamaServerReady",
  "toast.llamaServerSpawnFailed",
  "toast.llamaServerStarting",
].sort();

function specEntries(locale: Locale): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(locale.llamaServer ?? {})) {
    entries.set(`llamaServer.${key}`, value);
  }
  for (const [key, value] of Object.entries(locale.toast)) {
    if (key.startsWith("llamaServer")) entries.set(`toast.${key}`, value);
  }
  return entries;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

const jaEntries = specEntries(ja as Locale);
const enEntries = specEntries(en as Locale);

describe("llama-server-provider の文言", () => {
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

  it("追加の起動引数の案内は、値つきの引数を 2 行に分ける例を含む", () => {
    for (const entries of [jaEntries, enEntries]) {
      const help = entries.get("llamaServer.extraArgsHelp") ?? "";
      expect(help).toContain("--flash-attn");
      expect(help).toMatch(/2 行目|line 2/);
    }
  });

  it("モデル名・パス・数値は、決めた名前の補間値で受け取る", () => {
    const expected: Record<string, string[]> = {
      "llamaServer.failureExited": ["code"],
      "llamaServer.failureSpawn": ["message"],
      "llamaServer.modelsDirUnreadable": ["message"],
      "llamaServer.serverLogUnreadable": ["message"],
      "toast.llamaServerContextMismatch": ["actual", "requested"],
      "toast.llamaServerModelMissing": ["model"],
      "toast.llamaServerNoContextSize": ["model"],
      "toast.llamaServerPreferencesSaveFailed": ["message"],
      "toast.llamaServerReady": ["model"],
      "toast.llamaServerSpawnFailed": ["path"],
      "toast.llamaServerStarting": ["model"],
    };
    for (const key of EXPECTED_KEYS) {
      expect({ key, vars: placeholders(jaEntries.get(key) ?? "") }).toEqual({
        key,
        vars: expected[key] ?? [],
      });
    }
  });
});
