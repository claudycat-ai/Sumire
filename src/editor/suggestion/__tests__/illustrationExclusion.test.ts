/**
 * `illustration-prompt` spec の提案コントローラのテスト(jsdom)。task 2.5。
 *
 * - 情景文の生成中(`useIllustrationStore` に開始時刻がある)に Shift+Enter を押すと、
 *   トーストを出して提案を始めない(要件 5.6、design.md「suggestionController(変更)」)
 * - 提案のエラーの文言を共有の `describeProviderError` に移しても、続き生成のトーストは
 *   今と同じ(要件 2.8, 6.7, 7.5、design.md「errorMessage(新規)」の null の扱い)
 *
 * 差し替え(`vi.mock`)の形は thinkingSuggestion.test.ts / promptTemplateSuggestion.test.ts に倣う。
 * 情景文のストアは本物を使い、開始時刻を直接立てる。テスト時の言語は ja(`src/__tests__/setup.ts`)。
 *
 * Requirements: 2.8, 5.6, 6.7, 7.5
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, runScopeHandlers } from "@codemirror/view";

import i18n from "@/i18n";
import {
  ProviderError,
  type AIConfig,
  type AIProvider,
  type GenerationChunk,
  type ProviderErrorKind,
} from "@/domain/providers";
import { useIllustrationStore } from "@/stores/illustrationStore";
import { useSuggestionStore } from "@/stores/suggestionStore";
import { suggestionField, type SuggestionState } from "@/editor/suggestion/suggestionState";
import { abortInflight } from "@/editor/suggestion/suggestionController";
import { destroyMountedEditors, ghostElement, mountSuggestionEditor } from "./editorHarness";

// 提案コントローラが参照する外部の依存は、ここでまとめて差し替える。
const mocks = vi.hoisted(() => ({
  getActiveConfig: vi.fn<() => AIConfig | null>(),
  getProvider: vi.fn<(config: AIConfig) => AIProvider>(),
  buildGenerationRequest: vi.fn(),
  toastError: vi.fn<(message: string) => void>(),
  toastInfo: vi.fn<(message: string) => void>(),
  appendToMemo: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@/stores/aiConfigStore", () => ({
  useAIConfigStore: {
    getState: () => ({ getActiveConfig: mocks.getActiveConfig }),
  },
}));

vi.mock("@/domain/context/contextBuilder", () => ({
  buildGenerationRequest: mocks.buildGenerationRequest,
}));

vi.mock("@/domain/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/providers")>();
  return { ...actual, getProvider: mocks.getProvider };
});

vi.mock("@/components/ui/Toast", () => ({
  toastError: mocks.toastError,
  toastInfo: mocks.toastInfo,
}));

vi.mock("@/domain/memo/memoApi", () => ({
  appendToMemo: mocks.appendToMemo,
}));

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

const BUSY_TOAST = "情景文を生成中です。終わってから提案を要求してください";

function testConfig(): AIConfig {
  return {
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:5000/v1",
    model: "test-model",
    parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
    systemPrompt: null,
  };
}

/** マイクロタスクを回しながら、条件が成り立つまで待つ。成り立たないままなら失敗させる */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`条件が成り立たないまま待ちきれなかった: ${label}`);
}

/** 「これ以上何も起きない」を確かめる前に、溜まっているマイクロタスクを流す */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** 決まったチャンクを流し切るプロバイダ。`fail` を渡すと、チャンクのあとにそれを投げる */
function scriptedProvider(chunks: GenerationChunk[], fail?: unknown): AIProvider {
  async function* iterate(): AsyncGenerator<GenerationChunk> {
    for (const chunk of chunks) yield chunk;
    if (fail !== undefined) throw fail;
  }
  return {
    generateStream: vi.fn(() => iterate()),
    generate: () => Promise.reject(new Error("テストでは使わない")),
    countTokens: () => Promise.resolve(0),
  };
}

/** キー操作を、提案拡張のキーマップに通す。キーマップが処理したら true */
function pressShiftEnter(view: EditorView): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  return runScopeHandlers(view, event, "editor");
}

function suggestionOf(view: EditorView): SuggestionState | null {
  return view.state.field(suggestionField, false) ?? null;
}

/** 生成中の表示(`generating`)が一度でも true になったかを記録する */
function watchGenerating(): { everStarted: () => boolean; stop: () => void } {
  let started = false;
  const stop = useSuggestionStore.subscribe((state) => {
    if (state.generating) started = true;
  });
  return { everStarted: () => started, stop };
}

/** Shift+Enter で提案を要求し、生成が終わるまで進める */
async function requestAndFinish(view: EditorView): Promise<void> {
  expect(pressShiftEnter(view)).toBe(true);
  await waitUntil(() => useSuggestionStore.getState().generating, "生成の開始");
  await waitUntil(() => !useSuggestionStore.getState().generating, "生成の終了");
}

beforeEach(() => {
  expect(i18n.language).toBe("ja");
  vi.clearAllMocks();
  mocks.getActiveConfig.mockReturnValue(testConfig());
  mocks.buildGenerationRequest.mockResolvedValue({
    systemPrompt: "system",
    contextSections: [],
    body: "本文",
    usedTokens: { system: 0, sections: 0, body: 0, template: 0, reserved: 0, window: 0 },
  });
  mocks.appendToMemo.mockResolvedValue(undefined);
  useSuggestionStore.getState().setGenerating(false);
  useIllustrationStore.getState().finish();
});

