import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CATEGORY_ORDER,
  FileCategory,
  FileEntry,
  listProjectFiles,
} from "@/domain/project/filesApi";
import { createFile } from "@/domain/project/createFile";
import {
  refreshIncludedSettings,
  setIncludeInContext,
} from "@/domain/project/settingsApi";
import { useAppStore } from "@/stores/appStore";
import { useAutosaveStore } from "@/stores/autosaveStore";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import { useUILayoutStore } from "@/stores/uiLayoutStore";
import {
  refreshArchivedFiles,
  useArchivedFilesStore,
} from "@/stores/archivedFilesStore";
import { partitionByArchived } from "@/components/project/partitionByArchived";
import { flushAll } from "@/stores/flushRegistry";
import { toastError, toastInfo } from "@/components/ui/Toast";
import { NewFileDialog } from "@/components/project/NewFileDialog";
import {
  FileContextMenu,
  type FileTarget,
} from "@/components/project/FileContextMenu";
import { buildArchiveActions } from "@/components/project/archiveActions";

interface FileTreePaneProps {
  projectPath: string;
}

type CategoryFiles = Record<FileCategory, FileEntry[]>;

const EMPTY_CATEGORIES: CategoryFiles = {
  chapters: [],
  characters: [],
  worldbuilding: [],
  glossary: [],
  plot: [],
};

