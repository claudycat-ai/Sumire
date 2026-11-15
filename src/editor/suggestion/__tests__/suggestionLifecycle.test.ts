/**
 * 提案の暗黙のキャンセル(`suggestionLifecycle`)のテスト(jsdom)。
 *
 * 仕様 `docs/spec/ux.md`「提案のキャンセル挙動」: 提案の表示中に文字を入力したり、
 * カーソルを挿入位置から動かしたりすると、提案は消える。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import {
  clearSuggestionEffect,
  setSuggestionEffect,
  suggestionField,
} from "@/editor/suggestion/suggestionState";
import {
  destroyMountedEditors,
  ghostElement,
  mountSuggestionEditor,
} from "./editorHarness";

afterEach(() => {
  destroyMountedEditors();
  vi.restoreAllMocks();
});

/** 溜まっているマイクロタスクを流す(キャンセルの dispatch は更新の後に回る) */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function showSuggestion(view: EditorView, insertPos: number): void {
  view.dispatch({
    effects: setSuggestionEffect.of({
      text: "続き",
      insertPos,
      streaming: false,
      thinkingStartedAt: null,
    }),
  });
}

function mountWithUpdates(doc: string): { view: EditorView; updates: ViewUpdate[] } {
  const updates: ViewUpdate[] = [];
  const { view } = mountSuggestionEditor({
    doc,
    extensions: [EditorView.updateListener.of((u) => updates.push(u))],
  });
  return { view, updates };
}

describe("提案の暗黙のキャンセル", () => {
  it("提案の表示中に文字を入力すると、ゴーストが消える。CodeMirror のプラグインは落ちない", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    showSuggestion(view, 3);
    expect(ghostElement(view)).not.toBeNull();

    view.dispatch({
      changes: { from: 3, insert: "え" },
      selection: { anchor: 4 },
      userEvent: "input.type",
    });
    await flushMicrotasks();

    expect(view.state.field(suggestionField, false)).toBeNull();
    expect(ghostElement(view)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("一度キャンセルしたあとも、次の提案で同じように働く", async () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    showSuggestion(view, 3);
    view.dispatch({ changes: { from: 3, insert: "え" }, selection: { anchor: 4 } });
    await flushMicrotasks();
    expect(view.state.field(suggestionField, false)).toBeNull();

    showSuggestion(view, 4);
    expect(ghostElement(view)).not.toBeNull();
    view.dispatch({ changes: { from: 4, insert: "お" }, selection: { anchor: 5 } });
    await flushMicrotasks();

    expect(view.state.field(suggestionField, false)).toBeNull();
    expect(ghostElement(view)).toBeNull();
  });

  it("カーソルを挿入位置から動かすと消え、挿入位置のままなら消えない", async () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    showSuggestion(view, 3);

    view.dispatch({ selection: { anchor: 3 } });
    await flushMicrotasks();
    expect(view.state.field(suggestionField, false)).not.toBeNull();

    view.dispatch({ selection: { anchor: 1 } });
    await flushMicrotasks();
    expect(view.state.field(suggestionField, false)).toBeNull();
    expect(ghostElement(view)).toBeNull();
  });

  it("提案を消すのは文字入力とは別のトランザクションで、文書を変えない(採用時のスクロールと区別するため)", async () => {
    const { view, updates } = mountWithUpdates("あいう");
    showSuggestion(view, 3);
    updates.length = 0;

    view.dispatch({ changes: { from: 3, insert: "え" }, selection: { anchor: 4 } });
    await flushMicrotasks();

    const clearing = updates.filter((u) =>
      u.transactions.some((tr) => tr.effects.some((e) => e.is(clearSuggestionEffect))),
    );
    expect(clearing).toHaveLength(1);
    expect(clearing[0].docChanged).toBe(false);
  });

  it("消す前に別の提案が表示されていたら、その提案は消さない", async () => {
    const { view } = mountSuggestionEditor({ doc: "あいう" });
    showSuggestion(view, 3);
    view.dispatch({ changes: { from: 3, insert: "え" }, selection: { anchor: 4 } });
    // キャンセルの dispatch が走る前に、新しい提案を表示する
    showSuggestion(view, 4);
    await flushMicrotasks();

    expect(view.state.field(suggestionField, false)?.insertPos).toBe(4);
    expect(ghostElement(view)).not.toBeNull();
  });

  it("エディタを破棄した直後でも、例外を出さない", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editor = mountSuggestionEditor({ doc: "あいう" });
    showSuggestion(editor.view, 3);
    editor.view.dispatch({ changes: { from: 3, insert: "え" }, selection: { anchor: 4 } });
    editor.destroy();

    await expect(flushMicrotasks()).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
