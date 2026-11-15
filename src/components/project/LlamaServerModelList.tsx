import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { LlamaServerStatus } from "@/domain/llamaServer";
import { useLlamaServerStore } from "@/stores/llamaServerStore";
import { cn } from "@/lib/utils";

const STATE_LABEL_KEY = {
  stopped: "llamaServer.stateStopped",
  loading: "llamaServer.stateLoading",
  ready: "llamaServer.stateReady",
  failed: "llamaServer.stateFailed",
} as const satisfies Record<LlamaServerStatus["state"], string>;

/**
 * 左ペインの `llama-server` の行を展開した中身(`llama-server-provider` spec)。
 *
 * 上に状態の 1 行と「停止」(読み込み中・準備完了のときだけ)、下にモデルのファイル名の一覧
 * (空のときは、その理由に合わせた案内)。
 * 起動はここからはしない(モデルを選ぶだけ。動いている間の選び直しは、ストアが起動し直す)。
 */
export function LlamaServerModelList() {
  const { t } = useTranslation();
  const state = useLlamaServerStore((s) => s.status.state);
  const models = useLlamaServerStore((s) => s.models);
  const selectedModel = useLlamaServerStore((s) => s.preferences.selectedModel);
  const contextSizes = useLlamaServerStore((s) => s.preferences.models);
  const selectModel = useLlamaServerStore((s) => s.selectModel);
  const stop = useLlamaServerStore((s) => s.stop);
  const modelsError = useLlamaServerStore((s) => s.modelsError);
  const modelsDirUnset = useLlamaServerStore((s) => s.preferences.modelsDir === "");
  const refreshModels = useLlamaServerStore((s) => s.refreshModels);

  // このコンポーネントは、行が展開されている間だけマウントされる。展開のたびに 1 回、
  // フォルダの今の中身で一覧を作り直す(Sumire の外で足した・消した gguf を映す)。
  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const running = state === "loading" || state === "ready";
  // AI 設定画面の一覧と同じ基準で出し分ける。
  const emptyMessage =
    modelsError !== null
      ? t("llamaServer.modelsDirUnreadable", { message: modelsError })
      : modelsDirUnset
        ? t("llamaServer.modelsEmpty")
        : t("llamaServer.modelsDirNoGguf");

  return (
    <div className="pb-1 text-xs">
      <div className="flex items-center gap-2 py-1 pl-7 pr-2 text-zinc-500 dark:text-zinc-500">
        <span className="flex-1 truncate">{t(STATE_LABEL_KEY[state])}</span>
        {running && (
          <button
            type="button"
            onClick={() => void stop()}
            className="rounded-sm px-1.5 py-0.5 text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t("llamaServer.stop")}
          </button>
        )}
      </div>
      {models.length === 0 ? (
        <div className="break-all py-1 pl-7 pr-2 text-zinc-500 dark:text-zinc-500">
          {emptyMessage}
        </div>
      ) : (
        <ul>
          {models.map(({ fileName }) => {
            const isSelected = selectedModel === fileName;
            // 自分のプロパティだけを見る(`constructor` のような名前で、継承したものを拾わない)。
            const hasContextSize = Object.prototype.hasOwnProperty.call(
              contextSizes,
              fileName,
            );
            return (
              <li key={fileName}>
                <button
                  type="button"
                  onClick={() => void selectModel(fileName)}
                  aria-pressed={isSelected}
                  className="flex w-full items-center gap-1 py-1 pl-5 pr-2 text-left transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-900"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "w-3 shrink-0",
                      isSelected
                        ? "text-purple-600 dark:text-purple-400"
                        : "text-zinc-400 dark:text-zinc-600",
                    )}
                  >
                    {isSelected ? "●" : "○"}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-200"
                    title={fileName}
                  >
                    {fileName}
                  </span>
                  {!hasContextSize && (
                    <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-600">
                      {t("llamaServer.contextSizeUnset")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
