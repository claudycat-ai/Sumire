/**
 * `illustration-prompt` spec の情景文の生成のコントローラのテスト(jsdom)。task 3.1。
 *
 * - 開始の条件 1〜6 を順に確かめ、満たさなければトーストを出して、状態を作らずに戻る
 *   (design.md「illustrationController」の開始の条件の表、設定の不備のトーストの表)
 * - 文脈を組み立て、挿し絵用のプリセット・温度・最大トークン・タイムアウトでストリーミング送信する。
 *   `topP`・`extras` は続き生成の値を使う(生成の流れ 1〜4)
 * - 正常に終わったら、出所の行つきで思考を除いた情景文をメモに追記し、info のトーストを出す
 *   (終わり方の表の「本文あり、それ以外」の行)
 * - 本文に dispatch せず、入力・カーソル移動・章の切り替えで止まらない
 * - 正常以外の終わり方では追記せず、どの終わり方でも状態を戻す
 * - task 3.2: 終わり方の表の残りの行(思考が終わらない 2 種・空・接続の失敗・上限での途切れ・中止)の
 *   トーストと追記の有無、`stopIllustration`、プロジェクトの変更での中止、dev ログ
 * - `llama-server-provider` spec の task 4.2: `llama-server` でも使えること、起動の関門、
 *   生成中に `llama-server` が止められた・起動し直されたときの中止
 *
 * 差し替え(`vi.mock`)の形は src/editor/suggestion/__tests__/promptTemplateSuggestion.test.ts に倣う。
 * 文脈の組み立て(`buildIllustrationContext`)・場面の取り出し・設定の解決・思考の分離・
 * エントリの整形は本物を使う(偽のプロバイダは文字数をトークン数として返す)。
 * 文脈の組み立てだけは、外した設定のテストのために 1 回だけ結果を差し替えられるようにしてある。
 * テスト時の言語は ja(`src/__tests__/setup.ts`)。
 *
 * Requirements: 1.3, 1.4, 2.5, 2.6, 4.1, 4.2, 4.3, 4.4, 4.5, 5.2, 5.5, 5.7, 5.8, 6.1,
 *   7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";

import i18n from "@/i18n";
import {
  ILLUSTRATION_TEMPLATE_PRESETS,
  PROMPT_TEMPLATE_PRESETS,
  ProviderError,
  resolvePromptTemplate,
  type AIConfig,
  type AIProvider,
  type GenerationChunk,
  type GenerationRequest,
  type ParsedPromptTemplate,
} from "@/domain/providers";
import { DEFAULT_ILLUSTRATION_INSTRUCTION } from "@/domain/illustration/illustrationConfig";
import {
  parsePreferences,
  type GgufModel,
  type LlamaServerStatus,
  type StartLlamaServerRequest,
} from "@/domain/llamaServer";
import { buildIllustrationContext } from "@/domain/illustration/illustrationContext";
import { useAppStore } from "@/stores/appStore";
import { useIllustrationStore } from "@/stores/illustrationStore";
import { prepareLlamaServerConfig, useLlamaServerStore } from "@/stores/llamaServerStore";
import { useSuggestionStore } from "@/stores/suggestionStore";
import { ILLUSTRATION_TRUNCATED_NOTE } from "@/domain/illustration/illustrationEntry";
import {
  requestIllustration,
  stopIllustration,
} from "@/editor/illustration/illustrationController";
import {
  destroyMountedEditors,
  mountSuggestionEditor,
} from "@/editor/suggestion/__tests__/editorHarness";

// コントローラが参照する外部の依存は、ここでまとめて差し替える。
const mocks = vi.hoisted(() => ({
  getActiveConfig: vi.fn<() => AIConfig | null>(),
  getProvider: vi.fn<(config: AIConfig) => AIProvider>(),
  toastError: vi.fn<(message: string) => void>(),
  toastInfo: vi.fn<(message: string) => void>(),
  appendToMemo: vi.fn<(text: string) => Promise<void>>(),
  emitDevEvent: vi.fn<(event: string, payload?: Record<string, unknown>) => void>(),
  startLlamaServer: vi.fn<(req: StartLlamaServerRequest) => Promise<LlamaServerStatus>>(),
  listGgufModels: vi.fn<(dir: string) => Promise<GgufModel[]>>(),
}));

vi.mock("@/stores/aiConfigStore", () => ({
  useAIConfigStore: {
    getState: () => ({ getActiveConfig: mocks.getActiveConfig }),
  },
}));

vi.mock("@/domain/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/providers")>();
  return { ...actual, getProvider: mocks.getProvider };
});

// 既定は本物の組み立て。外した設定のテストだけ、結果を 1 回差し替える。
vi.mock("@/domain/illustration/illustrationContext", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/domain/illustration/illustrationContext")>();
  return { ...actual, buildIllustrationContext: vi.fn(actual.buildIllustrationContext) };
});

// 本物の関門が読み込みを始めるときの、一覧の読み直しと起動の command だけを差し替える。
vi.mock("@/domain/llamaServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/llamaServer")>();
  return {
    ...actual,
    startLlamaServer: mocks.startLlamaServer,
    listGgufModels: mocks.listGgufModels,
  };
});

// 起動の関門は、既定では本物(`llama-server` 以外の設定は素通し)。`llama-server` のテストでは
// 戻り値を差し替える。ストアは本物を使い、状態を直接書き換える。
vi.mock("@/stores/llamaServerStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/llamaServerStore")>();
  return { ...actual, prepareLlamaServerConfig: vi.fn(actual.prepareLlamaServerConfig) };
});

vi.mock("@/components/ui/Toast", () => ({
  toastError: mocks.toastError,
  toastInfo: mocks.toastInfo,
}));

vi.mock("@/domain/memo/memoApi", () => ({
  appendToMemo: mocks.appendToMemo,
}));

vi.mock("@/lib/devLog", () => ({
  emitDevEvent: mocks.emitDevEvent,
}));

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** フロントマターつきの章。場面にする行は 5 行目 */
const DOC = [
  "---",
  "title: 雨の橋",
  "---",
  "雨脚が強まる。",
  "リナは崩れかけた橋の中央で立ち止まった。",
  "遠くで雷が鳴った。",
].join("\n");
const SCENE_LINE = "リナは崩れかけた橋の中央で立ち止まった。";
/** 場面の行の途中(カーソル位置) */
const CURSOR_IN_SCENE = DOC.indexOf(SCENE_LINE) + 3;
const CHAPTER = "03_雨の橋.md";
const PROJECT_PATH = "/projects/test-novel";

interface ConfigOptions {
  provider?: string;
  illustration?: unknown;
  contextWindow?: number;
  /** 続き生成のテンプレート。省くと `gemma4` のプリセット */
  template?: unknown;
}

/** 情景文の生成に使う AI 設定。`illustration` を省くと `gemma4-think` のプリセットだけを指定する */
function testConfig(options: ConfigOptions = {}): AIConfig {
  return {
    provider: options.provider ?? "openai-compatible",
    endpoint: "http://127.0.0.1:5000/v1",
    model: "test-model",
    parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200, extras: { top_k: 20 } },
    systemPrompt: null,
    timeoutMs: 60000,
    contextWindow: options.contextWindow ?? 32768,
    thinking: { enabled: true, tags: [{ open: "<think>", close: "</think>" }] },
    template: "template" in options ? options.template : { preset: "gemma4" },
    illustration:
      "illustration" in options ? options.illustration : { template: { preset: "gemma4-think" } },
  };
}

/** 挿し絵用の表で解決したテンプレート(期待値) */
function illustrationTemplate(raw: unknown): ParsedPromptTemplate {
  const resolution = resolvePromptTemplate(raw, ILLUSTRATION_TEMPLATE_PRESETS);
  if (resolution.kind !== "ok") throw new Error(`解決できない指定: ${JSON.stringify(raw)}`);
  return resolution.template;
}

/** マイクロタスクを回しながら、条件が成り立つまで待つ。成り立たないままなら失敗させる */
async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`条件が成り立たないまま待ちきれなかった: ${label}`);
}

/** 「これ以上何も起きない」を確かめる前に、溜まっているマイクロタスクを流す */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function isGenerating(): boolean {
  return useIllustrationStore.getState().startedAt !== null;
}

