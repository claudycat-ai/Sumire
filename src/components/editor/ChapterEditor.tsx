import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildEditorExtensions, makeInitialState } from "@/editor/setup";
import { readFileText, writeFileText } from "@/domain/project/filesApi";
import { useAutosaveStore } from "@/stores/autosaveStore";
import { useEditorContentStore } from "@/stores/editorContentStore";
import { useEditorViewStore } from "@/stores/editorViewStore";
import { useArchivedFilesStore } from "@/stores/archivedFilesStore";
import { useFlushRegistry } from "@/stores/flushRegistry";
import { toastError } from "@/components/ui/Toast";
import { ArchiveToggle } from "@/components/settings/ArchiveToggle";
import i18n from "@/i18n";

interface ChapterEditorProps {
  projectPath: string;
  /** プロジェクトルートからの相対パス。同じパスでも別文書としては再マウントしない。 */
  relativePath: string;
  /** ヘッダーに表示するファイル名。 */
  fileName: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; initial: string }
  | { kind: "error"; message: string };

const AUTOSAVE_DEBOUNCE_MS = 2000;

export function ChapterEditor({
  projectPath,
  relativePath,
  fileName,
}: ChapterEditorProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const setActiveFile = useAutosaveStore((s) => s.setActiveFile);
  const archived = useArchivedFilesStore((s) =>
    s.relativePaths.has(relativePath),
  );

  // ファイルが切り替わるたびに内容を読み込む
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setActiveFile(relativePath);
    useEditorContentStore.getState().setDoc(null);
    readFileText(projectPath, relativePath)
      .then((content) => {
        if (cancelled) return;
        setState({ kind: "ready", initial: content });
        useEditorContentStore.getState().setDoc(content);
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, relativePath, setActiveFile]);

  // アンマウント時(プロジェクト閉じる等)にアクティブファイルとエディタ本文をクリア
  useEffect(() => {
    return () => {
      setActiveFile(null);
      useEditorContentStore.getState().setDoc(null);
    };
  }, [setActiveFile]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            <span className="truncate">{fileName}</span>
            <DirtyIndicator />
          </h2>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {relativePath}
          </p>
        </div>
        <ArchiveToggle
          projectPath={projectPath}
          relativePath={relativePath}
          archived={archived}
        />
      </header>

      <div className="flex-1 overflow-hidden">
        {state.kind === "loading" && (
          <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
            {t("common.loading")}
          </p>
        )}
        {state.kind === "error" && (
          <p className="p-4 text-sm text-red-500">
            {t("common.error", { message: state.message })}
          </p>
        )}
        {state.kind === "ready" && (
          <EditorMount
            // ファイルが切り替わるたびにエディタごと再マウントする(編集中ドキュメントの混線を防ぐ)
            key={relativePath}
            projectPath={projectPath}
            relativePath={relativePath}
            initialDoc={state.initial}
          />
        )}
      </div>
    </div>
  );
}

function DirtyIndicator() {
  const { t } = useTranslation();
  const status = useAutosaveStore((s) => s.status);
  if (status.kind !== "dirty" && status.kind !== "saving") return null;
  return (
    <span
      className="inline-block h-2 w-2 rounded-full bg-purple-500"
      title={
        status.kind === "dirty"
          ? t("editor.unsavedTooltip")
          : t("editor.savingTooltip")
      }
      aria-label={t("project.unsavedAria")}
    />
  );
}

interface EditorMountProps {
  projectPath: string;
  relativePath: string;
  initialDoc: string;
}

function EditorMount({
  projectPath,
  relativePath,
  initialDoc,
}: EditorMountProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // ペンディングのオートセーブを管理する ref
  const debounceRef = useRef<number | null>(null);
  // 最新のドキュメント本文を保持(クロージャ越しに最新値を読むため)
  const latestDocRef = useRef<string>(initialDoc);

  useEffect(() => {
    if (!containerRef.current) return;

    async function flushSave() {
      const content = latestDocRef.current;
      useAutosaveStore.getState().markSaving();
      try {
        await writeFileText(projectPath, relativePath, content);
        useAutosaveStore.getState().markSaved();
      } catch (e) {
        const message = String(e);
        useAutosaveStore.getState().markError(message);
        toastError(i18n.t("toast.saveFailed", { message }));
      }
    }

    function scheduleSave() {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void flushSave();
      }, AUTOSAVE_DEBOUNCE_MS);
    }

    const extensions = buildEditorExtensions({
      onChange: (doc) => {
        latestDocRef.current = doc;
        useEditorContentStore.getState().setDoc(doc);
        useAutosaveStore.getState().markDirty();
        scheduleSave();
      },
    });

    const state: EditorState = makeInitialState(initialDoc, extensions);
    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;
    useEditorViewStore.getState().setChapterView(view);

    // Ctrl+S 等のグローバル保存時に呼ばれる即時フラッシュ。デバウンス保留中なら即実行。
    const flushKey = `chapter:${relativePath}`;
    const flushPending = async () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        await flushSave();
      }
    };
    useFlushRegistry.getState().register(flushKey, flushPending);

    return () => {
      useFlushRegistry.getState().unregister(flushKey);
      // ファイル切替・アンマウント時はペンディングを即フラッシュする
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        void flushSave();
      }
      useEditorViewStore.getState().setChapterView(null);
      view.destroy();
      viewRef.current = null;
    };
    // initialDoc / projectPath / relativePath は親のキー再マウントで切り替えるので
    // 依存に入れない(マウント中は固定値として扱う)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full" />;
}
