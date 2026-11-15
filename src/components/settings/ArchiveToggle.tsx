import { useState } from "react";
import { useTranslation } from "react-i18next";
import { setArchived } from "@/domain/project/archiveApi";

/**
 * エディタヘッダ上に配置するアーカイブ表示 + トグルボタン。
 *
 * - `archived=false`: 控えめな「アーカイブ」アイコンボタン(クリックでアーカイブ)
 * - `archived=true`: 強調された「アーカイブ中」バッジを兼ねたクリック可能 UI(クリックで解除)
 *
 * クリックで `archiveApi.setArchived(projectPath, relativePath, !archived)` を呼ぶ。
 * エラー処理 / ローディング表示は呼び出し元の責務だが、多重クリック防止のために
 * 内部に pending state を持つ(連打中の重複発火を抑える)。
 */
export interface ArchiveToggleProps {
  projectPath: string;
  relativePath: string;
  archived: boolean;
}

export function ArchiveToggle({
  projectPath,
  relativePath,
  archived,
}: ArchiveToggleProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    if (pending) return;
    setPending(true);
    try {
      await setArchived(projectPath, relativePath, !archived);
    } finally {
      setPending(false);
    }
  }

  if (archived) {
    // アーカイブ中: 強調バッジ + 解除ボタン。
    // 既存パレット(zinc / purple)と整合する控えめな警告色として amber 系を採用。
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        aria-disabled={pending}
        title={t("archive.unarchive")}
        aria-label={t("archive.unarchive")}
        className={
          "inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium " +
          "border-amber-500/40 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 " +
          "dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-300 dark:hover:bg-amber-400/20 " +
          "disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        <span>{t("archive.archived")}</span>
        <span aria-hidden className="text-[10px] opacity-70">
          {t("archive.archivedSeparator")}
        </span>
      </button>
    );
  }

  // アクティブ: 控えめなアーカイブボタン。
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-disabled={pending}
      title={t("archive.archive")}
      aria-label={t("archive.archive")}
      className={
        "inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs " +
        "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 " +
        "dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-200 " +
        "disabled:cursor-not-allowed disabled:opacity-60"
      }
    >
      {t("archive.archive")}
    </button>
  );
}
