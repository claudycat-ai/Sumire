/**
 * Sumire 用の最小フロントマターパーサ。
 *
 * Sumire の Markdown ファイルは仕様で
 * `---\n<key>: <value>\n...\n---\n` 形式と決まっており、
 * フィールドも限定的(title / created / updated / includeInContext 程度)。
 * 一般的な YAML パーサ(js-yaml)を依存させるほどの複雑さは無いため、
 * 最小限の自前実装でカバーする。
 *
 * 制限:
 * - ネスト構造、配列、複数行値、引用符は扱わない
 * - 値は文字列として読み出し、boolean(`true`/`false`)だけは特例で boolean 化する
 * - パースに失敗した行は無視される(ファイル全体を破壊的に書き換えない)
 *
 * 仕様: docs/spec/02-architecture.md §249-280
 */

export type FrontmatterValue = string | boolean;

export interface Frontmatter {
  /** key は登場順を保持する。書き戻し時の順序を維持するため。 */
  fields: Map<string, FrontmatterValue>;
}

export interface ParsedFile {
  frontmatter: Frontmatter | null;
  body: string;
}

/**
 * ファイル全文を frontmatter と body に分解する。
 * 先頭が `---\n` で始まり、後続行に `---\n` が出てくる場合のみ frontmatter ありと判定する。
 */
export function parseFile(text: string): ParsedFile {
  // BOM や CR を除去した上で判定する
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { frontmatter: null, body: text };
  }

  // `---` の最初の行を読み飛ばす
  const afterFirst = normalized.replace(/^---\r?\n/, "");
  // 行頭の `---` で終わる箇所を探す(改行込みで一致させる)
  const closeMatch = afterFirst.match(/^---\r?\n?/m);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: null, body: text };
  }
  const headerText = afterFirst.slice(0, closeMatch.index);
  const body = afterFirst.slice(closeMatch.index + closeMatch[0].length);
  const fields = parseFields(headerText);
  return { frontmatter: { fields }, body };
}

function parseFields(text: string): Map<string, FrontmatterValue> {
  const map = new Map<string, FrontmatterValue>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    map.set(key, coerce(value));
  }
  return map;
}

function coerce(raw: string): FrontmatterValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  // 単純な引用符は剥がす(value: "foo" → foo)
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Frontmatter を文字列に直列化する(書き戻し用)。 */
export function stringifyFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ["---"];
  for (const [key, value] of fm.fields) {
    lines.push(`${key}: ${stringifyValue(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function stringifyValue(v: FrontmatterValue): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

/**
 * 既存ファイル本文に対して frontmatter フィールドを更新する。
 * frontmatter が無い場合は新規に追加する。
 *
 * `body` は元の body をそのまま保持する(書き換えない)。
 */
export function updateFrontmatterField(
  text: string,
  key: string,
  value: FrontmatterValue,
): string {
  const parsed = parseFile(text);
  const fields = new Map(parsed.frontmatter?.fields ?? []);
  fields.set(key, value);
  const fm: Frontmatter = { fields };
  return stringifyFrontmatter(fm) + parsed.body;
}

/** key を取り出す。boolean 型を期待する場合は getBoolean を使う。 */
export function getField(
  fm: Frontmatter | null,
  key: string,
): FrontmatterValue | undefined {
  return fm?.fields.get(key);
}

export function getBoolean(fm: Frontmatter | null, key: string): boolean {
  const v = getField(fm, key);
  return v === true;
}

export function getString(fm: Frontmatter | null, key: string): string | undefined {
  const v = getField(fm, key);
  return typeof v === "string" ? v : undefined;
}
