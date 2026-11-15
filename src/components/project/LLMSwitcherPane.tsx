import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderId } from "@/domain/providers/types";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { useAppStore } from "@/stores/appStore";
import { useLlamaServerStore } from "@/stores/llamaServerStore";
import { useUILayoutStore } from "@/stores/uiLayoutStore";
import { cn } from "@/lib/utils";
import { LlamaServerModelList } from "@/components/project/LlamaServerModelList";
import { emitDevEvent } from "@/lib/devLog";

/**
 * 表示順は固定(design.md L322 / task 6.1 仕様)。
 * Iterate しても安定した並びになるよう配列で持つ。
 */
const PROVIDER_DISPLAY_ORDER: readonly ProviderId[] = [
  "openai-compatible",
  "openai",
  "llama-server",
];

/**
 * 左サイドバー下部に置く「LLM 切替」ペイン。
 *
 * - 折り畳み可能(`HistoryPane` と同型の素実装、永続化なし。Req 5.1, 5.2)
 * - 各プロバイダ種別行を「左=切替スイッチ(●/○)」「中=表示名 (モデル数)」で表示(Req 5.3, 5.4)
 * - 種別行展開で配下に登録モデル名を表示(現状は 1 モデル/種別。Req 5.3)。
 *   `llama-server` だけは、状態とモデルの一覧(`LlamaServerModelList`)を出し、件数も一覧の数にする
 * - 行クリック → `appStore.selectAIProvider(id)` + `setActiveSettingsTab("ai")`
 *   (AI Settings Tab を開いて当該プロバイダを編集対象表示、Req 5 AC5)
 * - 左スイッチクリック → `useAIConfigStore.setActiveProvider(id)`(現在使うプロバイダ確定、Req 5.6)
 *   両者は `event.stopPropagation()` で機能分離(design.md L526)。
 * - 現在 active な行(`bundle.activeProvider === id`)の左スイッチを ●(紫)で強調(Req 5.8)
 * - ProjectView 側のサイドバー固定配置で、ファイルツリーの拡縮に追随する想定(Req 5.9)。
 *
 * 「キー未設定」バッジ(Req 5.7)は openai 種別行のみ表示する
 * (`openai-compatible` は API キー UI 非表示の方針、design.md L541)。
 * mount 時に `refreshSecretAvailability("openai")` を呼び、AISettingsPane の保存/削除完了後は
 * task 7.3 で同じ action を呼んで再評価する(`useAIConfigStore.secretAvailability` 経由で連携)。
 *
 * ## ネスト button 回避について
 * HTML はネストした `<button>` を許さないため、行内で「行クリック」と「スイッチクリック」を
 * 分けるには 2 つの兄弟 `<button>` を flex 行に並べる構成を採る(設計案の suggested simpler
 * structure に準拠)。`stopPropagation` は `<button>` 自体には不要だが、将来 row 全体で
 * pointerdown を拾う実装に切り替えた場合の保険として残している。
 */
