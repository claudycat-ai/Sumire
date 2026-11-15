/**
 * AI 設定画面でのプロンプトテンプレートの選択(`template-settings-ui` spec)。
 *
 * - いまの指定を 4 つの状態(指定なし / プリセット / 自由記述 / 読めない指定)に分ける
 * - 選択肢から、保存する `template` の値を作る
 * - プリセットごとの付帯情報(思考の有無、思考を分けるのに要るタグの組)を持つ
 * - 思考ありのプリセットを選んだときに、`thinking.tags` に要る組を足す
 *
 * 状態を持たず、保存も表示もしない純粋な関数とデータだけを持つ。
 * テンプレートの解釈は `resolvePromptTemplate` に任せ、ここで解釈し直さない。
 * `promptTemplate.ts` からこのモジュールへの依存は作らない。
 */
import {
  resolvePromptTemplate,
  type PromptTemplateError,
  type PromptTemplatePresetName,
} from "./promptTemplate";
import {
  DEFAULT_THINKING_CONFIG,
  type ThinkingConfig,
  type ThinkingTagPair,
} from "./types";

/** 画面で選べる選択肢。 */
export type TemplateChoice = "none" | PromptTemplatePresetName;

/** 並びを固定した選択肢の一覧(「指定なし」が先頭)。 */
export const TEMPLATE_CHOICES: readonly TemplateChoice[] = Object.freeze([
  "none",
  "gemma4",
  "gemma4-think",
  "chatml",
  "chatml-nothink",
]);

/** いまの指定の状態。 */
export type TemplateSelectionState =
  | { kind: "none" }
  | { kind: "preset"; name: PromptTemplatePresetName }
  | { kind: "custom"; invalid: boolean }
  | { kind: "unreadable"; error: PromptTemplateError };

export interface TemplatePresetInfo {
  /** 思考ありのプリセットか。 */
  thinking: boolean;
  /** 思考を本文と分けるのに要るタグの組。要らなければ空。 */
  requiredThinkingTags: readonly ThinkingTagPair[];
}

/** Gemma 4 の思考のチャンネルを囲むタグの組。 */
const GEMMA4_THINKING_TAGS: ThinkingTagPair = Object.freeze({
  open: "<|channel>",
  close: "<channel|>",
});

/**
 * プリセットごとの付帯情報。型を `Record<PromptTemplatePresetName, …>` にして、
 * プリセットを足したときの足し忘れをコンパイル時に検出する。
 */
export const TEMPLATE_PRESET_INFO: Readonly<
  Record<PromptTemplatePresetName, TemplatePresetInfo>
> = Object.freeze({
  gemma4: { thinking: false, requiredThinkingTags: [] },
  "gemma4-think": {
    thinking: true,
    requiredThinkingTags: [GEMMA4_THINKING_TAGS],
  },
  chatml: { thinking: false, requiredThinkingTags: [] },
  "chatml-nothink": { thinking: false, requiredThinkingTags: [] },
});

/** Max Tokens の案内を出す境目(この値未満で出す)。 */
export const THINKING_MAX_TOKENS_HINT = 1000;

/** `template` の生の値を、4 つの状態のどれかに分ける。 */
export function describeTemplateSelection(raw: unknown): TemplateSelectionState {
  const resolution = resolvePromptTemplate(raw);
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "ok": {
      const source = resolution.template.source;
      return source.kind === "preset"
        ? { kind: "preset", name: source.name }
        : { kind: "custom", invalid: false };
    }
    case "error": {
      const error = resolution.error;
      if (error.kind === "missingBody" || error.kind === "duplicateSlot") {
        return { kind: "custom", invalid: true };
      }
      return { kind: "unreadable", error };
    }
  }
}

/** 選択肢から、保存する `template` の値を作る。「指定なし」は `undefined`(キーごと無くなる)。 */
export function templateValueForChoice(
  choice: TemplateChoice,
): { preset: PromptTemplatePresetName } | undefined {
  return choice === "none" ? undefined : { preset: choice };
}

/** いまの状態と選択肢が同じか。自由記述と読めない指定は、どの選択肢とも一致しない。 */
export function isSameChoice(
  state: TemplateSelectionState,
  choice: TemplateChoice,
): boolean {
  if (state.kind === "none") return choice === "none";
  if (state.kind === "preset") return state.name === choice;
  return false;
}

