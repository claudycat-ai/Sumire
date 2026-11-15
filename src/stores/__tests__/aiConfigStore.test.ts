import { describe, expect, it, vi, beforeEach } from "vitest";

// `cloud-providers` spec task 11.4: useAIConfigStore.setActiveProvider /
// updateProviderSection の単体テスト。
// vi.mock はファイル先頭に hoist されるため、ストア (`aiConfigStore`) が
// import { saveProjectMeta } from "@/domain/project/projectApi" した時点で
// このモック版を見ることになる。actual から saveProjectMeta 以外は実物を流用する
// ことで、他の export(openProject 等)のシグネチャ変動に追従しやすくする。
vi.mock("@/domain/project/projectApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/domain/project/projectApi")>();
  return {
    ...actual,
    saveProjectMeta: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  extractAIConfigBundle,
  hasLegacyAiSection,
  useAIConfigStore,
} from "@/stores/aiConfigStore";
import {
  DEFAULT_AI_CONFIG_BUNDLE,
  isLocalCompletionProvider,
  type AIConfig,
  type ProviderId,
} from "@/domain/providers/types";
import type { SumireProjectMeta } from "@/domain/project/types";
import { useAppStore } from "@/stores/appStore";
import { saveProjectMeta } from "@/domain/project/projectApi";

const mockSaveProjectMeta = saveProjectMeta as unknown as ReturnType<
  typeof vi.fn
>;

// `cloud-providers` spec task 11.1: extractAIConfigBundle 単体テスト(5 パターン)
//
// task 2.2 で実装済みの pure な変換関数 `extractAIConfigBundle` の
// 入力 5 ケース(旧スキーマ ai のみ / 新スキーマ完全 / 一部欠落 /
// activeProvider 不明値 / 全欠落)に対する戻り値を確認する **回帰テスト**。
//
// TDD-style RED-then-GREEN ではなく、既存実装の不変条件を
// 永続的に守るためのレグレッションスイート。
//
// Requirements: Req 1.1(プロバイダ種別の併存)、Req 1.5(activeProvider
// 不明値時のフォールバック)。

const META_BASE = {
  schemaVersion: "1.0",
  title: "T",
  author: "A",
  created: "2026-01-01",
} as const;

// 読み込みは `thinking` を既定値で埋めない(`thinking-output` spec)ため、
// 既定値から補完したセクションは「既定値から thinking を除いたもの」になる。
function withoutThinking(config: AIConfig): AIConfig {
  const copy = structuredClone(config);
  delete copy.thinking;
  return copy;
}

