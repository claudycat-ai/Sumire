import { create } from "zustand";
import i18next from "i18next";
import {
  AIConfig,
  AIConfigBundle,
  DEFAULT_AI_CONFIG_BUNDLE,
  ProviderId,
  type ThinkingConfig,
  type ThinkingTagPair,
} from "@/domain/providers/types";
import type { SumireProjectMeta } from "@/domain/project/types";
import { useAppStore } from "@/stores/appStore";
import { saveProjectMeta } from "@/domain/project/projectApi";
import { toastError, toastInfo } from "@/components/ui/Toast";
import { SecretStore } from "@/domain/secrets";

/** `cloud-providers` spec で扱う既知のプロバイダ識別子 */
const KNOWN_PROVIDER_IDS: readonly ProviderId[] = [
  "openai-compatible",
  "openai",
  "llama-server",
];

/**
 * 現在開いているプロジェクトの AI 設定を保持するストア。
 *
 * - プロジェクトオープン時に sumire.json の `aiConfig` をロードして set。
 * - プロジェクトクローズ時(`currentProject = null`)に clear。
 * - プロバイダ層・ContextBuilder からは `getActiveConfig()` を参照する。
 *
 * 永続化は `setActiveProvider` / `updateProviderSection` の内部で
 * `saveProjectMeta` を async で呼ぶ(設計判断: design.md L479)。
 * `loadFromMeta` は読み込み専用で永続化しない。
 */
interface AIConfigState {
  /** プロバイダ種別ごとの設定 + 現在使うプロバイダの単一情報源(Req 1.1, 1.2, 1.4) */
  bundle: AIConfigBundle | null;
  /** 永続化のために meta 全体を保持(snapshots など他フィールドを失わないため) */
  currentMeta: SumireProjectMeta | null;
  /** 現在使うプロバイダの設定を返す(`bundle` が null なら null)*/
  getActiveConfig: () => AIConfig | null;
  /** sumire.json メタ情報をロードする。旧スキーマ検出時は toast で案内(Req 1.5) */
  loadFromMeta: (meta: SumireProjectMeta) => void;
  /** 現在使うプロバイダを切替、即座に sumire.json 永続化を発火(Req 1.3) */
  setActiveProvider: (id: ProviderId) => Promise<void>;
  /** プロバイダセクション部分更新、sumire.json 永続化を発火(Req 1.4) */
  updateProviderSection: (
    id: ProviderId,
    patch: Partial<AIConfig>,
  ) => Promise<void>;
  /**
   * テンプレートの指定(と、渡されたときだけ思考の分離の設定)を置き換えて保存し、
   * 成否を返す(`template-settings-ui` spec)。失敗したら、そのセクションの
   * `template` と `thinking` だけを呼ぶ前の値に戻す。プロジェクトを開いていない
   * ときは、ストアを書き換えずに `false` を返す。
   */
  saveTemplateSelection: (
    id: ProviderId,
    patch: TemplateSelectionPatch,
  ) => Promise<boolean>;
  /**
   * 各プロバイダの API キーが OS keychain に存在するかのキャッシュ。
   * - `null`: 未取得(初回 refresh 前)
   * - `true`: キー設定済み(`SecretStore.hasSecret` が `true` を返した最新値)
   * - `false`: キー未設定(`SecretStore.hasSecret` が `false` を返した最新値)
   *
   * UI のバッジ表示(LLMSwitcherPane "キー未設定"、AISettingsPane "キー設定済み")
   * のソース。`SecretStore` 自体は値キャッシュしない設計のため、UI 連携用の薄い
   * フラグ層をここに集約する(専用 store を増やさない、設計 L525-526 参照)。
   */
  secretAvailability: Record<ProviderId, boolean | null>;
  /**
   * 指定プロバイダの API キー存在を `SecretStore.hasSecret` で再評価し、
   * `secretAvailability[id]` を更新する。
   *
   * AISettingsPane の保存/削除完了後 + LLMSwitcherPane / AISettingsPane の mount 時に呼ぶ。
   */
  refreshSecretAvailability: (id: ProviderId) => Promise<void>;
  /** プロジェクトクローズ時に呼ぶ */
  clear: () => void;
}

