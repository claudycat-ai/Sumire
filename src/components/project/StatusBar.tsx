import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAutosaveStore } from "@/stores/autosaveStore";
import { useEditorContentStore } from "@/stores/editorContentStore";
import { useSuggestionStore } from "@/stores/suggestionStore";
import { useIllustrationStore } from "@/stores/illustrationStore";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { countCharacters } from "@/editor/charCount";

/** 日本語の文字数からトークン数を雑に推定する係数(OpenAICompatibleAdapter と同じ)。 */
const TOKEN_PER_CHAR = 1.5;
const DEFAULT_BUDGET = 500;

export function StatusBar() {
  const { t } = useTranslation();
  const status = useAutosaveStore((s) => s.status);
  const doc = useEditorContentStore((s) => s.doc);
  const generating = useSuggestionStore((s) => s.generating);
  const illustrationStartedAt = useIllustrationStore((s) => s.startedAt);
  const includedFiles = useSettingsContextStore((s) => s.files);
  const includedCount = includedFiles.size;
  const settingsBudget =
    useAIConfigStore(
      (s) => s.bundle?.providers[s.bundle.activeProvider]?.settingsTokenBudget,
    ) ?? DEFAULT_BUDGET;

  // 設定情報のトークン推定値: 含まれる全ファイル本文の文字数 × 係数
  const settingsTokensEstimate = useMemo(() => {
    let chars = 0;
    for (const f of includedFiles.values()) {
      chars += Array.from(f.body).length;
    }
    return Math.ceil(chars * TOKEN_PER_CHAR);
  }, [includedFiles]);
  const ratio = settingsBudget > 0 ? settingsTokensEstimate / settingsBudget : 0;
  let settingsColor: string;
  if (ratio > 1) {
    settingsColor = "text-red-500";
  } else if (ratio > 0.8) {
    settingsColor = "text-yellow-500 dark:text-yellow-400";
  } else {
    settingsColor = "text-zinc-500 dark:text-zinc-400";
  }

  // 「N 秒前」を 1 秒ごとに更新するため、現在時刻を保持する
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const charCount = useMemo(
    () => (doc !== null ? countCharacters(doc) : null),
    [doc],
  );

  let label: string;
  let color: string;
  switch (status.kind) {
    case "idle":
      label = t("status.idle");
      color = "text-zinc-500 dark:text-zinc-400";
      break;
    case "dirty":
      label = t("status.dirty");
      color = "text-purple-500 dark:text-purple-400";
      break;
    case "saving":
      label = t("status.saving");
      color = "text-purple-500 dark:text-purple-400";
      break;
    case "saved":
      label = t("status.saved", {
        relative: formatRelative(now - status.at, t),
      });
      color = "text-zinc-500 dark:text-zinc-400";
      break;
    case "error":
      label = t("status.saveFailed", { message: status.message });
      color = "text-red-500";
      break;
  }

  return (
    <footer className="flex items-center justify-between gap-4 border-t border-zinc-200 px-4 py-1 text-xs dark:border-zinc-800">
      <span className={color}>{label}</span>
      <div className="flex items-center gap-3">
        {generating && (
          <span
            className="text-purple-500 dark:text-purple-400"
            aria-live="polite"
          >
            {t("status.generating")}
          </span>
        )}
        {illustrationStartedAt !== null && (
          <IllustrationElapsed
            key={illustrationStartedAt}
            startedAt={illustrationStartedAt}
          />
        )}
        <span
          className={settingsColor}
          title={t("status.settingsTokensTooltip", {
            count: includedCount,
            ratio: TOKEN_PER_CHAR,
          })}
        >
          {t("status.settingsTokens", {
            used: settingsTokensEstimate.toLocaleString(),
            budget: settingsBudget.toLocaleString(),
          })}
        </span>
        {charCount !== null && (
          <span className="text-zinc-500 dark:text-zinc-400">
            {t("status.charCount", { n: charCount.toLocaleString() })}
          </span>
        )}
      </div>
    </footer>
  );
}

/**
 * 情景文の生成中の表示(illustration-prompt 要件 5.1)。
 * 生成中の間だけマウントし、経過秒数を 1 秒ごとに更新する。
 * 生成が終わる(アンマウントされる)とタイマーも解く。
 */
function IllustrationElapsed({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span className="text-purple-500 dark:text-purple-400" aria-live="polite">
      {t("status.illustrationGenerating", { seconds })}
    </span>
  );
}

function formatRelative(
  diffMs: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return t("time.secondsAgo", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  return t("time.hoursAgo", { n: hr });
}
