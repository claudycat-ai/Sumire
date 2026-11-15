import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";

interface Props {
  open: boolean;
  snapshotName: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * スナップショット復元の確認ダイアログ。
 *
 * 「現在の編集状態が上書きされる」破壊的操作なので、明示確認を取る。
 * スナップショットに含まれないファイル(=スナップショット時点以降に作成されたファイル)は
 * そのまま残ることもあわせて表示する。
 */
export function ConfirmRestoreDialog({
  open,
  snapshotName,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  if (!open || !snapshotName) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("snapshot.confirmAria")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
    >
      <div className="w-full max-w-md rounded-md border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("snapshot.confirmTitle")}
        </h2>
        <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">
          {t("snapshot.confirmBody")}
        </p>
        <p className="mb-2 text-sm text-zinc-700 dark:text-zinc-300">
          <Trans
            i18nKey="snapshot.confirmHint"
            components={[
              <kbd key="0" className="rounded bg-zinc-200 px-1 dark:bg-zinc-800" />,
            ]}
          />
        </p>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          {t("snapshot.confirmExtraFiles")}
        </p>
        <p className="mb-4 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {t("snapshot.confirmTarget", { name: snapshotName })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={onConfirm}>
            {t("snapshot.doRestore")}
          </Button>
        </div>
      </div>
    </div>
  );
}