/** `saveTemplateSelection` に渡す値。 */
export interface TemplateSelectionPatch {
  /** `undefined` は「指定なし」(保存するとキーが無くなる)。 */
  template: unknown;
  /** 省くと、思考の分離の設定を書き換えない。 */
  thinking?: ThinkingConfig;
}

/**
 * `bundle` から「現在使うプロバイダ」の `AIConfig` を派生させる。
 *
 * `getActiveConfig()` の本体。`bundle` が null のときは null を返す。
 */
function deriveConfig(bundle: AIConfigBundle | null): AIConfig | null {
  return bundle ? bundle.providers[bundle.activeProvider] : null;
}

/**
 * `meta` を `sumire.json` に書き戻す。
 *
 * - `currentProject.path` が無いとき(プロジェクト未オープン状態での誤呼び出し)は
 *   DEV ビルドでのみ警告ログを出して no-op 終了する。
 * - 書き込み失敗は toast で通知(本文編集を阻害しないため throw しない)。
 * - 成否を返す。保存先が無くて保存しなかったときも `false`。
 */
async function persistMeta(meta: SumireProjectMeta): Promise<boolean> {
  const projectPath = useAppStore.getState().currentProject?.path;
  if (!projectPath) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        "[aiConfigStore] persistMeta: no currentProject.path, skipping save",
      );
    }
    return false;
  }
  try {
    await saveProjectMeta(projectPath, meta);
    return true;
  } catch (e) {
    toastError(
      i18next.t("toast.aiConfigSaveFailed", { message: String(e) }),
    );
    return false;
  }
}

/**
 * `bundle` の 1 つのセクションを置き換えたバンドルと meta を作る。
 * セクションは新しいオブジェクトになる(registry の WeakMap キャッシュを意図的にミスさせる)。
 */
function withSection(
  bundle: AIConfigBundle,
  currentMeta: SumireProjectMeta | null,
  id: ProviderId,
  section: AIConfig,
): { bundle: AIConfigBundle; currentMeta: SumireProjectMeta } {
  const newBundle: AIConfigBundle = {
    ...bundle,
    providers: { ...bundle.providers, [id]: section },
  };
  const newMeta: SumireProjectMeta = currentMeta
    ? { ...currentMeta, aiConfig: newBundle }
    : ({ aiConfig: newBundle } as SumireProjectMeta);
  return { bundle: newBundle, currentMeta: newMeta };
}

/**
 * セクションの `template` と `thinking` を、`source` の値に揃えた写しを返す。
 * `source` に無いキーは、写しからも消す(保存したときにキーごと無くなるように)。
 */
function withTemplateFields(
  section: AIConfig,
  source: Pick<AIConfig, "template" | "thinking">,
  replaceThinking: boolean,
): AIConfig {
  const next: AIConfig = { ...section };
  if (source.template === undefined) {
    delete next.template;
  } else {
    next.template = source.template;
  }
  if (replaceThinking) {
    if (source.thinking === undefined) {
      delete next.thinking;
    } else {
      next.thinking = source.thinking;
    }
  }
  return next;
}

