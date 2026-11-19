import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { selectSelectedSettings, useAppStore } from "@/stores/appStore";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { useUILayoutStore } from "@/stores/uiLayoutStore";
import { Button } from "@/components/ui/Button";
import { FileTreeColumn } from "@/components/project/FileTreeColumn";
import { StatusBar } from "@/components/project/StatusBar";
import { ChapterEditor } from "@/components/editor/ChapterEditor";
import { MemoPane } from "@/components/memo/MemoPane";
import { SettingsPane } from "@/components/settings/SettingsPane";
import { HistoryPreview } from "@/components/snapshot/HistoryPreview";
import { ConfirmRestoreDialog } from "@/components/snapshot/ConfirmRestoreDialog";
import { performRestore } from "@/domain/snapshot/restoreFlow";
import { toastError, toastInfo } from "@/components/ui/Toast";

export function ProjectView() {
  const { t } = useTranslation();
  const project = useAppStore((s) => s.currentProject);
  const selectedChapter = useAppStore((s) => s.selectedChapter);
  const selectedSettings = useAppStore(selectSelectedSettings);
  const setCurrentProject = useAppStore((s) => s.setCurrentProject);
  const snapshot = useSnapshotStore((s) => s.current);
  const snapshotName = useSnapshotStore((s) => s.currentName);
  const exitPreview = useSnapshotStore((s) => s.exitPreview);
  const chapterGroupLayout = useUILayoutStore((s) => s.chapterGroupLayout);
  const rightColumnLayout = useUILayoutStore((s) => s.rightColumnLayout);
  const setChapterGroupLayout = useUILayoutStore(
    (s) => s.setChapterGroupLayout,
  );
  const setRightColumnLayout = useUILayoutStore((s) => s.setRightColumnLayout);
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  // react-resizable-panels の Separator は既定で tabIndex=0 を出力し、
  // 本文ペインからの Tab フォーカスを奪って提案採用 (Tab) を阻害する。
  // Sumire はキーボードでのリサイズ操作を提供しないので、フォーカス対象から外す。
  const horizontalSeparatorRef = useRef<HTMLDivElement>(null);
  const verticalSeparatorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    horizontalSeparatorRef.current?.setAttribute("tabindex", "-1");
    verticalSeparatorRef.current?.setAttribute("tabindex", "-1");
  });

  if (!project) {
    return (
      <main className="flex min-h-screen items-center justify-center text-zinc-500 dark:text-zinc-400">
        {t("project.noSelection")}
      </main>
    );
  }

  const inHistory = snapshot !== null;
  const chapterContentInHistory =
    snapshot && selectedChapter
      ? snapshot.files[selectedChapter.relativePath] ?? null
      : null;
  const settingsContentInHistory =
    snapshot && selectedSettings
      ? snapshot.files[selectedSettings.relativePath] ?? null
      : null;
  const memoContentInHistory = snapshot ? snapshot.files["memo.md"] ?? null : null;

  async function handleRestore() {
    if (!project || !snapshot) return;
    setConfirmingRestore(false);
    try {
      await performRestore(project.path, snapshot);
      exitPreview();
      toastInfo(t("toast.snapshotRestored"));
    } catch (e) {
      toastError(t("toast.restoreFailed", { message: String(e) }));
    }
  }

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {project.title}
          </h1>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {project.path}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCurrentProject(null)}
        >
          {t("project.close")}
        </Button>
      </header>

      {inHistory && (
        <div className="flex items-center justify-end gap-2 border-b border-purple-300 bg-purple-100 px-4 py-1.5 text-xs dark:border-purple-700 dark:bg-purple-950/50">
          <span className="mr-auto truncate text-purple-700 dark:text-purple-300">
            {t("project.historyMode", { name: snapshotName })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => exitPreview()}>
            {t("project.backToCurrent")}
          </Button>
          <Button size="sm" onClick={() => setConfirmingRestore(true)}>
            {t("project.restore")}
          </Button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* 列は配置によらず常に Group の前に置く。右のときは列の側が order-last で
            見た目の順だけを後ろへ回すので、切り替えても Group 以下はマウントし直されない。 */}
        <FileTreeColumn projectPath={project.path} />
        <Group
          orientation="horizontal"
          className="flex h-full flex-1"
          defaultLayout={chapterGroupLayout ?? undefined}
          onLayoutChanged={setChapterGroupLayout}
        >
          <Panel
            id="chapter"
            defaultSize="60%"
            minSize="20%"
            className="overflow-hidden"
          >
            <div className="h-full overflow-hidden">
              {inHistory ? (
                <HistoryPreview
                  content={chapterContentInHistory}
                  label={
                    selectedChapter
                      ? selectedChapter.name
                      : t("project.chapterUnselected")
                  }
                />
              ) : selectedChapter ? (
                <ChapterEditor
                  projectPath={project.path}
                  relativePath={selectedChapter.relativePath}
                  fileName={selectedChapter.name}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  {t("project.selectChapter")}
                </div>
              )}
            </div>
          </Panel>
          <Separator
            elementRef={horizontalSeparatorRef}
            className="w-1.5 cursor-col-resize bg-zinc-200 transition-colors hover:bg-purple-500/40 dark:bg-zinc-800"
          />
          <Panel
            id="right"
            defaultSize="40%"
            minSize="20%"
            className="overflow-hidden"
          >
            <Group
              orientation="vertical"
              className="flex h-full flex-col"
              defaultLayout={rightColumnLayout ?? undefined}
              onLayoutChanged={setRightColumnLayout}
            >
              <Panel
                id="memo"
                defaultSize="70%"
                minSize="20%"
                className="overflow-hidden"
              >
                {inHistory ? (
                  <HistoryPreview
                    content={memoContentInHistory}
                    label={t("project.memoLabel")}
                  />
                ) : (
                  <MemoPane projectPath={project.path} />
                )}
              </Panel>
              <Separator
                elementRef={verticalSeparatorRef}
                className="h-1.5 cursor-row-resize bg-zinc-200 transition-colors hover:bg-purple-500/40 dark:bg-zinc-800"
              />
              <Panel
                id="settings"
                defaultSize="30%"
                minSize="15%"
                className="overflow-hidden"
              >
                {inHistory ? (
                  <HistoryPreview
                    content={settingsContentInHistory}
                    label={
                      selectedSettings
                        ? selectedSettings.name
                        : t("project.settingsUnselected")
                    }
                  />
                ) : (
                  <SettingsPane projectPath={project.path} />
                )}
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>

      <StatusBar />

      <ConfirmRestoreDialog
        open={confirmingRestore}
        snapshotName={snapshotName}
        onCancel={() => setConfirmingRestore(false)}
        onConfirm={() => void handleRestore()}
      />
    </main>
  );
}
