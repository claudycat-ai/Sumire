/**
 * `prompt-template` spec の提案コントローラのテスト(jsdom)。task 3.1。
 *
 * - 提案要求のたびにテンプレートの指定を解決し、不備ならトーストを出して生成しない
 *   (design.md「suggestionController(変更)」「Error Handling」)
 * - 解決できたテンプレートを、コンテキストの組み立て(第 4 引数)と生成リクエストの両方に渡す
 * - OpenAI プロバイダでは、テンプレートの指定を読まない
 * - テンプレートがあっても、応答の扱い(思考の分離・ゴースト)は変えない
 *
 * 差し替え(`vi.mock`)の形は thinkingSuggestion.test.ts に倣う。テンプレートの解決
 * (`resolvePromptTemplate`)と分離器は本物を使う。テスト時の言語は ja(`src/__tests__/setup.ts`)。
 *
 * Requirements: 1.1, 1.5, 4.2, 4.3, 4.4, 4.9
 * (`template-settings-ui` spec task 3.2: 3.3, 3.4。画面から選んだ指定が、開き直さずに効く)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, runScopeHandlers } from "@codemirror/view";

import i18n from "@/i18n";
import {
  renderPromptTemplate,
  resolvePromptTemplate,
  type AIConfig,
  type AIProvider,
  type GenerationChunk,
  type GenerationRequest,
  type ParsedPromptTemplate,
  type ThinkingConfig,
} from "@/domain/providers";
import { useSuggestionStore } from "@/stores/suggestionStore";
import { suggestionField, type SuggestionState } from "@/editor/suggestion/suggestionState";
import { abortInflight } from "@/editor/suggestion/suggestionController";
import {
  destroyMountedEditors,
  ghostElement,
  mountSuggestionEditor,
  thinkingIndicatorElement,
} from "./editorHarness";

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

// 画面から選んだ指定の反映(template-settings-ui 3.3, 3.4)で、本物の AI 設定のストアに
// 保存させる。`sumire.json` への書き込みだけを差し替える。
vi.mock("@/domain/project/projectApi", () => ({
  saveProjectMeta: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** 提案生成に使う AI 設定。`template` を省くと、既存プロジェクトと同じ未設定になる */
function testConfig(
  options: { provider?: string; template?: unknown; thinking?: ThinkingConfig } = {},
): AIConfig {
  const config: AIConfig = {
    provider: options.provider ?? "openai-compatible",
    endpoint: "http://127.0.0.1:5000/v1",
    model: "test-model",
    parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
    systemPrompt: null,
  };
  if ("template" in options) config.template = options.template;
  if (options.thinking) config.thinking = options.thinking;
  return config;
}

