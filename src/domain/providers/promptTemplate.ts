/**
 * ローカル推論(OpenAI 互換サーバー)のプロンプトテンプレート。
 * `prompt-template` spec の design.md「promptTemplate」に対応する。
 *
 * - 内蔵プリセットの定義(続き生成の `PROMPT_TEMPLATE_PRESETS`、挿し絵の `ILLUSTRATION_TEMPLATE_PRESETS`)
 * - `sumire.json` の `aiConfig.providers.<id>.template` の生の値の解決(`resolvePromptTemplate`)
 * - 差し込み口に内容を入れた 1 本の文字列への描画(`renderPromptTemplate`)
 * - 差し込み口以外の文字列の取り出し(`templateLiteralText`、トークン数の見積もり用)
 *
 * 純粋な関数とデータだけを持ち、他のモジュールに依存しない。循環を避けるため
 * `types.ts` を import しない(`types.ts` がこのモジュールの型を `import type` で参照する)。
 */

export type PromptTemplateSlot = "system" | "settings" | "body";

export type PromptTemplatePresetName =
  | "gemma4"
  | "gemma4-think"
  | "chatml"
  | "chatml-nothink";

/** テンプレートを、文字列と差し込み口の並びに分けたもの。 */
export type PromptTemplatePart =
  | { kind: "literal"; text: string }
  | { kind: "slot"; slot: PromptTemplateSlot };

export interface ParsedPromptTemplate {
  /** 出典。dev ログやテストで使う。 */
  source: { kind: "preset"; name: PromptTemplatePresetName } | { kind: "custom" };
  parts: readonly PromptTemplatePart[];
  /** テンプレートに含まれる差し込み口。`body` は必ず含む。 */
  slots: ReadonlySet<PromptTemplateSlot>;
}

export type PromptTemplateError =
  | { kind: "unreadable" }
  | { kind: "unknownPreset"; name: string }
  | { kind: "missingBody" }
  | { kind: "duplicateSlot"; slot: PromptTemplateSlot };

export type PromptTemplateResolution =
  | { kind: "none" }
  | { kind: "ok"; template: ParsedPromptTemplate }
  | { kind: "error"; error: PromptTemplateError };

export interface PromptTemplateContents {
  system: string;
  settings: string;
  body: string;
}

/** プリセットの名前からテンプレートの文字列を引く表。続き生成用と挿し絵用がある。 */
export type PromptTemplatePresetTable = Readonly<
  Record<PromptTemplatePresetName, string>
>;

/**
 * 内蔵プリセット(design.md「プリセットの中身」の表)。
 *
 * - `gemma4` / `chatml` / `chatml-nothink` は本文をプロンプトの最後(モデルの番)に置き、
 *   後ろに何も付けない(要件 2.5)。
 * - `gemma4-think` は思考の場所を空けるため、本文を user の番に置き、モデルの番の開始で
 *   終える(要件 2.6)。
 * - BOS はどれにも含めない(推論サーバーが付ける)。
 */
export const PROMPT_TEMPLATE_PRESETS: PromptTemplatePresetTable = Object.freeze({
  gemma4:
    "<|turn>system\n{{system}}<turn|>\n<|turn>user\n{{settings}}<turn|>\n<|turn>model\n<|channel>thought\n<channel|>{{body}}",
  "gemma4-think":
    "<|turn>system\n<|think|>{{system}}<turn|>\n<|turn>user\n{{settings}}\n\n{{body}}<turn|>\n<|turn>model\n",
  chatml:
    "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{settings}}<|im_end|>\n<|im_start|>assistant\n{{body}}",
  "chatml-nothink":
    "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{settings}}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n{{body}}",
});

/**
 * 挿し絵用の内蔵プリセット(`illustration-prompt` spec の design.md「挿し絵用のプリセットの中身」の表)。
 *
 * - 名前は続き生成の表と同じ。どれも内容(指示と文脈)を user の番に置き、
 *   モデルの番の開始でプロンプトを終える(要件 6.4)。
 * - 思考を止める `gemma4` / `chatml-nothink` は、モデルの番の始まりに空の思考を置く。
 *   区切りの綴りは続き生成のプリセットと同じ。
 * - `{{settings}}` は置かない(挿し絵では設定を `{{body}}` の中に入れる)。
 * - BOS はどれにも含めない(推論サーバーが付ける)。
 */
export const ILLUSTRATION_TEMPLATE_PRESETS: PromptTemplatePresetTable = Object.freeze({
  gemma4:
    "<|turn>system\n{{system}}<turn|>\n<|turn>user\n{{body}}<turn|>\n<|turn>model\n<|channel>thought\n<channel|>",
  "gemma4-think":
    "<|turn>system\n<|think|>{{system}}<turn|>\n<|turn>user\n{{body}}<turn|>\n<|turn>model\n",
  chatml:
    "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{body}}<|im_end|>\n<|im_start|>assistant\n",
  "chatml-nothink":
    "<|im_start|>system\n{{system}}<|im_end|>\n<|im_start|>user\n{{body}}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
});

