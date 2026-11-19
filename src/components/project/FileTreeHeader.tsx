import { useTranslation } from "react-i18next";
import { useUILayoutStore } from "@/stores/uiLayoutStore";

const BUTTON_CLASS =
  "rounded px-1.5 py-0.5 text-xs leading-none text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-900";

/**
 * ファイル一覧の列の上に置くヘッダ。
 * 左から「すべて折りたたむ」「すべて展開する」「配置の切り替え」の 3 つのボタンを並べる。
 * 並びは配置によらず同じで、切り替えのボタンだけが行き先に応じて記号と文言を変える。
 * uiLayoutStore だけを読み書きし、選んでいるファイル(appStore)には触れない。
 */
export function FileTreeHeader() {
  const { t } = useTranslation();
  const placement = useUILayoutStore((s) => s.fileTreePlacement);
  const togglePlacement = useUILayoutStore((s) => s.toggleFileTreePlacement);
  const setAllCategories = useUILayoutStore((s) => s.setAllFileTreeCategories);

  const collapseLabel = t("project.fileTreeCollapseAll");
  const expandLabel = t("project.fileTreeExpandAll");
  const moveLabel =
    placement === "left"
      ? t("project.fileTreeMoveRight")
      : t("project.fileTreeMoveLeft");
  const moveGlyph = placement === "left" ? "⇥" : "⇤";

  return (
    <div
      role="toolbar"
      aria-label={t("project.fileTreeToolbarAria")}
      className="flex h-6 flex-shrink-0 items-center justify-end gap-0.5 border-b border-zinc-200 px-1 dark:border-zinc-800"
    >
      <button
        type="button"
        onClick={() => setAllCategories(false)}
        className={BUTTON_CLASS}
        title={collapseLabel}
        aria-label={collapseLabel}
      >
        ⊟
      </button>
      <button
        type="button"
        onClick={() => setAllCategories(true)}
        className={BUTTON_CLASS}
        title={expandLabel}
        aria-label={expandLabel}
      >
        ⊞
      </button>
      <button
        type="button"
        onClick={togglePlacement}
        className={BUTTON_CLASS}
        title={moveLabel}
        aria-label={moveLabel}
      >
        {moveGlyph}
      </button>
    </div>
  );
}
