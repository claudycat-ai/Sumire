import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildEditorExtensions, makeInitialState } from "@/editor/setup";

interface Props {
  /** 表示する文字列。null の場合「このファイルはこの時点に存在しません」を表示。 */
  content: string | null;
  /** ヘッダーに出すラベル(ファイル名やパスなど)。 */
  label?: string;
}

/**
 * スナップショット履歴モード時の読み取り専用プレビュー。
 *
 * - CodeMirror の readOnly + 提案 UX 無効
 * - フッターにヘルプ:「履歴モード — 現在に戻るには履歴セクションでもう一度クリック…(本文ペイン側にボタンあり)」
 *   は ProjectView 側の本文ペインヘッダーで案内するため、ここでは出さない
 */
export function HistoryPreview({ content, label }: Props) {
  const { t } = useTranslation();
  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        {t("snapshot.fileMissing")}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      {label && (
        <header className="border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <h3 className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {label}
          </h3>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {t("snapshot.readonlyLabel")}
          </p>
        </header>
      )}
      <div className="flex-1 overflow-hidden">
        <CodeMirrorReadOnly content={content} />
      </div>
    </div>
  );
}

function CodeMirrorReadOnly({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const extensions = buildEditorExtensions({
      onChange: () => {
        // readOnly のため呼ばれないはずだが、念のための no-op
      },
      readOnly: true,
      disableSuggestion: true,
    });
    const state: EditorState = makeInitialState(content, extensions);
    const view = new EditorView({ state, parent: containerRef.current });
    return () => view.destroy();
  }, [content]);

  return <div ref={containerRef} className="h-full" />;
}