describe("extractAIConfigBundle", () => {
  it("Case 1: 旧スキーマ ai のみ → openai-compatible に流し込み + openai は既定", () => {
    const meta = {
      ...META_BASE,
      ai: {
        provider: "openai-compatible",
        endpoint: "http://localhost:5000/v1",
        model: "japanese-stablelm",
        parameters: { temperature: 0.5, topP: 0.8, maxTokens: 100 },
        systemPrompt: "test prompt",
        contextWindow: 4096,
      },
    } as SumireProjectMeta;

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.activeProvider).toBe("openai-compatible");
    expect(bundle.providers["openai-compatible"]).toMatchObject({
      endpoint: "http://localhost:5000/v1",
      model: "japanese-stablelm",
      parameters: { temperature: 0.5, topP: 0.8, maxTokens: 100 },
      systemPrompt: "test prompt",
      contextWindow: 4096,
    });
    // 旧スキーマ経路でも openai セクションは DEFAULT 相当(thinking を除いて構造的等値)で埋める
    expect(bundle.providers.openai).toEqual(
      withoutThinking(DEFAULT_AI_CONFIG_BUNDLE.providers.openai),
    );
    expect(hasLegacyAiSection(meta)).toBe(true);
  });

  it("Case 2: 新スキーマ完全 → activeProvider と providers がそのまま反映", () => {
    const meta = {
      ...META_BASE,
      aiConfig: {
        activeProvider: "openai",
        providers: {
          "openai-compatible": {
            provider: "openai-compatible",
            endpoint: "http://other:5000/v1",
            model: "custom-model",
            parameters: { temperature: 0.3, topP: 0.7, maxTokens: 50 },
            systemPrompt: null,
            contextWindow: 8192,
          },
          openai: {
            provider: "openai",
            endpoint: "https://api.openai.com/v1",
            model: "gpt-4o",
            parameters: { temperature: 0.9, topP: 0.95, maxTokens: 300 },
            systemPrompt: "creative writing",
            contextWindow: 128000,
          },
        },
      },
    } as SumireProjectMeta;

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.activeProvider).toBe("openai");
    expect(bundle.providers["openai-compatible"].model).toBe("custom-model");
    expect(bundle.providers["openai-compatible"].endpoint).toBe(
      "http://other:5000/v1",
    );
    expect(bundle.providers["openai-compatible"].contextWindow).toBe(8192);
    expect(bundle.providers.openai.model).toBe("gpt-4o");
    expect(bundle.providers.openai.systemPrompt).toBe("creative writing");
    expect(bundle.providers.openai.contextWindow).toBe(128000);
    expect(hasLegacyAiSection(meta)).toBe(false);
  });

  it("Case 3: 新スキーマで openai セクション欠落 → 欠落分は DEFAULT で補完", () => {
    const meta = {
      ...META_BASE,
      aiConfig: {
        activeProvider: "openai-compatible",
        providers: {
          "openai-compatible": {
            endpoint: "http://lcl/v1",
            model: "x",
            parameters: { temperature: 0.5, topP: 0.5, maxTokens: 50 },
          },
          // openai セクションは故意に欠落
        },
      },
    } as SumireProjectMeta;

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.providers["openai-compatible"].endpoint).toBe(
      "http://lcl/v1",
    );
    expect(bundle.providers["openai-compatible"].model).toBe("x");
    expect(bundle.providers["openai-compatible"].parameters).toMatchObject({
      temperature: 0.5,
      topP: 0.5,
      maxTokens: 50,
    });
    // 欠落セクションは DEFAULT_AI_CONFIG_BUNDLE.providers.openai と、thinking を除いて構造的に等値
    expect(bundle.providers.openai).toEqual(
      withoutThinking(DEFAULT_AI_CONFIG_BUNDLE.providers.openai),
    );
  });

  it("Case 4: activeProvider が不明値 → openai-compatible にフォールバック(Req 1.5)", () => {
    const meta = {
      ...META_BASE,
      aiConfig: {
        activeProvider: "claude", // 未知
        providers: {
          "openai-compatible": {
            provider: "openai-compatible",
            endpoint: "http://lcl/v1",
            model: "local",
            parameters: { temperature: 0.5, topP: 0.8, maxTokens: 100 },
            systemPrompt: null,
            contextWindow: 4096,
          },
          openai: {
            provider: "openai",
            endpoint: "https://api.openai.com/v1",
            model: "gpt-4o",
            parameters: { temperature: 0.9, topP: 0.95, maxTokens: 300 },
            systemPrompt: null,
            contextWindow: 128000,
          },
        },
      },
    } as SumireProjectMeta;

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.activeProvider).toBe("openai-compatible");
    // フォールバックしても providers の中身は保持される
    expect(bundle.providers["openai-compatible"].model).toBe("local");
    expect(bundle.providers.openai.model).toBe("gpt-4o");
  });

  it("Case 5: ai / aiConfig 両方欠落 → DEFAULT_AI_CONFIG_BUNDLE 相当(thinking を除いて構造的等値)", () => {
    const meta = {
      ...META_BASE,
      // ai も aiConfig も無い
    } as SumireProjectMeta;

    const bundle = extractAIConfigBundle(meta);

    // 参照同一性ではなく構造的等値で確認(実装は deep copy する設計、
    // aiConfigStore.ts L276-289 参照)
    expect(bundle).toEqual({
      activeProvider: DEFAULT_AI_CONFIG_BUNDLE.activeProvider,
      providers: {
        "openai-compatible": withoutThinking(
          DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"],
        ),
        openai: withoutThinking(DEFAULT_AI_CONFIG_BUNDLE.providers.openai),
        "llama-server": withoutThinking(
          DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"],
        ),
      },
    });
    expect(hasLegacyAiSection(meta)).toBe(false);
  });

  it("不変条件: 全ケースで providers は両キーを持ち、activeProvider はその一方を指す", () => {
    const cases: SumireProjectMeta[] = [
      // Case 1: legacy
      {
        ...META_BASE,
        ai: {
          provider: "openai-compatible",
          endpoint: "http://localhost:5000/v1",
          model: "japanese-stablelm",
          parameters: { temperature: 0.5, topP: 0.8, maxTokens: 100 },
        },
      } as SumireProjectMeta,
      // Case 4: unknown activeProvider
      {
        ...META_BASE,
        aiConfig: {
          activeProvider: "gemini",
          providers: {},
        },
      } as SumireProjectMeta,
      // Case 5: empty
      { ...META_BASE } as SumireProjectMeta,
    ];

    const validProviders: readonly ProviderId[] = [
      "openai-compatible",
      "openai",
    ];

    for (const meta of cases) {
      const bundle = extractAIConfigBundle(meta);
      expect(bundle.providers["openai-compatible"]).toBeDefined();
      expect(bundle.providers.openai).toBeDefined();
      expect(validProviders).toContain(bundle.activeProvider);
    }
  });
});

// `cloud-providers` spec task 11.4: useAIConfigStore のアクション単体テスト。
//
// 対象は task 2.3 / 2.5 で実装済みの `setActiveProvider` /
// `updateProviderSection` の以下を不変条件として固定する:
//   - in-memory の bundle が更新される(activeProvider または 単一セクション)
//   - persistMeta 経由で `projectApi.saveProjectMeta` が currentProject.path と
//     新しい meta を引数に呼ばれる
//   - 他セクションの設定はそのまま保持される
//   - currentProject 未オープン時は in-memory のみ更新し saveProjectMeta は呼ばない
//   - bundle が null のときはアクション自体が no-op(メタ更新も persist も無し)
//
// Requirements:
//   Req 1.3: プロバイダ切替で activeProvider 更新 + 永続化
//   Req 1.4: セクション部分更新で他セクションが変わらない
//
// Boundary:
//   - 触ってよいファイル: 本ファイルのみ(EXTEND from task 11.1)
//   - `src/stores/aiConfigStore.ts` / `appStore.ts` / `projectApi.ts` は
//     先行タスクで完了済みのため触らない

const META_FOR_ACTION = {
  ...META_BASE,
  aiConfig: structuredClone(DEFAULT_AI_CONFIG_BUNDLE),
} as unknown as SumireProjectMeta;

