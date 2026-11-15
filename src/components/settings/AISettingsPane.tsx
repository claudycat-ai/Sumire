import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/stores/appStore";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import type { AIConfig, ProviderId } from "@/domain/providers/types";
import { ProviderError } from "@/domain/providers/types";
import { SecretStore } from "@/domain/secrets";
import {
  isReasoningModel,
  listOpenAIModels,
  OPENAI_CONTEXT_WINDOW_MAP,
  OpenAIAdapter,
} from "@/domain/providers/openai";
import { toastError, toastInfo } from "@/components/ui/Toast";
import { emitDevEvent } from "@/lib/devLog";
import { LlamaServerSettings } from "@/components/settings/LlamaServerSettings";

interface Props {
  /**
   * プロジェクトパス。本タスク(skeleton)では未使用だが、
   * task 7.2 / 7.3 で sumire.json 永続化の引数として使う。
   */
  projectPath: string;
}

/**
 * フォーム編集用のローカル state shape。
 * `AIConfig` と異なり数値も string で保持する(ユーザーが空欄や中間入力を持てるように)。
 * `null` 化や数値 parse は debounce 後の patch 構築時に行う。
 */
interface FormValues {
  endpoint: string;
  model: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  contextWindow: string;
  settingsTokenBudget: string;
  systemPrompt: string;
}

/**
 * 2 つの FormValues を全フィールド strict equality で比較する。
 *
 * 用途は「provider セクションが外部から更新された(参照変化した)が、値は
 * フォームの現在値と完全に同じ」というケースを検出して setForm を no-op にすること。
 * これにより自前 debounce save 起因の bundle 参照変化で form を再 set してしまい、
 * 結果 debounce useEffect が `form` 参照変化で再発火 → 1 秒後に冗長 save が走る、
 * という無限ループ気味の挙動を断ち切る(reviewer 指摘)。
 *
 * 全フィールドが string(systemPrompt も textarea 由来の string)なので === で十分。
 */
function formsEqual(a: FormValues, b: FormValues): boolean {
  return (
    a.endpoint === b.endpoint &&
    a.model === b.model &&
    a.temperature === b.temperature &&
    a.topP === b.topP &&
    a.maxTokens === b.maxTokens &&
    a.contextWindow === b.contextWindow &&
    a.settingsTokenBudget === b.settingsTokenBudget &&
    a.systemPrompt === b.systemPrompt
  );
}

/**
 * `AIConfig` から FormValues 文字列表現を生成。
 * 数値 → 文字列、null systemPrompt → 空文字列に正規化する。
 */
function configToForm(config: AIConfig): FormValues {
  return {
    endpoint: config.endpoint,
    model: config.model,
    temperature: String(config.parameters.temperature),
    topP: String(config.parameters.topP),
    maxTokens: String(config.parameters.maxTokens),
    contextWindow:
      config.contextWindow != null ? String(config.contextWindow) : "",
    settingsTokenBudget:
      config.settingsTokenBudget != null
        ? String(config.settingsTokenBudget)
        : "",
    systemPrompt: config.systemPrompt ?? "",
  };
}

/**
 * FormValues → 永続化用の `Partial<AIConfig>` patch に変換する。
 *
 * - 数値フィールドは parseFloat / parseInt で変換し、NaN なら現在の bundle 値を維持する
 *   (= patch から omit する)。仕様の「NaN は無視」を満たす。
 * - systemPrompt の空文字列は `null` に正規化(`AIConfig.systemPrompt` の型に合わせる)
 * - parameters は spread で再構成して新オブジェクト化(registry の WeakMap キャッシュをミスさせる)
 * - `llama-server` では endpoint / model / contextWindow を patch に入れない(欄が無く、
 *   値は起動した `llama-server` とアプリ側の設定から決まるので、`sumire.json` の値に触らない)
 */
