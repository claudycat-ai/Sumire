import {
  CATEGORY_ORDER,
  FileCategory,
  listProjectFiles,
  readFileText,
  writeFileText,
} from "./filesApi";
import {
  getBoolean,
  getString,
  parseFile,
  updateFrontmatterField,
} from "./frontmatter";
import { useSettingsContextStore, IncludedFile } from "@/stores/settingsContextStore";

/** 設定ファイル(章を除く)のカテゴリだけ。 */
const SETTINGS_CATEGORIES: FileCategory[] = CATEGORY_ORDER.filter(
  (c) => c !== "chapters",
);

/**
 * プロジェクト全体の設定ファイルをスキャンし、
 * `includeInContext: true` のファイルを settingsContextStore に流し込む。
 *
 * プロジェクトオープン時・ファイル新規作成後・トグル変更時に呼ぶ。
 */
export async function refreshIncludedSettings(projectPath: string): Promise<void> {
  const store = useSettingsContextStore.getState();
  store.clear();

  for (const category of SETTINGS_CATEGORIES) {
    const entries = await listProjectFiles(projectPath, category);
    for (const entry of entries) {
      const text = await readFileText(projectPath, entry.relativePath);
      const parsed = parseFile(text);
      if (!getBoolean(parsed.frontmatter, "includeInContext")) continue;
      if (getBoolean(parsed.frontmatter, "archived")) continue;
      const title = getString(parsed.frontmatter, "title") ?? entry.name;
      const file: IncludedFile = {
        relativePath: entry.relativePath,
        category,
        title,
        body: parsed.body.trim(),
      };
      store.upsertFile(file);
    }
  }
}

/**
 * 単一ファイルの includeInContext トグルを切り替える。
 *
 * - ファイル全文を読み、frontmatter の includeInContext を更新して書き戻す
 * - settingsContextStore のキャッシュも同期する
 */
export async function setIncludeInContext(
  projectPath: string,
  category: FileCategory,
  relativePath: string,
  include: boolean,
): Promise<void> {
  const text = await readFileText(projectPath, relativePath);
  const updated = updateFrontmatterField(text, "includeInContext", include);
  await writeFileText(projectPath, relativePath, updated);

  const store = useSettingsContextStore.getState();
  const parsed = parseFile(updated);
  // archived 判定が includeInContext より優先(Requirement 3.2)。
  // frontmatter は将来の解除に備えて include 値を保持するが、store には投入しない。
  if (getBoolean(parsed.frontmatter, "archived")) {
    store.removeFile(relativePath);
    return;
  }
  if (include) {
    const title = getString(parsed.frontmatter, "title") ?? relativePath;
    store.upsertFile({
      relativePath,
      category,
      title,
      body: parsed.body.trim(),
    });
  } else {
    store.removeFile(relativePath);
  }
}

/**
 * 編集中の設定ファイル本文に変更があった場合、includeInContext: true なら
 * キャッシュ(=次の生成リクエストで使われる本文)も追従更新する。
 */
export function syncIncludedBody(
  relativePath: string,
  category: FileCategory,
  text: string,
): void {
  const parsed = parseFile(text);
  const include = getBoolean(parsed.frontmatter, "includeInContext");
  const archived = getBoolean(parsed.frontmatter, "archived");
  const store = useSettingsContextStore.getState();
  // archived 判定が includeInContext より優先(Requirement 3.2)。
  if (archived || !include) {
    store.removeFile(relativePath);
    return;
  }
  const title = getString(parsed.frontmatter, "title") ?? relativePath;
  store.upsertFile({
    relativePath,
    category,
    title,
    body: parsed.body.trim(),
  });
}
