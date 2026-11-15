import i18n from "@/i18n";
import {
  FileCategory,
  listProjectFiles,
  writeFileText,
} from "./filesApi";
import { Frontmatter, stringifyFrontmatter } from "./frontmatter";

const FILENAME_FORBIDDEN = /[\\/:*?"<>|]/g;
const CHAPTER_PREFIX_RE = /^(\d{3})-/;

/**
 * ファイル名禁止文字を半角スペースに置換し、前後空白を圧縮する。
 * 日本語文字はそのまま許容する(URL 安全性は不要、Web 小説向けタイトルを尊重)。
 */
export function slugifyTitle(title: string): string {
  const replaced = title.replace(FILENAME_FORBIDDEN, " ").trim().replace(/\s+/g, " ");
  return replaced;
}

/**
 * 同名衝突を避けるためにサフィックス `-2`, `-3`, ... を追加する。
 * stem は拡張子抜きのファイル名(例: "アリス")。
 */
function pickUniqueStem(stem: string, existing: Set<string>): string {
  if (!existing.has(stem)) return stem;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(i18n.t("error.filenameConflict"));
}

/**
 * 章ファイルの次の連番を返す(3 桁固定、`001` 〜)。
 * 既存の最大連番 + 1。連番付き以外のファイルは無視する(欠番は詰めない)。
 */
export function nextChapterIndex(existingNames: string[]): number {
  let max = 0;
  for (const name of existingNames) {
    const m = name.match(CHAPTER_PREFIX_RE);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * 新規ファイルを作成する。
 *
 * - 章ファイル: ファイル名 `NNN-{slug}.md`、連番自動採番
 * - 設定ファイル: ファイル名 `{slug}.md`、連番なし
 * - 衝突時は `-2`, `-3` を末尾に付与
 * - 中身は YAML フロントマター(title, created)+ 空本文
 *
 * 戻り値: 作成されたファイルの relativePath。呼び出し側で setSelectedFile に渡す想定。
 */
export async function createFile(
  projectPath: string,
  category: FileCategory,
  title: string,
): Promise<{ relativePath: string; name: string }> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw new Error(i18n.t("error.titleRequired"));
  }
  const slug = slugifyTitle(trimmedTitle);
  if (!slug) {
    throw new Error(i18n.t("error.titleInvalid"));
  }

  const existing = await listProjectFiles(projectPath, category);
  const existingStems = new Set<string>(
    existing.map((e) => e.name.replace(/\.md$/i, "")),
  );

  let baseStem: string;
  if (category === "chapters") {
    const idx = nextChapterIndex(existing.map((e) => e.name));
    const numbered = `${String(idx).padStart(3, "0")}-${slug}`;
    baseStem = pickUniqueStem(numbered, existingStems);
  } else {
    baseStem = pickUniqueStem(slug, existingStems);
  }

  const fileName = `${baseStem}.md`;
  const relativePath = `${category}/${fileName}`;

  const fm: Frontmatter = {
    fields: new Map(),
  };
  fm.fields.set("title", trimmedTitle);
  fm.fields.set("created", new Date().toISOString());
  // 設定ファイルは includeInContext を初期 false で書いておく(発見性向上)
  if (category !== "chapters") {
    fm.fields.set("includeInContext", false);
  }

  const content = stringifyFrontmatter(fm) + "\n";
  await writeFileText(projectPath, relativePath, content);

  return { relativePath, name: fileName };
}

