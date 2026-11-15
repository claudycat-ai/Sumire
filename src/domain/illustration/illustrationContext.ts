/**
 * 挿し絵の情景文の文脈の組み立てと、コンテキスト窓への予算配分。
 * `illustration-prompt` spec の design.md「illustrationContext」に対応する。
 *
 * - 場面・前後の本文・設定を、見出し付きの 1 本の `body` にまとめる(要件 2.7)
 * - 窓に収まらなければ、設定を挿入順の後ろから外し、前後の本文を場面から遠い側から削る。
 *   場面そのものは削らない(要件 2.3〜2.6)
 *
 * トークン計測のために `getProvider` と `contextBuilder` の公開関数だけを使う。
 * DOM・CodeMirror・zustand・i18n は直接 import しない(設定ファイルは `packSettingSections` 経由で読む)。
 */

import {
  getProvider,
  joinSections,
  templateLiteralText,
  type AIConfig,
  type AIProvider,
  type ContextSection,
} from "@/domain/providers";
import {
  measureSectionCached,
  packSettingSections,
  trimBodyHead,
  trimBodyTail,
} from "@/domain/context/contextBuilder";
import type { IllustrationSettings } from "./illustrationConfig";

/** 場面と、その前後の本文。場面の取り出し(sceneSelection)もこの型を使う。 */
export interface SceneText {
  /** 場面(ルビ剥がし済み)。空白だけではない。 */
  scene: string;
  /** 今の章の、フロントマターを除いた本文のうち場面より前(ルビ剥がし済み)。 */
  before: string;
  /** 場面より後(ルビ剥がし済み)。 */
  after: string;
}

export interface IllustrationContextInput {
  /** トークン計測、contextWindow、settingsTokenBudget に使う。 */
  aiConfig: AIConfig;
  settings: IllustrationSettings;
  scene: SceneText;
}

export type IllustrationContextResult =
  | {
      kind: "ok";
      /** = settings.instruction(テンプレートに {{system}} があるときだけ計測に入れる)。 */
      systemPrompt: string;
      /** 見出し付きの文脈。 */
      body: string;
      /** 外した設定ファイルの表示名。予算で外したもの(挿入順)→ 窓であふれて外したもの(外した順)。 */
      droppedSettings: string[];
    }
  | { kind: "sceneTooLong" };

export const ILLUSTRATION_BLOCK_LABELS: {
  readonly settings: "【設定】";
  readonly before: "【場面より前の本文】";
  readonly scene: "【挿し絵にする場面】";
  readonly after: "【場面より後の本文】";
} = Object.freeze({
  settings: "【設定】",
  before: "【場面より前の本文】",
  scene: "【挿し絵にする場面】",
  after: "【場面より後の本文】",
});

/** 内容が空(空白だけを含む)のブロックは見出しごと出さない。 */
function isBlank(content: string): boolean {
  return content.trim() === "";
}

/** 設定ブロックの内容と、そのトークン数(見出しを含む。空なら 0)。 */
async function measureSettingsBlock(
  provider: AIProvider,
  accepted: ContextSection[],
): Promise<{ content: string; tokens: number }> {
  const content = joinSections(accepted);
  if (isBlank(content)) return { content: "", tokens: 0 };
  let tokens = await measureSectionCached(provider, ILLUSTRATION_BLOCK_LABELS.settings);
  for (const section of accepted) {
    tokens += await measureSectionCached(provider, section.content);
  }
  return { content, tokens };
}