afterEach(() => {
  abortInflight();
  destroyMountedEditors();
  useIllustrationStore.getState().finish();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 情景文との排他(5.6)
// ---------------------------------------------------------------------------

describe("情景文の生成中の提案の要求(5.6)", () => {
  it("情景文の生成中に Shift+Enter を押すと、キーを吸ってトーストを出し、提案を始めない", async () => {
    const provider = scriptedProvider([{ textDelta: "続き。", finishReason: "stop" }]);
    mocks.getProvider.mockReturnValue(provider);
    useIllustrationStore.getState().start(1000);
    const generating = watchGenerating();
    const { view } = mountSuggestionEditor({ doc: "あいう" });

    expect(pressShiftEnter(view)).toBe(true);
    await flushMicrotasks();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(BUSY_TOAST);
    expect(mocks.toastError).toHaveBeenCalledWith(i18n.t("toast.suggestionIllustrationBusy"));
    expect(mocks.getActiveConfig).not.toHaveBeenCalled();
    expect(mocks.buildGenerationRequest).not.toHaveBeenCalled();
    expect(provider.generateStream).not.toHaveBeenCalled();
    expect(generating.everStarted()).toBe(false);
    expect(useSuggestionStore.getState().generating).toBe(false);
    expect(suggestionOf(view)).toBeNull();
    expect(ghostElement(view)).toBeNull();
    // 情景文の生成の状態には触らない
    expect(useIllustrationStore.getState().startedAt).toBe(1000);
    generating.stop();
  });

  it("情景文の生成が終われば、次の Shift+Enter で提案が始まる", async () => {
    const provider = scriptedProvider([{ textDelta: "続き。", finishReason: "stop" }]);
    mocks.getProvider.mockReturnValue(provider);
    useIllustrationStore.getState().start(1000);
    const { view } = mountSuggestionEditor({ doc: "あいう" });

    expect(pressShiftEnter(view)).toBe(true);
    await flushMicrotasks();
    expect(provider.generateStream).not.toHaveBeenCalled();

    useIllustrationStore.getState().finish();
    await requestAndFinish(view);

    expect(provider.generateStream).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(suggestionOf(view)).toEqual({
      text: "続き。",
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
  });

  it("確定済みの提案を表示中に情景文の生成中で弾いても、表示中の提案は消さない", async () => {
    const provider = scriptedProvider([{ textDelta: "続き。", finishReason: "stop" }]);
    mocks.getProvider.mockReturnValue(provider);
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    await requestAndFinish(view);
    const shown = suggestionOf(view);
    expect(shown?.streaming).toBe(false);

    useIllustrationStore.getState().start(2000);
    expect(pressShiftEnter(view)).toBe(true);
    await flushMicrotasks();

    expect(mocks.toastError).toHaveBeenCalledWith(BUSY_TOAST);
    expect(provider.generateStream).toHaveBeenCalledTimes(1);
    expect(suggestionOf(view)).toEqual(shown);
    expect(ghostElement(view)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// エラーの文言(2.8, 6.7, 7.5): 共有の関数に移しても、続き生成のトーストは変わらない
// ---------------------------------------------------------------------------

describe("提案の失敗のトースト(2.8, 6.7, 7.5)", () => {
  const providerCases: { kind: ProviderErrorKind; message: string; toast: string | null }[] = [
    { kind: "network", message: "fetch failed", toast: "推論サーバーに接続できません" },
    { kind: "timeout", message: "timed out", toast: "応答がタイムアウトしました" },
    { kind: "http", message: "500 Internal", toast: "推論サーバーがエラーを返しました: 500 Internal" },
    { kind: "parse", message: "bad json", toast: "推論サーバーの応答を解析できませんでした" },
    { kind: "config", message: "エンドポイントが未設定です", toast: "エンドポイントが未設定です" },
    { kind: "auth", message: "401", toast: null },
    { kind: "rateLimit", message: "429", toast: null },
  ];

  for (const testCase of providerCases) {
    const expectation =
      testCase.toast === null ? "トーストを出さない" : `「${testCase.toast}」を出す`;
    it(`生成中に ProviderError(${testCase.kind})が起きたら${expectation}。ゴーストは消える`, async () => {
      const provider = scriptedProvider(
        [{ textDelta: "途中" }],
        new ProviderError(testCase.kind, testCase.message),
      );
      mocks.getProvider.mockReturnValue(provider);
      const { view } = mountSuggestionEditor({ doc: "あいう" });

      await requestAndFinish(view);

      if (testCase.toast === null) {
        expect(mocks.toastError).not.toHaveBeenCalled();
      } else {
        expect(mocks.toastError).toHaveBeenCalledTimes(1);
        expect(mocks.toastError).toHaveBeenCalledWith(testCase.toast);
      }
      expect(suggestionOf(view)).toBeNull();
      expect(ghostElement(view)).toBeNull();
    });
  }

  it("ProviderError でない例外は「提案要求に失敗しました: …」を出す", async () => {
    const provider = scriptedProvider([], new Error("想定外"));
    mocks.getProvider.mockReturnValue(provider);
    const { view } = mountSuggestionEditor({ doc: "あいう" });

    await requestAndFinish(view);

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith("提案要求に失敗しました: Error: 想定外");
  });

  it("コンテキストの組み立てで ProviderError が起きても、同じ文言を出す", async () => {
    mocks.buildGenerationRequest.mockRejectedValue(new ProviderError("network", "fetch failed"));
    const provider = scriptedProvider([]);
    mocks.getProvider.mockReturnValue(provider);
    const { view } = mountSuggestionEditor({ doc: "あいう" });

    await requestAndFinish(view);

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith("推論サーバーに接続できません");
    expect(provider.generateStream).not.toHaveBeenCalled();
  });
});