export function FileTreePane({ projectPath }: FileTreePaneProps) {
  const { t } = useTranslation();
  const selectedFile = useAppStore((s) => s.selectedFile);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);
  const autosaveActive = useAutosaveStore((s) => s.activeRelativePath);
  const autosaveStatus = useAutosaveStore((s) => s.status);
  const includedFiles = useSettingsContextStore((s) => s.files);
  const archivedSet = useArchivedFilesStore((s) => s.relativePaths);
  // 折り畳み状態は uiLayoutStore で永続化(per-machine, localStorage)。
  const expanded = useUILayoutStore((s) => s.fileTreeCategoryExpanded);
  const archivedExpanded = useUILayoutStore(
    (s) => s.fileTreeArchivedExpanded,
  );
  const toggleCategoryExpanded = useUILayoutStore(
    (s) => s.toggleFileTreeCategory,
  );
  const toggleArchivedExpanded = useUILayoutStore(
    (s) => s.toggleFileTreeArchived,
  );
  const isCurrentFileDirty =
    autosaveStatus.kind === "dirty" || autosaveStatus.kind === "saving";

  const [files, setFiles] = useState<CategoryFiles>(EMPTY_CATEGORIES);
  const [newFileCategory, setNewFileCategory] = useState<FileCategory | null>(
    null,
  );
  // 右クリック時の `FileContextMenu` 制御。target が null の間はメニューを描画しない。
  // 開く位置は viewport 座標(`event.clientX/Y`)を直接保持する。
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    position: { x: number; y: number };
    target: FileTarget | null;
  }>({
    open: false,
    position: { x: 0, y: 0 },
    target: null,
  });

  // アーカイブ操作の MenuAction は projectPath が変わらない限り使い回せる。
  // useMemo で参照同一性を保ち、`FileContextMenu` 側の余計な再レンダを防ぐ。
  const archiveActions = useMemo(
    () => buildArchiveActions(projectPath),
    [projectPath],
  );

  const refresh = useCallback(async () => {
    try {
      const results = await Promise.all(
        CATEGORY_ORDER.map((cat) =>
          listProjectFiles(projectPath, cat).then(
            (entries) => [cat, entries] as const,
          ),
        ),
      );
      const next: CategoryFiles = { ...EMPTY_CATEGORIES };
      for (const [cat, entries] of results) {
        next[cat] = entries;
      }
      setFiles(next);
      // ファイル一覧と並列でアーカイブ状態キャッシュも同期する。
      // 失敗してもツリー描画は継続できるよう、本体の refresh とは別に try/catch する。
      try {
        await refreshArchivedFiles(projectPath);
      } catch (e) {
        toastError(t("toast.archivedLoadFailed", { message: String(e) }));
      }
    } catch (e) {
      toastError(t("toast.fileListFailed", { message: String(e) }));
    }
  }, [projectPath, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  function toggleCategory(category: FileCategory) {
    toggleCategoryExpanded(category);
  }

  function toggleArchivedSubgroup(category: FileCategory) {
    toggleArchivedExpanded(category);
  }

  async function handleToggleInclude(
    category: FileCategory,
    relativePath: string,
    nextValue: boolean,
  ) {
    try {
      // 編集中の設定エディタにデバウンス待ちの保存があれば先に書き出す。
      // setIncludeInContext は frontmatter を書き換えるためにファイル全文を
      // 読み直すので、メモリ上の最新編集が反映されていないと巻き戻る。
      await flushAll();
      await setIncludeInContext(projectPath, category, relativePath, nextValue);
    } catch (e) {
      toastError(t("toast.contextToggleFailed", { message: String(e) }));
    }
  }

  async function handleConfirmCreate(title: string) {
    if (!newFileCategory) return;
    const category = newFileCategory;
    setNewFileCategory(null);
    try {
      const created = await createFile(projectPath, category, title);
      await refresh();
      // 設定ファイルなら includeInContext キャッシュも更新(初期 false なので変化はないが、
      // 将来「作成と同時に true 化」みたいな機能追加時のフックポイントとして整合させておく)
      if (category !== "chapters") {
        await refreshIncludedSettings(projectPath);
      }
      // 作成したファイルを即選択
      setSelectedFile({
        category,
        relativePath: created.relativePath,
        name: created.name,
      });
      toastInfo(
        t("toast.fileCreated", { label: t(`category.${category}`) }),
      );
    } catch (e) {
      toastError(t("toast.fileCreateFailed", { message: String(e) }));
    }
  }

  function handleContextMenu(
    e: ReactMouseEvent,
    category: FileCategory,
    entry: FileEntry,
    archived: boolean,
  ) {
    // WebView 標準メニュー(installContextmenuGuard で window レベルでも抑止済み)+
    // 親要素への伝播の両方を止める。stopPropagation はネスト時の競合保険。
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      open: true,
      position: { x: e.clientX, y: e.clientY },
      target: {
        category,
        relativePath: entry.relativePath,
        name: entry.name,
        archived,
      },
    });
  }

  function closeContextMenu() {
    setContextMenu((prev) => ({ ...prev, open: false, target: null }));
  }

  function renderFileRow(
    category: FileCategory,
    entry: FileEntry,
    options: { archived: boolean },
  ) {
    const isSelected = selectedFile?.relativePath === entry.relativePath;
    const isDirty =
      isCurrentFileDirty && autosaveActive === entry.relativePath;
    const isIncluded = includedFiles.has(entry.relativePath);
    const supportsInclude = category !== "chapters";
    const { archived } = options;
    return (
      <li key={entry.relativePath}>
        <div
          onContextMenu={(e) => handleContextMenu(e, category, entry, archived)}
          className={
            "flex w-full items-center gap-1.5 py-1 pr-3 transition-colors " +
            (archived
              ? "text-zinc-500 dark:text-zinc-500 "
              : "text-zinc-800 dark:text-zinc-200 ") +
            (isSelected
              ? "bg-purple-200 dark:bg-purple-900/50"
              : "hover:bg-zinc-200 dark:hover:bg-zinc-900")
          }
        >
          {supportsInclude ? (
            archived ? (
              // アーカイブ済みファイルの紫ドットは disabled 相当(クリック不能)。
              // クリックしても何も起きないよう onClick も disabled も両方かける。
              <button
                type="button"
                role="switch"
                aria-checked={isIncluded}
                aria-disabled
                disabled
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                title={t("archive.lockedTooltip")}
                className="group flex w-7 shrink-0 cursor-not-allowed items-center justify-center opacity-40"
              >
                <span
                  className={
                    "inline-block h-1.5 w-1.5 rounded-full " +
                    (isIncluded
                      ? "bg-purple-500"
                      : "border border-zinc-400 dark:border-zinc-600")
                  }
                />
              </button>
            ) : (
              <button
                type="button"
                role="switch"
                aria-checked={isIncluded}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleToggleInclude(
                    category,
                    entry.relativePath,
                    !isIncluded,
                  );
                }}
                title={
                  isIncluded
                    ? t("project.removeFromContext")
                    : t("project.addToContext")
                }
                className="group flex w-7 shrink-0 items-center justify-center"
              >
                <span
                  className={
                    "inline-block h-1.5 w-1.5 rounded-full transition-colors " +
                    (isIncluded
                      ? "bg-purple-500"
                      : "border border-zinc-400 group-hover:border-purple-500 dark:border-zinc-600")
                  }
                />
              </button>
            )
          ) : (
            // 章ファイルは includeInContext 対象外。アイコン枠は出さず、
            // 行頭の左余白だけ少し詰める。
            <span className="w-2 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            onClick={() =>
              setSelectedFile({
                category,
                relativePath: entry.relativePath,
                name: entry.name,
              })
            }
            className="flex flex-1 items-center gap-1.5 truncate text-left"
          >
            <span className="truncate">{entry.name}</span>
            {isDirty && (
              <span
                className="ml-auto inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-purple-500"
                aria-label={t("project.unsavedAria")}
              />
            )}
          </button>
        </div>
      </li>
    );
  }

  return (
    <nav
      aria-label={t("project.fileTreeAria")}
      className="flex flex-col text-sm"
    >
      <NewFileDialog
        open={newFileCategory !== null}
        category={newFileCategory}
        onCancel={() => setNewFileCategory(null)}
        onConfirm={handleConfirmCreate}
      />
      <FileContextMenu
        open={contextMenu.open}
        position={contextMenu.position}
        target={contextMenu.target}
        actions={archiveActions}
        onClose={closeContextMenu}
      />
      <ul className="flex-1 py-2">
        {CATEGORY_ORDER.map((category) => {
          const isExpanded = expanded[category];
          const items = files[category];
          // 各カテゴリ内をアクティブ / アーカイブ済みに分割する。
          // 元の並び順は安定保持(partitionByArchived の責務)。
          const { active, archived } = partitionByArchived(items, archivedSet);
          const isArchivedSubgroupExpanded = archivedExpanded[category];
          return (
            <li key={category} className="mb-1">
              <div className="flex items-center justify-between pr-2">
                <button
                  type="button"
                  onClick={() => toggleCategory(category)}
                  className="flex flex-1 items-center gap-1 px-3 py-1 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-900"
                >
                  <span className="inline-block w-3 text-zinc-400">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  {t(`category.${category}`)}
                  <span className="ml-1 text-zinc-400 dark:text-zinc-600">
                    ({items.length})
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setNewFileCategory(category)}
                  className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-200 hover:text-purple-600 dark:hover:bg-zinc-900 dark:hover:text-purple-400"
                  title={t("project.newFileTooltip", {
                    label: t(`category.${category}`),
                  })}
                  aria-label={t("project.newFileTooltip", {
                    label: t(`category.${category}`),
                  })}
                >
                  +
                </button>
              </div>
              {isExpanded && (
                <ul className="mt-0.5">
                  {items.length === 0 ? (
                    <li className="px-7 py-1 text-xs text-zinc-400 dark:text-zinc-600">
                      {t("project.empty")}
                    </li>
                  ) : (
                    <>
                      {active.map((entry) =>
                        renderFileRow(category, entry, { archived: false }),
                      )}
                      {archived.length > 0 && (
                        <li>
                          <button
                            type="button"
                            onClick={() => toggleArchivedSubgroup(category)}
                            className="flex w-full items-center gap-1 py-1 pl-7 pr-3 text-left text-xs text-zinc-500 hover:bg-zinc-200 dark:text-zinc-500 dark:hover:bg-zinc-900"
                            aria-expanded={isArchivedSubgroupExpanded}
                          >
                            <span className="inline-block w-3 text-zinc-400">
                              {isArchivedSubgroupExpanded ? "▾" : "▸"}
                            </span>
                            <span>{t("archive.archivedSubgroup")}</span>
                            <span className="text-zinc-400 dark:text-zinc-600">
                              ({archived.length})
                            </span>
                          </button>
                          {isArchivedSubgroupExpanded && (
                            <ul>
                              {archived.map((entry) =>
                                renderFileRow(category, entry, {
                                  archived: true,
                                }),
                              )}
                            </ul>
                          )}
                        </li>
                      )}
                    </>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
