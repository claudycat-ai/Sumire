import { stripRuby } from "@/editor/rubyDecoration";

/**
 * 仕様 (01-ux.md) に従い文字数を計算する。
 *
 * - ルビ記法 |ベース《ふりがな》 を取り除いた本文だけが対象
 * - 改行は除く、半角・全角スペースは含む
 * - YAML フロントマター(先頭の `---` ブロック)の除外は MVP 後に実装する
 */
export function countCharacters(doc: string): number {
  const stripped = stripRuby(doc);
  // 改行(LF / CRLF どちらでも)を取り除く
  const noNewline = stripped.replace(/\r?\n/g, "");
  // Unicode コードポイント単位で数える(サロゲートペア対応)
  return [...noNewline].length;
}
