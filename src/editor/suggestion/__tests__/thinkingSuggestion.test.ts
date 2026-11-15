/**
 * `thinking-output` spec のエディタのテスト(jsdom)。
 *
 * - task 2.2: 提案状態の思考の開始時刻と、ゴーストの思考中の表示とスクロール追随
 *   (design.md「SuggestionState」「GhostTextWidget」「SuggestionScroll」)。
 *   提案状態は `setSuggestionEffect` で直接与える
 * - task 3.1: 提案コントローラへの分離器の組み込み(design.md「SuggestionController」)。
 *   アダプタは、チャンクを 1 つずつ手で流せるストリームに差し替える
 * - task 3.2: 思考が終わらなかったときと、本文が空だったときの終わり方
 *   (design.md「SuggestionController」の終了時の分岐、「新しい文言」)
 *
 * 差し替え(`vi.mock`)はファイル全体に効く。task 2.2 のテストは提案状態を直接与えるので、
 * 差し替えの影響を受けない。
 *
 * テスト時の言語は ja(`src/__tests__/setup.ts`)。
 *
 * Requirements: 1.2, 1.3, 1.8, 1.9, 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.6
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, runScopeHandlers } from "@codemirror/view";

import i18n from "@/i18n";
import type {
  AIConfig,
  AIProvider,
  GenerationChunk,
  ThinkingConfig,
} from "@/domain/providers";
import { useSuggestionStore } from "@/stores/suggestionStore";
import {
  clearSuggestionEffect,
  setSuggestionEffect,
  suggestionField,
  type SuggestionState,
} from "@/editor/suggestion/suggestionState";
import { abortInflight } from "@/editor/suggestion/suggestionController";
import {
  destroyMountedEditors,
  ghostElement,
  mountSuggestionEditor,
  thinkingIndicatorElement,
} from "./editorHarness";

// 提案コントローラが参照する外部の依存は、ここでまとめて差し替える(task 3.1)。
// 分離器(createThinkingSplitter / resolveThinkingTags)は本物を使う。
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

function setSuggestion(view: EditorView, state: SuggestionState): void {
  view.dispatch({ effects: setSuggestionEffect.of(state) });
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

/** `setInterval` / `clearInterval` の呼び出しを記録する(fake timer を入れたあとに呼ぶ) */
function spyIntervals() {
  const setSpy = vi.spyOn(window, "setInterval");
  const clearSpy = vi.spyOn(window, "clearInterval");
  return {
    started: (): unknown[] => setSpy.mock.results.map((result) => result.value),
    cleared: (): unknown[] => clearSpy.mock.calls.map((call) => call[0]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  destroyMountedEditors();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ゴーストの思考中の表示(task 2.2)", () => {
  it("思考中の状態を与えると、本文に続けて「思考中… 0 秒」が出る(2.1, 2.4)", () => {
    expect(i18n.language).toBe("ja");
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, {
      text: "前",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: Date.now(),
    });

    const ghost = ghostElement(view);
    const indicator = thinkingIndicatorElement(view);
    expect(ghostBodyText(view)).toBe("前");
    expect(indicator?.textContent).toBe("思考中… 0 秒");
    // 本文の末尾に付く
    expect(ghost?.lastChild).toBe(indicator);
    expect(ghost?.textContent).toBe("前思考中… 0 秒");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
  });

  it("経過秒数は 1 秒ごとに、表示の文言だけが書き換わる(2.2)", () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, {
      text: "前",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: Date.now(),
    });
    const indicator = thinkingIndicatorElement(view);
    expect(indicator?.textContent).toBe("思考中… 0 秒");

    vi.advanceTimersByTime(999);
    expect(indicator?.textContent).toBe("思考中… 0 秒");
    vi.advanceTimersByTime(1);
    expect(indicator?.textContent).toBe("思考中… 1 秒");
    vi.advanceTimersByTime(2000);
    expect(indicator?.textContent).toBe("思考中… 3 秒");

    // 要素は作り直さず、本文もそのまま
    expect(thinkingIndicatorElement(view)).toBe(indicator);
    expect(ghostBodyText(view)).toBe("前");
  });

  it("経過秒数は、思考ブロックの開始時刻から数える(2.2)", () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, {
      text: "前",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: Date.now() - 5_400,
    });
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 5 秒");
  });

  it("思考中でない状態に戻すと、表示が消えて本文は残る(2.3, 2.4)", () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, {
      text: "前",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: Date.now(),
    });
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    setSuggestion(view, {
      text: "前",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: null,
    });
    expect(thinkingIndicatorElement(view)).toBeNull();
    expect(ghostElement(view)?.textContent).toBe("前");
  });

  it("本文が空でも、思考中ならカーソル位置に表示が出る(2.1)", () => {
    const { view } = mountSuggestionEditor({ doc: "一行目\n二行目", cursor: 3 });
    setSuggestion(view, {
      text: "",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: Date.now(),
    });

    const ghost = ghostElement(view);
    expect(ghost).not.toBeNull();
    expect(ghostBodyText(view)).toBe("");
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");
    // カーソルのある 1 行目の、カーソル位置に描かれる
    const lines = view.dom.querySelectorAll(".cm-line");
    expect(lines[0]?.contains(ghost)).toBe(true);
    expect(view.posAtDOM(ghost as HTMLElement)).toBe(3);
  });

  it("本文が空で思考中でもなければ、ゴーストを描かない", () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, {
      text: "",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: null,
    });
    expect(ghostElement(view)).toBeNull();
  });
});