beforeEach(() => {
  mockSaveProjectMeta.mockClear();
  // persistMeta が currentProject.path を読みに行くため、テスト用パスを設定。
  useAppStore.setState({
    currentProject: { path: "/test/project", title: "T" },
  });
  // 既知の初期 bundle に毎回リセット(他テストの状態漏れを防ぐ)。
  useAIConfigStore.setState({
    bundle: structuredClone(DEFAULT_AI_CONFIG_BUNDLE),
    currentMeta: structuredClone(META_FOR_ACTION),
    secretAvailability: {
      "openai-compatible": null,
      openai: null,
      "llama-server": null,
    },
  });
});

describe("useAIConfigStore.setActiveProvider (Req 1.3)", () => {
  it("実行後に bundle.activeProvider が更新される", async () => {
    await useAIConfigStore.getState().setActiveProvider("openai");
    expect(useAIConfigStore.getState().bundle?.activeProvider).toBe("openai");
  });

  it("実行後に saveProjectMeta が currentProject.path と新 meta で 1 回呼ばれる", async () => {
    await useAIConfigStore.getState().setActiveProvider("openai");

    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
    const [projectPath, meta] = mockSaveProjectMeta.mock.calls[0] as [
      string,
      SumireProjectMeta,
    ];
    expect(projectPath).toBe("/test/project");
    // `SumireProjectMeta.aiConfig` は型上 `unknown`(types.ts L17)のため
    // テスト内では as でナローイングして activeProvider を読む。
    const aiConfig = meta.aiConfig as { activeProvider: ProviderId };
    expect(aiConfig.activeProvider).toBe("openai");
  });

  it("他セクションの設定が変わらない(Req 1.4 への波及確認)", async () => {
    // 事前に openai-compatible の endpoint をカスタム値に書き換えておく
    useAIConfigStore.setState((s) => {
      if (!s.bundle) return s;
      return {
        ...s,
        bundle: {
          ...s.bundle,
          providers: {
            ...s.bundle.providers,
            "openai-compatible": {
              ...s.bundle.providers["openai-compatible"],
              endpoint: "http://custom:9999/v1",
            },
          },
        },
      };
    });

    await useAIConfigStore.getState().setActiveProvider("openai");

    const after = useAIConfigStore.getState().bundle;
    // openai-compatible の endpoint はカスタム値のまま
    expect(after?.providers["openai-compatible"].endpoint).toBe(
      "http://custom:9999/v1",
    );
    // openai セクションは初期値のまま(activeProvider 切替で書き換わらない)
    expect(after?.providers.openai).toEqual(
      DEFAULT_AI_CONFIG_BUNDLE.providers.openai,
    );
  });

  it("bundle が null のときは no-op(set も persist も発火しない)", async () => {
    useAIConfigStore.setState({ bundle: null, currentMeta: null });

    await useAIConfigStore.getState().setActiveProvider("openai");

    expect(useAIConfigStore.getState().bundle).toBeNull();
    expect(mockSaveProjectMeta).not.toHaveBeenCalled();
  });

  it("currentProject が null のとき in-memory は更新するが saveProjectMeta は呼ばない", async () => {
    useAppStore.setState({ currentProject: null });

    await useAIConfigStore.getState().setActiveProvider("openai");

    // in-memory の bundle は更新される
    expect(useAIConfigStore.getState().bundle?.activeProvider).toBe("openai");
    // しかし persistMeta は currentProject.path 不在を検知して save は呼ばない
    expect(mockSaveProjectMeta).not.toHaveBeenCalled();
  });
});

describe("useAIConfigStore.updateProviderSection (Req 1.4)", () => {
  it("指定セクションだけパッチされ、他セクションは初期値のまま保持される", async () => {
    await useAIConfigStore
      .getState()
      .updateProviderSection("openai", { model: "gpt-4o" });

    const after = useAIConfigStore.getState().bundle;
    expect(after?.providers.openai.model).toBe("gpt-4o");
    // openai-compatible は触れていないので初期値のまま
    expect(after?.providers["openai-compatible"]).toEqual(
      DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"],
    );
    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
  });

  it("更新したセクションは新しいオブジェクト参照(WeakMap キャッシュ意図的ミス、design L485)", async () => {
    const before = useAIConfigStore.getState().bundle?.providers.openai;
    await useAIConfigStore
      .getState()
      .updateProviderSection("openai", { model: "gpt-4o" });
    const after = useAIConfigStore.getState().bundle?.providers.openai;

    // 値の更新だけでなく、registry の WeakMap キャッシュをミスさせるため
    // 参照そのものを差し替えている設計(Adapter を作り直すため)。
    expect(after).not.toBe(before);
  });

  it("activeProvider は変更されない(bundle.activeProvider は前のまま)", async () => {
    const beforeActive = useAIConfigStore.getState().bundle?.activeProvider;
    await useAIConfigStore
      .getState()
      .updateProviderSection("openai", { model: "gpt-4o" });
    expect(useAIConfigStore.getState().bundle?.activeProvider).toBe(
      beforeActive,
    );
  });
});

// `thinking-output` spec task 1.2: sumire.json の思考の分離の設定(`thinking`)の
// 読み込みと保存。Requirements: 5.1, 5.8, 5.11。

/** `aiConfig.providers` の 2 セクションだけを指定して sumire.json のメタを作る。 */
function metaWithSections(
  openaiCompatible: Record<string, unknown>,
  openai: Record<string, unknown>,
): SumireProjectMeta {
  return {
    ...META_BASE,
    aiConfig: {
      activeProvider: "openai-compatible",
      providers: { "openai-compatible": openaiCompatible, openai },
    },
  } as SumireProjectMeta;
}