function buildPatch(form: FormValues, current: AIConfig): Partial<AIConfig> {
  const temperature = parseFloat(form.temperature);
  const topP = parseFloat(form.topP);
  const maxTokens = parseInt(form.maxTokens, 10);
  const contextWindow =
    form.contextWindow.trim() === ""
      ? undefined
      : parseInt(form.contextWindow, 10);
  const settingsTokenBudget =
    form.settingsTokenBudget.trim() === ""
      ? undefined
      : parseInt(form.settingsTokenBudget, 10);

  // parameters は patch に必ず含める(NaN だけ既存値で埋める)
  const newParameters = {
    ...current.parameters,
    temperature: Number.isFinite(temperature)
      ? temperature
      : current.parameters.temperature,
    topP: Number.isFinite(topP) ? topP : current.parameters.topP,
    maxTokens: Number.isFinite(maxTokens)
      ? maxTokens
      : current.parameters.maxTokens,
  };

  const patch: Partial<AIConfig> = {
    endpoint: form.endpoint,
    model: form.model,
    parameters: newParameters,
    systemPrompt: form.systemPrompt.trim() === "" ? null : form.systemPrompt,
  };

  // contextWindow / settingsTokenBudget は空欄を尊重(undefined で patch、
  // updateProviderSection 側の spread で「キー保持で値 undefined」になる)。
  // NaN のときだけ既存値を維持。
  if (form.contextWindow.trim() === "") {
    patch.contextWindow = undefined;
  } else if (Number.isFinite(contextWindow)) {
    patch.contextWindow = contextWindow;
  } else {
    patch.contextWindow = current.contextWindow;
  }

  if (form.settingsTokenBudget.trim() === "") {
    patch.settingsTokenBudget = undefined;
  } else if (Number.isFinite(settingsTokenBudget)) {
    patch.settingsTokenBudget = settingsTokenBudget;
  } else {
    patch.settingsTokenBudget = current.settingsTokenBudget;
  }

  if (current.provider === "llama-server") {
    delete patch.endpoint;
    delete patch.model;
    delete patch.contextWindow;
  }

  return patch;
}

/** 推論モデルで temperature / top_p を送らないことの注記。両方の入力欄から参照する。 */
const SAMPLING_NOTE_ID = "ai-sampling-ignored-note";

/**
 * SettingsPane の AI タブ専用 form。
 *
 * - `appStore.selectedAIProvider` で表示対象プロバイダを切替(Req 4.1, 4.2)
 *   `null` のときはプレースホルダー(Req 4.1)、選択中はその種別セクションのみ表示(Req 4.3)
 * - LLMSwitcherPane と「現在使うプロバイダ」スイッチを双方向同期(Req 4.6)
 * - フォーム本体(endpoint / model / parameters / systemPrompt / contextWindow /
 *   settingsTokenBudget)は controlled inputs + 1 秒 debounce のオートセーブで
 *   `useAIConfigStore.updateProviderSection` を呼ぶ(Req 4.4, 4.8)
 * - API キー入力(Req 4.7, 4.9)・モデル一覧取得(Req 4.5)・接続疎通(Req 4.7)は
 *   それぞれ task 7.3 / 7.4 / 7.5 のスコープ。本タスクでは触らない。
 *
 * 設計参照: design.md AISettingsPane セクション(L529-558)。
 */