describe("思考中の表示のタイマーの後始末(task 2.2)", () => {
  const thinking = (): SuggestionState => ({
    text: "前",
    insertPos: 3,
    streaming: true,
    thinkingStartedAt: Date.now(),
  });

  it("ゴーストを消すと、タイマーが残らない", () => {
    const intervals = spyIntervals();
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, thinking());
    expect(intervals.started()).toHaveLength(1);

    view.dispatch({ effects: clearSuggestionEffect.of(null) });
    expect(ghostElement(view)).toBeNull();
    expect(intervals.cleared()).toEqual(expect.arrayContaining(intervals.started()));
  });

  it("思考を抜けると、タイマーが残らない", () => {
    const intervals = spyIntervals();
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, thinking());
    expect(intervals.started()).toHaveLength(1);

    setSuggestion(view, { ...thinking(), thinkingStartedAt: null });
    expect(intervals.started()).toHaveLength(1);
    expect(intervals.cleared()).toEqual(expect.arrayContaining(intervals.started()));
  });

  it("EditorView を破棄すると、タイマーが残らない", () => {
    const intervals = spyIntervals();
    const editor = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(editor.view, thinking());
    expect(intervals.started()).toHaveLength(1);

    editor.destroy();
    expect(intervals.cleared()).toEqual(expect.arrayContaining(intervals.started()));
  });

  it("同じ状態を送り直しても、タイマーは増えず、消せば止まる", () => {
    const intervals = spyIntervals();
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    const state = thinking();
    setSuggestion(view, state);
    // 別のオブジェクトで同じ値を送る(Widget は eq が真になり、DOM が引き継がれる)
    setSuggestion(view, { ...state });
    expect(intervals.started()).toHaveLength(1);
    expect(intervals.cleared()).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 2 秒");

    view.dispatch({ effects: clearSuggestionEffect.of(null) });
    expect(intervals.cleared()).toEqual(expect.arrayContaining(intervals.started()));
  });
});