export const useAIConfigStore = create<AIConfigState>((set, get) => ({
  bundle: null,
  currentMeta: null,
  secretAvailability: {
    "openai-compatible": null,
    openai: null,
    "llama-server": null,
  },

  getActiveConfig: () => deriveConfig(get().bundle),

  loadFromMeta: (meta) => {
    if (hasLegacyAiSection(meta)) {
      toastInfo(i18next.t("toast.aiConfigLegacy"));
    }
    const bundle = extractAIConfigBundle(meta);
    set({
      bundle,
      currentMeta: meta,
    });
  },

  setActiveProvider: async (id) => {
    const state = get();
    if (!state.bundle) return;
    const newBundle: AIConfigBundle = {
      ...state.bundle,
      activeProvider: id,
    };
    const newMeta: SumireProjectMeta = state.currentMeta
      ? { ...state.currentMeta, aiConfig: newBundle }
      : ({ aiConfig: newBundle } as SumireProjectMeta);
    set({
      bundle: newBundle,
      currentMeta: newMeta,
    });
    await persistMeta(newMeta);
  },

  updateProviderSection: async (id, patch) => {
    const state = get();
    if (!state.bundle) return;
    // 設計上の意図(design.md L485): セクションを spread で新オブジェクト化することで
    // registry の WeakMap キャッシュを意図的にミスさせ、Adapter を作り直す。
    const newBundle: AIConfigBundle = {
      ...state.bundle,
      providers: {
        ...state.bundle.providers,
        [id]: { ...state.bundle.providers[id], ...patch },
      },
    };
    const newMeta: SumireProjectMeta = state.currentMeta
      ? { ...state.currentMeta, aiConfig: newBundle }
      : ({ aiConfig: newBundle } as SumireProjectMeta);
    set({
      bundle: newBundle,
      currentMeta: newMeta,
    });
    await persistMeta(newMeta);
  },

  saveTemplateSelection: async (id, patch) => {
    const state = get();
    if (!state.bundle) return false;
    if (!useAppStore.getState().currentProject?.path) return false;

    const before = state.bundle.providers[id];
    const previous = { template: before.template, thinking: before.thinking };
    const replaceThinking = patch.thinking !== undefined;
    const next = withSection(
      state.bundle,
      state.currentMeta,
      id,
      withTemplateFields(before, patch, replaceThinking),
    );
    set(next);
    const ok = await persistMeta(next.currentMeta);
    if (ok) return true;

    // 失敗したら、その間に書かれたほかの項目を残して、template と thinking だけを戻す
    const latest = get();
    if (latest.bundle) {
      set(
        withSection(
          latest.bundle,
          latest.currentMeta,
          id,
          withTemplateFields(
            latest.bundle.providers[id],
            previous,
            replaceThinking,
          ),
        ),
      );
    }
    return false;
  },

  refreshSecretAvailability: async (id) => {
    try {
      const has = await SecretStore.hasSecret(id);
      set((state) => ({
        secretAvailability: { ...state.secretAvailability, [id]: has },
      }));
    } catch (e) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(
          "[aiConfigStore] refreshSecretAvailability failed:",
          id,
          e,
        );
      }
      // 取得失敗時は前回値を保持(false に倒さない)
    }
  },

  clear: () =>
    set({
      bundle: null,
      currentMeta: null,
      secretAvailability: {
        "openai-compatible": null,
        openai: null,
        "llama-server": null,
      },
    }),
}));

/**
 * `meta` が旧スキーマ(`ai` フィールドのみ、`aiConfig` 不在)かを判定する。
 *
 * 呼び出し側(`useAIConfigStore.loadFromMeta` など)は本判定で `true` のとき
 * 「sumire.json を新スキーマに移行してください」のトースト通知を出し、
 * その後 `extractAIConfigBundle(meta)` で得たバンドルを set する責務を負う。
 *
 * `extractAIConfigBundle` を pure な変換関数として保つために
 * 判定だけを別関数に切り出している(設計判断: kiro task 2.2 case (A))。
 */
export function hasLegacyAiSection(meta: SumireProjectMeta): boolean {
  return meta.aiConfig == null && meta.ai != null;
}