export function AISettingsPane({ projectPath: _projectPath }: Props) {
  const { t } = useTranslation();
  const selectedAIProvider = useAppStore((s) => s.selectedAIProvider);
  const activeProvider = useAIConfigStore(
    (s) => s.bundle?.activeProvider ?? null,
  );
  const setActiveProvider = useAIConfigStore((s) => s.setActiveProvider);
  // bundle 全体を購読して、外部更新(LLMSwitcher 経由のスイッチ等)に追従。
  // ただし「フォーム編集 → debounce save → bundle 更新 → form 再 sync」のループを
  // 起こさないよう、再 sync の発火条件は selectedAIProvider 切替時のみに限定する
  // (下記 useEffect 参照)。
  const bundle = useAIConfigStore((s) => s.bundle);

  // フォーム local state。selectedAIProvider が null のときは null で、
  // 選択直後の useEffect で current bundle 値から初期化する。
  const [form, setForm] = useState<FormValues | null>(null);

  // selectedAIProvider 切替 + bundle 参照変化(他箇所からの永続化等)に追従して
  // form を current bundle 値で再初期化する。
  //
  // **重要**: ここで毎回 `setForm(configToForm(providerConfig))` してしまうと、
  // `configToForm` は毎回新オブジェクトを返すので React の bail-out が効かず、
  // form 参照が必ず変化する。すると debounce useEffect が form 依存で再発火し、
  // 1 秒後に冗長 save → bundle 参照変化 → mount effect 再発火 → ...という
  // 増殖ループを起こす(reviewer 指摘)。
  //
  // これを断つために、setForm の updater 内で「現在 form と次 form が値同一なら
  // 前の参照を返す(= bail-out)」という比較を入れる。これで自前 save 起因の
  // bundle 変化では form 参照は変わらず、debounce useEffect は再発火しない。
  const providerConfig =
    selectedAIProvider != null && bundle != null
      ? bundle.providers[selectedAIProvider]
      : null;
  useEffect(() => {
    if (providerConfig == null) {
      setForm(null);
      return;
    }
    const next = configToForm(providerConfig);
    setForm((prev) => (prev != null && formsEqual(prev, next) ? prev : next));
  }, [providerConfig]);

  // debounce 保存。form が変わって 1 秒経つと updateProviderSection を呼ぶ。
  //
  // **依存設計**: deps は `form` と `selectedAIProvider` のみ。`providerConfig` は
  // ref 経由で参照する。理由:
  //   - 自前 save が起きると bundle が新参照になり `providerConfig` も新参照になる。
  //     useEffect の deps に入れるとここで再発火 → 1 秒後に再 save → ...の増殖ループ。
  //   - mount effect 側で「値同一なら setForm bail-out」している(formsEqual)ので、
  //     自前 save 起因の bundle 変化では `form` は変わらない。よって `form` のみを
  //     deps にすれば「ユーザー編集起因の form 変化」だけが debounce を発火する。
  //   - patch 構築に必要な `providerConfig` の最新値は ref から読む。
  const providerConfigRef = useRef<AIConfig | null>(providerConfig);
  providerConfigRef.current = providerConfig;
  useEffect(() => {
    if (selectedAIProvider == null || form == null) return;
    const handle = setTimeout(() => {
      const current = providerConfigRef.current;
      if (current == null) return;
      // 「マウント直後の form 初期化」など、form の値が現在の bundle と完全に
      // 同じならば save する必要がない。configToForm(current) と form を比較し、
      // 同値ならスキップする(冗長書き込み防止)。
      if (formsEqual(form, configToForm(current))) return;
      const patch = buildPatch(form, current);
      void useAIConfigStore
        .getState()
        .updateProviderSection(selectedAIProvider, patch);
    }, 1000);
    return () => clearTimeout(handle);
  }, [form, selectedAIProvider]);

  if (selectedAIProvider === null) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
        {t("aiSettings.placeholder")}
      </div>
    );
  }

  const isActive = activeProvider === selectedAIProvider;
  const isLlamaServer = selectedAIProvider === "llama-server";
  // OpenAI の推論モデルには temperature / top_p を送らない(OpenAIAdapter の Chat 経路)。
  // 値は編集できるまま残し、送られないことだけを注記で示す。
  const samplingIgnored =
    selectedAIProvider === "openai" && form != null && isReasoningModel(form.model);

  // bundle ロード前(form 未初期化)はヘッダーだけ描画して空欄で待機。
  // 通常は loadFromMeta が同期的に bundle を埋めるため、ここに到達するのは
  // プロジェクト未オープン時だけ(その場合は AISettingsPane 自体が描かれない想定)。
  if (form == null) {
    return (
      <section className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {t(`aiProvider.${selectedAIProvider}`)}
          </span>
        </header>
        <div className="flex-1 overflow-y-auto" />
      </section>
    );
  }

  // 共通の input 用 Tailwind クラス(NewProjectDialog のスタイルに合わせる)
  const inputClass =
    "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
  const labelClass =
    "mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300";

  return (
    <section className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => void setActiveProvider(selectedAIProvider)}
          aria-pressed={isActive}
          title={t(isActive ? "aiProvider.activeNow" : "aiProvider.setActive")}
          className={
            "flex h-6 w-6 items-center justify-center rounded text-base " +
            (isActive
              ? "text-purple-600 dark:text-purple-400"
              : "text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400")
          }
        >
          {isActive ? "●" : "○"}
        </button>
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {t(`aiProvider.${selectedAIProvider}`)}
        </span>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {!isLlamaServer && (
          <div>
            <label className={labelClass} htmlFor="ai-endpoint">
              {t("aiSettings.endpoint")}
            </label>
            <input
              id="ai-endpoint"
              type="text"
              value={form.endpoint}
              onChange={(e) =>
                setForm((prev) =>
                  prev == null ? prev : { ...prev, endpoint: e.target.value },
                )
              }
              className={inputClass}
            />
          </div>
        )}

        {isLlamaServer ? (
          <LlamaServerSettings inputClass={inputClass} labelClass={labelClass} />
        ) : selectedAIProvider === "openai" ? (
          <ModelSelectorOpenAI
            form={form}
            setForm={setForm}
            inputClass={inputClass}
            labelClass={labelClass}
          />
        ) : (
          <div>
            <label className={labelClass} htmlFor="ai-model">
              {t("aiSettings.model")}
            </label>
            <input
              id="ai-model"
              type="text"
              value={form.model}
              onChange={(e) =>
                setForm((prev) =>
                  prev == null ? prev : { ...prev, model: e.target.value },
                )
              }
              className={inputClass}
            />
          </div>
        )}

        <fieldset className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <legend className="px-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            {t("aiSettings.parameters")}
          </legend>

          <div>
            <label className={labelClass} htmlFor="ai-temperature">
              {t("aiSettings.temperature")}
            </label>
            <input
              id="ai-temperature"
              type="number"
              step="0.1"
              min="0"
              max="2"
              aria-describedby={samplingIgnored ? SAMPLING_NOTE_ID : undefined}
              value={form.temperature}
              onChange={(e) =>
                setForm((prev) =>
                  prev == null
                    ? prev
                    : { ...prev, temperature: e.target.value },
                )
              }
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="ai-top-p">
              {t("aiSettings.topP")}
            </label>
            <input
              id="ai-top-p"
              type="number"
              step="0.05"
              min="0"
              max="1"
              aria-describedby={samplingIgnored ? SAMPLING_NOTE_ID : undefined}
              value={form.topP}
              onChange={(e) =>
                setForm((prev) =>
                  prev == null ? prev : { ...prev, topP: e.target.value },
                )
              }
              className={inputClass}
            />
            {samplingIgnored && (
              <p
                id={SAMPLING_NOTE_ID}
                className="mt-1 text-xs text-zinc-500 dark:text-zinc-500"
              >
                {t("aiSettings.samplingIgnoredForReasoning")}
              </p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor="ai-max-tokens">
              {t("aiSettings.maxTokens")}
            </label>
            <input
              id="ai-max-tokens"
              type="number"
              step="1"
              min="1"
              value={form.maxTokens}
              onChange={(e) =>
                setForm((prev) =>
                  prev == null ? prev : { ...prev, maxTokens: e.target.value },
                )
              }
              className={inputClass}
            />
          </div>

          {!isLlamaServer && (
            <div>
              <label className={labelClass} htmlFor="ai-context-window">
                {t("aiSettings.contextWindow")}
              </label>
              <input
                id="ai-context-window"
                type="number"
                step="1"
                min="1"
                value={form.contextWindow}
                onChange={(e) =>
                  setForm((prev) =>
                    prev == null
                      ? prev
                      : { ...prev, contextWindow: e.target.value },
                  )
                }
                className={inputClass}
              />
            </div>
          )}

          <div>
            <label className={labelClass} htmlFor="ai-settings-token-budget">
              {t("aiSettings.settingsTokenBudget")}
            </label>
            <input
              id="ai-settings-token-budget"
              type="number"
              step="1"
              min="0"
              value={form.settingsTokenBudget}
              onChange={(e) =>
                setForm((prev) =>
                  prev == null
                    ? prev
                    : { ...prev, settingsTokenBudget: e.target.value },
                )
              }
              className={inputClass}
            />
          </div>
        </fieldset>

        <div>
          <label className={labelClass} htmlFor="ai-system-prompt">
            {t("aiSettings.systemPrompt")}
          </label>
          <textarea
            id="ai-system-prompt"
            value={form.systemPrompt}
            onChange={(e) =>
              setForm((prev) =>
                prev == null
                  ? prev
                  : { ...prev, systemPrompt: e.target.value },
              )
            }
            rows={6}
            className={inputClass + " resize-y"}
          />
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            {t("aiSettings.systemPromptHelp")}
          </p>
        </div>

        {selectedAIProvider === "openai" && (
          <>
            <ApiKeySection providerId="openai" inputClass={inputClass} />
            <ConnectionTestSection
              form={form}
              providerConfig={providerConfig}
            />
          </>
        )}
      </div>
    </section>
  );
}