const LOCAL_SECTION = {
  provider: "openai-compatible",
  endpoint: "http://127.0.0.1:5000/v1",
  model: "qwen-finetune-Q4_K_M.gguf",
  parameters: { temperature: 0.8, topP: 0.9, maxTokens: 1000 },
  systemPrompt: null,
} as const;

const CLOUD_SECTION = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  parameters: { temperature: 0.7, topP: 0.9, maxTokens: 300 },
  systemPrompt: null,
} as const;

/** 設定画面の保存と同じ形の patch(`thinking` を含まない)。 */
const SETTINGS_PANE_PATCH: Partial<AIConfig> = {
  endpoint: "http://127.0.0.1:5001/v1",
  model: "other-model.gguf",
  parameters: { temperature: 0.6, topP: 0.95, maxTokens: 2000 },
  systemPrompt: null,
  contextWindow: 8192,
  settingsTokenBudget: undefined,
};

type PersistedProviders = Record<ProviderId, Record<string, unknown>>;

/** 保存された meta を、`saveProjectMeta` と同じく JSON にしてから読み戻す。 */
function persistedProviders(callIndex = 0): PersistedProviders {
  const [, meta] = mockSaveProjectMeta.mock.calls[callIndex] as [
    string,
    SumireProjectMeta,
  ];
  const parsed = JSON.parse(JSON.stringify(meta)) as {
    aiConfig: { providers: PersistedProviders };
  };
  return parsed.aiConfig.providers;
}

describe("thinking の読み込み(5.1, 5.11)", () => {
  it("thinking 付きの sumire.json を読むと、各セクションの thinking が保持される", () => {
    const localThinking = {
      enabled: true,
      tags: [
        { open: "<think>", close: "</think>" },
        { open: "<thinking>", close: "</thinking>" },
      ],
    };
    const meta = metaWithSections(
      { ...LOCAL_SECTION, thinking: localThinking },
      { ...CLOUD_SECTION, thinking: { enabled: false } },
    );

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.providers["openai-compatible"].thinking).toEqual(
      localThinking,
    );
    expect(bundle.providers.openai.thinking).toEqual({ enabled: false });
    // 読み込んだ値は sumire.json の生値と参照を共有しない
    expect(bundle.providers["openai-compatible"].thinking).not.toBe(
      localThinking,
    );
    expect(bundle.providers["openai-compatible"].thinking?.tags?.[0]).not.toBe(
      localThinking.tags[0],
    );
  });

  it("型の合わない部分だけを捨て、空文字の組は残す", () => {
    const meta = metaWithSections(
      {
        ...LOCAL_SECTION,
        thinking: {
          enabled: "yes",
          tags: [
            { open: "<think>", close: "</think>" },
            { open: "", close: "" },
            { open: "<a>" },
            { open: 1, close: "</b>" },
            null,
            "<think>",
            ["<x>", "</x>"],
          ],
        },
      },
      { ...CLOUD_SECTION, thinking: { enabled: false, tags: "<think>" } },
    );

    const bundle = extractAIConfigBundle(meta);

    // enabled は真偽値でないので持たない。空文字の組を無視するのは resolveThinkingTags の役目
    expect(bundle.providers["openai-compatible"].thinking).toEqual({
      tags: [
        { open: "<think>", close: "</think>" },
        { open: "", close: "" },
      ],
    });
    expect(bundle.providers["openai-compatible"].thinking).not.toHaveProperty(
      "enabled",
    );
    // tags が配列でなければ tags だけを捨てる
    expect(bundle.providers.openai.thinking).toEqual({ enabled: false });
    expect(bundle.providers.openai.thinking).not.toHaveProperty("tags");
  });

  it("thinking がオブジェクトでない(null・配列・文字列)ときは未設定として扱う", () => {
    for (const thinking of [null, [], "<think>", true]) {
      const meta = metaWithSections(
        { ...LOCAL_SECTION, thinking },
        { ...CLOUD_SECTION },
      );
      expect(
        extractAIConfigBundle(meta).providers["openai-compatible"].thinking,
      ).toBeUndefined();
    }
  });

  it("thinking の無いセクションは、既定値で埋めずに未設定のまま", () => {
    const meta = metaWithSections({ ...LOCAL_SECTION }, { ...CLOUD_SECTION });

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.providers["openai-compatible"].thinking).toBeUndefined();
    expect(bundle.providers.openai.thinking).toBeUndefined();
  });
});

describe("thinking の保存(5.8, 5.11)", () => {
  it("設定画面で他の項目を保存しても、sumire.json の thinking が残る", async () => {
    const localThinking = {
      enabled: true,
      tags: [
        { open: "<think>", close: "</think>" },
        { open: "<thinking>", close: "</thinking>" },
      ],
    };
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections(
          { ...LOCAL_SECTION, thinking: localThinking },
          { ...CLOUD_SECTION, thinking: { enabled: false } },
        ),
      );

    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", SETTINGS_PANE_PATCH);

    // in-memory でも残る
    expect(
      useAIConfigStore.getState().bundle?.providers["openai-compatible"]
        .thinking,
    ).toEqual(localThinking);
    // 書き出される sumire.json にも残る(更新したセクションも、していないセクションも)
    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
    const providers = persistedProviders();
    expect(providers["openai-compatible"].model).toBe("other-model.gguf");
    expect(providers["openai-compatible"].thinking).toEqual(localThinking);
    expect(providers.openai.thinking).toEqual({ enabled: false });
  });

  it("thinking の無いファイルを保存しても、thinking は書き足されない", async () => {
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections({ ...LOCAL_SECTION }, { ...CLOUD_SECTION }),
      );

    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", SETTINGS_PANE_PATCH);
    await useAIConfigStore.getState().setActiveProvider("openai");

    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(2);
    for (const callIndex of [0, 1]) {
      const providers = persistedProviders(callIndex);
      expect(providers["openai-compatible"]).not.toHaveProperty("thinking");
      expect(providers.openai).not.toHaveProperty("thinking");
    }
  });
});