/** 解決済みのテンプレート(期待値)。解決できない指定ならテストを失敗させる */
function parsedTemplate(raw: unknown): ParsedPromptTemplate {
  const resolution = resolvePromptTemplate(raw);
  if (resolution.kind !== "ok") throw new Error(`解決できない指定: ${JSON.stringify(raw)}`);
  return resolution.template;
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

/** アダプタの代わりに、チャンクを 1 つずつ手で流せるストリーム。受け取ったリクエストを記録する */
interface ControlledStream {
  provider: AIProvider;
  /** `generateStream` に渡されたリクエストの並び */
  requests: GenerationRequest[];
  /** コントローラが次のチャンクを待っているか */
  isWaiting(): boolean;
  /** チャンクを 1 つ流し、コントローラがそれを処理して次のチャンクを待つところまで進める */
  send(textDelta: string, finishReason?: GenerationChunk["finishReason"]): Promise<void>;
  /** ストリームを終え、コントローラが提案を確定するまで進める */
  end(): Promise<void>;
}

function createControlledStream(): ControlledStream {
  const queue: GenerationChunk[] = [];
  const requests: GenerationRequest[] = [];
  let ended = false;
  let waiting = false;
  let wake: (() => void) | null = null;

  async function* iterate(signal: AbortSignal): AsyncGenerator<GenerationChunk> {
    const onAbort = () => wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        if (signal.aborted) return;
        const chunk = queue.shift();
        if (chunk) {
          yield chunk;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          waiting = true;
        });
        waiting = false;
        wake = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  const generateStream = vi.fn((request: GenerationRequest, signal: AbortSignal) => {
    requests.push(request);
    return iterate(signal);
  });

  return {
    provider: {
      generateStream,
      generate: () => Promise.reject(new Error("テストでは使わない")),
      countTokens: () => Promise.resolve(0),
    },
    requests,
    isWaiting: () => waiting,
    async send(textDelta, finishReason) {
      queue.push(finishReason ? { textDelta, finishReason } : { textDelta });
      wake?.();
      await waitUntil(
        () => waiting && queue.length === 0,
        `チャンク ${JSON.stringify(textDelta)} の処理`,
      );
    },
    async end() {
      ended = true;
      wake?.();
      await waitUntil(() => !useSuggestionStore.getState().generating, "生成の終了");
    },
  };
}

/** キー操作を、提案拡張のキーマップに通す。キーマップが処理したら true */
function pressKey(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  return runScopeHandlers(view, event, "editor");
}

function suggestionOf(view: EditorView): SuggestionState | null {
  return view.state.field(suggestionField, false) ?? null;
}

/** ゴーストのうち、思考中の表示を除いた本文の部分。ゴーストが無ければ null */
function ghostBodyText(view: EditorView): string | null {
  const ghost = ghostElement(view);
  if (!ghost) return null;
  return [...ghost.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("");
}

/** 生成中の表示(`generating`)が一度でも true になったかを記録する */
function watchGenerating(): { everStarted: () => boolean; stop: () => void } {
  let started = false;
  const stop = useSuggestionStore.subscribe((state) => {
    if (state.generating) started = true;
  });
  return { everStarted: () => started, stop };
}

interface StartedSuggestion {
  view: EditorView;
  stream: ControlledStream;
}

/** エディタを取り付けて Shift+Enter で提案を要求し、最初のチャンクを待つところまで進める */
async function startSuggestion(options: {
  doc: string;
  config: AIConfig;
}): Promise<StartedSuggestion> {
  const stream = createControlledStream();
  mocks.getActiveConfig.mockReturnValue(options.config);
  mocks.getProvider.mockReturnValue(stream.provider);
  const { view } = mountSuggestionEditor({ doc: options.doc });
  expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
  await waitUntil(stream.isWaiting, "最初のチャンクを待つところまで");
  return { view, stream };
}

/** `buildGenerationRequest` の最後の呼び出しの第 4 引数 */
function lastBuildTemplateArg(): unknown {
  const calls = mocks.buildGenerationRequest.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][3];
}

beforeEach(() => {
  expect(i18n.language).toBe("ja");
  vi.clearAllMocks();
  mocks.buildGenerationRequest.mockResolvedValue({
    systemPrompt: "system",
    contextSections: [],
    body: "本文",
    usedTokens: { system: 0, sections: 0, body: 0, template: 0, reserved: 0, window: 0 },
  });
  mocks.appendToMemo.mockResolvedValue(undefined);
  useSuggestionStore.getState().setGenerating(false);
});

afterEach(() => {
  // 途中で終えたテストの生成を止め、進行中のリクエストを次のテストに持ち越さない
  abortInflight();
  destroyMountedEditors();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 不備のトースト
// ---------------------------------------------------------------------------

describe("テンプレートの指定の不備(prompt-template 4.2, 4.3, 4.4)", () => {
  const cases: { title: string; template: unknown; toast: string }[] = [
    {
      title: "読めない形(preset と custom の両方)なら、読めないことを伝える(prompt-template 4.4)",
      template: { preset: "gemma4", custom: "{{body}}" },
      toast:
        "テンプレートの指定を読めません。sumire.json の template には preset か custom のどちらか一方を書いてください",
    },
    {
      title: "読めない形(文字列そのもの)なら、読めないことを伝える(prompt-template 4.4)",
      template: "gemma4",
      toast:
        "テンプレートの指定を読めません。sumire.json の template には preset か custom のどちらか一方を書いてください",
    },
    {
      title: "未知のプリセット名なら、その名前が無いことを伝える(prompt-template 4.2)",
      template: { preset: "gemma5" },
      toast:
        "テンプレートのプリセット「gemma5」はありません。使えるのは gemma4 / gemma4-think / chatml / chatml-nothink です",
    },
    {
      title: "本文の差し込み口が無いなら、{{body}} が無いことを伝える(prompt-template 4.3)",
      template: { custom: "<s>{{system}}\n{{settings}}\n" },
      toast: "テンプレートに本文の差し込み口 {{body}} がありません",
    },
    {
      title: "差し込み口が重複しているなら、重複した差し込み口を伝える(prompt-template 4.3)",
      template: { custom: ["{{system}}", "{{settings}}", "{{system}}", "{{body}}"] },
      toast: "テンプレートに差し込み口 {{system}} が 2 つ以上あります",
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.title}。コンテキストの組み立ても生成も呼ばれず、生成中の表示にならない`, async () => {
      const stream = createControlledStream();
      mocks.getActiveConfig.mockReturnValue(testConfig({ template: testCase.template }));
      mocks.getProvider.mockReturnValue(stream.provider);
      const generating = watchGenerating();
      const { view } = mountSuggestionEditor({ doc: "あいう" });

      expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
      await flushMicrotasks();

      expect(mocks.toastError).toHaveBeenCalledTimes(1);
      expect(mocks.toastError).toHaveBeenCalledWith(testCase.toast);
      expect(mocks.buildGenerationRequest).not.toHaveBeenCalled();
      expect(stream.provider.generateStream).not.toHaveBeenCalled();
      expect(generating.everStarted()).toBe(false);
      expect(useSuggestionStore.getState().generating).toBe(false);
      expect(suggestionOf(view)).toBeNull();
      expect(ghostElement(view)).toBeNull();

      // 進行中のリクエストが残っていないので、次の要求でもう一度解決してトーストを出す
      expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
      await flushMicrotasks();
      expect(mocks.toastError).toHaveBeenCalledTimes(2);
      expect(mocks.buildGenerationRequest).not.toHaveBeenCalled();
      generating.stop();
    });
  }
});

// ---------------------------------------------------------------------------
// 解決できたテンプレートの受け渡し
// ---------------------------------------------------------------------------

describe("解決できたテンプレートの受け渡し(prompt-template 1.1)", () => {
  it("プリセットの指定で、コンテキストの組み立ての第 4 引数と生成リクエストの両方に解決済みのテンプレートが渡る(prompt-template 1.1)", async () => {
    const config = testConfig({ template: { preset: "gemma4" } });
    const { stream } = await startSuggestion({ doc: "あいう", config });
    const expected = parsedTemplate({ preset: "gemma4" });

    expect(mocks.buildGenerationRequest).toHaveBeenCalledTimes(1);
    const [configArg, systemArg, bodyArg] = mocks.buildGenerationRequest.mock.calls[0];
    expect(configArg).toBe(config);
    expect(typeof systemArg).toBe("string");
    expect(bodyArg).toBe("あいう");
    expect(lastBuildTemplateArg()).toEqual(expected);

    expect(stream.requests).toHaveLength(1);
    expect(stream.requests[0]).toEqual({
      systemPrompt: "system",
      contextSections: [],
      body: "本文",
      parameters: config.parameters,
      promptTemplate: expected,
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("自由記述の指定でも、解決済みのテンプレートが両方に渡る(prompt-template 1.1)", async () => {
    const custom = ["[SYS]{{system}}", "[SET]{{settings}}", "[BODY]{{body}}"];
    const config = testConfig({ template: { custom } });
    const { stream } = await startSuggestion({ doc: "あいう", config });
    const expected = parsedTemplate({ custom });

    expect(lastBuildTemplateArg()).toEqual(expected);
    expect(stream.requests[0].promptTemplate).toEqual(expected);
  });

  it("テンプレートの指定が無ければ、どちらにもテンプレートを渡さない(prompt-template 1.4 の回帰)", async () => {
    const { stream } = await startSuggestion({ doc: "あいう", config: testConfig() });

    expect(lastBuildTemplateArg()).toBeUndefined();
    expect(stream.requests[0].promptTemplate).toBeUndefined();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("OpenAI プロバイダの設定に正しいテンプレートの指定があっても、どちらにも渡らない(prompt-template 4.9)", async () => {
    const config = testConfig({ provider: "openai", template: { preset: "gemma4" } });
    const { stream } = await startSuggestion({ doc: "あいう", config });

    expect(lastBuildTemplateArg()).toBeUndefined();
    expect(stream.requests[0].promptTemplate).toBeUndefined();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("OpenAI プロバイダの設定に不備のあるテンプレートの指定があっても、読まずにそのまま生成する(prompt-template 4.9)", async () => {
    const config = testConfig({ provider: "openai", template: { preset: "gemma5" } });
    const { view, stream } = await startSuggestion({ doc: "あいう", config });

    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(lastBuildTemplateArg()).toBeUndefined();
    expect(stream.requests[0].promptTemplate).toBeUndefined();

    await stream.send("続き。", "stop");
    await stream.end();
    expect(suggestionOf(view)).toEqual({
      text: "続き。",
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 応答の扱いは変えない
// ---------------------------------------------------------------------------

describe("テンプレートありの応答の扱い(prompt-template 1.5)", () => {
  it("思考ありのプリセットで、思考ブロックは分けられ、ゴーストと採用は従来どおり動く(prompt-template 1.5)", async () => {
    const config = testConfig({
      template: { preset: "gemma4-think" },
      thinking: { enabled: true, tags: [{ open: "<|channel>", close: "<channel|>" }] },
    });
    const { view, stream } = await startSuggestion({ doc: "彼女は", config });
    expect(stream.requests[0].promptTemplate).toEqual(parsedTemplate({ preset: "gemma4-think" }));

    await stream.send("<|channel>thought\nplan the scene");
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");
    expect(ghostBodyText(view)).toBe("");

    await stream.send("<channel|>");
    expect(thinkingIndicatorElement(view)).toBeNull();

    await stream.send("ため息をついた。");
    expect(ghostBodyText(view)).toBe("ため息をついた。");
    await stream.send("\n改札の前で待っていた。", "stop");
    await stream.end();

    const expected = "ため息をついた。\n改札の前で待っていた。";
    expect(suggestionOf(view)).toEqual({
      text: expected,
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
    expect(ghostElement(view)?.textContent).toBe(expected);

    expect(pressKey(view, "m", { altKey: true })).toBe(true);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(expected);
    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(`彼女は${expected}`);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("思考なしのプリセットで、`<think>` の応答も既定のタグで分けられる(prompt-template 1.5)", async () => {
    const config = testConfig({ template: { preset: "chatml" } });
    const { view, stream } = await startSuggestion({ doc: "あいう", config });

    await stream.send("<think>\nplan</think>");
    await stream.send("彼は振り返った。", "stop");
    await stream.end();

    expect(suggestionOf(view)).toEqual({
      text: "彼は振り返った。",
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 画面から選んだ指定の反映(template-settings-ui 3.3, 3.4)
// ---------------------------------------------------------------------------

describe("画面から選んだ指定の反映(template-settings-ui 3.3, 3.4)", () => {
  type RealAIConfigStore = typeof import("@/stores/aiConfigStore");
  let realStore: RealAIConfigStore["useAIConfigStore"];

  beforeEach(async () => {
    // このファイルでは AI 設定のストアを差し替えているので、本物を別に読み込む。
    // 提案コントローラには、本物のストアの「現在使うプロバイダ」の設定を、要求のたびに読ませる。
    const actual = await vi.importActual<RealAIConfigStore>("@/stores/aiConfigStore");
    const { useAppStore } = await import("@/stores/appStore");
    const { DEFAULT_AI_CONFIG_BUNDLE } = await import("@/domain/providers/types");
    realStore = actual.useAIConfigStore;
    useAppStore.setState({ currentProject: { path: "/proj", title: "test" } });
    realStore
      .getState()
      .loadFromMeta({ aiConfig: structuredClone(DEFAULT_AI_CONFIG_BUNDLE) } as never);
    mocks.getActiveConfig.mockImplementation(() => realStore.getState().getActiveConfig());
  });

  /** 保存先は「現在使うプロバイダ」のセクション(提案はそのセクションを読む) */
  async function choose(template: unknown): Promise<void> {
    const active = realStore.getState().bundle?.activeProvider;
    if (active == null) throw new Error("bundle is null");
    const ok = await realStore.getState().saveTemplateSelection(active, { template });
    expect(ok).toBe(true);
  }

  /** エディタを取り付けて提案を要求し、最初のチャンクを待つところまで進める */
  async function request(): Promise<ControlledStream> {
    const stream = createControlledStream();
    mocks.getProvider.mockReturnValue(stream.provider);
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
    await waitUntil(stream.isWaiting, "最初のチャンクを待つところまで");
    return stream;
  }

  it("gemma4 を選んだあと、開き直さずに要求すると、Gemma 4 の形で送られる(3.3)", async () => {
    const before = await request();
    expect(before.requests[0].promptTemplate).toBeUndefined();
    await before.send("続き。", "stop");
    await before.end();

    await choose({ preset: "gemma4" });
    const after = await request();
    const template = after.requests[0].promptTemplate;
    expect(template).toEqual(parsedTemplate({ preset: "gemma4" }));
    expect(
      renderPromptTemplate(template as ParsedPromptTemplate, {
        system: "S",
        settings: "T",
        body: "B",
      }).startsWith("<|turn>system\nS"),
    ).toBe(true);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("生成中に指定を変えても、その要求は変わらず、次の要求から新しい指定になる(3.4)", async () => {
    await choose({ preset: "gemma4" });

    // コンテキストの組み立てを止めておき、その間に指定を変える
    let releaseBuild: (() => void) | undefined;
    mocks.buildGenerationRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBuild = () =>
            resolve({
              systemPrompt: "system",
              contextSections: [],
              body: "本文",
              usedTokens: { system: 0, sections: 0, body: 0, template: 0, reserved: 0, window: 0 },
            });
        }),
    );
    const first = createControlledStream();
    mocks.getProvider.mockReturnValue(first.provider);
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
    await waitUntil(() => releaseBuild !== undefined, "コンテキストの組み立てが始まるまで");

    await choose({ preset: "chatml" });
    releaseBuild?.();
    await waitUntil(first.isWaiting, "最初のチャンクを待つところまで");
    expect(lastBuildTemplateArg()).toEqual(parsedTemplate({ preset: "gemma4" }));
    expect(first.requests[0].promptTemplate).toEqual(parsedTemplate({ preset: "gemma4" }));
    await first.send("続き。", "stop");
    await first.end();

    const second = await request();
    expect(second.requests[0].promptTemplate).toEqual(parsedTemplate({ preset: "chatml" }));
  });

  it("「指定なし」に戻すと、テンプレートなし(素の連結)で送られる", async () => {
    await choose({ preset: "gemma4" });
    const withTemplate = await request();
    expect(withTemplate.requests[0].promptTemplate).toBeDefined();
    await withTemplate.send("続き。", "stop");
    await withTemplate.end();

    await choose(undefined);
    const plain = await request();
    expect(plain.requests[0].promptTemplate).toBeUndefined();
    expect(lastBuildTemplateArg()).toBeUndefined();
  });
});
