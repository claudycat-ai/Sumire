import { useTranslation } from "react-i18next";
import { useAppStore, type SettingsTab } from "@/stores/appStore";

const TABS: SettingsTab[] = [
  "characters",
  "worldbuilding",
  "glossary",
  "plot",
  "ai",
];

/**
 * 設定タブのタブバー。
 *
 * - 各タブクリックで `appStore.activeSettingsTab` を更新する(`cloud-providers` spec で
 *   従来の「クリック無効」ポリシーを撤廃)
 * - 「AI」タブは AISettingsPane を表示する。それ以外の 4 タブは既存の SettingsEditor を
 *   表示する(SettingsPane で分岐、task 8.2)
 * - 「コンテキストに含める」状態の可視化はファイルツリーペインで行う
 */
export function SettingsTabBar() {
  const { t } = useTranslation();
  const activeTab = useAppStore((s) => s.activeSettingsTab);
  const setActiveTab = useAppStore((s) => s.setActiveSettingsTab);

  return (
    <div
      role="tablist"
      aria-label={t("editor.settingsTabsAria")}
      className="flex items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 dark:border-zinc-800 dark:bg-zinc-950"
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => setActiveTab(tab)}
            className={
              "px-3 py-1.5 text-xs " +
              (isActive
                ? "border-b-2 border-purple-500 text-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")
            }
          >
            {t(`category.${tab}`)}
          </button>
        );
      })}
    </div>
  );
}
