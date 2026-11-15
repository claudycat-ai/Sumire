// アプリ側の設定 `preferences.json` の解析と書き戻し。
// ファイルの読み書きそのものは llamaServerApi(Rust の command)が受け持つ。

import type { LlamaServerPreferences } from "./types";

export const DEFAULT_LLAMA_SERVER_PREFERENCES: Readonly<LlamaServerPreferences> =
  Object.freeze({
    executablePath: "",
    modelsDir: "",
    extraArgs: Object.freeze([]) as unknown as string[],
    selectedModel: null,
    models: Object.freeze({}) as Record<string, { contextSize: number }>,
  });

// Rust 側は起動の要求のコンテキスト長を u32 で受ける。
export const MAX_CONTEXT_SIZE = 0xffffffff;

export interface ParsedPreferences {
  /** 読んだ JSON の全体。書き戻すときに、`llamaServer` 以外のキーを保つために持つ */
  raw: Record<string, unknown>;
  llamaServer: LlamaServerPreferences;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoot(json: string | null): Record<string, unknown> {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeModels(value: unknown): Record<string, { contextSize: number }> {
  if (!isPlainObject(value)) return {};
  const entries: [string, { contextSize: number }][] = [];
  for (const [fileName, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    const { contextSize } = entry;
    if (
      typeof contextSize === "number" &&
      Number.isInteger(contextSize) &&
      contextSize > 0 &&
      contextSize <= MAX_CONTEXT_SIZE
    ) {
      entries.push([fileName, { contextSize }]);
    }
  }
  // 代入で組み立てると、キーが "__proto__" のときにプロトタイプを書き換えてしまう。
  return Object.fromEntries(entries);
}

function normalizeLlamaServer(value: unknown): LlamaServerPreferences {
  const source = isPlainObject(value) ? value : {};
  const { executablePath, modelsDir, extraArgs, selectedModel, models } = source;
  return {
    executablePath: typeof executablePath === "string" ? executablePath : "",
    modelsDir: typeof modelsDir === "string" ? modelsDir : "",
    extraArgs: Array.isArray(extraArgs)
      ? extraArgs.filter((arg): arg is string => typeof arg === "string")
      : [],
    selectedModel:
      typeof selectedModel === "string" && selectedModel !== ""
        ? selectedModel
        : null,
    models: normalizeModels(models),
  };
}

/**
 * `preferences.json` の中身を解析する。`null`(ファイルが無い)・壊れた JSON・
 * オブジェクトでない値は、全体を空として扱う。`llamaServer` の中で型の合わない部分は、
 * その部分だけ既定値にする。
 */
export function parsePreferences(json: string | null): ParsedPreferences {
  const raw = parseRoot(json);
  return { raw, llamaServer: normalizeLlamaServer(raw.llamaServer) };
}

/** `raw` の `llamaServer` だけを差し替えた JSON を返す。ほかのトップレベルのキーは保つ。 */
export function serializePreferences(
  raw: Record<string, unknown>,
  llamaServer: LlamaServerPreferences,
): string {
  return JSON.stringify({ ...raw, llamaServer }, null, 2);
}

/** 追加の起動引数の欄(1 行に 1 引数)を配列にする。空行は捨て、前後の空白は除く。 */
export function parseExtraArgsText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** `parseExtraArgsText` の逆。配列を、1 行に 1 引数の文字列にする。 */
export function formatExtraArgsText(extraArgs: readonly string[]): string {
  return extraArgs.join("\n");
}