describe("思考中のスクロール追随(task 2.2)", () => {
  it("本文が空の思考中でも、ゴーストの末尾を測って追随する", () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    vi.advanceTimersByTime(100); // 取り付け時の計測を流しておく
    setSuggestion(view, {
      text: "",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: Date.now(),
    });
    const ghost = ghostElement(view);
    expect(ghost).not.toBeNull();
    const measure = vi.spyOn(ghost as HTMLElement, "getBoundingClientRect");

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(measure).toHaveBeenCalled();
  });

  it("本文の末尾が変わらなくても、思考中の表示が出た時点で追随する", () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    setSuggestion(view, {
      text: "前",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: null,
    });
    vi.advanceTimersByTime(100);

    setSuggestion(view, {
      text: "前",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: Date.now(),
    });
    const ghost = ghostElement(view);
    expect(ghost).not.toBeNull();
    const measure = vi.spyOn(ghost as HTMLElement, "getBoundingClientRect");

    vi.advanceTimersByTime(100);
    expect(measure).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// task 3.1: 提案コントローラへの分離器の組み込み
// ---------------------------------------------------------------------------

const EMPTY_RESPONSE_TOAST = "提案を取得できませんでした(応答が空です)";

/** 提案生成に使う AI 設定。`thinking` を省くと、既存プロジェクトと同じ未設定になる */
function testConfig(thinking?: ThinkingConfig): AIConfig {
  const config: AIConfig = {
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:5000/v1",
    model: "test-model",
    parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
    systemPrompt: null,
  };
  if (thinking) config.thinking = thinking;
  return config;
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

/** アダプタの代わりに、チャンクを 1 つずつ手で流せるストリーム */
interface ControlledStream {
  provider: AIProvider;
  /** プロバイダに渡された AbortSignal。生成が始まるまでは null */
  signal(): AbortSignal | null;
  /** コントローラが次のチャンクを待っているか */
  isWaiting(): boolean;
  /** チャンクを 1 つ流し、コントローラがそれを処理して次のチャンクを待つところまで進める */
  send(textDelta: string, finishReason?: GenerationChunk["finishReason"]): Promise<void>;
  /** ストリームを終え、コントローラが提案を確定する(か片付ける)まで進める */
  end(): Promise<void>;
}

function createControlledStream(): ControlledStream {
  const queue: GenerationChunk[] = [];
  let ended = false;
  let waiting = false;
  let wake: (() => void) | null = null;
  let receivedSignal: AbortSignal | null = null;

  async function* iterate(signal: AbortSignal): AsyncGenerator<GenerationChunk> {
    const onAbort = () => wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        // 実際のアダプタと同じく、外からの停止では静かに終わる
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

  return {
    provider: {
      generateStream: (_request, signal) => {
        receivedSignal = signal;
        return iterate(signal);
      },
      generate: () => Promise.reject(new Error("テストでは使わない")),
      countTokens: () => Promise.resolve(0),
    },
    signal: () => receivedSignal,
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

/** コンソールに出た文字列をすべて集める(思考の中身が出ていないことの確認用) */
function captureConsole(): () => string {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  return () =>
    spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
}

interface StartedSuggestion {
  view: EditorView;
  stream: ControlledStream;
  /** コントローラが送った提案状態(setSuggestionEffect)の並び */
  sent: SuggestionState[];
}

/** エディタを取り付けて Shift+Enter で提案を要求し、最初のチャンクを待つところまで進める */
async function startSuggestion(options: {
  doc: string;
  cursor?: number;
  config?: AIConfig;
}): Promise<StartedSuggestion> {
  const stream = createControlledStream();
  mocks.getActiveConfig.mockReturnValue(options.config ?? testConfig());
  mocks.getProvider.mockReturnValue(stream.provider);
  const sent: SuggestionState[] = [];
  const recorder = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSuggestionEffect)) sent.push(effect.value);
      }
    }
  });
  const { view } = mountSuggestionEditor({
    doc: options.doc,
    cursor: options.cursor,
    extensions: [recorder],
  });
  expect(pressKey(view, "Enter", { shiftKey: true })).toBe(true);
  await waitUntil(stream.isWaiting, "最初のチャンクを待つところまで");
  return { view, stream, sent };
}

/** 提案コントローラのテストの前に、差し替えた依存の呼び出し記録と戻り値をそろえ直す */
function resetControllerMocks(): void {
  vi.clearAllMocks();
  mocks.buildGenerationRequest.mockResolvedValue({
    systemPrompt: "system",
    contextSections: [],
    body: "本文",
    usedTokens: { system: 0, sections: 0, body: 0, reserved: 0, window: 0 },
  });
  mocks.appendToMemo.mockResolvedValue(undefined);
}