// `prompt-template` spec task 1.2: sumire.json のテンプレートの指定(`template`)の
// 読み込みと保存。型は検査せず生の値のまま持つ(不備は提案要求のときに伝える)。
// Requirements: 4.1, 4.6, 4.7, 4.8。

describe("template の読み込み(prompt-template 4.1)", () => {
  it("プリセットの指定を、そのままの値で保持する", () => {
    const template = { preset: "gemma4" };
    const meta = metaWithSections(
      { ...LOCAL_SECTION, template },
      { ...CLOUD_SECTION },
    );

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.providers["openai-compatible"].template).toEqual({
      preset: "gemma4",
    });
    // 読み込んだ値は sumire.json の生値と参照を共有しない
    expect(bundle.providers["openai-compatible"].template).not.toBe(template);
  });

  it("自由記述(文字列・行の配列)を、そのままの値で保持する", () => {
    const stringTemplate = {
      custom: "<start_of_turn>user\n{{system}}{{settings}}{{body}}",
    };
    const lineTemplate = {
      custom: ["<start_of_turn>user", "{{system}}", "{{settings}}{{body}}"],
    };
    const meta = metaWithSections(
      { ...LOCAL_SECTION, template: stringTemplate },
      { ...CLOUD_SECTION, template: lineTemplate },
    );

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.providers["openai-compatible"].template).toEqual(
      stringTemplate,
    );
    expect(bundle.providers.openai.template).toEqual(lineTemplate);
    const loadedLines = bundle.providers.openai.template as {
      custom: string[];
    };
    expect(loadedLines).not.toBe(lineTemplate);
    expect(loadedLines.custom).not.toBe(lineTemplate.custom);
  });

  it("読めない値(数値・preset が文字列でない・両方の指定)も捨てずに保持する(prompt-template 4.4)", () => {
    for (const template of [
      1,
      "gemma4",
      { preset: 1 },
      { preset: "gemma4", custom: "{{body}}" },
      [{ preset: "gemma4" }],
    ]) {
      const meta = metaWithSections(
        { ...LOCAL_SECTION, template },
        { ...CLOUD_SECTION },
      );
      expect(
        extractAIConfigBundle(meta).providers["openai-compatible"].template,
      ).toEqual(template);
    }
  });

  it("template の無いセクションは、既定値で埋めずに未設定のまま", () => {
    const meta = metaWithSections({ ...LOCAL_SECTION }, { ...CLOUD_SECTION });

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.providers["openai-compatible"].template).toBeUndefined();
    expect(bundle.providers.openai.template).toBeUndefined();
  });
});

describe("template の保存(prompt-template 4.6, 4.7)", () => {
  it("設定画面で他の項目を保存しても、sumire.json の template が残る", async () => {
    const localTemplate = {
      custom: ["<start_of_turn>user", "{{system}}{{settings}}{{body}}"],
    };
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections(
          { ...LOCAL_SECTION, template: localTemplate },
          { ...CLOUD_SECTION, template: { preset: 1 } },
        ),
      );

    // 設定画面の patch は template を含まない(画面に出さない、4.7)
    expect(SETTINGS_PANE_PATCH).not.toHaveProperty("template");
    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", SETTINGS_PANE_PATCH);

    // in-memory でも残る
    expect(
      useAIConfigStore.getState().bundle?.providers["openai-compatible"]
        .template,
    ).toEqual(localTemplate);
    // 書き出される sumire.json にも残る(更新したセクションも、していないセクションも)
    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
    const providers = persistedProviders();
    expect(providers["openai-compatible"].model).toBe("other-model.gguf");
    expect(providers["openai-compatible"].template).toEqual(localTemplate);
    // 読めない値も保存で失わない
    expect(providers.openai.template).toEqual({ preset: 1 });
  });

  it("template の無いファイルを保存しても、template は書き足されない", async () => {
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections({ ...LOCAL_SECTION }, { ...CLOUD_SECTION }),
      );

    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", SETTINGS_PANE_PATCH);
    await useAIConfigStore.getState().setActiveProvider("openai");

    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(2);
    for (const callIndex of [0, 1]) {
      const providers = persistedProviders(callIndex);
      expect(providers["openai-compatible"]).not.toHaveProperty("template");
      expect(providers.openai).not.toHaveProperty("template");
    }
  });
});

// `illustration-prompt` spec task 1.3: sumire.json の挿し絵の設定(`illustration`)の
// 読み込みと保存。テンプレートの指定と同じく、型は検査せず生の値のまま持つ。
// Requirements: 6.2, 6.6。