/**
 * OpenAI セクション用の接続疎通テスト UI(Req 4.7)。
 *
 * - 「接続テスト」ボタン + ステータスバッジ(未確認 / テスト中 / OK / 失敗)。
 * - 内部実装: `OpenAIAdapter` を直接 `new` して `generate({ maxTokens: 1 })` を投げる
 *   (registry は介さない。task 7.5 の指針)。
 * - 編集中の `form` の値で `AIConfig` を構築するため、未保存の変更でも疎通テスト可能。
 * - 結果は **ローカル state にのみ** 保持(bundle / sumire.json には保存しない、
 *   design L546「ユーザー操作時のみ」)。
 * - `selectedAIProvider` が openai 以外に切り替わるとこのコンポーネントが unmount され、
 *   ローカル state(testStatus / testError)が自然にリセットされる。
 *
 * **エラーメッセージ**: `ProviderError.kind`(auth / network / config / http / ...)を
 * 先頭に出して、ユーザーが原因を切り分けられるようにする。
 */
function ConnectionTestSection({
  form,
  providerConfig,
}: {
  form: FormValues;
  providerConfig: AIConfig | null;
}) {
  const { t } = useTranslation();
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "failed"
  >("idle");
  const [testError, setTestError] = useState<string | null>(null);

  async function handleConnectionTest() {
    setTestStatus("testing");
    setTestError(null);
    try {
      // form は文字列ベースなので、現在 bundle 値(providerConfig)を base にして
      // 既存の buildPatch ロジックで AIConfig を組み立てる。providerConfig が null の
      // ケース(bundle 未ロード)はボタン押下前に到達しない想定だが、念のため弾く。
      if (providerConfig == null) {
        throw new ProviderError(
          "config",
          t("aiSettings.connectionTestNoConfig"),
        );
      }
      const patch = buildPatch(form, providerConfig);
      // patch.parameters は buildPatch 内で必ず再構成されるが、型上は任意なので
      // フォールバックを用意しておく。
      const config: AIConfig = {
        ...providerConfig,
        ...patch,
        parameters: patch.parameters ?? providerConfig.parameters,
      };
      const adapter = new OpenAIAdapter(config);
      const result = await adapter.generate({
        systemPrompt: "test",
        contextSections: [],
        body: "Hello",
        parameters: {
          temperature: 0.0,
          topP: 1.0,
          // 課金最小化のため 1 トークンだけ。返却テキストが空でも疎通成功と見なす。
          maxTokens: 1,
        },
      });
      // 戻り値の中身は問わない(成功した時点で疎通 OK)。
      void result;
      setTestStatus("ok");
      emitDevEvent("connection.test.result", { ok: true });
    } catch (e) {
      setTestStatus("failed");
      if (e instanceof ProviderError) {
        setTestError(`${e.kind}: ${e.message}`);
        emitDevEvent("connection.test.result", {
          ok: false,
          kind: e.kind,
          message: e.message,
        });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setTestError(message);
        emitDevEvent("connection.test.result", {
          ok: false,
          kind: "unknown",
          message,
        });
      }
    }
  }

  // バッジ色クラス。idle / testing / ok / failed で切り替える。
  const badgeBaseClass =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
  const badgeClassByStatus: Record<typeof testStatus, string> = {
    idle: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    testing: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    ok: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  };
  const badgeLabelByStatus: Record<typeof testStatus, string> = {
    idle: t("aiSettings.connectionStatusIdle"),
    testing: t("aiSettings.connectionStatusTesting"),
    ok: t("aiSettings.connectionStatusOk"),
    failed: t("aiSettings.connectionStatusFailed"),
  };

  const secondaryButtonClass =
    "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

  return (
    <fieldset className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <legend className="px-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {t("aiSettings.connectionTest")}
      </legend>

      <div
        className="flex items-center gap-3"
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          onClick={() => void handleConnectionTest()}
          disabled={testStatus === "testing"}
          className={secondaryButtonClass}
        >
          {t("aiSettings.connectionTest")}
        </button>
        <span className={`${badgeBaseClass} ${badgeClassByStatus[testStatus]}`}>
          {badgeLabelByStatus[testStatus]}
        </span>
      </div>

      {testStatus === "failed" && testError != null && (
        <p className="text-xs font-mono text-red-700 dark:text-red-300 break-all">
          {testError}
        </p>
      )}
    </fieldset>
  );
}