describe("提案コントローラへの分離器の組み込み(task 3.1)", () => {
  beforeEach(() => {
    resetControllerMocks();
  });

  afterEach(() => {
    // 途中で終えたテストの生成を止め、進行中のリクエストを次のテストに持ち越さない
    abortInflight();
  });

  it("タグを出さない応答では、ゴースト・採用・メモ転記が導入前と同じ(1.8)", async () => {
    const { view, stream, sent } = await startSuggestion({ doc: "あいう" });

    await stream.send("彼は");
    expect(ghostBodyText(view)).toBe("彼は");
    await stream.send("振り返った。");
    expect(ghostBodyText(view)).toBe("彼は振り返った。");
    await stream.send("\n「おはよう」", "stop");
    expect(ghostBodyText(view)).toBe("彼は振り返った。\n「おはよう」");
    expect(thinkingIndicatorElement(view)).toBeNull();
    await stream.end();

    const expected = "彼は振り返った。\n「おはよう」";
    expect(sent).toEqual([
      { text: "彼は", insertPos: 3, streaming: true, thinkingStartedAt: null },
      { text: "彼は振り返った。", insertPos: 3, streaming: true, thinkingStartedAt: null },
      { text: expected, insertPos: 3, streaming: true, thinkingStartedAt: null },
      { text: expected, insertPos: 3, streaming: false, thinkingStartedAt: null },
    ]);
    expect(suggestionOf(view)).toEqual({
      text: expected,
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });

    expect(pressKey(view, "m", { altKey: true })).toBe(true);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(expected);
    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(`あいう${expected}`);
    expect(view.state.selection.main.head).toBe(3 + expected.length);
    expect(suggestionOf(view)).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("タグを出さない応答なら、改行やタグでない `<` を含んでも、確定する提案は届いた差分の連結になる(1.8)", async () => {
    const deltas = ["\n\n", "a<b ", "</think>", "<"];
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    for (const delta of deltas) await stream.send(delta);
    await stream.end();

    const expected = deltas.join("");
    expect(suggestionOf(view)).toEqual({
      text: expected,
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
    expect(pressKey(view, "m", { altKey: true })).toBe(true);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(expected);
    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(`あいう${expected}`);
  });

  it("実測の形: 思考中は思考前の本文に「思考中」が付き、終了タグで消えて本文が伸びる。確定した提案に思考は含まれない(1.2, 1.3, 1.9, 2.3, 2.4)", async () => {
    const loggedText = captureConsole();
    const { view, stream, sent } = await startSuggestion({ doc: "彼女は" });

    await stream.send("ため息をついた。\n\n");
    expect(ghostBodyText(view)).toBe("ため息をついた。\n\n");
    expect(thinkingIndicatorElement(view)).toBeNull();

    await stream.send("<think>\nOkay, the user wants");
    const startedAt = Date.now();
    expect(ghostBodyText(view)).toBe("ため息をついた。\n\n");
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");
    expect(suggestionOf(view)).toEqual({
      text: "ため息をついた。\n\n",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: startedAt,
    });

    // 思考中にチャンクが届き続けても、提案状態は送り直さない
    const sentWhileThinking = sent.length;
    vi.advanceTimersByTime(2000);
    await stream.send(" a calm scene at the school gate.");
    await stream.send("\nLet me write it.\n");
    expect(sent).toHaveLength(sentWhileThinking);
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 2 秒");

    await stream.send("</think>");
    expect(thinkingIndicatorElement(view)).toBeNull();
    expect(ghostBodyText(view)).toBe("ため息をついた。\n\n");
    expect(suggestionOf(view)).toEqual({
      text: "ため息をついた。\n\n",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: null,
    });

    await stream.send("\n\n改札の");
    expect(ghostBodyText(view)).toBe("ため息をついた。\n\n改札の");
    await stream.send("前で待っていた。", "stop");
    await stream.end();

    const expected = "ため息をついた。\n\n改札の前で待っていた。";
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

    // 思考の中身は、送った提案状態にもコンソールにも出ない(1.9)
    const thinkingContent = /<\/?think|Okay|school gate|Let me write/;
    for (const state of sent) expect(state.text).not.toMatch(thinkingContent);
    expect(loggedText()).not.toMatch(thinkingContent);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("応答の先頭の思考ブロックで、`</think>`・改行・本文が別々に届いても、`</think>` の時点で表示が消える(2.3)", async () => {
    const { view, stream, sent } = await startSuggestion({ doc: "あいう" });

    await stream.send("<think>\nplan the scene");
    expect(ghostBodyText(view)).toBe("");
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");

    await stream.send("</think>");
    expect(thinkingIndicatorElement(view)).toBeNull();
    expect(ghostElement(view)).toBeNull();
    // 本文が空でも提案状態は残す(ストリーミング中として Tab を吸い、暗黙のキャンセルも働く)
    expect(suggestionOf(view)).toEqual({
      text: "",
      insertPos: 3,
      streaming: true,
      thinkingStartedAt: null,
    });

    const sentAfterClose = sent.length;
    await stream.send("\n\n");
    expect(sent).toHaveLength(sentAfterClose);
    expect(ghostElement(view)).toBeNull();

    await stream.send("改札の前で");
    expect(ghostBodyText(view)).toBe("改札の前で");
    expect(thinkingIndicatorElement(view)).toBeNull();
    await stream.end();
    expect(suggestionOf(view)).toEqual({
      text: "改札の前で",
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
  });

  it("まだ提案状態を送っていない間は、保留だけのスナップショット(先頭の改行、開始タグの切れ端)を送らない", async () => {
    const { view, stream, sent } = await startSuggestion({ doc: "あいう" });

    await stream.send("\n");
    await stream.send("<th");
    expect(sent).toHaveLength(0);
    expect(suggestionOf(view)).toBeNull();

    await stream.send("ink>\n");
    expect(sent).toEqual([
      { text: "", insertPos: 3, streaming: true, thinkingStartedAt: Date.now() },
    ]);
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");
  });

  it("本文が空の思考中に Tab を押しても、文書は変わらず生成も止まらない。Alt+M も吸って何もしない", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("<think>\nhmm");
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("あいう");
    expect(stream.signal()?.aborted).toBe(false);
    expect(useSuggestionStore.getState().generating).toBe(true);
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    expect(pressKey(view, "m", { altKey: true })).toBe(true);
    expect(mocks.appendToMemo).not.toHaveBeenCalled();

    // 生成は続いていて、思考のあとの本文が届く
    await stream.send("</think>本文");
    expect(ghostBodyText(view)).toBe("本文");
    await stream.end();
    expect(suggestionOf(view)).toEqual({
      text: "本文",
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
  });

  it("ストリーミング中なら、本文が空の提案状態でも Tab を下に流さずに吸う(採用の判定順)", () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    // 提案状態が無ければ、Tab は下に流す(既存の挙動)
    expect(pressKey(view, "Tab")).toBe(false);

    for (const thinkingStartedAt of [Date.now(), null]) {
      setSuggestion(view, { text: "", insertPos: 3, streaming: true, thinkingStartedAt });
      expect(pressKey(view, "Tab")).toBe(true);
      expect(view.state.doc.toString()).toBe("あいう");
      expect(suggestionOf(view)).not.toBeNull();
    }
  });

  it("思考中の Esc で、思考前の本文ごとゴーストが消え、生成が止まる(2.5)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("ため息をついた。\n\n");
    await stream.send("<think>\nplan");
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    expect(pressKey(view, "Escape")).toBe(true);
    expect(ghostElement(view)).toBeNull();
    expect(suggestionOf(view)).toBeNull();
    expect(stream.signal()?.aborted).toBe(true);
    expect(useSuggestionStore.getState().generating).toBe(false);

    // 停止したあとに提案が出直したり、トーストが出たりしない
    await flushMicrotasks();
    expect(suggestionOf(view)).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("思考中に文字を入力すると、生成が止まり、思考前の本文ごとゴーストと「思考中」の表示が消える", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("ため息をついた。\n\n");
    await stream.send("<think>\nplan");
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    view.dispatch({
      changes: { from: 3, insert: "え" },
      selection: { anchor: 4 },
      userEvent: "input.type",
    });
    await flushMicrotasks();

    expect(stream.signal()?.aborted).toBe(true);
    expect(useSuggestionStore.getState().generating).toBe(false);
    expect(suggestionOf(view)).toBeNull();
    expect(ghostElement(view)).toBeNull();
    expect(thinkingIndicatorElement(view)).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("あいうえ");
  });

  it("本文が空の思考中の Esc でも、表示が消えて生成が止まる(2.5)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("<think>\nplan");
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    expect(pressKey(view, "Escape")).toBe(true);
    expect(ghostElement(view)).toBeNull();
    expect(suggestionOf(view)).toBeNull();
    expect(stream.signal()?.aborted).toBe(true);
    await flushMicrotasks();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("思考だけの応答では、既存の「応答が空です」を出し、ゴーストを残さない(思考を除いた本文で判定する。4.5)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("<think>\nplan\n</think>");
    await stream.send("\n\n", "stop");
    await stream.end();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(EMPTY_RESPONSE_TOAST);
    expect(suggestionOf(view)).toBeNull();
    expect(ghostElement(view)).toBeNull();
  });

  it("確定は分離器の最終結果で行う: 応答の末尾の思考ブロックは、直前の改行ごと除く", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("ため息をついた。\n\n");
    await stream.send("<think>\nmore?\n</think>", "stop");
    expect(ghostBodyText(view)).toBe("ため息をついた。\n\n");
    await stream.end();

    expect(suggestionOf(view)).toEqual({
      text: "ため息をついた。",
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("あいうため息をついた。");
  });

  it("思考ブロックが新しく始まるたびに、経過秒数を 0 から数え直す(2.2)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("前。<think>a");
    const firstStartedAt = Date.now();
    expect(suggestionOf(view)?.thinkingStartedAt).toBe(firstStartedAt);
    vi.advanceTimersByTime(5000);
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 5 秒");

    await stream.send("</think>中。");
    expect(thinkingIndicatorElement(view)).toBeNull();
    expect(ghostBodyText(view)).toBe("前。中。");
    vi.advanceTimersByTime(1000);

    await stream.send("<think>b");
    expect(suggestionOf(view)?.thinkingStartedAt).toBe(firstStartedAt + 6000);
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");
    expect(ghostBodyText(view)).toBe("前。中。");

    await stream.send("</think>後。", "stop");
    await stream.end();
    expect(suggestionOf(view)?.text).toBe("前。中。後。");
  });

  it("1 つのチャンクの中で思考ブロックが閉じて次が始まっても、経過秒数を 0 から数え直す(2.2)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("前。<think>a");
    const firstStartedAt = Date.now();
    vi.advanceTimersByTime(5000);
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 5 秒");

    await stream.send("</think>中。<think>b");
    expect(suggestionOf(view)?.thinkingStartedAt).toBe(firstStartedAt + 5000);
    expect(thinkingIndicatorElement(view)?.textContent).toBe("思考中… 0 秒");
    expect(ghostBodyText(view)).toBe("前。中。");

    await stream.send("</think>後。", "stop");
    await stream.end();
    expect(suggestionOf(view)?.text).toBe("前。中。後。");
  });

  it("タグの組は設定から解決する: 設定した組だけを思考として扱う", async () => {
    const config = testConfig({
      enabled: true,
      tags: [{ open: "<reasoning>", close: "</reasoning>" }],
    });
    const { view, stream } = await startSuggestion({ doc: "あいう", config });
    await stream.send("前。<reasoning>x</reasoning>");
    await stream.send("後。<think>y</think>", "stop");
    await stream.end();

    expect(suggestionOf(view)?.text).toBe("前。後。<think>y</think>");
  });

  it("本文が空の思考中 → 思考を抜ける → 同じ位置で再び思考中、の流れでも、表示が出るたびに追随する", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("<think>\nfirst");
    expect(thinkingIndicatorElement(view)).not.toBeNull();
    vi.advanceTimersByTime(100); // 1 回目の表示の計測を流しておく

    await stream.send("</think>");
    expect(ghostElement(view)).toBeNull();
    vi.advanceTimersByTime(100);

    await stream.send("\n<think>\nsecond");
    const ghost = ghostElement(view);
    expect(ghost).not.toBeNull();
    expect(thinkingIndicatorElement(view)).not.toBeNull();
    const measure = vi.spyOn(ghost as HTMLElement, "getBoundingClientRect");

    vi.advanceTimersByTime(100);
    expect(measure).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// task 3.2: 思考が終わらなかったときと、本文が空だったときの終わり方
// ---------------------------------------------------------------------------

/** テスト時の言語(ja)での、思考の途中で上限に達したときのトースト(4.2) */
const THINKING_MAX_TOKENS_TOAST = "思考の途中で生成の上限に達しました。maxTokens を増やしてください";
/** テスト時の言語(ja)での、上限以外の理由で思考が終わらなかったときのトースト(4.3) */
const THINKING_UNFINISHED_TOAST = "思考が終わらないまま応答が終わりました";

/** 提案が残っていない: ゴーストも提案状態も無く、Tab と Alt+M は提案を扱わずに下へ流す(4.1) */
function expectNoSuggestion(view: EditorView, doc: string): void {
  expect(ghostElement(view)).toBeNull();
  expect(thinkingIndicatorElement(view)).toBeNull();
  expect(suggestionOf(view)).toBeNull();
  expect(pressKey(view, "Tab")).toBe(false);
  expect(pressKey(view, "m", { altKey: true })).toBe(false);
  expect(view.state.doc.toString()).toBe(doc);
  expect(mocks.appendToMemo).not.toHaveBeenCalled();
}

describe("思考が終わらなかったときと、本文が空だったときの終わり方(task 3.2)", () => {
  beforeEach(() => {
    resetControllerMocks();
  });

  afterEach(() => {
    abortInflight();
  });

  it("思考の途中で上限(length)に達して終わると、思考前の本文ごとゴーストを消し、maxTokens の案内を出す(4.1, 4.2, 4.4)", async () => {
    const { view, stream } = await startSuggestion({ doc: "彼女は" });
    await stream.send("ため息をついた。\n\n");
    await stream.send("<think>\nOkay, the user wants");
    expect(ghostBodyText(view)).toBe("ため息をついた。\n\n");
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    await stream.send(" a calm scene at the", "length");
    await stream.end();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(THINKING_MAX_TOKENS_TOAST);
    expect(mocks.toastError).not.toHaveBeenCalledWith(EMPTY_RESPONSE_TOAST);
    expectNoSuggestion(view, "彼女は");
  });

  it.each([
    ["stop", "stop"],
    ["error", "error"],
    ["終了理由なし", undefined],
  ] as const)(
    "思考の途中で上限以外(%s)で終わると、ゴーストを消し、未終了の案内を出す(4.1, 4.3, 4.4)",
    async (_label, finishReason) => {
      const { view, stream } = await startSuggestion({ doc: "あいう" });
      await stream.send("<think>\nplan the scene");
      expect(thinkingIndicatorElement(view)).not.toBeNull();

      await stream.send(", then write", finishReason);
      await stream.end();

      expect(mocks.toastError).toHaveBeenCalledTimes(1);
      expect(mocks.toastError).toHaveBeenCalledWith(THINKING_UNFINISHED_TOAST);
      expect(mocks.toastError).not.toHaveBeenCalledWith(EMPTY_RESPONSE_TOAST);
      expectNoSuggestion(view, "あいう");
    },
  );

  it("終了理由が、本文が空の最後のチャンクで別に届いても、上限到達として扱う", async () => {
    const { view, stream, sent } = await startSuggestion({ doc: "あいう" });
    await stream.send("<think>\nplan");
    await stream.send(" the scene");
    const sentBeforeFinish = sent.length;

    // OpenAI 互換のサーバーは、最後に `"text": ""` と finish_reason だけを送ってくる
    await stream.send("", "length");
    expect(sent).toHaveLength(sentBeforeFinish);
    await stream.end();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(THINKING_MAX_TOKENS_TOAST);
    expectNoSuggestion(view, "あいう");
  });

  it("終わった思考ブロックのあとに本文があっても、最後の思考が終わらなければ本文をすべて捨てる(4.1)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("前。<think>a</think>中。");
    expect(ghostBodyText(view)).toBe("前。中。");
    await stream.send("<think>b");
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    await stream.send("c", "stop");
    await stream.end();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(THINKING_UNFINISHED_TOAST);
    expectNoSuggestion(view, "あいう");
  });

  it("最後のスナップショットが思考中でなくても、分離器の最終結果で思考が終わっていなければ未終了として扱う", async () => {
    // 開始タグ同士に接頭辞関係があると、短いほうが届いても応答が終わるまで判定を待つ
    const config = testConfig({
      enabled: true,
      tags: [
        { open: "<<", close: ">>" },
        { open: "<<<", close: ">>>" },
      ],
    });
    const { view, stream } = await startSuggestion({ doc: "あいう", config });
    await stream.send("前。<<", "stop");
    expect(ghostBodyText(view)).toBe("前。");
    expect(thinkingIndicatorElement(view)).toBeNull();
    await stream.end();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(THINKING_UNFINISHED_TOAST);
    expectNoSuggestion(view, "あいう");
  });

  it("思考が終わったあと本文が空なら、上限で終わっても既存の「応答が空です」を出す(4.5)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("<think>\nplan\n</think>\n\n");
    await stream.send("", "length");
    await stream.end();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(EMPTY_RESPONSE_TOAST);
    expectNoSuggestion(view, "あいう");
  });

  it("思考中に上限の終了理由を受けたあとでも、Esc で止めればトーストを出さない(2.5)", async () => {
    const { view, stream } = await startSuggestion({ doc: "あいう" });
    await stream.send("前。<think>\nplan", "length");
    expect(thinkingIndicatorElement(view)).not.toBeNull();

    expect(pressKey(view, "Escape")).toBe(true);
    expect(stream.signal()?.aborted).toBe(true);
    await flushMicrotasks();

    expect(useSuggestionStore.getState().generating).toBe(false);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expectNoSuggestion(view, "あいう");
  });

  it("設定で無効にすると、タグも本文としてゴーストと採用に出て、終了タグが無くても案内を出さない(5.6)", async () => {
    const config = testConfig({
      enabled: false,
      tags: [{ open: "<think>", close: "</think>" }],
    });
    const { view, stream } = await startSuggestion({ doc: "あいう", config });
    await stream.send("前。\n\n<thi");
    expect(ghostBodyText(view)).toBe("前。\n\n<thi");
    await stream.send("nk>\nplan\n</think>\n\n後。");
    expect(ghostBodyText(view)).toBe("前。\n\n<think>\nplan\n</think>\n\n後。");
    expect(thinkingIndicatorElement(view)).toBeNull();
    await stream.send("<think>\nmore", "length");
    await stream.end();

    const expected = "前。\n\n<think>\nplan\n</think>\n\n後。<think>\nmore";
    expect(suggestionOf(view)).toEqual({
      text: expected,
      insertPos: 3,
      streaming: false,
      thinkingStartedAt: null,
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(pressKey(view, "m", { altKey: true })).toBe(true);
    expect(mocks.appendToMemo).toHaveBeenCalledWith(expected);
    expect(pressKey(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(`あいう${expected}`);
  });

  it("2 種類の案内は ja / en の両方にあり、互いにも「応答が空です」とも区別できる(4.2, 4.3, 4.4)", () => {
    expect(i18n.t("toast.thinkingMaxTokens")).toBe(THINKING_MAX_TOKENS_TOAST);
    expect(i18n.t("toast.thinkingUnfinished")).toBe(THINKING_UNFINISHED_TOAST);
    for (const lng of ["ja", "en"]) {
      // getResource は fallbackLng に倒さないので、言語ごとにキーがあるかを確かめられる
      const maxTokens: unknown = i18n.getResource(lng, "translation", "toast.thinkingMaxTokens");
      const unfinished: unknown = i18n.getResource(lng, "translation", "toast.thinkingUnfinished");
      expect(typeof maxTokens).toBe("string");
      expect(typeof unfinished).toBe("string");
      // 上限到達の案内は、増やすべき設定の名前を含む(4.2)
      expect(maxTokens).toContain("maxTokens");
      expect(new Set([maxTokens, unfinished, EMPTY_RESPONSE_TOAST]).size).toBe(3);
    }
  });
});