describe("illustration の読み込み(illustration-prompt 6.2)", () => {
  it("挿し絵の設定を、そのままの値で保持する", () => {
    const illustration = {
      template: { preset: "gemma4-think" },
      temperature: 0.7,
      maxTokens: 4096,
      timeoutMs: 180000,
      instruction: ["情景を描写する。", "人物の外見を含める。"],
    };
    const meta = metaWithSections(
      { ...LOCAL_SECTION, illustration },
      { ...CLOUD_SECTION },
    );

    const bundle = extractAIConfigBundle(meta);

    const loaded = bundle.providers["openai-compatible"].illustration as {
      instruction: string[];
    };
    expect(loaded).toEqual(illustration);
    // 読み込んだ値は sumire.json の生値と参照を共有しない
    expect(loaded).not.toBe(illustration);
    expect(loaded.instruction).not.toBe(illustration.instruction);
  });

  it("読めない値(null・数値・文字列・配列・型の合わない項目)も捨てずに保持する", () => {
    for (const illustration of [
      null,
      1,
      "gemma4",
      [{ template: { preset: "gemma4" } }],
      { template: { preset: 1 }, temperature: "hot", maxTokens: -1 },
      {},
    ]) {
      const meta = metaWithSections(
        { ...LOCAL_SECTION },
        { ...CLOUD_SECTION, illustration },
      );
      expect(extractAIConfigBundle(meta).providers.openai.illustration).toEqual(
        illustration,
      );
    }
  });

  it("illustration の無いセクションは、既定値で埋めずに未設定のまま", () => {
    const meta = metaWithSections({ ...LOCAL_SECTION }, { ...CLOUD_SECTION });

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.providers["openai-compatible"].illustration).toBeUndefined();
    expect(bundle.providers.openai.illustration).toBeUndefined();
  });
});

describe("illustration の保存(illustration-prompt 6.2, 6.6)", () => {
  it("設定画面で他の項目を保存しても、sumire.json の illustration が残る", async () => {
    const localIllustration = {
      template: { preset: "gemma4-think" },
      maxTokens: 4096,
    };
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections(
          { ...LOCAL_SECTION, illustration: localIllustration },
          { ...CLOUD_SECTION, illustration: { template: 1 } },
        ),
      );

    // 設定画面の patch は illustration を含まない(画面に出さない、6.6)
    expect(SETTINGS_PANE_PATCH).not.toHaveProperty("illustration");
    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", SETTINGS_PANE_PATCH);

    // in-memory でも残る
    expect(
      useAIConfigStore.getState().bundle?.providers["openai-compatible"]
        .illustration,
    ).toEqual(localIllustration);
    // 書き出される sumire.json にも残る(更新したセクションも、していないセクションも)
    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
    const providers = persistedProviders();
    expect(providers["openai-compatible"].model).toBe("other-model.gguf");
    expect(providers["openai-compatible"].illustration).toEqual(
      localIllustration,
    );
    // 読めない値も保存で失わない
    expect(providers.openai.illustration).toEqual({ template: 1 });
  });

  it("illustration が null でも、保存で失われない", async () => {
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections(
          { ...LOCAL_SECTION, illustration: null },
          { ...CLOUD_SECTION },
        ),
      );

    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", SETTINGS_PANE_PATCH);

    const providers = persistedProviders();
    expect(providers["openai-compatible"]).toHaveProperty("illustration", null);
  });

  it("illustration の無いファイルを保存しても、illustration は書き足されない", async () => {
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections({ ...LOCAL_SECTION }, { ...CLOUD_SECTION }),
      );

    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", SETTINGS_PANE_PATCH);
    await useAIConfigStore.getState().setActiveProvider("openai");

    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(2);
    for (const callIndex of [0, 1]) {
      const providers = persistedProviders(callIndex);
      expect(providers["openai-compatible"]).not.toHaveProperty("illustration");
      expect(providers.openai).not.toHaveProperty("illustration");
    }
  });
});

// `llama-server-provider` spec task 1.1: プロバイダの種別 `llama-server` の既定値と、
// sumire.json の読み書き。Requirements: 1.1, 1.2, 1.4, 1.5, 2.9。

