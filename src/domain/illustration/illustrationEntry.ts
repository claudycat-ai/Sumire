/**
 * 挿し絵の情景文をメモに追記するときのエントリ本文を整形する。
 *
 * 区切り(`***`)と日時は `formatMemoEntry`(domain/memo/memoApi.ts)が付けるので、ここでは付けない。
 * 文言は i18n を通さず固定にする。メモに残る本文は表示言語で変わらないほうがよい
 * (`formatMemoEntry` の日時と同じ扱い)。
 */

export interface IllustrationEntrySource {
  /** 生成を始めたときの章ファイル名(拡張子つき) */
  chapterName: string;
  /** 場面の冒頭(sceneSelection が作る) */
  sceneHead: string;
}

/** 生成の上限で情景文が途中で切れたときに、情景文の次の行に足す注記(7.7)。 */
export const ILLUSTRATION_TRUNCATED_NOTE = "(生成の上限に達したため、ここで途切れています)";

/**
 * appendToMemo に渡すテキスト。区切りと日時は formatMemoEntry が付ける。
 *
 * - 1 行目: `〔挿し絵〕{chapterName}「{sceneHead}」`(4.2)
 * - 2 行目以降: 前後の空白を除いた情景文。`trim()` は全角空白(U+3000)も除く
 * - `truncated` のとき: 空行を挟まず、情景文の次の行に注記を足す(7.7)
 */
export function formatIllustrationEntry(
  source: IllustrationEntrySource,
  text: string,
  truncated: boolean,
): string {
  const lines = [`〔挿し絵〕${source.chapterName}「${source.sceneHead}」`, text.trim()];
  if (truncated) lines.push(ILLUSTRATION_TRUNCATED_NOTE);
  return lines.join("\n");
}