/**
 * OpenAI 用のモデル選択 UI。
 *
 * - プリセット dropdown(取得前は `OPENAI_CONTEXT_WINDOW_MAP` のキー、`/v1/models` の取得に
 *   成功した後は取得結果だけ)
 * - 手動入力テキストフィールド(未公開プレビューモデル用)
 * - 「モデル一覧を更新」ボタン(押下で `listOpenAIModels` を呼び、結果を React state にキャッシュ)
 *
 * 設計参照: design.md L542「モデル選択 UI」。Req 4.5 を満たす。
 *
 * **state 設計**:
 * - `form.model` が source of truth(dropdown / 手動入力どちらの編集も同じフィールドを書く)
 * - `fetchedModels` は session-only(永続化なし、unmount で消える)
 * - dropdown 選択時に `OPENAI_CONTEXT_WINDOW_MAP[modelId]` が定義されていれば
 *   contextWindow を自動補完(ユーザーは別欄で手動上書き可)
 */
function ModelSelectorOpenAI({
  form,
  setForm,
  inputClass,
  labelClass,
}: {
  form: FormValues;
  setForm: Dispatch<SetStateAction<FormValues | null>>;
  inputClass: string;
  labelClass: string;
}) {
  const { t } = useTranslation();
  // `null` はまだ取得していない状態。
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  // 取得前はプリセット候補(OPENAI_CONTEXT_WINDOW_MAP のキー)を出す。取得に成功したら
  // 取得結果だけにする(API が返さない廃止済みモデルをプリセットから残さないため)。
  // 重複排除 + アルファベット順で並べる(予測しやすい順序)。
  const options = Array.from(
    new Set(fetchedModels ?? Object.keys(OPENAI_CONTEXT_WINDOW_MAP)),
  ).sort();

  // dropdown の value 属性は form.model を直接渡す。
  // form.model が options に含まれない(= 手動入力中)の場合は空(プレースホルダー表示)になる。
  const dropdownValue = options.includes(form.model) ? form.model : "";

  async function handleFetchModels() {
    setIsFetching(true);
    emitDevEvent("models.fetch.start");
    try {
      // キーの値は読まず、設定済みかどうかだけを確かめる(キーは Rust 側が送信時に付ける)。
      const hasKey = await SecretStore.hasSecret("openai");
      if (!hasKey) {
        toastError(t("aiSettings.modelFetchNoKey"));
        emitDevEvent("models.fetch.skip", { reason: "noKey" });
        return;
      }
      const result = await listOpenAIModels(form.endpoint);
      setFetchedModels(result.map((m) => m.id));
      toastInfo(t("aiSettings.modelFetchSuccess", { count: result.length }));
      emitDevEvent("models.fetch.success", { count: result.length });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toastError(t("aiSettings.modelFetchFailed", { message }));
      emitDevEvent("models.fetch.error", {
        kind: e instanceof ProviderError ? e.kind : "unknown",
        message,
      });
    } finally {
      setIsFetching(false);
    }
  }

  // 共通ボタンクラス(ApiKeySection と揃える)
  const secondaryButtonClass =
    "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

  return (
    <fieldset className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <legend className="px-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {t("aiSettings.model")}
      </legend>

      {/* プリセット dropdown(取得前はプリセット、取得後は取得結果) */}
      <div>
        <label className={labelClass} htmlFor="ai-model-preset">
          {t("aiSettings.modelPreset")}
        </label>
        <select
          id="ai-model-preset"
          value={dropdownValue}
          onChange={(e) => {
            const newModel = e.target.value;
            if (newModel === "") return;
            const presetCw = OPENAI_CONTEXT_WINDOW_MAP[newModel];
            setForm((prev) =>
              prev == null
                ? prev
                : {
                    ...prev,
                    model: newModel,
                    // 既知モデル → contextWindow を自動補完(ユーザーは別欄で上書き可)
                    // 未知モデル(取得結果に出てきた preview など) → 既存値を維持
                    contextWindow:
                      presetCw != null ? String(presetCw) : prev.contextWindow,
                  },
            );
          }}
          className={inputClass}
        >
          <option value="" disabled>
            {t("aiSettings.modelSelectPlaceholder")}
          </option>
          {options.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>

      {/* 手動入力(未公開プレビューモデル用) */}
      <div>
        <label className={labelClass} htmlFor="ai-model">
          {t("aiSettings.modelCustom")}
        </label>
        <input
          id="ai-model"
          type="text"
          value={form.model}
          onChange={(e) =>
            setForm((prev) =>
              prev == null ? prev : { ...prev, model: e.target.value },
            )
          }
          placeholder={t("aiSettings.modelCustomPlaceholder")}
          className={inputClass}
        />
      </div>

      {/* モデル一覧を更新ボタン */}
      <div>
        <button
          type="button"
          onClick={() => void handleFetchModels()}
          disabled={isFetching}
          className={secondaryButtonClass}
        >
          {isFetching
            ? t("aiSettings.modelFetching")
            : t("aiSettings.modelFetch")}
        </button>
      </div>
    </fieldset>
  );
}

/**
 * API キー入力 + 保存/削除 + 「キー設定済み」ステータス表示。
 *
 * **設計原則(design.md L681-685)**:
 * - 入力値は **local React state にのみ** 持ち、`sumire.json` / bundle / メモリキャッシュには
 *   一切残さない。`SecretStore.setSecret` で OS keychain に渡したら入力欄をクリアする。
 * - 「保存済みのキー」を入力欄に逆ロードしない(キーの値は画面側から取得できない。
 *   provider-http-rust Req 7.1)。ステータス表示(キー設定済み/未設定)で
 *   「保存されているか」だけを伝える。
 * - 「表示」操作は `<input type="password">` → `type="text"` の一時切替で、5 秒で自動再マスク。
 *
 * **LLMSwitcherPane との連携(Req 5.7)**:
 * - 保存/削除完了直後に `useAIConfigStore.refreshSecretAvailability(providerId)` を呼ぶ。
 *   これで `secretAvailability[providerId]` が更新され、LLMSwitcherPane の「キー未設定」
 *   バッジが即時に消える/現れる。
 * - mount 時にも 1 回呼んで自セクションのステータス表示を最新化する。
 *
 * **i18n キー**: `aiSettings.apiKey*` 系(ja.json / en.json)。
 */
function ApiKeySection({
  providerId,
  inputClass,
}: {
  providerId: ProviderId;
  inputClass: string;
}) {
  const { t } = useTranslation();
  const refreshSecretAvailability = useAIConfigStore(
    (s) => s.refreshSecretAvailability,
  );
  const isKeySet = useAIConfigStore(
    (s) => s.secretAvailability[providerId] === true,
  );

  const [inputValue, setInputValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  // 「表示」状態の自動再マスク用タイマー。アンマウント時 / 再 toggle 時に必ず clear。
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 自セクションを単独で開いた場合でもステータスバッジが動くよう、
  // mount 時に一度だけ refresh する(LLMSwitcherPane の mount effect と二重に
  // なるが、両方とも安価な keychain read なので問題ない)。
  useEffect(() => {
    void refreshSecretAvailability(providerId);
  }, [providerId, refreshSecretAvailability]);

  // unmount 時に reveal タイマーが残っていれば破棄(setState after unmount 警告防止)。
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, []);

  function clearRevealTimer() {
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }

  function toggleReveal() {
    if (revealed) {
      setRevealed(false);
      clearRevealTimer();
    } else {
      setRevealed(true);
      clearRevealTimer();
      revealTimerRef.current = setTimeout(() => {
        setRevealed(false);
        revealTimerRef.current = null;
      }, 5000);
    }
  }

  async function handleSave() {
    const trimmed = inputValue.trim();
    if (trimmed === "") {
      toastError(t("aiSettings.apiKeyEmpty"));
      return;
    }
    setBusy(true);
    try {
      await SecretStore.setSecret(providerId, trimmed);
      // 保存完了後は入力欄を空にする(平文をメモリ滞在させない)。
      setInputValue("");
      setRevealed(false);
      clearRevealTimer();
      // LLMSwitcherPane の「キー未設定」バッジ + 自セクションのステータス表示を更新。
      await refreshSecretAvailability(providerId);
      toastInfo(t("aiSettings.apiKeySaved"));
      emitDevEvent("secret.set", { provider: providerId, ok: true });
    } catch (e) {
      toastError(t("aiSettings.apiKeySaveFailed", { message: String(e) }));
      emitDevEvent("secret.set", {
        provider: providerId,
        ok: false,
        error: String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await SecretStore.deleteSecret(providerId);
      // 削除後も入力欄をクリア(削除直前に何か入力してあったケースの保険)。
      setInputValue("");
      setRevealed(false);
      clearRevealTimer();
      await refreshSecretAvailability(providerId);
      toastInfo(t("aiSettings.apiKeyDeleted"));
      emitDevEvent("secret.delete", { provider: providerId, ok: true });
    } catch (e) {
      toastError(t("aiSettings.apiKeyDeleteFailed", { message: String(e) }));
      emitDevEvent("secret.delete", {
        provider: providerId,
        ok: false,
        error: String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  // 共通ボタンクラス(NewProjectDialog 系のスタイルに合わせる)。
  const primaryButtonClass =
    "rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50";
  const secondaryButtonClass =
    "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
  const dangerButtonClass =
    "rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950";

  return (
    <fieldset className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <legend className="px-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {t("aiSettings.apiKey")}
      </legend>

      {/* ステータス表示(キー設定済み/未設定、Req 4.7) */}
      <div
        className="flex items-center gap-2 text-xs"
        role="status"
        aria-live="polite"
      >
        {isKeySet ? (
          <>
            <span className="text-purple-600 dark:text-purple-400">●</span>
            <span className="text-zinc-700 dark:text-zinc-300">
              {t("aiSettings.apiKeyStatusSet")}
            </span>
          </>
        ) : (
          <>
            <span className="text-zinc-400 dark:text-zinc-600">○</span>
            <span className="text-zinc-500 dark:text-zinc-500">
              {t("aiSettings.apiKeyStatusUnset")}
            </span>
          </>
        )}
      </div>

      {/* 入力欄 + 表示/隠す トグル(Req 2.5, 4.9) */}
      <div className="flex gap-2">
        <input
          id="ai-api-key"
          type={revealed ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("aiSettings.apiKeyPlaceholder")}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          aria-label={t("aiSettings.apiKey")}
          className={inputClass}
        />
        <button
          type="button"
          onClick={toggleReveal}
          className={secondaryButtonClass}
          title={
            revealed
              ? t("aiSettings.apiKeyHide")
              : t("aiSettings.apiKeyShow")
          }
        >
          {revealed ? t("aiSettings.apiKeyHide") : t("aiSettings.apiKeyShow")}
        </button>
      </div>

      {/* 保存 / 削除(Req 2.3, 2.4) */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || inputValue.trim() === ""}
          className={primaryButtonClass}
        >
          {t("aiSettings.apiKeySave")}
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={busy || !isKeySet}
          className={dangerButtonClass}
        >
          {t("aiSettings.apiKeyDelete")}
        </button>
      </div>
    </fieldset>
  );
}