describe("llama-server のセクション(llama-server-provider 1.2, 1.5, 2.9)", () => {
  it("既定のバンドルは llama-server のセクションを持つ(接続先とモデル名は空、コンテキスト長は無し)", () => {
    const section = DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"];
    const local = DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"];

    expect(section.provider).toBe("llama-server");
    expect(section.endpoint).toBe("");
    expect(section.model).toBe("");
    expect(section).not.toHaveProperty("contextWindow");
    expect(section.parameters).toEqual(local.parameters);
    expect(section.systemPrompt).toBe(local.systemPrompt);
    expect(section.timeoutMs).toBe(local.timeoutMs);
    expect(section.settingsTokenBudget).toBe(local.settingsTokenBudget);
    expect(section.thinking).toEqual(local.thinking);
    // 既定値どうしで参照を共有しない
    expect(section.parameters).not.toBe(local.parameters);
    expect(section.thinking).not.toBe(local.thinking);
    // 既定のバンドルの「現在使うプロバイダ」は変えない
    expect(DEFAULT_AI_CONFIG_BUNDLE.activeProvider).toBe("openai-compatible");
  });

  it("llama-server のセクションが無い sumire.json を読むと既定値で補い、現在使うプロバイダは変えない(1.5)", () => {
    const meta = {
      ...META_BASE,
      aiConfig: {
        activeProvider: "openai",
        providers: {
          "openai-compatible": { ...LOCAL_SECTION },
          openai: { ...CLOUD_SECTION },
        },
      },
    } as SumireProjectMeta;

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.activeProvider).toBe("openai");
    expect(bundle.providers["llama-server"]).toEqual(
      withoutThinking(DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"]),
    );
    expect(bundle.providers["llama-server"]).not.toBe(
      DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"],
    );
    // 既存のセクションはそのまま
    expect(bundle.providers["openai-compatible"].model).toBe(
      LOCAL_SECTION.model,
    );
    expect(bundle.providers.openai.model).toBe(CLOUD_SECTION.model);
  });

  it("旧い形(ai のみ)と設定なしでも、llama-server のセクションを既定値で持つ", () => {
    const legacy = {
      ...META_BASE,
      ai: { ...LOCAL_SECTION },
    } as SumireProjectMeta;
    const empty = { ...META_BASE } as SumireProjectMeta;

    for (const meta of [legacy, empty]) {
      const bundle = extractAIConfigBundle(meta);
      expect(bundle.activeProvider).toBe("openai-compatible");
      expect(bundle.providers["llama-server"]).toEqual(
        withoutThinking(DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"]),
      );
    }
  });

  it("sumire.json に書かれた llama-server の作品ごとの設定を読む(2.9)", () => {
    const meta = {
      ...META_BASE,
      aiConfig: {
        activeProvider: "llama-server",
        providers: {
          "openai-compatible": { ...LOCAL_SECTION },
          openai: { ...CLOUD_SECTION },
          "llama-server": {
            provider: "llama-server",
            endpoint: "",
            model: "",
            parameters: { temperature: 1.0, topP: 0.95, maxTokens: 800 },
            systemPrompt: "前置き",
            timeoutMs: 120000,
            settingsTokenBudget: 1500,
            thinking: { enabled: false },
            template: { preset: "gemma4" },
            illustration: { maxTokens: 300 },
          },
        },
      },
    } as SumireProjectMeta;

    const bundle = extractAIConfigBundle(meta);

    expect(bundle.activeProvider).toBe("llama-server");
    expect(bundle.providers["llama-server"]).toEqual({
      provider: "llama-server",
      endpoint: "",
      model: "",
      parameters: { temperature: 1.0, topP: 0.95, maxTokens: 800 },
      systemPrompt: "前置き",
      timeoutMs: 120000,
      settingsTokenBudget: 1500,
      thinking: { enabled: false },
      template: { preset: "gemma4" },
      illustration: { maxTokens: 300 },
    });
  });

  it("llama-server を現在使うプロバイダとして保存し、読み直せる(1.2)", async () => {
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections({ ...LOCAL_SECTION }, { ...CLOUD_SECTION }),
      );

    await useAIConfigStore.getState().setActiveProvider("llama-server");

    expect(useAIConfigStore.getState().bundle?.activeProvider).toBe(
      "llama-server",
    );
    expect(useAIConfigStore.getState().getActiveConfig()?.provider).toBe(
      "llama-server",
    );
    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
    const [, saved] = mockSaveProjectMeta.mock.calls[0] as [
      string,
      SumireProjectMeta,
    ];
    const reread = extractAIConfigBundle(
      JSON.parse(JSON.stringify(saved)) as SumireProjectMeta,
    );
    expect(reread.activeProvider).toBe("llama-server");
    expect(reread.providers["llama-server"].provider).toBe("llama-server");
    expect(reread.providers["openai-compatible"].model).toBe(
      LOCAL_SECTION.model,
    );
    expect(reread.providers.openai.model).toBe(CLOUD_SECTION.model);
  });

  it("llama-server のセクションの更新は、ほかのセクションを変えない(1.4)", async () => {
    await useAIConfigStore.getState().updateProviderSection("llama-server", {
      parameters: { temperature: 1.0, topP: 0.95, maxTokens: 800 },
    });

    const after = useAIConfigStore.getState().bundle;
    expect(after?.providers["llama-server"].parameters.maxTokens).toBe(800);
    expect(after?.providers["openai-compatible"]).toEqual(
      DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"],
    );
    expect(after?.providers.openai).toEqual(
      DEFAULT_AI_CONFIG_BUNDLE.providers.openai,
    );
    expect(after?.activeProvider).toBe("openai-compatible");
  });

  it("キーの有無の状態は llama-server のキーを持ち、clear で未取得に戻る", () => {
    useAIConfigStore.getState().clear();

    expect(useAIConfigStore.getState().secretAvailability).toEqual({
      "openai-compatible": null,
      openai: null,
      "llama-server": null,
    });
  });
});

describe("isLocalCompletionProvider(llama-server-provider 1.4)", () => {
  it("OpenAI 互換と llama-server で真、それ以外で偽を返す", () => {
    expect(isLocalCompletionProvider("openai-compatible")).toBe(true);
    expect(isLocalCompletionProvider("llama-server")).toBe(true);
    expect(isLocalCompletionProvider("openai")).toBe(false);
    expect(isLocalCompletionProvider("")).toBe(false);
    expect(isLocalCompletionProvider("claude")).toBe(false);
  });
});

// `template-settings-ui` spec task 1.2: テンプレートと思考の分離の設定を、成否つきで保存する。
// Requirements: 3.1, 3.5, 7.4。

