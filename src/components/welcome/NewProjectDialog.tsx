import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { sanitizeFolderName } from "@/lib/folderName";

interface NewProjectDialogProps {
  open: boolean;
  parentPath: string;
  onCancel: () => void;
  onConfirm: (input: { title: string; author: string }) => void;
}

export function NewProjectDialog({
  open,
  parentPath,
  onCancel,
  onConfirm,
}: NewProjectDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setAuthor("");
    // 自動フォーカス(マウント直後はまだ ref が確定しない場合があるため次のタスクで)
    const id = setTimeout(() => titleRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  // タイトル入力に応じてフォルダ名プレビューを派生計算
  // (`sanitizeFolderName` は副作用なしの純関数なので useMemo の依存は title のみで十分)
  const folderResult = useMemo(() => sanitizeFolderName(title), [title]);

  if (!open) return null;

  // 送信ボタン disabled 条件:
  // - title.trim() が空 (既存挙動)
  // - サニタイズ失敗 (empty / tooLong) 時 (新規)
  const submitDisabled = !title.trim() || !folderResult.ok;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitDisabled) return;
    // folderName は親側 (App.handleConfirmCreate) で再計算する。
    // ここでは title / author のみを渡す。
    onConfirm({ title: title.trim(), author: author.trim() });
  }

  // プレビュー表示用のフルパス文字列。
  // 親パスの末尾区切りはそのまま受け取り、`/` で連結する
  // (プレビュー表示専用、ファイルシステム操作には使わない)。
  const previewPath = `${parentPath}/${folderResult.folderName}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {t("welcome.createDialogTitle")}
        </h2>
        <p className="mb-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {t("welcome.parentFolderLabel", { path: parentPath })}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm text-zinc-700 dark:text-zinc-300">
              {t("common.title")} <span className="text-red-500">{t("common.required")}</span>
            </span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              required
            />
          </label>

          {/* フォルダ名プレビュー: 成功時はパスを表示、失敗時は警告アイコン + 理由文言 */}
          {folderResult.ok ? (
            <p className="break-all text-xs text-zinc-600 dark:text-zinc-400">
              {t("welcome.folderPreviewLabel", { path: previewPath })}
            </p>
          ) : (
            <p className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
              <span aria-hidden="true">⚠️</span>
              <span>
                {folderResult.error.kind === "empty"
                  ? t("welcome.invalidFolderName.empty")
                  : t("welcome.invalidFolderName.tooLong", {
                      length: folderResult.error.length,
                    })}
              </span>
            </p>
          )}

          <label className="block">
            <span className="mb-1 block text-sm text-zinc-700 dark:text-zinc-300">
              {t("welcome.author")}
            </span>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {t("common.create")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
