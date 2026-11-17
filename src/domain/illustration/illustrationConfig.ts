/**
 * 挿し絵の情景文の設定(`sumire.json` の `aiConfig.providers.<id>.illustration`)の解決。
 * `illustration-prompt` spec の design.md「illustrationConfig」に対応する。
 *
 * - 生の値を、生成に使う値(テンプレート・指示文・温度・最大トークン・タイムアウト)に解決する
 * - `illustration.template` が無いときは、続き生成のテンプレートのプリセットと同じ名前の
 *   挿し絵用のプリセットを使う(2026-11-17。新規プロジェクトのまま `Alt+I` を使えるように)
 * - 既定値(`ILLUSTRATION_DEFAULTS`)と内蔵の指示文(`DEFAULT_ILLUSTRATION_INSTRUCTION`)を持つ
 *
 * 純粋な関数とデータだけを持つ。DOM・CodeMirror・zustand・i18n は import しない。
 */

import {
  ILLUSTRATION_TEMPLATE_PRESETS,
  resolvePromptTemplate,
  type ParsedPromptTemplate,
  type PromptTemplateError,
} from "@/domain/providers";

export interface IllustrationSettings {
  template: ParsedPromptTemplate;
  instruction: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export type IllustrationConfigError =
  /**
   * illustration が無い、または illustration.template が無く、続き生成のテンプレートも
   * プリセットでない(指定なし・自由記述・不備のある指定)
   */
  | { kind: "missingTemplate" }
  /** illustration がオブジェクトでない */
  | { kind: "unreadable" }
  | { kind: "template"; error: PromptTemplateError };

export type IllustrationConfigResolution =
  | { kind: "ok"; settings: IllustrationSettings }
  | { kind: "error"; error: IllustrationConfigError };

/** 数値の既定値(要件 6.5)。最大トークンは思考と情景文の両方が収まる量にする。 */
export const ILLUSTRATION_DEFAULTS: {
  readonly temperature: 0.7;
  readonly maxTokens: 4096;
  readonly timeoutMs: 180000;
} = Object.freeze({
  temperature: 0.7,
  maxTokens: 4096,
  timeoutMs: 180000,
});

/** 内蔵の指示文(design.md「内蔵の指示文」、要件 3.1〜3.5)。 */
export const DEFAULT_ILLUSTRATION_INSTRUCTION: string = [
  "あなたは小説の挿し絵づくりを手伝うアシスタントです。【挿し絵にする場面】に書かれた場面を、一枚の絵として描くための情景文にまとめてください。【設定】と、場面より前と後の本文は、場面を理解するための材料です。",
  "",
  "- 本文の続きを書いたり、本文を書き換えたりしないでください。",
  "- 人物の位置関係・動作・視線・表情・姿勢、場所、時間・天気・光、絵に必要な小道具、構図(視点、距離感、前景と背景)のうち、本文から読み取れるものを書いてください。",
  "- 人物の外見や衣装は、本文か【設定】に書かれているものだけを書いてください。書かれていない外見・衣装・小物・場所の細部を創作してはいけません。",
  "- 心情は、表情・姿勢・視線・手の動き・距離感など、絵で見える形に置き換えて書いてください。",
  "- 出力は日本語の地の文の情景文だけにしてください。見出し、箇条書き、前置き、説明は書かないでください。",
].join("\n");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 有限の数なら採り、それ以外は既定値(規則 5)。 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 有限の正の数なら採り、それ以外は既定値(規則 5)。 */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * 指示文の上書きを解決する(規則 6)。文字列か文字列だけの配列(`\n` でつなぐ)で、
 * 前後の空白を除いて空でなければ採る。それ以外は内蔵の指示文。
 */
function resolveInstruction(value: unknown): string {
  let text: string | null = null;
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
    text = value.join("\n");
  }
  if (text === null || text.trim() === "") {
    return DEFAULT_ILLUSTRATION_INSTRUCTION;
  }
  return text;
}

/**
 * `illustration.template` が無いときに使う、挿し絵用のテンプレートを決める。
 * 続き生成のテンプレート(`AIConfig.template`)が内蔵プリセットなら、同じ名前の挿し絵用の
 * プリセットを返す。指定なし・自由記述・不備のある指定なら `null`(素の連結には戻さない)。
 * 続き生成の指定の解釈は `resolvePromptTemplate` に任せ、ここで読み直さない。
 */
function templateFromContinuation(continuationTemplate: unknown): ParsedPromptTemplate | null {
  const continuation = resolvePromptTemplate(continuationTemplate);
  if (continuation.kind !== "ok" || continuation.template.source.kind !== "preset") {
    return null;
  }
  const resolution = resolvePromptTemplate(
    { preset: continuation.template.source.name },
    ILLUSTRATION_TEMPLATE_PRESETS,
  );
  return resolution.kind === "ok" ? resolution.template : null;
}

/**
 * `AIConfig.illustration` の生の値を解決する。`AIConfig.illustration` を読む口はこの関数に限る。
 *
 * `continuationTemplate` は続き生成のテンプレートの生の値(`AIConfig.template`)。
 * `illustration.template` が無いときの代わりを決めるためだけに使う。
 *
 * 1. `undefined` / `null` → `{}` と同じに扱う(下の 3 へ)
 * 2. オブジェクトでない(配列を含む)→ `unreadable`
 * 3. `template` が無い(`undefined` / `null`)→ 続き生成のテンプレートが内蔵プリセットなら、
 *    同じ名前の挿し絵用のプリセットを使う。そうでなければ `missingTemplate`
 * 4. `template` は挿し絵用のプリセット表で解決する。不備は `{ kind: "template", error }`
 *    (続き生成のテンプレートには戻さない)
 * 5. `temperature` / `maxTokens` / `timeoutMs` は、有限の数で `maxTokens` / `timeoutMs` が正なら採り、
 *    それ以外は黙って既定値にする
 * 6. `instruction` は文字列か文字列の配列(`\n` でつなぐ)。空や読めない形なら内蔵の指示文
 * 7. ほかのキーは無視する
 */
export function resolveIllustrationConfig(
  raw: unknown,
  continuationTemplate?: unknown,
): IllustrationConfigResolution {
  const section: unknown = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(section)) {
    return { kind: "error", error: { kind: "unreadable" } };
  }

  let template: ParsedPromptTemplate;
  const resolution = resolvePromptTemplate(section.template, ILLUSTRATION_TEMPLATE_PRESETS);
  if (resolution.kind === "error") {
    return { kind: "error", error: { kind: "template", error: resolution.error } };
  }
  if (resolution.kind === "none") {
    // template が undefined / null。続き生成のプリセットと同じ名前を使う
    const fallback = templateFromContinuation(continuationTemplate);
    if (fallback === null) {
      return { kind: "error", error: { kind: "missingTemplate" } };
    }
    template = fallback;
  } else {
    template = resolution.template;
  }

  return {
    kind: "ok",
    settings: {
      template,
      instruction: resolveInstruction(section.instruction),
      temperature: finiteOr(section.temperature, ILLUSTRATION_DEFAULTS.temperature),
      maxTokens: positiveOr(section.maxTokens, ILLUSTRATION_DEFAULTS.maxTokens),
      timeoutMs: positiveOr(section.timeoutMs, ILLUSTRATION_DEFAULTS.timeoutMs),
    },
  };
}
