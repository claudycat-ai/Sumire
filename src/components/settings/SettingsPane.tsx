import { useTranslation } from "react-i18next";
import { selectSelectedSettings, useAppStore } from "@/stores/appStore";
import { SettingsTabBar } from "./SettingsTabBar";
import { SettingsEditor } from "./SettingsEditor";
import { AISettingsPane } from "./AISettingsPane";

interface Props {
  projectPath: string;
}

/**
 * 縦二段レイアウトの下半分。
 * 設定タブのタブバー + アクティブな設定ファイルの編集ビュー。
 *
 * `appStore.activeSettingsTab` で AI タブと既存 4 タブを分岐する。
 * - "ai" → <AISettingsPane />(`cloud-providers` spec, Req 4.3)
 * - その他 → アクティブタブのカテゴリで最後に開いていた設定ファイルを表示
 *
 * 章ファイルを選択中でも、設定ファイルの記憶(`selectedSettingsByCategory`)は
 * 章クリックで消えない。タブ切替時はカテゴリごとの「最後に見ていたファイル」を
 * 復元する。一度も開いていないカテゴリではプレースホルダを出す。
 */
export function SettingsPane({ projectPath }: Props) {
  const { t } = useTranslation();
  const selected = useAppStore(selectSelectedSettings);
  const activeSettingsTab = useAppStore((s) => s.activeSettingsTab);

  if (activeSettingsTab === "ai") {
    return (
      <section className="flex h-full flex-col">
        <SettingsTabBar />
        <div className="flex-1 overflow-hidden">
          <AISettingsPane projectPath={projectPath} />
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col">
      <SettingsTabBar />
      <div className="flex-1 overflow-hidden">
        {selected ? (
          <SettingsEditor
            projectPath={projectPath}
            category={selected.category}
            relativePath={selected.relativePath}
            fileName={selected.name}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {t("editor.selectSettings")}
          </div>
        )}
      </div>
    </section>
  );
}