export function LLMSwitcherPane() {
  const { t } = useTranslation();
  const bundle = useAIConfigStore((s) => s.bundle);
  const activeProvider = useAIConfigStore(
    (s) => s.bundle?.activeProvider ?? null,
  );
  const setActiveProvider = useAIConfigStore((s) => s.setActiveProvider);
  const secretAvailability = useAIConfigStore((s) => s.secretAvailability);
  const refreshSecretAvailability = useAIConfigStore(
    (s) => s.refreshSecretAvailability,
  );
  const llamaServerModelCount = useLlamaServerStore((s) => s.models.length);
  const selectedAIProvider = useAppStore((s) => s.selectedAIProvider);
  const selectAIProvider = useAppStore((s) => s.selectAIProvider);
  const setActiveSettingsTab = useAppStore((s) => s.setActiveSettingsTab);
  // 折り畳み状態は uiLayoutStore で永続化(per-machine, localStorage)。
  const headerExpanded = useUILayoutStore((s) => s.llmSwitcherExpanded);
  const toggleHeader = useUILayoutStore((s) => s.toggleLLMSwitcher);
  const providerExpanded = useUILayoutStore((s) => s.llmProviderExpanded);
  const toggleProviderExpanded = useUILayoutStore(
    (s) => s.toggleLLMProvider,
  );

  // mount 時に openai 種別のみ keychain 状態を取得(Req 5.7)。
  // openai-compatible は API キー UI 非表示の方針(design.md L541)のためバッジ対象外、
  // 不要な keychain 呼び出しを避けるため refresh しない。
  useEffect(() => {
    void refreshSecretAvailability("openai");
  }, [refreshSecretAvailability]);

  // bundle は ProjectView 配下でのみマウントされる前提だが、
  // プロジェクト切替直後の一瞬で null を引く可能性があるので防御。
  if (!bundle) {
    return null;
  }

  async function handleSelectActive(id: ProviderId, e: React.MouseEvent) {
    e.stopPropagation();
    const from = bundle?.activeProvider ?? null;
    await setActiveProvider(id);
    emitDevEvent("provider.switch", { from, to: id });
  }

  function handleSelectForEdit(id: ProviderId) {
    selectAIProvider(id);
    // 設定パネルが他タブを開いていても AI タブに切り替えて編集対象を見せる(Req 5 AC5)。
    setActiveSettingsTab("ai");
  }

  function handleToggleProviderExpand(id: ProviderId) {
    toggleProviderExpanded(id);
  }

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={toggleHeader}
        className="flex w-full items-center gap-1 px-3 py-1 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-900"
      >
        <span className="inline-block w-3 text-zinc-400">
          {headerExpanded ? "▾" : "▸"}
        </span>
        {t("project.llmSwitcher")}
      </button>
      {headerExpanded && (
        <ul className="max-h-60 overflow-y-auto">
          {PROVIDER_DISPLAY_ORDER.map((id) => {
            const section = bundle.providers[id];
            const isActive = activeProvider === id;
            const isSelectedForEdit = selectedAIProvider === id;
            const isProviderOpen = providerExpanded[id];
            return (
              <li key={id}>
                <div
                  className={cn(
                    "flex w-full items-center text-xs transition-colors",
                    isSelectedForEdit
                      ? "bg-purple-200 dark:bg-purple-900/50"
                      : "hover:bg-zinc-200 dark:hover:bg-zinc-900",
                  )}
                >
                  {/* 左: 「現在使うプロバイダ」切替スイッチ(Req 5.6, 5.8) */}
                  <button
                    type="button"
                    onClick={(e) => void handleSelectActive(id, e)}
                    className={cn(
                      "px-2 py-1",
                      isActive
                        ? "text-purple-600 dark:text-purple-400"
                        : "text-zinc-400 dark:text-zinc-600",
                    )}
                    title={
                      isActive
                        ? t("aiProvider.activeNow")
                        : t("aiProvider.setActive")
                    }
                    aria-pressed={isActive}
                  >
                    {isActive ? "●" : "○"}
                  </button>
                  {/* 中: 行クリックで AI 設定タブの編集対象を切替(Req 5.5) */}
                  <button
                    type="button"
                    onClick={() => handleSelectForEdit(id)}
                    className="flex flex-1 items-center gap-1 py-1 pr-2 text-left"
                  >
                    {/* 折り畳みインジケータ(階層展開、Req 5.3) */}
                    <span
                      className="inline-block w-3 text-zinc-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleProviderExpand(id);
                      }}
                      role="button"
                      tabIndex={-1}
                      aria-label={
                        isProviderOpen
                          ? t("aiProvider.collapseModels")
                          : t("aiProvider.expandModels")
                      }
                    >
                      {isProviderOpen ? "▾" : "▸"}
                    </span>
                    <span className="truncate text-zinc-800 dark:text-zinc-200">
                      {t(`aiProvider.${id}`)}
                    </span>
                    <span className="ml-1 text-zinc-400 dark:text-zinc-600">
                      ({id === "llama-server" ? llamaServerModelCount : 1})
                    </span>
                  </button>
                  {/* 右: 「キー未設定」バッジ(Req 5.7、openai 種別かつ keychain 未保存のとき) */}
                  {id === "openai" &&
                    secretAvailability.openai === false && (
                      <span
                        className="mr-2 rounded-sm bg-red-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-700 dark:bg-red-900/40 dark:text-red-300"
                        title={t("aiProvider.keyMissing")}
                      >
                        {t("aiProvider.keyMissing")}
                      </span>
                    )}
                </div>
                {isProviderOpen &&
                  (id === "llama-server" ? (
                    <LlamaServerModelList />
                  ) : (
                    <div className="px-7 py-1 text-xs text-zinc-500 dark:text-zinc-500">
                      {section.model}
                    </div>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
