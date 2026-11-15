import { create } from "zustand";
import {
  CATEGORY_ORDER,
  listProjectFiles,
  readFileText,
} from "@/domain/project/filesApi";
import { getBoolean, parseFile } from "@/domain/project/frontmatter";

/**
 * プロジェクト内のうち、frontmatter で `archived: true` がマークされた
 * ファイルの相対パスだけを保持するキャッシュ。
 *
 * `useSettingsContextStore` は `includeInContext: true` の設定ファイル本文も
 * キャッシュするのに対し、こちらはツリー描画(=分類)用途なので
 * relativePath の Set だけを持つ。
 *
 * 同期タイミング:
 * - プロジェクトオープン時(ツリー初回描画と並列)
 * - `archiveApi.setArchived` 実行後
 *
 * 章ファイルもアーカイブ対象なのでスキャン対象に含む(設定ファイルだけを
 * 見る `useSettingsContextStore` と異なる)。
 */
interface ArchivedFilesState {
  relativePaths: Set<string>;
  setAll: (paths: Iterable<string>) => void;
  clear: () => void;
}

export const useArchivedFilesStore = create<ArchivedFilesState>((set) => ({
  relativePaths: new Set<string>(),
  setAll: (paths) => set({ relativePaths: new Set(paths) }),
  clear: () => set({ relativePaths: new Set() }),
}));

/**
 * プロジェクト全体の Markdown ファイルをスキャンし、
 * `archived: true` のものを `useArchivedFilesStore` に流し込む。
 *
 * 既存の `listProjectFiles` は `archived` を返さないため、
 * 各ファイルを `readFileText` + frontmatter パースで判定する。
 * I/O コストは「全ファイル × ファイルサイズ」だが、`refreshIncludedSettings`
 * とほぼ同じパスを通る既存パターンなので追加負担は限定的。
 */
export async function refreshArchivedFiles(projectPath: string): Promise<void> {
  const archived = new Set<string>();
  for (const category of CATEGORY_ORDER) {
    const entries = await listProjectFiles(projectPath, category);
    for (const entry of entries) {
      const text = await readFileText(projectPath, entry.relativePath);
      const parsed = parseFile(text);
      // archiveApi.isArchived と同等(getBoolean(... "archived"))。
      // archiveApi → store の循環参照を避けるためここでは getBoolean を直接呼ぶ。
      if (getBoolean(parsed.frontmatter, "archived")) {
        archived.add(entry.relativePath);
      }
    }
  }
  useArchivedFilesStore.getState().setAll(archived);
}
