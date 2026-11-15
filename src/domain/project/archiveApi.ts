import { readFileText, writeFileText } from "./filesApi";
import {
  Frontmatter,
  getBoolean,
  updateFrontmatterField,
} from "./frontmatter";
import { refreshIncludedSettings } from "./settingsApi";
import { refreshArchivedFiles } from "@/stores/archivedFilesStore";

/**
 * アーカイブ状態の読み書き API。
 *
 * `includeInContext` の動線(`settingsApi.setIncludeInContext`)と完全な並列構造で実装する。
 * 違いは frontmatter キーが `archived` であること、書き換え後の store 同期方法のみ。
 *
 * 不変条件:
 * - 本文(body)には一切手を加えない(`updateFrontmatterField` が body を保持するため自動的に満たされる)
 * - `includeInContext` を含む他の frontmatter キーの値は変化しない
 * - `setArchived` を 1 度も呼ばないファイルには `archived` キーが追加されない(Requirement 5.3)
 */

/**
 * 単一ファイルの archived フラグを切り替える。
 *
 * - ファイル全文を読み、frontmatter の `archived` キーを更新して書き戻す
 * - 書き換え後に `refreshIncludedSettings` を呼び、`useSettingsContextStore` を再同期する
 *   (アーカイブされたファイルが store から掃き出される / 解除されたファイルが復帰する)
 * - 続けて `refreshArchivedFiles` を呼び、ツリー描画用の `useArchivedFilesStore` も
 *   同期する(アクティブ / アーカイブ済みサブグループの再分類が反映される)
 *
 * @param projectPath プロジェクトルートの絶対パス
 * @param relativePath プロジェクトルートからの相対パス(POSIX 区切り)
 * @param archived 設定する値(true でアーカイブ、false でアクティブ)
 */
export async function setArchived(
  projectPath: string,
  relativePath: string,
  archived: boolean,
): Promise<void> {
  const text = await readFileText(projectPath, relativePath);
  const updated = updateFrontmatterField(text, "archived", archived);
  await writeFileText(projectPath, relativePath, updated);
  // `useSettingsContextStore`(プロンプト流入対象キャッシュ)と
  // `useArchivedFilesStore`(ツリー描画の分類キャッシュ)を両方同期する。
  // 順序に依存はないが、書き込み完了後に直列で呼んで最終状態を確定させる。
  await refreshIncludedSettings(projectPath);
  await refreshArchivedFiles(projectPath);
}

/**
 * パース済み frontmatter からアーカイブ状態を判定する。
 *
 * `archived` キーが無い場合 / `archived: false` の場合はアクティブ扱い(=`false` を返す)。
 * 既存プロジェクト互換(Requirement 5.1)。
 */
export function isArchived(frontmatter: Frontmatter | null): boolean {
  return getBoolean(frontmatter, "archived");
}