/**
 * `sumire.json` の AI 設定を **常に有効な `AIConfigBundle`** に整形して返す。
 *
 * 入力 5 ケースを内部で吸収する(`cloud-providers` spec Req 1.1, 1.5):
 *
 *   1. 新スキーマ完全(`meta.aiConfig` フル) → そのまま型ガード後返す
 *   2. 部分新スキーマ(`providers.openai` 欠落 等) → 欠落セクションは
 *      `DEFAULT_AI_CONFIG_BUNDLE` から補完。`llama-server` を足す前に作った
 *      `sumire.json` もここを通り、`activeProvider` は変えない
 *      (`llama-server-provider` spec Req 1.5)
 *   3. `aiConfig.activeProvider` が不明値(例: `"claude"`) →
 *      `"openai-compatible"` にフォールバック(Req 1.5)
 *   4. 旧スキーマ(`meta.ai` のみ) → `providers["openai-compatible"]` を
 *      `meta.ai` から組み立て、`providers.openai` は既定、
 *      `activeProvider` は `"openai-compatible"`
 *   5. AI 設定なし(両方欠落) → `DEFAULT_AI_CONFIG_BUNDLE` 相当の
 *      新規オブジェクト(参照共有しない deep copy)を返す
 *
 * **invariant**: 戻り値は必ず `providers` の全 `ProviderId` キーを持ち、
 * `activeProvider` は `providers` のキー集合に含まれる(`AIConfigBundle` の
 * 不変条件、`types.ts` 参照)。
 *
 * 旧スキーマかどうかの判定は本関数の責務外。`hasLegacyAiSection(meta)` を
 * 別途呼び、必要なら通知を出すこと。
 */
export function extractAIConfigBundle(meta: SumireProjectMeta): AIConfigBundle {
  // Case 1〜3: 新スキーマ
  if (meta.aiConfig != null && typeof meta.aiConfig === "object") {
    const rawBundle = meta.aiConfig as Record<string, unknown>;
    const rawProviders =
      rawBundle.providers != null && typeof rawBundle.providers === "object"
        ? (rawBundle.providers as Record<string, unknown>)
        : {};

    return {
      activeProvider: isKnownProviderId(rawBundle.activeProvider)
        ? rawBundle.activeProvider
        : "openai-compatible",
      providers: {
        "openai-compatible": extractAIConfigSection(
          rawProviders["openai-compatible"],
          DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"],
        ),
        openai: extractAIConfigSection(
          rawProviders.openai,
          DEFAULT_AI_CONFIG_BUNDLE.providers.openai,
        ),
        "llama-server": extractAIConfigSection(
          rawProviders["llama-server"],
          DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"],
        ),
      },
    };
  }

  // Case 4: 旧スキーマ(`meta.ai` のみ)
  if (meta.ai != null) {
    return {
      activeProvider: "openai-compatible",
      providers: {
        "openai-compatible": extractAIConfigSection(
          meta.ai,
          DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"],
        ),
        openai: extractAIConfigSection(
          undefined,
          DEFAULT_AI_CONFIG_BUNDLE.providers.openai,
        ),
        "llama-server": extractAIConfigSection(
          undefined,
          DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"],
        ),
      },
    };
  }

  // Case 5: 両方欠落 → DEFAULT を deep copy(参照共有を避けるため
  // extractAIConfigSection を経由して各セクションを新オブジェクト化)
  return {
    activeProvider: DEFAULT_AI_CONFIG_BUNDLE.activeProvider,
    providers: {
      "openai-compatible": extractAIConfigSection(
        undefined,
        DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"],
      ),
      openai: extractAIConfigSection(
        undefined,
        DEFAULT_AI_CONFIG_BUNDLE.providers.openai,
      ),
      "llama-server": extractAIConfigSection(
        undefined,
        DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"],
      ),
    },
  };
}

