import { useState } from "react";
import { useTranslation } from "react-i18next";
import { setIncludeInContext } from "@/domain/project/settingsApi";
import type { FileCategory } from "@/domain/project/filesApi";
import { toastError } from "@/components/ui/Toast";

/**
 * エディタヘッダ上に配置する includeInContext トグルボタン。
 *
 * - `checked=false`: 控えめなテキストボタン「コンテキストに含める」(クリックで有効化)
 * - `checked=true`: 強調バッジ「コンテキスト / 解除」(クリックで無効化)
 *
 * ArchiveToggle と同じボタン形式 + 状態別バッジ構造で揃え、色だけ purple に変える。
 * archived 時は親(SettingsEditor)側で本コンポーネントを描画しない方針のため、
 * `archived` prop は受け取らない。
 */
interface Props {
  projectPath: string;
  category: FileCategory;
  relativePath: string;
  /**
   * 現在の includeInContext 値。親(SettingsEditor)が settingsContextStore を
   * 購読して渡す。store 経由の単一情報源なので、ツリー右クリックなど別動線で
   * 切替されたときも追従する。
   */
  checked: boolean;
}

export function IncludeInContextToggle({
  projectPath,
  category,
  relativePath,
  checked,
}: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    if (pending) return;
    const next = !checked;
    setPending(true);
    try {
      await setIncludeInContext(projectPath, category, relativePath, next);
    } catch (e) {
      toastError(t("toast.contextToggleFailed", { message: String(e) }));
    } finally {
      setPending(false);
    }
  }

  if (checked) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        aria-disabled={pending}
        title={t("settings.excludeFromContext")}
        aria-label={t("settings.excludeFromContext")}
        className={
          "inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium " +
          "border-purple-500/40 bg-purple-500/15 text-purple-700 hover:bg-purple-500/25 " +
          "dark:border-purple-400/40 dark:bg-purple-400/15 dark:text-purple-300 dark:hover:bg-purple-400/20 " +
          "disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        <span>{t("settings.includedActive")}</span>
        <span aria-hidden className="text-[10px] opacity-70">
          {t("settings.includedSeparator")}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-disabled={pending}
      title={t("settings.includeInContext")}
      aria-label={t("settings.includeInContext")}
      className={
        "inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs " +
        "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 " +
        "dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-200 " +
        "disabled:cursor-not-allowed disabled:opacity-60"
      }
    >
      {t("settings.includeInContext")}
    </button>
  );
}
