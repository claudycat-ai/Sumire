/**
 * `llama-server-provider` spec の提案コントローラのテスト(jsdom)。task 4.1。
 *
 * - `llama-server` で止まっているときは、起動の関門が読み込みを始め、その要求では生成しない
 * - 準備完了のときは、関門が返した実効の設定(接続先 `http://127.0.0.1:<port>/v1`)で、
 *   テンプレートで包んだプロンプトを送り、思考の分離を適用する
 * - テンプレートの不備があるときは、関門を呼ばない(起動しない)
 * - 生成中に `llama-server` が止められる・別のモデルで起動し直されると、生成を静かに中止する
 *
 * 差し替え(`vi.mock`)の形は promptTemplateSuggestion.test.ts に倣う。関門とストア
 * (`@/stores/llamaServerStore`)は本物を使い、Tauri の command のラッパーだけを差し替える。
 * テスト時の言語は ja(`src/__tests__/setup.ts`)。
 *
 * Requirements: 1.3, 1.4, 3.4, 4.2, 5.2, 5.4, 5.12, 6.6, 8.1, 8.3, 8.4, 8.6
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, runScopeHandlers } from "@codemirror/view";

import i18n from "@/i18n";
import {
  resolvePromptTemplate,
  type AIConfig,
  type AIProvider,
  type GenerationChunk,
  type GenerationRequest,
  type ParsedPromptTemplate,
  type ThinkingConfig,
} from "@/domain/providers";
import type {
  GgufModel,
  LlamaServerStatus,
  StartLlamaServerRequest,
} from "@/domain/llamaServer";
import { useLlamaServerStore } from "@/stores/llamaServerStore";
import { useSuggestionStore } from "@/stores/suggestionStore";
import { suggestionField, type SuggestionState } from "@/editor/suggestion/suggestionState";
import { abortInflight } from "@/editor/suggestion/suggestionController";
import {
  destroyMountedEditors,
  ghostElement,
  mountSuggestionEditor,
  thinkingIndicatorElement,
} from "./editorHarness";

const mocks = vi.hoisted(() => ({
  getActiveConfig: vi.fn<() => AIConfig | null>(),
  getProvider: vi.fn<(config: AIConfig) => AIProvider>(),
  buildGenerationRequest: vi.fn(),
  toastError: vi.fn<(message: string) => void>(),
  toastInfo: vi.fn<(message: string) => void>(),
  appendToMemo: vi.fn<(text: string) => Promise<void>>(),
  startLlamaServer: vi.fn<(request: StartLlamaServerRequest) => Promise<LlamaServerStatus>>(),
  stopLlamaServer: vi.fn<() => Promise<LlamaServerStatus>>(),
  writeAppPreferences: vi.fn<(text: string) => Promise<void>>(),
  listGgufModels: vi.fn<(dir: string) => Promise<GgufModel[]>>(),
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

vi.mock("@/domain/llamaServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/llamaServer")>();
  return {
    ...actual,
    startLlamaServer: mocks.startLlamaServer,
    stopLlamaServer: mocks.stopLlamaServer,
    writeAppPreferences: mocks.writeAppPreferences,
    listGgufModels: mocks.listGgufModels,
  };
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

const MODELS_DIR = "C:\\models";
const MODEL_A = "model-a.gguf";
const MODEL_B = "model-b.gguf";
const PORT = 51234;

/** `sumire.json` の `llama-server` のセクション。接続先とモデル名は実効の設定で上書きされる */
function llamaConfig(options: { template?: unknown; thinking?: ThinkingConfig } = {}): AIConfig {
  const config: AIConfig = {
    provider: "llama-server",
    endpoint: "",
    model: "",
    parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
    systemPrompt: null,
  };
  if ("template" in options) config.template = options.template;
  if (options.thinking) config.thinking = options.thinking;
  return config;
}

function readyStatus(runId = 3): LlamaServerStatus {
  return {
    state: "ready",
    runId,
    modelPath: `${MODELS_DIR}\\${MODEL_A}`,
    contextSize: 8192,
    port: PORT,
  };
}

/** ストアを、起動できる設定(パス・フォルダ・2 つのモデル・A を選択)と、指定の状態にする */
function setLlamaServer(status: LlamaServerStatus): void {
  useLlamaServerStore.setState({
    preferences: {
      executablePath: "C:\\bin\\llama-server.exe",
      modelsDir: MODELS_DIR,
      extraArgs: [],
      selectedModel: MODEL_A,
      models: { [MODEL_A]: { contextSize: 8192 }, [MODEL_B]: { contextSize: 4096 } },
    },
    models: [
      { fileName: MODEL_A, sizeBytes: 1 },
      { fileName: MODEL_B, sizeBytes: 1 },
    ],
    modelsError: null,
    status,
    actualContextSize: null,
  });
}

