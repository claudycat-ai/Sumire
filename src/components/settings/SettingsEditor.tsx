import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildEditorExtensions, makeInitialState } from "@/editor/setup";
import { readFileText, writeFileText } from "@/domain/project/filesApi";
import { syncIncludedBody } from "@/domain/project/settingsApi";
import type { FileCategory } from "@/domain/project/filesApi";
import { useArchivedFilesStore } from "@/stores/archivedFilesStore";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import { useEditorViewStore } from "@/stores/editorViewStore";
import { useFlushRegistry } from "@/stores/flushRegistry";
import { toastError } from "@/components/ui/Toast";
import { ArchiveToggle } from "./ArchiveToggle";
import { IncludeInContextToggle } from "./IncludeInContextToggle";
import i18n from "@/i18n";

interface Props {
  projectPath: string;
  category: FileCategory;
  relativePath: string;
  fileName: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; initial: string }
  | { kind: "error"; message: string };

const AUTOSAVE_DEBOUNCE_MS = 2000;

/**
 * 設定ファイル(キャラ・世界観・用語集・プロット概要)用エディタ。
 *
 * - CodeMirror、提案 UX(Shift+Enter / Tab 等)は無効
 * - includeInContext トグルをヘッダーに表示
 * - オートセーブは章エディタと同じ 2 秒デバウンス
 * - 編集ごとに settingsContextStore を追従更新(現在 included なら本文キャッシュも更新)
 */
export function SettingsEditor({
  projectPath,
  category,
  relativePath,
  fileName,
}: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const archived = useArchivedFilesStore((s) =>
    s.relativePaths.has(relativePath),
  );
  // includeInContext は settingsContextStore を購読し、ツリー右クリックなど
  // 別経路からの切替にも追従する(ArchiveToggle が archivedFilesStore を購読する
  // のと同じ構造)。store は archived 中のファイルを保持しないが、archived 中は
  // IncludeInContextToggle 自体を非表示にするので問題なし。
  const included = useSettingsContextStore((s) => s.files.has(relativePath));

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    readFileText(projectPath, relativePath)
      .then((content) => {
        if (cancelled) return;
        setState({ kind: "ready", initial: content });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, relativePath]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {fileName}
          </h3>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {relativePath}
          </p>
        </div>
        {state.kind === "ready" && (
          <div className="flex shrink-0 items-center gap-2">
            {!archived && (
              <IncludeInContextToggle
                projectPath={projectPath}
                category={category}
                relativePath={relativePath}
                checked={included}
              />
            )}
            <ArchiveToggle
              projectPath={projectPath}
              relativePath={relativePath}
              archived={archived}
            />
          </div>
        )}
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
          <SettingsMount
            key={relativePath}
            projectPath={projectPath}
            category={category}
            relativePath={relativePath}
            initialDoc={state.initial}
          />
        )}
      </div>
    </div>
  );
}

interface MountProps {
  projectPath: string;
  category: FileCategory;
  relativePath: string;
  initialDoc: string;
}

function SettingsMount({
  projectPath,
  category,
  relativePath,
  initialDoc,
}: MountProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const latestDocRef = useRef<string>(initialDoc);

  useEffect(() => {
    if (!containerRef.current) return;

    async function flushSave() {
      const content = latestDocRef.current;
      try {
        await writeFileText(projectPath, relativePath, content);
        // 現在 included なら本文キャッシュも追従。included でなければ no-op。
        syncIncludedBody(relativePath, category, content);
      } catch (e) {
        toastError(i18n.t("toast.saveFailed", { message: String(e) }));
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
      disableSuggestion: true,
      onChange: (doc) => {
        latestDocRef.current = doc;
        scheduleSave();
      },
    });

    const state: EditorState = makeInitialState(initialDoc, extensions);
    const view = new EditorView({ state, parent: containerRef.current });
    useEditorViewStore.getState().setSettingsView(view);

    const flushKey = `settings:${relativePath}`;
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
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        void flushSave();
      }
      useEditorViewStore.getState().setSettingsView(null);
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full" />;
}
