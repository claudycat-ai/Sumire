import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { type FileCategory } from "@/domain/project/filesApi";

interface Props {
  open: boolean;
  category: FileCategory | null;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}

/**
 * 新規ファイル作成のタイトル入力ダイアログ。
 *
 * 章 / キャラ / 世界観 / 用語集 / プロット概要 で共有する。
 * カテゴリに応じて見出し文だけ切り替える。
 */
export function NewFileDialog({ open, category, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      // ダイアログ表示時に input にフォーカス
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open || !category) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onConfirm(title);
  }

  const categoryLabel = t(`category.${category}`);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("project.newFileTitle", { label: categoryLabel })}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("project.newFileTitle", { label: categoryLabel })}
        </h2>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-zinc-700 dark:text-zinc-300">
            {t("common.title")}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            placeholder={
              category === "chapters"
                ? t("project.createPlaceholderChapter")
                : t("project.createPlaceholderOther")
            }
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim()}>
            {t("common.create")}
          </Button>
        </div>
      </form>
    </div>
  );
}