function parsedTemplate(raw: unknown): ParsedPromptTemplate {
  const resolution = resolvePromptTemplate(raw);
  if (resolution.kind !== "ok") throw new Error(`解決できない指定: ${JSON.stringify(raw)}`);
  return resolution.template;
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`条件が成り立たないまま待ちきれなかった: ${label}`);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

interface ControlledStream {
  provider: AIProvider;
  requests: GenerationRequest[];
  /** `generateStream` に渡された中止の合図の並び */
  signals: AbortSignal[];
  isWaiting(): boolean;
  send(textDelta: string, finishReason?: GenerationChunk["finishReason"]): Promise<void>;
  end(): Promise<void>;
}

function createControlledStream(): ControlledStream {
  const queue: GenerationChunk[] = [];
  const requests: GenerationRequest[] = [];
  const signals: AbortSignal[] = [];
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
    signals.push(signal);
    return iterate(signal);
  });

  return {
    provider: {
      generateStream,
      generate: () => Promise.reject(new Error("テストでは使わない")),
      countTokens: () => Promise.resolve(0),
    },
    requests,
    signals,
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

function ghostBodyText(view: EditorView): string | null {
  const ghost = ghostElement(view);
  if (!ghost) return null;
  return [...ghost.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("");
}

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

/** 生成が中止され、何も残っていないことを確かめる */
function expectSilentlyAborted(started: StartedSuggestion): void {
  expect(started.stream.signals[0].aborted).toBe(true);
  expect(useSuggestionStore.getState().generating).toBe(false);
  expect(suggestionOf(started.view)).toBeNull();
  expect(ghostElement(started.view)).toBeNull();
  expect(mocks.toastError).not.toHaveBeenCalled();
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
  // 起動の command は戻さない(読み込み中のまま)。戻り値で状態が進むところは、ここでは見ない
  mocks.startLlamaServer.mockReturnValue(new Promise<LlamaServerStatus>(() => {}));
  mocks.stopLlamaServer.mockImplementation(() =>
    Promise.resolve({
      state: "stopped",
      runId: useLlamaServerStore.getState().status.runId,
      cause: "requested",
      exitCode: null,
    }),
  );
  mocks.writeAppPreferences.mockResolvedValue(undefined);
  // 起動の直前の一覧の読み直し。フォルダの中身は、ストアの一覧と同じにする
  mocks.listGgufModels.mockResolvedValue([
    { fileName: MODEL_A, sizeBytes: 1 },
    { fileName: MODEL_B, sizeBytes: 1 },
  ]);
  useSuggestionStore.getState().setGenerating(false);
  setLlamaServer({ state: "stopped", runId: 0, cause: "initial", exitCode: null });
});

afterEach(() => {
  abortInflight();
  destroyMountedEditors();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 起動の関門
// ---------------------------------------------------------------------------

describe("llama-server が準備完了でないときの提案要求(llama-server-provider 4.2, 5.2, 5.12)", () => {
  /** 提案を要求し、生成が始まらなかったことを確かめる */
  async function requestAndExpectNoGeneration(config: AIConfig): Promise<void> {
    const stream = createControlledStream();
    mocks.getActiveConfig.mockReturnValue(config);
    mocks.getProvider.mockReturnValue(stream.provider);
    const generating = watchGenerating();
    const { view } = mountSuggestionEditor({ doc: "あいう" });

    expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
    await flushMicrotasks();

    expect(mocks.buildGenerationRequest).not.toHaveBeenCalled();
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(stream.provider.generateStream).not.toHaveBeenCalled();
    expect(generating.everStarted()).toBe(false);
    expect(useSuggestionStore.getState().generating).toBe(false);
    expect(suggestionOf(view)).toBeNull();
    expect(ghostElement(view)).toBeNull();
    generating.stop();
  }

  it("止まっているときは、読み込みを 1 回始めて知らせ、生成中の表示もゴーストも出さない(llama-server-provider 4.2)", async () => {
    await requestAndExpectNoGeneration(llamaConfig());

    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer).toHaveBeenCalledWith({
      executablePath: "C:\\bin\\llama-server.exe",
      modelPath: `${MODELS_DIR}\\${MODEL_A}`,
      contextSize: 8192,
      extraArgs: [],
    });
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      `${MODEL_A} を読み込み始めました。準備ができたらお知らせします`,
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status.state).toBe("loading");
  });

  it("失敗のあとの要求でも、止まっているときと同じく読み込みを始めて生成しない(llama-server-provider 5.12)", async () => {
    setLlamaServer({
      state: "failed",
      runId: 2,
      reason: "exited",
      executablePath: "C:\\bin\\llama-server.exe",
      modelPath: `${MODELS_DIR}\\${MODEL_A}`,
      message: "",
      exitCode: 1,
    });

    await requestAndExpectNoGeneration(llamaConfig());

    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
  });

  it("読み込み中は、読み込み中であることを知らせ、起動し直さず、生成しない(llama-server-provider 5.2)", async () => {
    setLlamaServer({
      state: "loading",
      runId: 1,
      modelPath: `${MODELS_DIR}\\${MODEL_A}`,
      contextSize: 8192,
      port: PORT,
    });

    await requestAndExpectNoGeneration(llamaConfig());

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "モデルを読み込み中です。準備ができてからもう一度要求してください",
    );
  });

  it("テンプレートの不備があるときは、不備を伝えるだけで、読み込みを始めない(llama-server-provider 8.3)", async () => {
    await requestAndExpectNoGeneration(llamaConfig({ template: { preset: "gemma5" } }));

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "テンプレートのプリセット「gemma5」はありません。使えるのは gemma4 / gemma4-think / chatml / chatml-nothink です",
    );
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status.state).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// 準備完了のときの生成
// ---------------------------------------------------------------------------

describe("llama-server が準備完了のときの提案(llama-server-provider 1.3, 5.4, 8.1, 8.3, 8.4)", () => {
  it("テンプレートで包んだプロンプトを実効の接続先に送り、思考を分け、採用まで従来どおり動く", async () => {
    setLlamaServer(readyStatus());
    const config = llamaConfig({
      template: { preset: "gemma4-think" },
      thinking: { enabled: true, tags: [{ open: "<|channel>", close: "<channel|>" }] },
    });
    const { view, stream } = await startSuggestion({ doc: "彼女は", config });
    const expectedTemplate = parsedTemplate({ preset: "gemma4-think" });
    const effective: AIConfig = {
      ...config,
      endpoint: `http://127.0.0.1:${PORT}/v1`,
      model: MODEL_A,
      contextWindow: 8192,
    };

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();

    // コンテキストの組み立てにも、アダプタの取得にも、同じ実効の設定を使う
    expect(mocks.buildGenerationRequest).toHaveBeenCalledTimes(1);
    const [configArg, , bodyArg, templateArg] = mocks.buildGenerationRequest.mock.calls[0];
    expect(configArg).toEqual(effective);
    expect(bodyArg).toBe("彼女は");
    expect(templateArg).toEqual(expectedTemplate);
    expect(mocks.getProvider).toHaveBeenCalledTimes(1);
    expect(mocks.getProvider.mock.calls[0][0]).toBe(configArg);

    expect(stream.requests).toHaveLength(1);
    expect(stream.requests[0]).toEqual({
      systemPrompt: "system",
      contextSections: [],
      body: "本文",
      parameters: config.parameters,
      promptTemplate: expectedTemplate,
    });

    await stream.send("<|channel>thought\nplan the scene");
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");
    expect(ghostBodyText(view)).toBe("");
    await stream.send("<channel|>");
    expect(thinkingIndicatorElement(view)).toBeNull();
    await stream.send("ため息をついた。", "stop");
    await stream.end();

    expect(suggestionOf(view)).toEqual({
      text: "ため息をついた。",
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("彼女はため息をついた。");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("Esc で生成を止めても、llama-server は止めない(llama-server-provider 8.6)", async () => {
    setLlamaServer(readyStatus());
    const started = await startSuggestion({ doc: "あいう", config: llamaConfig() });
    await started.stream.send("途中まで");

    expect(pressKey(started.view, "Escape")).toBe(true);
    await flushMicrotasks();

    expectSilentlyAborted(started);
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(readyStatus());
  });
});

// ---------------------------------------------------------------------------
// 生成中の停止・切り替え
// ---------------------------------------------------------------------------

describe("生成中に llama-server が止まる・切り替わる(llama-server-provider 3.4, 6.6)", () => {
  it("停止の操作で状態が「停止中」になると、生成を中止し、失敗のトーストを出さない(llama-server-provider 6.6)", async () => {
    setLlamaServer(readyStatus());
    const started = await startSuggestion({ doc: "あいう", config: llamaConfig() });
    await started.stream.send("途中まで");
    expect(ghostBodyText(started.view)).toBe("途中まで");

    await useLlamaServerStore.getState().stop();
    await flushMicrotasks();

    expect(useLlamaServerStore.getState().status.state).toBe("stopped");
    expectSilentlyAborted(started);
  });

  it("別のモデルが選ばれて読み込み中になると、生成を中止し、失敗のトーストを出さない(llama-server-provider 3.4)", async () => {
    setLlamaServer(readyStatus());
    const started = await startSuggestion({ doc: "あいう", config: llamaConfig() });
    await started.stream.send("途中まで");

    await useLlamaServerStore.getState().selectModel(MODEL_B);
    await flushMicrotasks();

    expect(useLlamaServerStore.getState().status.state).toBe("loading");
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expectSilentlyAborted(started);
  });

  it("準備完了のまま通し番号だけが変わっても(起動し直しのあと)、生成を中止する(llama-server-provider 3.4)", async () => {
    setLlamaServer(readyStatus(3));
    const started = await startSuggestion({ doc: "あいう", config: llamaConfig() });
    await started.stream.send("途中まで");

    useLlamaServerStore.setState({ status: readyStatus(4) });
    await flushMicrotasks();

    expectSilentlyAborted(started);
  });

  it("コンテキストの組み立ての途中で止められたら、生成を送らずに終える(llama-server-provider 6.6)", async () => {
    setLlamaServer(readyStatus());
    const stream = createControlledStream();
    let resolveBuild: (value: unknown) => void = () => {};
    mocks.buildGenerationRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveBuild = resolve;
      }),
    );
    mocks.getActiveConfig.mockReturnValue(llamaConfig());
    mocks.getProvider.mockReturnValue(stream.provider);
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
    await waitUntil(() => mocks.buildGenerationRequest.mock.calls.length === 1, "組み立ての開始");
    expect(useSuggestionStore.getState().generating).toBe(true);

    await useLlamaServerStore.getState().stop();
    expect(useSuggestionStore.getState().generating).toBe(false);
    resolveBuild({ systemPrompt: "system", contextSections: [], body: "本文" });
    await flushMicrotasks();

    expect(stream.provider.generateStream).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("生成が終わったあとは購読を解いていて、確定した提案は停止で消えない(llama-server-provider 6.6)", async () => {
    setLlamaServer(readyStatus());
    const { view, stream } = await startSuggestion({ doc: "あいう", config: llamaConfig() });
    await stream.send("続き。", "stop");
    await stream.end();
    const confirmed = suggestionOf(view);
    expect(confirmed?.streaming).toBe(false);

    await useLlamaServerStore.getState().stop();
    await flushMicrotasks();

    expect(suggestionOf(view)).toEqual(confirmed);
    expect(ghostElement(view)?.textContent).toBe("続き。");
  });

  it("前の生成が終わったあとに始めた次の生成は、前の購読に中止されない(通し番号は要求ごとに取り直す)", async () => {
    setLlamaServer(readyStatus(3));
    const first = await startSuggestion({ doc: "あいう", config: llamaConfig() });
    expect(pressKey(first.view, "Escape")).toBe(true);
    await flushMicrotasks();

    // 起動し直されて、通し番号が進んだ準備完了になった
    setLlamaServer(readyStatus(5));
    const second = await startSuggestion({ doc: "かきく", config: llamaConfig() });
    // モデルの一覧の読み直しなど、状態と関係のない書き換えでは中止しない
    useLlamaServerStore.setState({ modelsError: null });
    await second.stream.send("続き。", "stop");
    await second.stream.end();

    expect(suggestionOf(second.view)?.text).toBe("続き。");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ほかのプロバイダ
// ---------------------------------------------------------------------------

describe("ほかのプロバイダは変えない(llama-server-provider 1.4)", () => {
  it("OpenAI 互換では、llama-server の状態がどう変わっても、設定をそのまま使って生成を続ける", async () => {
    const config: AIConfig = {
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:5000/v1",
      model: "test-model",
      parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
      systemPrompt: null,
    };
    const { view, stream } = await startSuggestion({ doc: "あいう", config });

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.buildGenerationRequest.mock.calls[0][0]).toBe(config);
    expect(mocks.getProvider.mock.calls[0][0]).toBe(config);

    await stream.send("途中まで");
    setLlamaServer(readyStatus(9));
    setLlamaServer({ state: "stopped", runId: 9, cause: "requested", exitCode: null });
    await stream.send("。", "stop");
    await stream.end();

    expect(stream.signals[0].aborted).toBe(false);
    expect(suggestionOf(view)?.text).toBe("途中まで。");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