describe("saveTemplateSelection(template-settings-ui 3.1, 3.5, 7.4)", () => {
  const GEMMA4_TAGS = { open: "<|channel>", close: "<channel|>" };
  const THINK_TAGS = { open: "<think>", close: "</think>" };
  const ILLUSTRATION = { template: { preset: "chatml" }, maxTokens: 4096 };

  function loadLocal(extra: Record<string, unknown>): void {
    useAIConfigStore
      .getState()
      .loadFromMeta(
        metaWithSections(
          { ...LOCAL_SECTION, ...extra },
          { ...CLOUD_SECTION, template: { preset: "gemma4" } },
        ),
      );
  }

  function localSection(): AIConfig {
    const bundle = useAIConfigStore.getState().bundle;
    if (bundle == null) throw new Error("bundle is null");
    return bundle.providers["openai-compatible"];
  }

  it("成功すると template と thinking がストアと保存内容に入り、true を返す", async () => {
    loadLocal({ thinking: { enabled: true, tags: [THINK_TAGS] } });
    const thinking = { enabled: true, tags: [THINK_TAGS, GEMMA4_TAGS] };

    const ok = await useAIConfigStore
      .getState()
      .saveTemplateSelection("openai-compatible", {
        template: { preset: "gemma4-think" },
        thinking,
      });

    expect(ok).toBe(true);
    expect(localSection().template).toEqual({ preset: "gemma4-think" });
    expect(localSection().thinking).toEqual(thinking);
    expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
    const providers = persistedProviders();
    expect(providers["openai-compatible"].template).toEqual({
      preset: "gemma4-think",
    });
    expect(providers["openai-compatible"].thinking).toEqual(thinking);
    // ほかのプロバイダのセクションは変わらない
    expect(providers.openai.template).toEqual({ preset: "gemma4" });
  });

  it("thinking を省くと、思考の分離の設定は変わらない", async () => {
    const before = { enabled: false, tags: [THINK_TAGS] };
    loadLocal({ thinking: before });

    await useAIConfigStore
      .getState()
      .saveTemplateSelection("openai-compatible", {
        template: { preset: "chatml" },
      });

    expect(localSection().thinking).toEqual(before);
    expect(persistedProviders()["openai-compatible"].thinking).toEqual(before);
  });

  it("template に undefined を渡すと、保存内容から template のキーが無くなる", async () => {
    loadLocal({ template: { preset: "gemma4" } });

    const ok = await useAIConfigStore
      .getState()
      .saveTemplateSelection("openai-compatible", { template: undefined });

    expect(ok).toBe(true);
    expect(localSection().template).toBeUndefined();
    expect(persistedProviders()["openai-compatible"]).not.toHaveProperty(
      "template",
    );
  });

  it("挿し絵用の設定は書き換えない", async () => {
    loadLocal({ illustration: ILLUSTRATION });

    await useAIConfigStore
      .getState()
      .saveTemplateSelection("openai-compatible", {
        template: { preset: "gemma4-think" },
        thinking: { tags: [THINK_TAGS, GEMMA4_TAGS] },
      });

    expect(localSection().illustration).toEqual(ILLUSTRATION);
    expect(persistedProviders()["openai-compatible"].illustration).toEqual(
      ILLUSTRATION,
    );
  });

  it("保存が失敗すると false を返し、template と thinking だけが元に戻る", async () => {
    const custom = { custom: "{{system}}{{body}}" };
    const thinking = { enabled: true, tags: [THINK_TAGS] };
    loadLocal({ template: custom, thinking });

    let release: (() => void) | undefined;
    mockSaveProjectMeta.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          release = () => reject(new Error("disk full"));
        }),
    );

    const pending = useAIConfigStore
      .getState()
      .saveTemplateSelection("openai-compatible", {
        template: { preset: "gemma4-think" },
        thinking: { enabled: true, tags: [THINK_TAGS, GEMMA4_TAGS] },
      });
    // 保存を待っている間に、自動保存がほかの項目を書く
    await useAIConfigStore
      .getState()
      .updateProviderSection("openai-compatible", {
        parameters: { temperature: 0.5, topP: 0.9, maxTokens: 2000 },
      });
    release?.();
    const ok = await pending;

    expect(ok).toBe(false);
    const section = localSection();
    expect(section.template).toEqual(custom);
    expect(section.thinking).toEqual(thinking);
    expect(section.parameters.maxTokens).toBe(2000);
    expect(
      useAIConfigStore.getState().bundle?.providers.openai.template,
    ).toEqual({ preset: "gemma4" });
    // 戻した値は currentMeta にも入る(次の保存で、失敗した値を書かない)
    const metaSection = (
      useAIConfigStore.getState().currentMeta?.aiConfig as AIConfigBundleLike
    ).providers["openai-compatible"];
    expect(metaSection.template).toEqual(custom);
  });

  it("プロジェクトを開いていないときは、ストアを書き換えずに false を返す", async () => {
    loadLocal({ template: { preset: "gemma4" } });
    useAppStore.setState({ currentProject: null });

    const ok = await useAIConfigStore
      .getState()
      .saveTemplateSelection("openai-compatible", {
        template: { preset: "chatml" },
      });

    expect(ok).toBe(false);
    expect(localSection().template).toEqual({ preset: "gemma4" });
    expect(mockSaveProjectMeta).not.toHaveBeenCalled();
  });

  it("bundle が無いときは false を返す", async () => {
    useAIConfigStore.setState({ bundle: null, currentMeta: null });
    const ok = await useAIConfigStore
      .getState()
      .saveTemplateSelection("openai-compatible", { template: undefined });
    expect(ok).toBe(false);
    expect(mockSaveProjectMeta).not.toHaveBeenCalled();
  });
});

type AIConfigBundleLike = { providers: Record<ProviderId, AIConfig> };
