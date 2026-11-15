import { flushAll } from "@/stores/flushRegistry";
import { useAppStore } from "@/stores/appStore";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { openProject } from "@/domain/project/projectApi";
import {
  buildSnapshotTimestamp,
  saveSnapshot,
} from "@/domain/snapshot/snapshotApi";
import { toastError, toastInfo } from "@/components/ui/Toast";

const DEFAULT_MAX_KEEP = 10;

/**
 * Ctrl+S に対応する保存フロー。
 *
 * 1. 各エディタの保留中オートセーブを flush(=最新内容をディスクに反映)
 * 2. sumire.json から snapshots.maxKeep を取得(無ければ既定値 10)
 * 3. Rust 側 save_snapshot を呼ぶ
 * 4. トースト通知
 *
 * プロジェクトが開いていない場合は何もしない。
 */
export async function performSnapshotSave(): Promise<void> {
  const project = useAppStore.getState().currentProject;
  if (!project) return;

  try {
    // 1. flush
    await flushAll();

    // 2. maxKeep を sumire.json から(失敗してもデフォルトで継続)
    let maxKeep = DEFAULT_MAX_KEEP;
    try {
      const meta = await openProject(project.path);
      const snap = (meta.snapshots ?? {}) as { maxKeep?: unknown };
      if (typeof snap.maxKeep === "number" && Number.isFinite(snap.maxKeep)) {
        maxKeep = Math.max(0, Math.floor(snap.maxKeep));
      }
    } catch {
      // sumire.json 読めなくても保存自体は試みる
    }

    // 3. save
    const { filenameStem, iso } = buildSnapshotTimestamp();
    await saveSnapshot(project.path, filenameStem, iso, maxKeep);

    // 4. 履歴一覧を再取得させる(maxKeep による削除も含めて反映)
    useSnapshotStore.getState().bumpHistoryVersion();

    // 5. 通知
    toastInfo("スナップショットを保存しました");
  } catch (e) {
    toastError(`スナップショット保存に失敗しました: ${e}`);
  }
}
