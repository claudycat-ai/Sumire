import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildEditorExtensions, makeInitialState } from "@/editor/setup";
import { readMemo, writeMemo } from "@/domain/memo/memoApi";
import { useMemoEditorStore } from "@/stores/memoEditorStore";
import { useFlushRegistry } from "@/stores/flushRegistry";
import { toastError } from "@/components/ui/Toast";
import i18n from "@/i18n";

interface Props {
  projectPath: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; initial: string }
  | { kind: "error"; message: string };

const AUTOSAVE_DEBOUNCE_MS = 2000;

/**
 * 縦三段レイアウトの中段。memo.md を読み込んで CodeMirror エディタで編集する。
 *
 * - 提案 UX(Shift+Enter / Tab 等)は無効。雑メモ用。
 * - オートセーブは 2 秒デバウンス。失敗時のみトーストで通知。
 *   保存状態のステータスバー表示は本文(章エディタ)が主役なので介入しない。
 * - EditorView 参照を memoEditorStore に登録し、suggestionController が
 *   Ctrl+Shift+M 時にここに転記する。
 */
export function MemoPane({ projectPath }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    readMemo(projectPath)
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
  }, [projectPath]);

  return (
    <section className="flex h-full flex-col">
      <header className="border-b border-zinc-200 px-4 py-1.5 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {t("project.memoLabel")}
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
          <MemoMount
            key={projectPath}
            projectPath={projectPath}
            initialDoc={state.initial}
          />
        )}
      </div>
    </section>
  );
}

interface MountProps {
  projectPath: string;
  initialDoc: string;
}

function MemoMount({ projectPath, initialDoc }: MountProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const latestDocRef = useRef<string>(initialDoc);

  useEffect(() => {
    if (!containerRef.current) return;

    async function flushSave() {
      try {
        await writeMemo(projectPath, latestDocRef.current);
      } catch (e) {
        toastError(i18n.t("toast.memoSaveFailed", { message: String(e) }));
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
    useMemoEditorStore.getState().setView(view);

    const flushPending = async () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        await flushSave();
      }
    };
    useFlushRegistry.getState().register("memo", flushPending);

    return () => {
      useFlushRegistry.getState().unregister("memo");
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        void flushSave();
      }
      useMemoEditorStore.getState().setView(null);
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full" />;
}
