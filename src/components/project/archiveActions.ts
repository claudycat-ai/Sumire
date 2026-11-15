import i18n from "@/i18n";
import { setArchived } from "@/domain/project/archiveApi";
import type {
  FileTarget,
  MenuAction,
} from "@/components/project/FileContextMenu";
import { toastError } from "@/components/ui/Toast";

/**
 * `FileContextMenu` に渡すアーカイブ操作 MenuAction 配列を構築する。
 *
 * - `archive`: アクティブな(`archived === false`)ファイルでのみ表示。
 *   選択時に `archiveApi.setArchived(projectPath, relativePath, true)` を呼ぶ。
 * - `unarchive`: アーカイブ済みの(`archived === true`)ファイルでのみ表示。
 *   選択時に `archiveApi.setArchived(projectPath, relativePath, false)` を呼ぶ。
 *
 * `visible` で排他制御するため、同時に表示される項目は常にどちらか一方だけ。
 *
 * `onSelect` は async だが、内部で `setArchived` の例外を握り潰して
 * `toastError` でユーザに通知し、`console.error` に詳細を残す。これは
 * `FileContextMenu` 側が `void action.onSelect(target)` で結果を破棄して
 * 即クローズする契約のため、ここで throw しても誰もキャッチできない
 * (unhandled promise rejection になる)から。エラーが起きてもメニューは
 * 既に閉じている(onClose が同期的に呼ばれている)ため、上位で握る必要は無い。
 *
 * pure function として切り出すことで、`FileTreePane` の DOM テストを
 * 立てなくても actions の構築ロジックを単体テストできる。
 *
 * label は i18n 解決後の文字列を保持する。i18n の lng 切替後に
 * `buildArchiveActions` を呼び直せば最新の言語が反映される。
 */
export function buildArchiveActions(projectPath: string): MenuAction[] {
  return [
    {
      id: "archive",
      label: i18n.t("archive.archive"),
      visible: (target: FileTarget) => !target.archived,
      onSelect: async (target: FileTarget) => {
        try {
          await setArchived(projectPath, target.relativePath, true);
        } catch (e) {
          console.error("[archiveActions] archive failed", e);
          toastError(i18n.t("toast.archiveFailed", { message: String(e) }));
        }
      },
    },
    {
      id: "unarchive",
      label: i18n.t("archive.unarchive"),
      visible: (target: FileTarget) => target.archived,
      onSelect: async (target: FileTarget) => {
        try {
          await setArchived(projectPath, target.relativePath, false);
        } catch (e) {
          console.error("[archiveActions] unarchive failed", e);
          toastError(i18n.t("toast.unarchiveFailed", { message: String(e) }));
        }
      },
    },
  ];
}
