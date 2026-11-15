import type { FileEntry } from "@/domain/project/filesApi";

/**
 * ファイル一覧を `archived` フラグでアクティブ / アーカイブ済みに分割する。
 *
 * - `archivedSet` に含まれる relativePath を archived に、それ以外を active に振り分ける
 * - 元の配列順序は保持する(active 内・archived 内の並び順が安定)
 * - 純粋関数(I/O なし)。store 側の同期スナップショットを `Set<string>` として渡す
 *
 * 既存ツリーの items.map() を 2 段表示に拡張するための内部ヘルパ。
 */
export interface PartitionResult {
  active: FileEntry[];
  archived: FileEntry[];
}

export function partitionByArchived(
  entries: FileEntry[],
  archivedSet: ReadonlySet<string>,
): PartitionResult {
  const active: FileEntry[] = [];
  const archived: FileEntry[] = [];
  for (const entry of entries) {
    if (archivedSet.has(entry.relativePath)) {
      archived.push(entry);
    } else {
      active.push(entry);
    }
  }
  return { active, archived };
}