/** 差し込み口の表記(完全一致)。`{{ system }}` のような揺れは文字列として扱う。 */
const SLOT_PATTERN = /\{\{(system|settings|body)\}\}/g;

function isPresetName(
  name: string,
  presets: PromptTemplatePresetTable,
): name is PromptTemplatePresetName {
  return Object.prototype.hasOwnProperty.call(presets, name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * テンプレートの文字列を、文字列と差し込み口の並びに分ける(解決の規則 6, 7)。
 * 重複は本文なしより先に判定する。空の文字列片は並びに入れない。
 */
function parseTemplateText(
  text: string,
  source: ParsedPromptTemplate["source"],
): PromptTemplateResolution {
  const parts: PromptTemplatePart[] = [];
  const slots = new Set<PromptTemplateSlot>();
  let cursor = 0;

  for (const match of text.matchAll(SLOT_PATTERN)) {
    const slot = match[1] as PromptTemplateSlot;
    if (slots.has(slot)) {
      return { kind: "error", error: { kind: "duplicateSlot", slot } };
    }
    slots.add(slot);
    const start = match.index;
    if (start > cursor) {
      parts.push({ kind: "literal", text: text.slice(cursor, start) });
    }
    parts.push({ kind: "slot", slot });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    parts.push({ kind: "literal", text: text.slice(cursor) });
  }

  if (!slots.has("body")) {
    return { kind: "error", error: { kind: "missingBody" } };
  }
  return { kind: "ok", template: { source, parts, slots } };
}

/** `custom` の値をテンプレートの文字列にする。読めない形なら null。 */
function customText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
    return value.join("\n");
  }
  return null;
}

/**
 * テンプレートの指定の生の値を解決する。`AIConfig.template` を読む口はこの関数に限る。
 *
 * `presets` はプリセットの名前を引く表。省略時は続き生成の表(`PROMPT_TEMPLATE_PRESETS`)で、
 * 挿し絵は `ILLUSTRATION_TEMPLATE_PRESETS` を渡す。下の規則は表によらず同じ。
 *
 * 1. `undefined` / `null` → `none`
 * 2. オブジェクトでない(配列を含む)→ `unreadable`
 * 3. `preset` と `custom` の両方がある、またはどちらも無い → `unreadable`(ほかのキーは無視)
 * 4. `preset` が文字列でない → `unreadable`、プリセットに無い名前 → `unknownPreset`
 * 5. `custom` は文字列か文字列だけの配列(`\n` でつなぐ)。それ以外 → `unreadable`
 * 6. 差し込み口の重複 → `duplicateSlot`、`{{body}}` が無い → `missingBody`
 * 7. それ以外は `ok`(本文の後ろの文字列は許す)
 */
export function resolvePromptTemplate(
  raw: unknown,
  presets: PromptTemplatePresetTable = PROMPT_TEMPLATE_PRESETS,
): PromptTemplateResolution {
  if (raw === undefined || raw === null) {
    return { kind: "none" };
  }
  if (!isPlainObject(raw)) {
    return { kind: "error", error: { kind: "unreadable" } };
  }

  const hasPreset = Object.prototype.hasOwnProperty.call(raw, "preset");
  const hasCustom = Object.prototype.hasOwnProperty.call(raw, "custom");
  if (hasPreset === hasCustom) {
    return { kind: "error", error: { kind: "unreadable" } };
  }

  if (hasPreset) {
    const name = raw.preset;
    if (typeof name !== "string") {
      return { kind: "error", error: { kind: "unreadable" } };
    }
    if (!isPresetName(name, presets)) {
      return { kind: "error", error: { kind: "unknownPreset", name } };
    }
    return parseTemplateText(presets[name], {
      kind: "preset",
      name,
    });
  }

  const text = customText(raw.custom);
  if (text === null) {
    return { kind: "error", error: { kind: "unreadable" } };
  }
  return parseTemplateText(text, { kind: "custom" });
}

/**
 * 差し込み口に内容を入れた 1 本の文字列を返す。
 * 文字列片はそのまま、差し込み口は内容をそのまま入れる。内容の中の `{{…}}` は再解釈しない。
 * テンプレートに無い差し込み口の内容は使わない。
 */
export function renderPromptTemplate(
  template: ParsedPromptTemplate,
  contents: PromptTemplateContents,
): string {
  return template.parts
    .map((part) => (part.kind === "literal" ? part.text : contents[part.slot]))
    .join("");
}

/** 差し込み口以外の文字列をつないだもの(トークン数の見積もり用)。 */
export function templateLiteralText(template: ParsedPromptTemplate): string {
  return template.parts
    .map((part) => (part.kind === "literal" ? part.text : ""))
    .join("");
}