/** `value` が既知の `ProviderId` 文字列かを判定する type guard */
function isKnownProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === "string" &&
    (KNOWN_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * `aiConfig.providers.<id>` または旧 `meta.ai` の生値を `AIConfig` に整形する。
 *
 * - 各フィールドは type-guard し、不正なら `fallback` から埋める
 *   (`thinking` だけは例外で、`fallback` から埋めない。`extractThinkingConfig` 参照)
 * - 戻り値は **必ず新オブジェクト**(fallback の参照を共有しない)
 *
 * 旧スキーマ・新スキーマどちらの経路でも同じセマンティクスになるよう、
 * `extractAIConfigBundle` の両ケース(新スキーマ Case 1〜3 / 旧スキーマ Case 4)
 * から共通で呼ばれる。
 */
function extractAIConfigSection(
  raw: unknown,
  fallback: AIConfig,
): AIConfig {
  const rawSection =
    raw != null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const params =
    rawSection.parameters != null && typeof rawSection.parameters === "object"
      ? (rawSection.parameters as Record<string, unknown>)
      : {};

  return {
    provider:
      typeof rawSection.provider === "string"
        ? rawSection.provider
        : fallback.provider,
    endpoint:
      typeof rawSection.endpoint === "string"
        ? rawSection.endpoint
        : fallback.endpoint,
    model:
      typeof rawSection.model === "string" ? rawSection.model : fallback.model,
    parameters: {
      temperature:
        typeof params.temperature === "number"
          ? params.temperature
          : fallback.parameters.temperature,
      topP:
        typeof params.topP === "number"
          ? params.topP
          : fallback.parameters.topP,
      maxTokens:
        typeof params.maxTokens === "number"
          ? params.maxTokens
          : fallback.parameters.maxTokens,
      extras:
        params.extras != null && typeof params.extras === "object"
          ? (params.extras as Record<string, unknown>)
          : fallback.parameters.extras,
    },
    systemPrompt:
      typeof rawSection.systemPrompt === "string"
        ? rawSection.systemPrompt
        : fallback.systemPrompt,
    timeoutMs:
      typeof rawSection.timeoutMs === "number"
        ? rawSection.timeoutMs
        : fallback.timeoutMs,
    settingsTokenBudget:
      typeof rawSection.settingsTokenBudget === "number"
        ? rawSection.settingsTokenBudget
        : fallback.settingsTokenBudget,
    contextWindow:
      typeof rawSection.contextWindow === "number"
        ? rawSection.contextWindow
        : fallback.contextWindow,
    thinking: extractThinkingConfig(rawSection.thinking),
    template: copyRawValue(rawSection.template),
    illustration: copyRawValue(rawSection.illustration),
  };
}

/**
 * `aiConfig.providers.<id>` の `template` / `illustration` の生値を、参照を共有しない写しにする。
 *
 * - 型は検査しない。読めない値も捨てずに持ち、不備は使うときに判定して伝える
 *   (`template` は提案要求のときに `resolvePromptTemplate` が、prompt-template 4.4。
 *   `illustration` は情景文の生成のときに `resolveIllustrationConfig` が)。捨てると、
 *   保存したときに書き手の指定が消えてしまう(prompt-template 4.6、illustration-prompt 6.2)
 * - `sumire.json` に無ければ `undefined` のまま返し、既定値では埋めない
 *   (prompt-template 4.8)。`null` は値として保持する
 * - 写しは JSON の往復で作る。`structuredClone` は古い WebView に無いことがあるため使わない
 */
function copyRawValue(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  return JSON.parse(JSON.stringify(raw)) as unknown;
}

/**
 * `aiConfig.providers.<id>.thinking` の生値を `ThinkingConfig` に整形する。
 *
 * - 型の合わない部分だけを捨てる。`tags` は `open` と `close` がどちらも文字列の組だけを
 *   残す。空文字の組も残す(無視するかどうかは `resolveThinkingTags` が決める)
 * - `sumire.json` に無ければ `undefined` のまま返し、既定値では埋めない。埋めると、
 *   既存プロジェクトを保存したときに `thinking` が書き足されてしまう(thinking-output 5.11)
 * - 戻り値は必ず新オブジェクト(`sumire.json` の生値と参照を共有しない)
 */
function extractThinkingConfig(raw: unknown): ThinkingConfig | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rawThinking = raw as Record<string, unknown>;
  const thinking: ThinkingConfig = {};
  if (typeof rawThinking.enabled === "boolean") {
    thinking.enabled = rawThinking.enabled;
  }
  if (Array.isArray(rawThinking.tags)) {
    const rawTags: readonly unknown[] = rawThinking.tags;
    thinking.tags = rawTags
      .filter(isThinkingTagPair)
      .map((pair) => ({ open: pair.open, close: pair.close }));
  }
  return thinking;
}

/** `value` が `open` と `close` をどちらも文字列で持つかを判定する type guard */
function isThinkingTagPair(value: unknown): value is ThinkingTagPair {
  if (value == null || typeof value !== "object") return false;
  const pair = value as Record<string, unknown>;
  return typeof pair.open === "string" && typeof pair.close === "string";
}

