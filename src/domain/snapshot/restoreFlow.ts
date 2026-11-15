import { writeFileText } from "@/domain/project/filesApi";
import { refreshIncludedSettings } from "@/domain/project/settingsApi";
import type { SnapshotPayload } from "@/domain/snapshot/snapshotApi";
import { useAppStore } from "@/stores/appStore";
import { useSnapshotStore } from "@/stores/snapshotStore";

/**
 * スナップショットから復元する。
 *
 * - スナップショット内のすべてのファイルを書き戻す
 * - スナップショットに **無い** ファイル(=スナップショット時点以降に作成されたファイル)は
 *   削除しない(安全側)
 * - 復元後、現在開いている章/設定/メモエディタは「キーが変わっていれば」自動で再ロードされる
 *   が、章タブのキーは relativePath で同一のままなので明示再マウントが必要
 *
 * MVP では再マウントトリガーとして:
 *   - selectedChapter / selectedSettings をいったん null → 元の値に戻す手は取れるが煩雑なため、
 *     `setSelectedFile(null)` で全ペインを未選択状態に戻す。書き手が左ペインからもう一度開く動線。
 *
 * 将来的にはエディタの key に snapshotRevision を含めて自動再ロードする方が UX 良いが、
 * 履歴復元は頻度が低い操作なのでこの簡易版で開始する。
 */
export async function performRestore(
  projectPath: string,
  snapshot: SnapshotPayload,
): Promise<void> {
  const setSelectedFile = useAppStore.getState().setSelectedFile;

  // 1. すべてのファイルを書き戻す
  for (const [relPath, content] of Object.entries(snapshot.files)) {
    await writeFileText(projectPath, relPath, content);
  }

  // 2. 開いていたファイルを未選択に戻す(再オープンで最新内容が読み込まれるように)
  setSelectedFile(null);

  // 3. includeInContext キャッシュを再ロード
  await refreshIncludedSettings(projectPath);

  // 4. 履歴一覧の世代を進める(復元自体ではディスク上の history は変わらないが、
  //    UI の一貫性のため明示的に再取得を促す)
  useSnapshotStore.getState().bumpHistoryVersion();
}
