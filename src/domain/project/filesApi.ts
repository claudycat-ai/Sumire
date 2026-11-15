import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  /** プロジェクトルートからの相対パス(POSIX 区切り)。 */
  relativePath: string;
  /** 表示用ファイル名(拡張子含む)。 */
  name: string;
}

/** プロジェクト内のファイルカテゴリ。サブディレクトリ名と一致する。 */
export type FileCategory =
  | "chapters"
  | "characters"
  | "worldbuilding"
  | "glossary"
  | "plot";

/** カテゴリの表示順。 */
export const CATEGORY_ORDER: FileCategory[] = [
  "chapters",
  "characters",
  "worldbuilding",
  "glossary",
  "plot",
];

/** カテゴリの種別(本文 or 設定)。選択時の挙動を決めるのに使う。 */
export function categoryKind(category: FileCategory): "chapter" | "settings" {
  return category === "chapters" ? "chapter" : "settings";
}

interface RawFileEntry {
  relative_path: string;
  name: string;
}

/** 指定カテゴリの Markdown ファイル一覧を取得する。 */
export async function listProjectFiles(
  projectPath: string,
  category: FileCategory,
): Promise<FileEntry[]> {
  const raw = await invoke<RawFileEntry[]>("list_project_files", {
    projectPath,
    subdir: category,
  });
  return raw.map((e) => ({
    relativePath: e.relative_path,
    name: e.name,
  }));
}

/** プロジェクト内ファイルの内容を文字列で取得する。 */
export async function readFileText(
  projectPath: string,
  relativePath: string,
): Promise<string> {
  return invoke<string>("read_file_text", { projectPath, relativePath });
}

/** プロジェクト内ファイルに文字列を書き込む(上書き)。 */
export async function writeFileText(
  projectPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await invoke("write_file_text", { projectPath, relativePath, content });
}