/** 選び直すと、いまの記述が置き換わるので確認が要るか。 */
export function needsConfirm(state: TemplateSelectionState): boolean {
  return state.kind === "custom" || state.kind === "unreadable";
}

export interface ThinkingTagsResult {
  /** 書き換えるときの新しい設定。書き換えないときは `null`。 */
  next: ThinkingConfig | null;
  /** 思考の分離が無効にされていて、足さなかった。 */
  disabled: boolean;
}

function samePair(a: ThinkingTagPair, b: ThinkingTagPair): boolean {
  return a.open === b.open && a.close === b.close;
}

function copyPair(pair: ThinkingTagPair): ThinkingTagPair {
  return { open: pair.open, close: pair.close };
}

/**
 * 思考を分けるのに要るタグの組を、思考の分離の設定に足す。
 *
 * 1. 思考の分離が無効なら、足さない(有効にもしない)
 * 2. 要る組が空なら、書き換えない
 * 3. 要る組がすべてあれば、書き換えない
 * 4. 今の組をそのまま残し、有効な組が 1 つも無ければ既定の組を足し、最後に無い組を足す。
 *    `resolveThinkingTags` は有効な組が 1 つでもあると既定の組を使わないので、
 *    既定の組を書かないと `<think>` の分離が外れてしまう
 *
 * 今ある組は消さず、順序も変えない。引数を書き換えず、返す設定は引数と配列や組を共有しない。
 */
export function ensureThinkingTags(
  current: ThinkingConfig | undefined,
  required: readonly ThinkingTagPair[],
): ThinkingTagsResult {
  if (current?.enabled === false) {
    return { next: null, disabled: true };
  }
  const currentTags = current?.tags ?? [];
  const missing = required.filter(
    (pair) => !currentTags.some((tag) => samePair(tag, pair)),
  );
  if (missing.length === 0) {
    return { next: null, disabled: false };
  }

  const hasValidPair = currentTags.some(
    (pair) => pair.open !== "" && pair.close !== "",
  );
  const defaults = hasValidPair ? [] : (DEFAULT_THINKING_CONFIG.tags ?? []);
  const tags = [...currentTags, ...defaults, ...missing].map(copyPair);

  const next: ThinkingConfig = {};
  if (current?.enabled !== undefined) next.enabled = current.enabled;
  next.tags = tags;
  return { next, disabled: false };
}

export interface TemplateChangePlan {
  /** 保存する `template` の値。 */
  template: { preset: PromptTemplatePresetName } | undefined;
  /** 保存する `thinking` の値。書き換えないときは `null`。 */
  thinking: ThinkingConfig | null;
  /** タグの組を足した。 */
  tagsAdded: boolean;
}

/**
 * 選択肢から、保存する `template` と `thinking` の変更をまとめて求める。
 * 思考ありでない選択肢では、思考の分離の設定を書き換えない(足した組を消すこともしない)。
 */
export function planTemplateChange(
  choice: TemplateChoice,
  currentThinking: ThinkingConfig | undefined,
): TemplateChangePlan {
  const template = templateValueForChoice(choice);
  if (choice === "none") {
    return { template, thinking: null, tagsAdded: false };
  }
  const required = TEMPLATE_PRESET_INFO[choice].requiredThinkingTags;
  if (required.length === 0) {
    return { template, thinking: null, tagsAdded: false };
  }
  const { next } = ensureThinkingTags(currentThinking, required);
  return { template, thinking: next, tagsAdded: next !== null };
}

function isThinkingPreset(state: TemplateSelectionState): boolean {
  return state.kind === "preset" && TEMPLATE_PRESET_INFO[state.name].thinking;
}

/** 思考ありのプリセットで、Max Tokens が案内の境目より小さいか。 */
export function shouldHintMaxTokens(
  state: TemplateSelectionState,
  maxTokens: number,
): boolean {
  if (!Number.isFinite(maxTokens)) return false;
  return isThinkingPreset(state) && maxTokens < THINKING_MAX_TOKENS_HINT;
}

/**
 * 思考ありのプリセットなのに、思考の分離が無効にされているか。
 * 無効の判定は `resolveThinkingTags` と同じ(`enabled: false` のときだけ無効、省略は有効)。
 */
export function isThinkingDisabledFor(
  state: TemplateSelectionState,
  thinking: ThinkingConfig | undefined,
): boolean {
  return isThinkingPreset(state) && thinking?.enabled === false;
}