/**
 * 見出し付きの文脈を組み立て、コンテキスト窓に収める(design.md「予算配分」1〜5)。
 *
 * 1. `R0 = W − 指示({{system}} があるとき)− テンプレートの文字列 − 設定ブロック − 場面ブロック
 *    − 前後の見出しの分 − maxTokens`
 * 2. 設定は `packSettingSections` で予算まで詰め、入らなかった名前を `droppedSettings` に入れる
 * 3. `R0 < 0` なら、採用した設定を挿入順の後ろから 1 件ずつ外して計算し直す。0 件でも
 *    `R0 < 0` なら `sceneTooLong`。場面は削らない
 * 4. 後ろの本文は `min(後ろの全量, floor(R0 / 4))` まで末尾から削る
 * 5. 前の本文は `R0 − 実際に入れた後ろ` まで先頭から削る
 *
 * ブロック間の `\n\n` と、境目のトークン化による 1〜2 トークンのずれは、続き生成と同じく許容する。
 */
export async function buildIllustrationContext(
  input: IllustrationContextInput,
): Promise<IllustrationContextResult> {
  const { aiConfig, settings, scene } = input;
  const provider = getProvider(aiConfig);
  const window = aiConfig.contextWindow ?? 2048;
  const settingsBudget = aiConfig.settingsTokenBudget ?? 500;
  const reserved = Math.max(0, settings.maxTokens);
  const L = ILLUSTRATION_BLOCK_LABELS;

  // 指示文は {{system}} の差し込み口があるときだけプロンプトに入るので、そのときだけ数える。
  const instructionTokens =
    settings.template.slots.has("system") && !isBlank(settings.instruction)
      ? await measureSectionCached(provider, settings.instruction)
      : 0;
  const templateTokens = await measureSectionCached(
    provider,
    templateLiteralText(settings.template),
  );

  // 場面のブロックは必ず出し、削らない。
  const sceneTokens =
    (await measureSectionCached(provider, L.scene)) + (await provider.countTokens(scene.scene));

  // 前後の見出しは、本文があるときだけ出すので、そのときだけ数える。
  const hasBefore = !isBlank(scene.before);
  const hasAfter = !isBlank(scene.after);
  const headingTokens =
    (hasBefore ? await measureSectionCached(provider, L.before) : 0) +
    (hasAfter ? await measureSectionCached(provider, L.after) : 0);

  const fixedTokens = instructionTokens + templateTokens + sceneTokens + headingTokens + reserved;

  // 2. 設定を予算まで詰める。
  const packed = await packSettingSections(provider, settingsBudget);
  const accepted = [...packed.accepted];
  const droppedSettings = [...packed.dropped];

  // 3. 窓からあふれるなら、設定を挿入順の後ろから 1 件ずつ外す。
  let settingsBlock = await measureSettingsBlock(provider, accepted);
  let r0 = window - fixedTokens - settingsBlock.tokens;
  while (r0 < 0 && accepted.length > 0) {
    const removed = accepted.pop()!;
    droppedSettings.push(removed.label);
    settingsBlock = await measureSettingsBlock(provider, accepted);
    r0 = window - fixedTokens - settingsBlock.tokens;
  }
  if (r0 < 0) {
    return { kind: "sceneTooLong" };
  }

  // 4. 後ろの本文: 残りの 1/4 まで、場面から遠い末尾から削る。
  let after = "";
  let afterTokens = 0;
  if (hasAfter) {
    const afterTotal = await provider.countTokens(scene.after);
    const afterBudget = Math.min(afterTotal, Math.floor(r0 / 4));
    after = await trimBodyTail(provider, scene.after, afterBudget);
    afterTokens = after === "" ? 0 : await provider.countTokens(after);
  }

  // 5. 前の本文: 残り全部まで、場面から遠い先頭から削る。
  const before = hasBefore ? await trimBodyHead(provider, scene.before, r0 - afterTokens) : "";

  const blocks: string[] = [];
  if (!isBlank(settingsBlock.content)) blocks.push(`${L.settings}\n${settingsBlock.content}`);
  if (!isBlank(before)) blocks.push(`${L.before}\n${before}`);
  blocks.push(`${L.scene}\n${scene.scene}`);
  if (!isBlank(after)) blocks.push(`${L.after}\n${after}`);

  return {
    kind: "ok",
    systemPrompt: settings.instruction,
    body: blocks.join("\n\n"),
    droppedSettings,
  };
}