/** アダプタの代わりに、チャンクを 1 つずつ手で流せるストリーム。受け取ったリクエストを記録する */
interface ControlledStream {
  provider: AIProvider;
  generateStream: ReturnType<typeof vi.fn>;
  /** `generateStream` に渡されたリクエストの並び */
  requests: GenerationRequest[];
  /** コントローラが次のチャンクを待っているか */
  isWaiting(): boolean;
  /** チャンクを 1 つ流し、コントローラがそれを処理して次のチャンクを待つところまで進める */
  send(textDelta: string, finishReason?: GenerationChunk["finishReason"]): Promise<void>;
  /** 次のチャンクの代わりにエラーを投げる */
  fail(error: unknown): Promise<void>;
  /** ストリームを終え、コントローラが生成を終えるまで進める */
  end(): Promise<void>;
}

const openStreams: ControlledStream[] = [];

/**
 * `ignoreAbort` を立てると、中止されてもチャンクや例外を流し続ける(中止のあとに届いた
 * チャンクや例外を、コントローラが自分で無視することを確かめるため)。
 */
function createControlledStream(options: { ignoreAbort?: boolean } = {}): ControlledStream {
  const queue: (GenerationChunk | { error: unknown })[] = [];
  const requests: GenerationRequest[] = [];
  let ended = false;
  let waiting = false;
  let wake: (() => void) | null = null;

  async function* iterate(signal: AbortSignal): AsyncGenerator<GenerationChunk> {
    const onAbort = () => {
      if (!options.ignoreAbort) wake?.();
    };
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        if (signal.aborted && !options.ignoreAbort) return;
        const item = queue.shift();
        if (item) {
          if ("error" in item) throw item.error;
          yield item;
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

  const stream: ControlledStream = {
    provider: {
      generateStream,
      generate: () => Promise.reject(new Error("テストでは使わない")),
      // 文字数をトークン数とみなす
      countTokens: (text: string) => Promise.resolve(Array.from(text).length),
    },
    generateStream,
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
    async fail(error) {
      queue.push({ error });
      wake?.();
      await waitUntil(() => !isGenerating(), "エラーでの生成の終了");
    },
    async end() {
      ended = true;
      wake?.();
      await waitUntil(() => !isGenerating(), "生成の終了");
    },
  };
  openStreams.push(stream);
  return stream;
}

/** エディタを取り付け、ストリームを返すプロバイダと設定を用意する */
function setup(options: { config?: AIConfig; doc?: string; cursor?: number } = {}): {
  view: EditorView;
  stream: ControlledStream;
} {
  const stream = createControlledStream();
  mocks.getActiveConfig.mockReturnValue(options.config ?? testConfig());
  mocks.getProvider.mockReturnValue(stream.provider);
  const { view } = mountSuggestionEditor({
    doc: options.doc ?? DOC,
    cursor: options.cursor ?? CURSOR_IN_SCENE,
  });
  return { view, stream };
}

/** Alt+I の代わりに生成を要求し、最初のチャンクを待つところまで進める */
async function startIllustration(view: EditorView, stream: ControlledStream): Promise<void> {
  expect(requestIllustration(view)).toBe(true);
  await waitUntil(stream.isWaiting, "最初のチャンクを待つところまで");
}

/**
 * 生成のための getProvider の呼び出しの引数。`generateStream` の各呼び出しの直前にあった
 * getProvider の呼び出しを生成用とみなす(文脈の組み立てでのトークン計測の呼び出しは、
 * それより前に済んでいる)。タイムアウトの値では見分けない。
 */
function generationProviderConfigs(stream: ControlledStream): AIConfig[] {
  const orders = mocks.getProvider.mock.invocationCallOrder;
  return stream.generateStream.mock.invocationCallOrder.map((streamOrder: number) => {
    let index = -1;
    orders.forEach((order, i) => {
      if (order < streamOrder) index = i;
    });
    if (index < 0) throw new Error("generateStream の前に getProvider が呼ばれていない");
    return mocks.getProvider.mock.calls[index][0];
  });
}

beforeEach(() => {
  expect(i18n.language).toBe("ja");
  vi.clearAllMocks();
  mocks.appendToMemo.mockResolvedValue(undefined);
  useSuggestionStore.getState().setGenerating(false);
  useIllustrationStore.getState().finish();
  // 起動の command は戻らないままにする(仮の「読み込み中」のあとの知らせは、ここでは扱わない)
  mocks.startLlamaServer.mockReturnValue(new Promise(() => {}));
  useLlamaServerStore.setState({
    preferences: parsePreferences(null).llamaServer,
    models: [],
    modelsError: null,
    status: { state: "stopped", runId: 0, cause: "initial", exitCode: null },
    actualContextSize: null,
  });
  useAppStore.setState({
    currentProject: { path: PROJECT_PATH, title: "テストの小説" },
    selectedChapter: {
      category: "chapters",
      relativePath: `chapters/${CHAPTER}`,
      name: CHAPTER,
    },
  });
});

afterEach(async () => {
  // 途中で終えたテストのストリームを閉じ、進行中の生成を次のテストに持ち越さない
  for (const stream of openStreams.splice(0)) {
    if (stream.isWaiting()) await stream.end();
  }
  destroyMountedEditors();
  useAppStore.setState({ currentProject: null, selectedChapter: null });
});

// ---------------------------------------------------------------------------
// 開始の条件
// ---------------------------------------------------------------------------

describe("開始の条件(design.md の開始の条件 1〜6)", () => {
  /** 開始の条件で止まったときの共通の確かめ: トーストが 1 枚、状態もプロバイダの呼び出しも無い */
  async function expectRejected(view: EditorView, toast: string): Promise<void> {
    const states: (number | null)[] = [];
    const unsubscribe = useIllustrationStore.subscribe((s) => states.push(s.startedAt));
    expect(requestIllustration(view)).toBe(true);
    await flushMicrotasks();
    unsubscribe();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(toast);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(isGenerating()).toBe(false);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(vi.mocked(buildIllustrationContext)).not.toHaveBeenCalled();
    expect(mocks.appendToMemo).not.toHaveBeenCalled();
  }

  it("1. 情景文の生成中なら、生成中であることを伝え、2 本目を始めない(5.5)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    const startedAt = useIllustrationStore.getState().startedAt;
    expect(startedAt).not.toBeNull();
    vi.clearAllMocks();

    expect(requestIllustration(view)).toBe(true);
    await flushMicrotasks();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith("情景文を生成中です");
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(stream.generateStream).toHaveBeenCalledTimes(0);
    expect(useIllustrationStore.getState().startedAt).toBe(startedAt);

    // 1 本目はそのまま続き、正常に終わる
    await stream.send("橋の中央に少女が立つ。", "stop");
    await stream.end();
    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
  });

  it("2. 提案の生成中なら、提案を生成中であることを伝える(5.7)", async () => {
    const { view } = setup();
    useSuggestionStore.getState().setGenerating(true);
    await expectRejected(view, "続きの提案を生成中です。終わってからもう一度押してください");
  });

  it("3. 設定が無い(プロジェクトが開かれていない)なら、プロジェクトを開くよう伝える", async () => {
    const { view } = setup();
    mocks.getActiveConfig.mockReturnValue(null);
    await expectRejected(view, "プロジェクトを開いてください");
  });

  it("4. OpenAI 互換プロバイダでなければ、使えないことを伝える(7.1)", async () => {
    const { view } = setup({ config: testConfig({ provider: "openai" }) });
    await expectRejected(
      view,
      "挿し絵の情景文は、ローカルのプロバイダ(OpenAI 互換・llama.cpp)でだけ使えます",
    );
  });

  describe("5. 挿し絵用の設定の不備(7.2)", () => {
    const TEMPLATE_MISSING_TOAST =
      "挿し絵用のテンプレートが決まりません。AI 設定画面でプロンプトテンプレートのプリセットを選ぶか、sumire.json の illustration.template にプリセットか自由記述を書いてください";
    const cases: { title: string; illustration: unknown; template?: unknown; toast: string }[] = [
      {
        title: "illustration が無く、続き生成のテンプレートも指定なし",
        illustration: undefined,
        template: undefined,
        toast: TEMPLATE_MISSING_TOAST,
      },
      {
        title: "illustration.template が無く、続き生成のテンプレートも指定なし",
        illustration: { temperature: 0.5 },
        template: undefined,
        toast: TEMPLATE_MISSING_TOAST,
      },
      {
        title: "illustration が無く、続き生成のテンプレートが自由記述",
        illustration: undefined,
        template: { custom: "{{system}}{{settings}}{{body}}" },
        toast: TEMPLATE_MISSING_TOAST,
      },
      {
        title: "illustration がオブジェクトでない",
        illustration: "gemma4-think",
        toast:
          "挿し絵用の設定を読めません。sumire.json の illustration はオブジェクトで書いてください",
      },
      {
        title: "テンプレートの指定が読めない(preset と custom の両方)",
        illustration: { template: { preset: "gemma4-think", custom: "{{body}}" } },
        toast:
          "挿し絵用のテンプレートの指定を読めません。sumire.json の illustration.template には preset か custom のどちらか一方を書いてください",
      },
      {
        title: "未知のプリセット名",
        illustration: { template: { preset: "gemma5" } },
        toast:
          "挿し絵用のテンプレートのプリセット「gemma5」はありません。使えるのは gemma4 / gemma4-think / chatml / chatml-nothink です",
      },
      {
        title: "本文の差し込み口が無い",
        illustration: { template: { custom: "<s>{{system}}\n" } },
        toast: "挿し絵用のテンプレートに本文の差し込み口 {{body}} がありません",
      },
      {
        title: "差し込み口が重複している",
        illustration: { template: { custom: ["{{system}}", "{{system}}", "{{body}}"] } },
        toast: "挿し絵用のテンプレートに差し込み口 {{system}} が 2 つ以上あります",
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.title}なら、直し方を伝える`, async () => {
        const config = testConfig({
          illustration: testCase.illustration,
          ...("template" in testCase ? { template: testCase.template } : {}),
        });
        const { view } = setup({ config });
        await expectRejected(view, testCase.toast);
      });
    }
  });

  it("6. 場面が無い(選択が無く、カーソル行が空)なら、場面を選ぶよう伝える(1.3)", async () => {
    const doc = `${DOC}\n\n次の段落。`;
    const emptyLine = doc.indexOf("\n\n") + 1;
    const { view } = setup({ doc, cursor: emptyLine });
    await expectRejected(
      view,
      "挿し絵にする場面を選択するか、場面の行にカーソルを置いてください",
    );
  });

  it("条件は上から順に確かめる(提案の生成中は、設定の不備より先に伝える)", async () => {
    const { view } = setup({
      config: testConfig({ illustration: undefined, template: undefined }),
      cursor: 0,
    });
    useSuggestionStore.getState().setGenerating(true);
    await expectRejected(view, "続きの提案を生成中です。終わってからもう一度押してください");
  });
});

// ---------------------------------------------------------------------------
// 正常に終わったとき
// ---------------------------------------------------------------------------

describe("正常に終わったとき(4.1〜4.4, 1.4)", () => {
  it("思考を除いた情景文を、出所の行つきで 1 件だけメモに追記し、info のトーストを出す", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    expect(isGenerating()).toBe(true);

    await stream.send("<think>場面を整理する。");
    await stream.send("位置関係を考える。</think>");
    await stream.send("雨の降りしきる中、");
    await stream.send("崩れかけた橋の中央に少女が立ち止まっている。\n", "stop");
    await stream.end();

    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
    const entry = mocks.appendToMemo.mock.calls[0][0];
    expect(entry).toBe(
      `〔挿し絵〕${CHAPTER}「${SCENE_LINE}」\n雨の降りしきる中、崩れかけた橋の中央に少女が立ち止まっている。`,
    );
    expect(entry).not.toContain("場面を整理する");
    expect(entry).not.toContain("<think>");
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith("情景文をメモに追加しました");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(isGenerating()).toBe(false);
  });

  it("追記してからトーストを出し、トーストのあとで状態を戻す", async () => {
    const { view, stream } = setup();
    const startedDuringToast: boolean[] = [];
    mocks.toastInfo.mockImplementation(() => {
      startedDuringToast.push(isGenerating());
    });
    await startIllustration(view, stream);
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();

    expect(mocks.appendToMemo.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.toastInfo.mock.invocationCallOrder[0],
    );
    expect(startedDuringToast).toEqual([true]);
    expect(isGenerating()).toBe(false);
  });

  it("本文・カーソルを変えず、生成のあいだ本文にトランザクションを送らない(1.4)", async () => {
    let transactions = 0;
    const stream = createControlledStream();
    mocks.getActiveConfig.mockReturnValue(testConfig());
    mocks.getProvider.mockReturnValue(stream.provider);
    const { view } = mountSuggestionEditor({
      doc: DOC,
      cursor: CURSOR_IN_SCENE,
      extensions: [
        EditorView.updateListener.of((update) => {
          transactions += update.transactions.length;
        }),
      ],
    });

    await startIllustration(view, stream);
    await stream.send("<think>考える。</think>橋の上に少女が立つ。", "stop");
    await stream.end();

    expect(transactions).toBe(0);
    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.state.selection.main.anchor).toBe(CURSOR_IN_SCENE);
    expect(view.state.selection.main.head).toBe(CURSOR_IN_SCENE);
    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
  });

  it("選択範囲を場面にしたときも、選択範囲を変えない(1.1, 1.4)", async () => {
    const { view, stream } = setup();
    const from = DOC.indexOf("崩れかけた");
    const to = from + "崩れかけた橋".length;
    view.dispatch({ selection: { anchor: to, head: from } });

    await startIllustration(view, stream);
    expect(stream.requests[0].body).toContain("【挿し絵にする場面】\n崩れかけた橋");
    await stream.send("橋が崩れかけている。", "stop");
    await stream.end();

    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.state.selection.main.anchor).toBe(to);
    expect(view.state.selection.main.head).toBe(from);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(
      `〔挿し絵〕${CHAPTER}「崩れかけた橋」\n橋が崩れかけている。`,
    );
  });

  it("章が選ばれていなければ、章名を空にして追記する", async () => {
    useAppStore.setState({ selectedChapter: null });
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();

    expect(mocks.appendToMemo).toHaveBeenCalledWith(
      `〔挿し絵〕「${SCENE_LINE}」\n橋の上に少女が立つ。`,
    );
  });
});

// ---------------------------------------------------------------------------
// 送るリクエスト
// ---------------------------------------------------------------------------

describe("送るリクエスト(6.1, 6.2)", () => {
  it("挿し絵用のプリセットで包み、温度・最大トークン・タイムアウトは挿し絵用、topP・extras は続き生成の値", async () => {
    const config = testConfig({
      illustration: {
        template: { preset: "gemma4-think" },
        temperature: 0.3,
        maxTokens: 1000,
        timeoutMs: 90000,
      },
    });
    const { view, stream } = setup({ config });
    await startIllustration(view, stream);

    expect(stream.generateStream).toHaveBeenCalledTimes(1);
    const request = stream.requests[0];
    const expectedTemplate = illustrationTemplate({ preset: "gemma4-think" });
    expect(request.promptTemplate).toEqual(expectedTemplate);
    // 続き生成の表の同名プリセットではない
    expect(PROMPT_TEMPLATE_PRESETS["gemma4-think"]).not.toBe(
      ILLUSTRATION_TEMPLATE_PRESETS["gemma4-think"],
    );
    expect(request.systemPrompt).toBe(DEFAULT_ILLUSTRATION_INSTRUCTION);
    expect(request.contextSections).toEqual([]);
    expect(request.body).toBe(
      [
        "【場面より前の本文】",
        "雨脚が強まる。",
        "",
        "【挿し絵にする場面】",
        SCENE_LINE,
        "",
        "【場面より後の本文】",
        "遠くで雷が鳴った。",
      ].join("\n"),
    );
    expect(request.parameters).toEqual({
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 1000,
      extras: { top_k: 20 },
    });

    // 接続先・モデル・思考の設定は続き生成と共通で、タイムアウトだけ挿し絵用(6.1)
    const providerConfigs = generationProviderConfigs(stream);
    expect(providerConfigs).toHaveLength(1);
    expect(providerConfigs[0]).toEqual({ ...config, timeoutMs: 90000 });
    // 渡した設定そのものは書き換えない
    expect(config.timeoutMs).toBe(60000);
    expect(config.parameters).toEqual({
      temperature: 0.8,
      topP: 0.9,
      maxTokens: 200,
      extras: { top_k: 20 },
    });

    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
  });

  it("挿し絵用の値を省いたら既定値(温度 0.7、最大トークン 4096、タイムアウト 180000)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);

    expect(stream.requests[0].parameters).toEqual({
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      extras: { top_k: 20 },
    });
    expect(generationProviderConfigs(stream)[0].timeoutMs).toBe(180000);

    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
  });

  it("illustration.template が無ければ、続き生成のテンプレートと同じ名前の挿し絵用のプリセットで包む", async () => {
    const config = testConfig({ illustration: undefined, template: { preset: "chatml-nothink" } });
    const { view, stream } = setup({ config });
    await startIllustration(view, stream);

    expect(stream.requests[0].promptTemplate).toEqual(
      illustrationTemplate({ preset: "chatml-nothink" }),
    );
    // 挿し絵用のほかの値は既定値
    expect(stream.requests[0].systemPrompt).toBe(DEFAULT_ILLUSTRATION_INSTRUCTION);
    expect(stream.requests[0].parameters.maxTokens).toBe(4096);

    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
  });

  it("指示文を上書きしたら、それを systemPrompt にする(3.6)", async () => {
    const config = testConfig({
      illustration: { template: { preset: "chatml" }, instruction: ["一行目", "二行目"] },
    });
    const { view, stream } = setup({ config });
    await startIllustration(view, stream);

    expect(stream.requests[0].systemPrompt).toBe("一行目\n二行目");
    expect(stream.requests[0].promptTemplate).toEqual(illustrationTemplate({ preset: "chatml" }));

    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
  });
});

// ---------------------------------------------------------------------------
// 生成中の操作
// ---------------------------------------------------------------------------

describe("生成中の入力・カーソル移動・章の切り替え(4.5, 5.2)", () => {
  it("入力・カーソル移動・章の切り替えでは止まらず、開始時の章名で追記する", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考える。</think>");

    // 本文に書き足し、カーソルを動かす
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\n書き足した行。" },
      selection: { anchor: view.state.doc.length + "\n書き足した行。".length },
      userEvent: "input.type",
    });
    view.dispatch({ selection: { anchor: 0 }, userEvent: "select" });
    // 別の章に切り替える
    useAppStore.setState({
      selectedChapter: {
        category: "chapters",
        relativePath: "chapters/04_晴れ間.md",
        name: "04_晴れ間.md",
      },
    });
    await flushMicrotasks();
    expect(isGenerating()).toBe(true);
    expect(stream.isWaiting()).toBe(true);

    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();

    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(
      `〔挿し絵〕${CHAPTER}「${SCENE_LINE}」\n橋の上に少女が立つ。`,
    );
    expect(mocks.toastInfo).toHaveBeenCalledWith("情景文をメモに追加しました");
  });
});

// ---------------------------------------------------------------------------
// 文脈の組み立ての結果
// ---------------------------------------------------------------------------

describe("文脈の組み立ての結果(2.5, 2.6)", () => {
  it("場面がコンテキストに収まらなければ、トーストを出して状態を戻し、送信しない(2.5)", async () => {
    // 窓 100 に既定の最大トークン 4096 は収まらない
    const { view, stream } = setup({ config: testConfig({ contextWindow: 100 }) });
    const states: (number | null)[] = [];
    const unsubscribe = useIllustrationStore.subscribe((s) => states.push(s.startedAt));

    expect(requestIllustration(view)).toBe(true);
    await waitUntil(() => mocks.toastError.mock.calls.length > 0, "場面が長すぎるトースト");
    await flushMicrotasks();
    unsubscribe();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "場面がコンテキストに収まりません。場面を短くするか、contextWindow か挿し絵用の maxTokens を見直してください",
    );
    // 開始時に状態を作り、判定のあとで戻している
    expect(states).toHaveLength(2);
    expect(states[0]).not.toBeNull();
    expect(states[1]).toBeNull();
    expect(stream.generateStream).not.toHaveBeenCalled();
    expect(mocks.appendToMemo).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();

    // 状態が戻っているので、もう一度始められる
    mocks.getActiveConfig.mockReturnValue(testConfig());
    await startIllustration(view, stream);
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
  });

  it("設定を外したら、送信の前に info のトーストで外した名前を伝え、そのまま生成する(2.6)", async () => {
    const { view, stream } = setup();
    vi.mocked(buildIllustrationContext).mockResolvedValueOnce({
      kind: "ok",
      systemPrompt: DEFAULT_ILLUSTRATION_INSTRUCTION,
      body: `【挿し絵にする場面】\n${SCENE_LINE}`,
      droppedSettings: ["キャラ設定: リナ", "世界観: 王都"],
    });

    await startIllustration(view, stream);

    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "コンテキストに収まらない設定を外しました: キャラ設定: リナ、世界観: 王都",
    );
    expect(mocks.toastInfo.mock.invocationCallOrder[0]).toBeLessThan(
      stream.generateStream.mock.invocationCallOrder[0],
    );
    expect(stream.requests[0].body).toBe(`【挿し絵にする場面】\n${SCENE_LINE}`);

    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenLastCalledWith("情景文をメモに追加しました");
  });

  it("設定を外していなければ、外したトーストは出さない", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
  });
});

// ---------------------------------------------------------------------------
// 正常以外の終わり方(追記しないことと、状態を戻すことだけを確かめる)
// ---------------------------------------------------------------------------

describe("正常以外の終わり方では追記せず、状態を戻す(4.3, 7.6)", () => {
  it("思考だけの応答(思考を除いた本文が空)なら追記しない", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考えただけ。</think>\n", "stop");
    await stream.end();

    expect(mocks.appendToMemo).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(isGenerating()).toBe(false);
  });

  it("思考が終わらないまま応答が終わったら、思考前の本文があっても追記しない", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("前置き。<think>考え続ける", "length");
    await stream.end();

    expect(mocks.appendToMemo).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(isGenerating()).toBe(false);
  });

  it("ストリームが失敗したら追記せず、状態を戻し、もう一度始められる", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("途中まで。");
    await stream.fail(new ProviderError("network", "接続できない"));

    expect(mocks.appendToMemo).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(isGenerating()).toBe(false);

    const retry = createControlledStream();
    mocks.getProvider.mockReturnValue(retry.provider);
    await startIllustration(view, retry);
    await retry.send("橋の上に少女が立つ。", "stop");
    await retry.end();
    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// task 3.2: 終わり方の表の残りの行
// ---------------------------------------------------------------------------

/** 正常に追記したときのエントリ */
const APPENDED_ENTRY = `〔挿し絵〕${CHAPTER}「${SCENE_LINE}」\n橋の上に少女が立つ。`;

/** 終わったあと、同じ場面でもう一度始められ、正常に追記まで進むことを確かめる(7.6) */
async function expectRestartable(view: EditorView): Promise<void> {
  expect(isGenerating()).toBe(false);
  mocks.appendToMemo.mockResolvedValue(undefined);
  const appendedBefore = mocks.appendToMemo.mock.calls.length;
  const retry = createControlledStream();
  mocks.getProvider.mockReturnValue(retry.provider);
  await startIllustration(view, retry);
  await retry.send("橋の上に少女が立つ。", "stop");
  await retry.end();
  expect(mocks.appendToMemo).toHaveBeenCalledTimes(appendedBefore + 1);
  expect(mocks.appendToMemo).toHaveBeenLastCalledWith(APPENDED_ENTRY);
}

/** error のトーストが 1 枚だけ出て、info のトーストも追記も無いことを確かめる */
function expectErrorToastOnly(message: string): void {
  expect(mocks.toastError).toHaveBeenCalledTimes(1);
  expect(mocks.toastError).toHaveBeenCalledWith(message);
  expect(mocks.toastInfo).not.toHaveBeenCalled();
  expect(mocks.appendToMemo).not.toHaveBeenCalled();
}

/** トーストも追記も無いことを確かめる(中止) */
function expectSilent(): void {
  expect(mocks.toastError).not.toHaveBeenCalled();
  expect(mocks.toastInfo).not.toHaveBeenCalled();
  expect(mocks.appendToMemo).not.toHaveBeenCalled();
}

/** 解決を手で決められる Promise */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `ignoreAbort` のストリームを返すプロバイダでエディタを用意する */
function setupIgnoringAbort(): { view: EditorView; stream: ControlledStream } {
  const stream = createControlledStream({ ignoreAbort: true });
  mocks.getActiveConfig.mockReturnValue(testConfig());
  mocks.getProvider.mockReturnValue(stream.provider);
  const { view } = mountSuggestionEditor({ doc: DOC, cursor: CURSOR_IN_SCENE });
  return { view, stream };
}

describe("思考が終わらない・空・上限での途切れ(7.3, 7.4, 7.7)", () => {
  it("思考の途中で上限に達したら、maxTokens を増やすよう伝え、思考前の本文があっても追記しない(7.4)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("前置き。<think>考え続ける", "length");
    await stream.end();

    expectErrorToastOnly(
      "思考の途中で生成の上限に達しました。挿し絵用の maxTokens を増やしてください",
    );
    await expectRestartable(view);
  });

  it("思考の途中の上限は、終了理由が本文の空なチャンクで届いても見分ける(7.4)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考え続ける");
    await stream.send("", "length");
    await stream.end();

    expectErrorToastOnly(
      "思考の途中で生成の上限に達しました。挿し絵用の maxTokens を増やしてください",
    );
    await expectRestartable(view);
  });

  it("上限以外で思考が終わらないまま応答が終わったら、その旨を伝えて追記しない(7.4)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考え続ける", "stop");
    await stream.end();

    expectErrorToastOnly("思考が終わらないまま応答が終わりました");
    await expectRestartable(view);
  });

  it("終了理由が届かないまま思考の途中で終わっても、上限以外として伝える(7.4)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考え続ける");
    await stream.end();

    expectErrorToastOnly("思考が終わらないまま応答が終わりました");
  });

  it("思考を除いた本文が空白だけなら、取得できなかったことを伝えて追記しない(7.3)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考えただけ。</think>\n 　\n", "stop");
    await stream.end();

    expectErrorToastOnly("情景文を取得できませんでした(応答が空です)");
    await expectRestartable(view);
  });

  it("応答に何も無ければ、取得できなかったことを伝える(7.3)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.end();

    expectErrorToastOnly("情景文を取得できませんでした(応答が空です)");
  });

  it("思考のあと情景文の途中で上限に達したら、注記つきで追記し、途切れのトーストだけを出す(7.7)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考える。</think>");
    await stream.send("雨の中、橋の上に少女が");
    // 終了理由は本文の空なチャンクで届く
    await stream.send("", "length");
    await stream.end();

    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(
      `〔挿し絵〕${CHAPTER}「${SCENE_LINE}」\n雨の中、橋の上に少女が\n${ILLUSTRATION_TRUNCATED_NOTE}`,
    );
    // 「追加しました」と 2 枚重ねない
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "情景文をメモに追加しましたが、生成の上限で途切れています。挿し絵用の maxTokens を増やしてください",
    );
    // 追記してからトーストを出す
    expect(mocks.appendToMemo.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.toastError.mock.invocationCallOrder[0],
    );
    await expectRestartable(view);
  });
});

describe("接続やリクエストの失敗(7.5)", () => {
  const providerCases: { kind: ProviderError["kind"]; message: string; toast: string }[] = [
    { kind: "network", message: "fetch failed", toast: "推論サーバーに接続できません" },
    { kind: "timeout", message: "timed out", toast: "応答がタイムアウトしました" },
    {
      kind: "http",
      message: "500 Internal Server Error",
      toast: "推論サーバーがエラーを返しました: 500 Internal Server Error",
    },
    { kind: "parse", message: "bad json", toast: "推論サーバーの応答を解析できませんでした" },
    { kind: "config", message: "endpoint が空です", toast: "endpoint が空です" },
    // 続き生成では黙る分類も、情景文では失敗を伝える(design.md「errorMessage」)
    { kind: "auth", message: "認証できない", toast: "情景文の生成に失敗しました: 認証できない" },
    {
      kind: "rateLimit",
      message: "回数の上限",
      toast: "情景文の生成に失敗しました: 回数の上限",
    },
  ];

  for (const testCase of providerCases) {
    it(`ProviderError(${testCase.kind})は続き生成と同じ分類の文言で伝え、追記しない`, async () => {
      const { view, stream } = setup();
      await startIllustration(view, stream);
      await stream.send("<think>考える。</think>途中まで。");
      await stream.fail(new ProviderError(testCase.kind, testCase.message));

      expectErrorToastOnly(testCase.toast);
      await expectRestartable(view);
    });
  }

  it("ProviderError でない例外は、失敗の文言に例外を添えて伝える", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.fail(new Error("想定外"));

    expectErrorToastOnly("情景文の生成に失敗しました: Error: 想定外");
    await expectRestartable(view);
  });

  it("文脈の組み立て(トークン計測)で失敗しても、同じ分類で伝え、送信しない", async () => {
    const { view, stream } = setup();
    vi.mocked(buildIllustrationContext).mockRejectedValueOnce(
      new ProviderError("network", "fetch failed"),
    );

    expect(requestIllustration(view)).toBe(true);
    await waitUntil(() => !isGenerating(), "失敗での生成の終了");
    await flushMicrotasks();

    expectErrorToastOnly("推論サーバーに接続できません");
    expect(stream.generateStream).not.toHaveBeenCalled();
    await expectRestartable(view);
  });

  it("メモへの書き込みが失敗したら、失敗の文言で伝え、追加したトーストは出さない", async () => {
    const { view, stream } = setup();
    mocks.appendToMemo.mockRejectedValueOnce(new Error("書き込めない"));
    await startIllustration(view, stream);
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();

    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "情景文の生成に失敗しました: Error: 書き込めない",
    );
    await expectRestartable(view);
  });
});

describe("中止(stopIllustration、5.3)", () => {
  it("生成中でなければ何もせず false を返す(キーを下に流す)", async () => {
    const { view } = setup();
    expect(stopIllustration(view)).toBe(false);
    await flushMicrotasks();
    expectSilent();
    expect(isGenerating()).toBe(false);
  });

  it("生成中なら中止して true を返し、追記もトーストもせずに状態を戻す", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考える。</think>橋の上に");

    expect(stopIllustration(view)).toBe(true);
    const signal = stream.generateStream.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(true);
    await waitUntil(() => !isGenerating(), "中止での生成の終了");
    await flushMicrotasks();

    expectSilent();
    await expectRestartable(view);
  });

  it("中止したあとは、もう一度押しても false を返す(二重に中止しない)", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    expect(stopIllustration(view)).toBe(true);
    expect(stopIllustration(view)).toBe(false);
    await waitUntil(() => !isGenerating(), "中止での生成の終了");
    expectSilent();
  });

  it("中止のあとに本文と終了理由が届いても、追記もトーストもしない", async () => {
    const { view, stream } = setupIgnoringAbort();
    await startIllustration(view, stream);

    expect(stopIllustration(view)).toBe(true);
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();

    expectSilent();
    await expectRestartable(view);
  });

  it("中止のあとに例外が届いても、トーストを出さない", async () => {
    const { view, stream } = setupIgnoringAbort();
    await startIllustration(view, stream);

    expect(stopIllustration(view)).toBe(true);
    await stream.fail(new ProviderError("network", "fetch failed"));

    expectSilent();
    await expectRestartable(view);
  });

  it("文脈の組み立て中に中止したら、送信せず、外した設定のトーストも出さない", async () => {
    const { view, stream } = setup();
    const built = deferred<Awaited<ReturnType<typeof buildIllustrationContext>>>();
    vi.mocked(buildIllustrationContext).mockReturnValueOnce(built.promise);

    expect(requestIllustration(view)).toBe(true);
    expect(isGenerating()).toBe(true);
    expect(stopIllustration(view)).toBe(true);
    built.resolve({
      kind: "ok",
      systemPrompt: DEFAULT_ILLUSTRATION_INSTRUCTION,
      body: `【挿し絵にする場面】\n${SCENE_LINE}`,
      droppedSettings: ["キャラ設定: リナ"],
    });
    await waitUntil(() => !isGenerating(), "中止での生成の終了");
    await flushMicrotasks();

    expectSilent();
    expect(stream.generateStream).not.toHaveBeenCalled();
    await expectRestartable(view);
  });
});

describe("プロジェクトの変更(5.8)", () => {
  it("別のプロジェクトに切り替わったら中止し、追記もトーストもしない", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考える。</think>");

    useAppStore.setState({ currentProject: { path: "/projects/another", title: "別の小説" } });
    const signal = stream.generateStream.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(true);
    await waitUntil(() => !isGenerating(), "プロジェクトの変更での中止");
    await flushMicrotasks();

    expectSilent();
    // 切り替えた先のプロジェクトで、もう一度始められる
    await expectRestartable(view);
  });

  it("プロジェクトを閉じたら中止し、追記もトーストもしない", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);

    useAppStore.setState({ currentProject: null, selectedChapter: null });
    await waitUntil(() => !isGenerating(), "プロジェクトを閉じたことでの中止");
    await flushMicrotasks();

    expectSilent();
  });

  it("プロジェクトが変わったあとに本文が届いても、追記しない", async () => {
    const { view, stream } = setupIgnoringAbort();
    await startIllustration(view, stream);

    useAppStore.setState({ currentProject: { path: "/projects/another", title: "別の小説" } });
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();

    expectSilent();
  });

  it("パスが同じなら、プロジェクトの情報が置き換わっても止まらない", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);

    useAppStore.setState({ currentProject: { path: PROJECT_PATH, title: "改題した小説" } });
    await flushMicrotasks();
    expect(isGenerating()).toBe(true);
    expect(stream.isWaiting()).toBe(true);

    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
    expect(mocks.appendToMemo).toHaveBeenCalledWith(APPENDED_ENTRY);
  });

  it("どの終わり方でも、プロジェクトの購読を解く", async () => {
    const original = useAppStore.subscribe;
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    const spy = vi.spyOn(useAppStore, "subscribe").mockImplementation((listener) => {
      const unsubscribe = vi.fn(original(listener));
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    });
    try {
      const { view, stream } = setup();
      // 正常
      await startIllustration(view, stream);
      expect(unsubscribes).toHaveLength(1);
      await stream.send("橋の上に少女が立つ。", "stop");
      await stream.end();
      expect(unsubscribes[0]).toHaveBeenCalledTimes(1);

      // 失敗
      const failing = createControlledStream();
      mocks.getProvider.mockReturnValue(failing.provider);
      await startIllustration(view, failing);
      expect(unsubscribes).toHaveLength(2);
      await failing.fail(new ProviderError("network", "fetch failed"));
      expect(unsubscribes[1]).toHaveBeenCalledTimes(1);

      // 中止
      const stopped = createControlledStream();
      mocks.getProvider.mockReturnValue(stopped.provider);
      await startIllustration(view, stopped);
      expect(unsubscribes).toHaveLength(3);
      stopIllustration(view);
      await waitUntil(() => !isGenerating(), "中止での生成の終了");
      expect(unsubscribes[2]).toHaveBeenCalledTimes(1);

      // 場面が長すぎる
      mocks.getActiveConfig.mockReturnValue(testConfig({ contextWindow: 100 }));
      expect(requestIllustration(view)).toBe(true);
      await waitUntil(() => !isGenerating(), "場面が長すぎるときの終了");
      expect(mocks.toastError).toHaveBeenLastCalledWith(
        "場面がコンテキストに収まりません。場面を短くするか、contextWindow か挿し絵用の maxTokens を見直してください",
      );
      expect(unsubscribes).toHaveLength(4);
      expect(unsubscribes[3]).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("dev ログ(design.md「State Management」)", () => {
  function illustrationEvents(): { event: string; payload: Record<string, unknown> }[] {
    return mocks.emitDevEvent.mock.calls
      .filter(([event]) => event.startsWith("illustration."))
      .map(([event, payload]) => ({ event, payload: payload ?? {} }));
  }

  /** 文字列で持ってよい項目。それ以外の項目は数値か null で、テキストを持たない */
  const STRING_KEYS = ["template", "outcome", "finishReason", "errorKind"];

  /** 本文・場面・情景文・思考・指示文・エラーの本文が payload に入っていない */
  function expectNoText(): void {
    const events = illustrationEvents();
    const serialized = JSON.stringify(events);
    for (const fragment of [
      "リナ",
      "雨脚",
      "雷",
      "少女",
      "橋の上",
      "考える",
      "整理する",
      "途中",
      "<think>",
      "挿し絵づくり",
      "秘密の応答",
    ]) {
      expect(serialized).not.toContain(fragment);
    }
    for (const { payload } of events) {
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "string") expect(STRING_KEYS).toContain(key);
        else expect(value === null || typeof value === "number").toBe(true);
      }
    }
  }

  /** 終了のイベントの文字数の内訳(UTF-16 の単位で数える) */
  function charCounts(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      responseChars: payload.responseChars,
      textChars: payload.textChars,
      thinkingChars: payload.thinkingChars,
    };
  }

  it("開始と終了を出し、テンプレートの出典・終わり方・終了理由・所要ミリ秒を入れる", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    expect(illustrationEvents()).toEqual([
      { event: "illustration.start", payload: { template: "gemma4-think" } },
    ]);
    await stream.send("<think>考える。</think>橋の上に少女が立つ。", "stop");
    await stream.end();

    const events = illustrationEvents();
    expect(events.map((e) => e.event)).toEqual(["illustration.start", "illustration.end"]);
    expect(events[1].payload).toMatchObject({
      template: "gemma4-think",
      outcome: "appended",
      finishReason: "stop",
    });
    expect(typeof events[1].payload.durationMs).toBe("number");
    expect(events[1].payload.durationMs as number).toBeGreaterThanOrEqual(0);
    expectNoText();
  });

  it("文字数の内訳(応答の総文字数、思考を除いた情景文の文字数、その差)を数値で入れる", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    // 複数のチャンクに分かれた応答と、本文が空で終了理由だけのチャンク
    const chunks = ["<think>場面を", "整理する。</think>", "橋の上に少女が立つ。"];
    for (const chunk of chunks) await stream.send(chunk);
    await stream.send("", "stop");
    await stream.end();

    const responseChars = chunks.join("").length;
    const textChars = "橋の上に少女が立つ。".length;
    const payload = illustrationEvents()[1].payload;
    expect(payload).toMatchObject({ outcome: "appended" });
    expect(charCounts(payload)).toEqual({
      responseChars,
      textChars,
      thinkingChars: responseChars - textChars,
    });
    expect(payload.thinkingChars as number).toBeGreaterThan(0);
    expectNoText();
  });

  it("思考の分離が無効なら、思考などの文字数は 0 になる", async () => {
    const config: AIConfig = { ...testConfig(), thinking: { enabled: false } };
    const { view, stream } = setup({ config });
    await startIllustration(view, stream);
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();

    const length = "橋の上に少女が立つ。".length;
    const payload = illustrationEvents()[1].payload;
    expect(payload).toMatchObject({ outcome: "appended" });
    expect(charCounts(payload)).toEqual({
      responseChars: length,
      textChars: length,
      thinkingChars: 0,
    });
    expectNoText();
  });

  it("思考が終わらないまま上限に達したら、情景文は 0 文字、残りはすべて思考などとして数える", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    const response = "<think>考える。考える。";
    await stream.send(response, "length");
    await stream.end();

    const payload = illustrationEvents()[1].payload;
    expect(payload).toMatchObject({ outcome: "thinkingMaxTokens" });
    expect(charCounts(payload)).toEqual({
      responseChars: response.length,
      textChars: 0,
      thinkingChars: response.length,
    });
    expectNoText();
  });

  it("場面がコンテキストに収まらず送信しなかったら、応答は 0 文字、内訳は未受信の null", async () => {
    const { view } = setup({ config: testConfig({ contextWindow: 100 }) });
    expect(requestIllustration(view)).toBe(true);
    await waitUntil(() => illustrationEvents().length === 2, "終了の dev ログ");

    const payload = illustrationEvents()[1].payload;
    expect(payload).toMatchObject({ outcome: "sceneTooLong" });
    expect(charCounts(payload)).toEqual({ responseChars: 0, textChars: null, thinkingChars: null });
    expectNoText();
  });

  it("自由記述のテンプレートは custom として出す。途切れも終わり方として出す", async () => {
    const config = testConfig({ illustration: { template: { custom: "{{system}}\n{{body}}\n" } } });
    const { view, stream } = setup({ config });
    await startIllustration(view, stream);
    await stream.send("橋の上に少女が", "length");
    await stream.end();

    const events = illustrationEvents();
    expect(events[0].payload).toEqual({ template: "custom" });
    expect(events[1]).toMatchObject({
      event: "illustration.end",
      payload: { template: "custom", outcome: "truncated", finishReason: "length" },
    });
    expectNoText();
  });

  it("失敗は error として出し、エラーの分類だけを入れる", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    await stream.send("<think>考える。</think>途中。");
    await stream.fail(new ProviderError("http", "500 秘密の応答"));

    const events = illustrationEvents();
    expect(events.map((e) => e.event)).toEqual(["illustration.start", "illustration.error"]);
    expect(events[1].payload).toMatchObject({
      template: "gemma4-think",
      outcome: "failed",
      errorKind: "http",
    });
    expect(typeof events[1].payload.durationMs).toBe("number");
    // 応答は途中まで受け取ったが、思考の分離を終えていないので内訳は null
    expect(charCounts(events[1].payload)).toEqual({
      responseChars: "<think>考える。</think>途中。".length,
      textChars: null,
      thinkingChars: null,
    });
    expectNoText();
  });

  it("中止は終わり方 aborted の終了として出す", async () => {
    const { view, stream } = setup();
    await startIllustration(view, stream);
    stopIllustration(view);
    await waitUntil(() => !isGenerating(), "中止での生成の終了");

    const events = illustrationEvents();
    expect(events.map((e) => e.event)).toEqual(["illustration.start", "illustration.end"]);
    expect(events[1].payload).toMatchObject({ outcome: "aborted" });
    // 応答を受け取る前に中止した。このストリームは中止で静かに終わるので、思考の分離は
    // 空のまま終えている(例外で終わるアダプタなら内訳は null になる。失敗のテストを参照)
    expect(charCounts(events[1].payload)).toEqual({
      responseChars: 0,
      textChars: 0,
      thinkingChars: 0,
    });
    expectNoText();
  });
});

// ---------------------------------------------------------------------------
// llama-server-provider task 4.2: llama-server で動かす
// ---------------------------------------------------------------------------

describe("llama-server で動かす(llama-server-provider 3.4, 4.2, 6.6, 8.4, 8.5)", () => {
  const RUN_ID = 3;
  const READY_STATUS = {
    state: "ready",
    runId: RUN_ID,
    modelPath: "C:\\models\\gemma-4.gguf",
    contextSize: 16384,
    port: 51234,
  } as const;
  const UNSUPPORTED_TOAST = "挿し絵の情景文は、ローカルのプロバイダ(OpenAI 互換・llama.cpp)でだけ使えます";

  /** `sumire.json` の `llama-server` のセクション(接続先・モデル名は空のまま) */
  function sectionConfig(): AIConfig {
    return { ...testConfig({ provider: "llama-server" }), endpoint: "", model: "" };
  }

  /** 関門が返す実効の設定(起動した llama-server の接続先・モデル名・コンテキスト長) */
  function effectiveConfig(section: AIConfig): AIConfig {
    return {
      ...section,
      endpoint: "http://127.0.0.1:51234/v1",
      model: "gemma-4.gguf",
      contextWindow: 16384,
    };
  }

  /** 準備完了の llama-server と、関門が実効の設定を返す状態でエディタを用意する */
  function setupReady(
    options: { ignoreAbort?: boolean; section?: AIConfig; doc?: string; cursor?: number } = {},
  ): { view: EditorView; stream: ControlledStream; section: AIConfig; effective: AIConfig } {
    const section = options.section ?? sectionConfig();
    const effective = effectiveConfig(section);
    const stream = createControlledStream({ ignoreAbort: options.ignoreAbort });
    mocks.getActiveConfig.mockReturnValue(section);
    mocks.getProvider.mockReturnValue(stream.provider);
    useLlamaServerStore.setState({ status: READY_STATUS, actualContextSize: 16384 });
    vi.mocked(prepareLlamaServerConfig).mockReturnValue({ kind: "ready", config: effective });
    const { view } = mountSuggestionEditor({
      doc: options.doc ?? DOC,
      cursor: options.cursor ?? CURSOR_IN_SCENE,
    });
    return { view, stream, section, effective };
  }

  afterEach(async () => {
    // 差し替えた戻り値を次のテストに持ち越さない(本物の関門に戻す)
    const actual = await vi.importActual<typeof import("@/stores/llamaServerStore")>(
      "@/stores/llamaServerStore",
    );
    vi.mocked(prepareLlamaServerConfig).mockReset();
    vi.mocked(prepareLlamaServerConfig).mockImplementation(actual.prepareLlamaServerConfig);
  });

  it("準備完了なら、関門が返した実効の設定で文脈を組み立てて生成し、メモに追記する(8.5)", async () => {
    const { view, stream, section, effective: base } = setupReady();
    // 思考のタグは、関門が返した設定の側だけ変える(元のセクションは <think>)
    const effective: AIConfig = {
      ...base,
      thinking: { enabled: true, tags: [{ open: "<reason>", close: "</reason>" }] },
    };
    vi.mocked(prepareLlamaServerConfig).mockReturnValue({ kind: "ready", config: effective });
    await startIllustration(view, stream);

    expect(vi.mocked(prepareLlamaServerConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepareLlamaServerConfig).mock.calls[0][0]).toBe(section);
    expect(vi.mocked(buildIllustrationContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildIllustrationContext).mock.calls[0][0].aiConfig).toBe(effective);
    const providerConfigs = generationProviderConfigs(stream);
    expect(providerConfigs).toHaveLength(1);
    expect(providerConfigs[0]).toEqual({ ...effective, timeoutMs: 180000 });
    expect(providerConfigs[0].endpoint).toBe("http://127.0.0.1:51234/v1");
    expect(stream.requests[0].promptTemplate).toEqual(
      illustrationTemplate({ preset: "gemma4-think" }),
    );

    // 思考の分離は OpenAI 互換のときと同じ規則で、返った設定のタグから解決する(8.4)
    await stream.send("<reason>考える。</reason>橋の上に少女が立つ。", "stop");
    await stream.end();

    expect(mocks.appendToMemo).toHaveBeenCalledTimes(1);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(APPENDED_ENTRY);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith("情景文をメモに追加しました");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(isGenerating()).toBe(false);
  });

  it("関門に断られたら、状態を作らず、生成しない。コントローラはトーストを出さない(4.2)", async () => {
    const { view, stream } = setupReady();
    vi.mocked(prepareLlamaServerConfig).mockReturnValue({ kind: "declined" });
    const states: (number | null)[] = [];
    const unsubscribe = useIllustrationStore.subscribe((s) => states.push(s.startedAt));

    expect(requestIllustration(view)).toBe(true);
    await flushMicrotasks();
    unsubscribe();

    expect(vi.mocked(prepareLlamaServerConfig)).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]);
    expect(isGenerating()).toBe(false);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(vi.mocked(buildIllustrationContext)).not.toHaveBeenCalled();
    expect(stream.generateStream).not.toHaveBeenCalled();
    expect(mocks.appendToMemo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
    expect(stopIllustration(view)).toBe(false);

    // 状態を残していないので、準備完了になればそのまま始められる
    vi.mocked(prepareLlamaServerConfig).mockReturnValue({
      kind: "ready",
      config: effectiveConfig(sectionConfig()),
    });
    await startIllustration(view, stream);
    await stream.send("橋の上に少女が立つ。", "stop");
    await stream.end();
    expect(mocks.appendToMemo).toHaveBeenCalledWith(APPENDED_ENTRY);
  });

  it("止まっていて設定がそろっているときは、読み込みを 1 回始めて知らせ、生成しない(4.2)", async () => {
    // 関門は差し替えない(本物)。ストアは「停止中」で、起動できる設定がそろっている
    const model = "gemma-4.gguf";
    useLlamaServerStore.setState({
      preferences: {
        executablePath: "C:\\bin\\llama-server.exe",
        modelsDir: "C:\\models",
        extraArgs: ["--flash-attn", "on"],
        selectedModel: model,
        models: { [model]: { contextSize: 16384 } },
      },
      models: [{ fileName: model, sizeBytes: 1 }],
    });
    // 起動の直前の一覧の読み直し。フォルダの中身は、ストアの一覧と同じにする
    mocks.listGgufModels.mockResolvedValue([{ fileName: model, sizeBytes: 1 }]);
    const stream = createControlledStream();
    mocks.getActiveConfig.mockReturnValue(sectionConfig());
    mocks.getProvider.mockReturnValue(stream.provider);
    const { view } = mountSuggestionEditor({ doc: DOC, cursor: CURSOR_IN_SCENE });
    const states: (number | null)[] = [];
    const unsubscribe = useIllustrationStore.subscribe((s) => states.push(s.startedAt));

    expect(requestIllustration(view)).toBe(true);
    await flushMicrotasks();
    unsubscribe();

    expect(vi.mocked(prepareLlamaServerConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepareLlamaServerConfig)).toHaveReturnedWith({ kind: "declined" });
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer).toHaveBeenCalledWith({
      executablePath: "C:\\bin\\llama-server.exe",
      modelPath: `C:\\models\\${model}`,
      contextSize: 16384,
      extraArgs: ["--flash-attn", "on"],
    });
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      `${model} を読み込み始めました。準備ができたらお知らせします`,
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status.state).toBe("loading");

    // 生成中の状態は一度も作らない
    expect(states).toEqual([]);
    expect(isGenerating()).toBe(false);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(vi.mocked(buildIllustrationContext)).not.toHaveBeenCalled();
    expect(stream.generateStream).not.toHaveBeenCalled();
    expect(mocks.appendToMemo).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent.mock.calls.map(([event]) => event)).not.toContain(
      "illustration.start",
    );
    expect(stopIllustration(view)).toBe(false);
  });

  it("実行ファイルのパスが未設定なら、読み込みを始めずに断り、生成しない(4.4)", async () => {
    // 関門は差し替えない。ストアは既定の「停止中」で、実行ファイルのパスも未設定
    const stream = createControlledStream();
    mocks.getActiveConfig.mockReturnValue(sectionConfig());
    mocks.getProvider.mockReturnValue(stream.provider);
    const { view } = mountSuggestionEditor({ doc: DOC, cursor: CURSOR_IN_SCENE });

    expect(requestIllustration(view)).toBe(true);
    await flushMicrotasks();

    expect(vi.mocked(prepareLlamaServerConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepareLlamaServerConfig)).toHaveReturnedWith({ kind: "declined" });
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status.state).toBe("stopped");
    expect(isGenerating()).toBe(false);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(mocks.appendToMemo).not.toHaveBeenCalled();
    // 出るのは関門のトーストだけで、使えない旨のトーストではない
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "llama-server の実行ファイルが設定されていません。AI 設定画面でパスを設定してください",
    );
  });

  it("場面が空なら、関門を呼ばずに場面を選ぶよう伝える", async () => {
    const doc = `${DOC}\n\n次の段落。`;
    const { view } = setupReady({ doc, cursor: doc.indexOf("\n\n") + 1 });

    expect(requestIllustration(view)).toBe(true);
    await flushMicrotasks();

    expect(vi.mocked(prepareLlamaServerConfig)).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "挿し絵にする場面を選択するか、場面の行にカーソルを置いてください",
    );
    expect(isGenerating()).toBe(false);
  });

  it("挿し絵用の設定の不備・提案の生成中でも、関門を呼ばない", async () => {
    const { view } = setupReady({
      section: { ...sectionConfig(), illustration: undefined, template: undefined },
    });
    expect(requestIllustration(view)).toBe(true);
    expect(mocks.toastError).toHaveBeenLastCalledWith(
      "挿し絵用のテンプレートが決まりません。AI 設定画面でプロンプトテンプレートのプリセットを選ぶか、sumire.json の illustration.template にプリセットか自由記述を書いてください",
    );

    mocks.getActiveConfig.mockReturnValue(sectionConfig());
    useSuggestionStore.getState().setGenerating(true);
    expect(requestIllustration(view)).toBe(true);
    await flushMicrotasks();

    expect(mocks.toastError).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenLastCalledWith(
      "続きの提案を生成中です。終わってからもう一度押してください",
    );
    expect(vi.mocked(prepareLlamaServerConfig)).not.toHaveBeenCalled();
    expect(isGenerating()).toBe(false);
  });

  describe("生成中に llama-server が止められた・起動し直された(3.4, 6.6)", () => {
    const cases: { title: string; change: () => void }[] = [
      {
        title: "状態が「停止中」になる",
        change: () =>
          useLlamaServerStore.setState({
            status: { state: "stopped", runId: RUN_ID, cause: "requested", exitCode: null },
          }),
      },
      {
        title: "別のモデルが選ばれて読み込み中になる(通し番号は手元のまま)",
        change: () =>
          useLlamaServerStore.setState({
            status: {
              state: "loading",
              runId: RUN_ID,
              modelPath: "C:\\models\\another.gguf",
              contextSize: 8192,
              port: 0,
            },
          }),
      },
      {
        title: "通し番号が変わる(起動し直されて準備完了)",
        change: () =>
          useLlamaServerStore.setState({ status: { ...READY_STATUS, runId: RUN_ID + 1 } }),
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.title}と中止し、追記も失敗のトーストも無い`, async () => {
        const { view, stream } = setupReady();
        await startIllustration(view, stream);
        await stream.send("<think>考える。</think>橋の上に");

        testCase.change();
        const signal = stream.generateStream.mock.calls[0][1] as AbortSignal;
        expect(signal.aborted).toBe(true);
        await waitUntil(() => !isGenerating(), "llama-server の変化での中止");
        await flushMicrotasks();

        expectSilent();
      });

      it(`${testCase.title}あとに本文や例外が届いても、追記もトーストもしない`, async () => {
        const { view, stream } = setupReady({ ignoreAbort: true });
        await startIllustration(view, stream);
        testCase.change();
        await stream.send("橋の上に少女が立つ。", "stop");
        await stream.end();
        expectSilent();

        useLlamaServerStore.setState({ status: READY_STATUS });
        const failing = createControlledStream({ ignoreAbort: true });
        mocks.getProvider.mockReturnValue(failing.provider);
        await startIllustration(view, failing);
        testCase.change();
        await failing.fail(new ProviderError("network", "fetch failed"));
        expectSilent();
      });
    }

    it("状態も通し番号も変わらない書き換え(実際のコンテキスト長など)では止まらない", async () => {
      const { view, stream } = setupReady();
      await startIllustration(view, stream);

      useLlamaServerStore.setState({ actualContextSize: 8192 });
      useLlamaServerStore.setState({ status: { ...READY_STATUS } });
      await flushMicrotasks();
      expect(isGenerating()).toBe(true);
      expect(stream.isWaiting()).toBe(true);

      await stream.send("橋の上に少女が立つ。", "stop");
      await stream.end();
      expect(mocks.appendToMemo).toHaveBeenCalledWith(APPENDED_ENTRY);
    });

    it("どの終わり方でも、llama-server のストアの購読を解く", async () => {
      const original = useLlamaServerStore.subscribe;
      const unsubscribes: ReturnType<typeof vi.fn>[] = [];
      const spy = vi.spyOn(useLlamaServerStore, "subscribe").mockImplementation((listener) => {
        const unsubscribe = vi.fn(original(listener));
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      });
      try {
        const { view, stream } = setupReady();
        // 正常
        await startIllustration(view, stream);
        expect(unsubscribes).toHaveLength(1);
        expect(unsubscribes[0]).not.toHaveBeenCalled();
        await stream.send("橋の上に少女が立つ。", "stop");
        await stream.end();
        expect(unsubscribes[0]).toHaveBeenCalledTimes(1);

        // 失敗
        const failing = createControlledStream();
        mocks.getProvider.mockReturnValue(failing.provider);
        await startIllustration(view, failing);
        expect(unsubscribes).toHaveLength(2);
        await failing.fail(new ProviderError("network", "fetch failed"));
        expect(unsubscribes[1]).toHaveBeenCalledTimes(1);

        // llama-server の停止での中止
        const stopped = createControlledStream();
        mocks.getProvider.mockReturnValue(stopped.provider);
        await startIllustration(view, stopped);
        expect(unsubscribes).toHaveLength(3);
        useLlamaServerStore.setState({
          status: { state: "stopped", runId: RUN_ID, cause: "requested", exitCode: null },
        });
        await waitUntil(() => !isGenerating(), "停止での生成の終了");
        expect(unsubscribes[2]).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("llama-server 以外のプロバイダ(1.4)", () => {
    it("OpenAI 互換では、関門が通した設定をそのまま使い、llama-server のストアを購読しない", async () => {
      const spy = vi.spyOn(useLlamaServerStore, "subscribe");
      try {
        const config = testConfig();
        const { view, stream } = setup({ config });
        await startIllustration(view, stream);

        expect(vi.mocked(prepareLlamaServerConfig)).toHaveBeenCalledTimes(1);
        expect(spy).not.toHaveBeenCalled();
        expect(vi.mocked(buildIllustrationContext).mock.calls[0][0].aiConfig).toBe(config);
        // llama-server の状態が変わっても止まらない
        useLlamaServerStore.setState({ status: READY_STATUS });
        useLlamaServerStore.setState({
          status: { state: "stopped", runId: RUN_ID, cause: "requested", exitCode: null },
        });
        await flushMicrotasks();
        expect(isGenerating()).toBe(true);

        await stream.send("橋の上に少女が立つ。", "stop");
        await stream.end();
        expect(mocks.appendToMemo).toHaveBeenCalledWith(APPENDED_ENTRY);
      } finally {
        spy.mockRestore();
      }
    });

    it("OpenAI プロバイダでは、今までどおり使えない旨を伝え、関門を呼ばない", async () => {
      const { view } = setup({ config: testConfig({ provider: "openai" }) });

      expect(requestIllustration(view)).toBe(true);
      await flushMicrotasks();

      expect(mocks.toastError).toHaveBeenCalledTimes(1);
      expect(mocks.toastError).toHaveBeenCalledWith(UNSUPPORTED_TOAST);
      expect(vi.mocked(prepareLlamaServerConfig)).not.toHaveBeenCalled();
      expect(isGenerating()).toBe(false);
      expect(mocks.getProvider).not.toHaveBeenCalled();
    });
  });
});
