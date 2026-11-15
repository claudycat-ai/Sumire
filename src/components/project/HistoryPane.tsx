import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SnapshotEntry,
  listSnapshots,
  readSnapshot,
} from "@/domain/snapshot/snapshotApi";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { useUILayoutStore } from "@/stores/uiLayoutStore";
import { toastError } from "@/components/ui/Toast";

interface Props {
  projectPath: string;
}

/**
 * 左ペイン下部に置く「履歴」セクション。
 *
 * - 折り畳み可能(VS Code のタイムライン風)
 * - 一覧をクリックでプレビュー(履歴モードに入る)
 * - 履歴モード中はその項目がハイライト
 *
 * 「現在に戻る」「復元」ボタンは本文ペイン側のヘッダーに置く(ProjectView)。
 *
 * 一覧は ProjectView から refreshKey の変化で更新される(スナップショット保存後など)。
 */
export function HistoryPane({ projectPath }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<SnapshotEntry[]>([]);
  // 折り畳み状態は uiLayoutStore で永続化(per-machine, localStorage)。
  const expanded = useUILayoutStore((s) => s.historyPaneExpanded);
  const toggleExpanded = useUILayoutStore((s) => s.toggleHistoryPane);
  const currentName = useSnapshotStore((s) => s.currentName);
  const historyVersion = useSnapshotStore((s) => s.historyVersion);
  const enterPreview = useSnapshotStore((s) => s.enterPreview);

  const refresh = useCallback(async () => {
    try {
      const list = await listSnapshots(projectPath);
      setItems(list);
    } catch (e) {
      toastError(t("toast.historyLoadFailed", { message: String(e) }));
    }
  }, [projectPath, t]);

  useEffect(() => {
    void refresh();
    // historyVersion 変化(=保存完了・復元完了)で一覧を再取得
  }, [refresh, historyVersion]);

  async function handleSelect(entry: SnapshotEntry) {
    try {
      const payload = await readSnapshot(projectPath, entry.name);
      enterPreview(entry.name, payload);
    } catch (e) {
      toastError(t("toast.snapshotReadFailed", { message: String(e) }));
    }
  }

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-center gap-1 px-3 py-1 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-900"
      >
        <span className="inline-block w-3 text-zinc-400">
          {expanded ? "▾" : "▸"}
        </span>
        {t("project.history")}
        <span className="ml-1 text-zinc-400 dark:text-zinc-600">
          ({items.length})
        </span>
      </button>
      {expanded && (
        <ul className="max-h-60 overflow-y-auto">
          {items.length === 0 ? (
            <li className="px-7 py-1 text-xs text-zinc-400 dark:text-zinc-600">
              {t("project.historyEmpty")}
            </li>
          ) : (
            items.map((entry) => {
              const isSelected = currentName === entry.name;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    onClick={() => void handleSelect(entry)}
                    className={
                      "block w-full px-3 py-1 text-left text-xs transition-colors " +
                      (isSelected
                        ? "bg-purple-200 dark:bg-purple-900/50"
                        : "hover:bg-zinc-200 dark:hover:bg-zinc-900")
                    }
                    title={t("project.snapshotTooltip", {
                      timestamp: entry.timestamp,
                      count: entry.fileCount,
                    })}
                  >
                    <span className="truncate text-zinc-800 dark:text-zinc-200">
                      {formatLabel(entry.timestamp, entry.name)}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

/** ISO タイムスタンプを「MM/DD HH:mm:ss」風に短縮表示。失敗時はファイル名にフォールバック。 */
function formatLabel(iso: string, fallbackName: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return fallbackName.replace(/\.json$/, "");
  return `${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}
