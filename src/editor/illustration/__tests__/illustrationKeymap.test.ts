/**
 * `illustration-prompt` spec の Alt+I と Esc のキーのテスト(jsdom)。task 3.3。
 *
 * - エディタは本番と同じ `buildEditorExtensions`(src/editor/setup.ts)で組む。提案の keymap との
 *   並び順を実物どおりにするため(design.md「Testing Strategy」> Integration Tests、テストの補助)。
 *   `editorHarness.ts` の `mountSuggestionEditor` は提案の拡張だけを直接載せるので使わない
 * - キーの押下は `runScopeHandlers(view, event, "editor")` で CodeMirror の keymap に通す
 * - ここで確かめるのは keymap の並びとディスパッチであって、コントローラの中身ではない。
 *   `requestIllustration` / `stopIllustration` は差し替え、「生成中」の有無だけを持つ偽物にする
 *   (中止で追記もトーストも無いことは illustrationController.test.ts で確かめている)
 * - 提案の表示中は、提案の状態に `setSuggestionEffect` を dispatch して作る
 *
 * Requirements: 1.1, 1.2, 1.5, 5.3, 5.4
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";

import { buildEditorExtensions } from "@/editor/setup";
import {
  setSuggestionEffect,
  suggestionField,
  type SuggestionState,
} from "@/editor/suggestion/suggestionState";
import { abortInflight } from "@/editor/suggestion/suggestionController";
import { installCodeMirrorDomStubs } from "@/editor/suggestion/__tests__/editorHarness";

// 情景文の生成中かどうかだけを持つ偽のコントローラ
const fake = vi.hoisted(() => {
  const state = { generating: false };
  return {
    state,
    requestIllustration: vi.fn((_view: unknown): boolean => {
      state.generating = true;
      return true;
    }),
    stopIllustration: vi.fn((_view: unknown): boolean => {
      if (!state.generating) return false;
      state.generating = false;
      return true;
    }),
  };
});

vi.mock("@/editor/illustration/illustrationController", () => ({
  requestIllustration: fake.requestIllustration,
  stopIllustration: fake.stopIllustration,
}));

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

const mounted: { view: EditorView; parent: HTMLElement }[] = [];

/** 本番と同じ拡張の組み立てで EditorView を document に取り付ける */
function mountEditor(options: {
  doc: string;
  selection?: { anchor: number; head?: number };
  disableSuggestion?: boolean;
}): EditorView {
  installCodeMirrorDomStubs();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: options.doc,
      selection: options.selection ?? { anchor: options.doc.length },
      extensions: buildEditorExtensions({
        onChange: () => {},
        disableSuggestion: options.disableSuggestion,
      }),
    }),
    parent,
  });
  mounted.push({ view, parent });
  return view;
}

/** キー操作を、エディタの keymap に通す。どれかの keymap が処理したら true */
function press(view: EditorView, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  return runScopeHandlers(view, event, "editor");
}

function pressAltI(view: EditorView): boolean {
  return press(view, { key: "i", code: "KeyI", keyCode: 73, altKey: true });
}

function pressEscape(view: EditorView): boolean {
  return press(view, { key: "Escape", code: "Escape", keyCode: 27 });
}

function showSuggestion(view: EditorView): SuggestionState {
  const shown: SuggestionState = {
    text: "続き。",
    insertPos: view.state.doc.length,
    streaming: false,
    thinkingStartedAt: null,
  };
  view.dispatch({ effects: setSuggestionEffect.of(shown) });
  return shown;
}

function suggestionOf(view: EditorView): SuggestionState | null {
  return view.state.field(suggestionField, false) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.state.generating = false;
});

afterEach(() => {
  abortInflight();
  for (const { view, parent } of mounted.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

// ---------------------------------------------------------------------------
// Alt+I(1.1, 1.2, 1.5)
// ---------------------------------------------------------------------------

describe("Alt+I で情景文の生成を始める(1.1, 1.2, 1.5)", () => {
  it("本文エディタで範囲を選んで Alt+I を押すと、そのエディタで生成を始め、キーを吸う(1.1)", () => {
    const view = mountEditor({ doc: "雨の橋。\n\n二人が立つ。", selection: { anchor: 0, head: 4 } });

    expect(pressAltI(view)).toBe(true);

    expect(fake.requestIllustration).toHaveBeenCalledTimes(1);
    expect(fake.requestIllustration).toHaveBeenCalledWith(view);
    // 本文には何も入らない
    expect(view.state.doc.toString()).toBe("雨の橋。\n\n二人が立つ。");
  });

  it("範囲を選ばずに Alt+I を押しても、そのエディタで生成を始める(1.2)", () => {
    const view = mountEditor({ doc: "雨の橋。", selection: { anchor: 2 } });

    expect(pressAltI(view)).toBe(true);

    expect(fake.requestIllustration).toHaveBeenCalledTimes(1);
    expect(fake.requestIllustration).toHaveBeenCalledWith(view);
    expect(view.state.doc.toString()).toBe("雨の橋。");
  });

  it("提案を無効にしたエディタ(メモ・設定)では、Alt+I が何もしない(1.5)", () => {
    const view = mountEditor({ doc: "メモ。", disableSuggestion: true });

    expect(pressAltI(view)).toBe(false);

    expect(fake.requestIllustration).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("メモ。");
  });
});

// ---------------------------------------------------------------------------
// Esc(5.3, 5.4)
// ---------------------------------------------------------------------------

describe("Esc で情景文の生成を中止する(5.3, 5.4)", () => {
  it("情景文の生成中で、提案が表示されていなければ、Esc で中止される(5.3)", () => {
    const view = mountEditor({ doc: "雨の橋。" });
    expect(pressAltI(view)).toBe(true);
    expect(fake.state.generating).toBe(true);

    expect(pressEscape(view)).toBe(true);

    expect(fake.stopIllustration).toHaveBeenCalledTimes(1);
    expect(fake.stopIllustration).toHaveBeenCalledWith(view);
    expect(fake.state.generating).toBe(false);
  });

  it("情景文の生成中で、提案が表示されていれば、Esc で提案が消え、生成は続く(5.4)", () => {
    const view = mountEditor({ doc: "雨の橋。" });
    expect(pressAltI(view)).toBe(true);
    showSuggestion(view);
    expect(suggestionOf(view)).not.toBeNull();

    expect(pressEscape(view)).toBe(true);

    expect(suggestionOf(view)).toBeNull();
    expect(fake.stopIllustration).not.toHaveBeenCalled();
    expect(fake.state.generating).toBe(true);

    // 提案が消えたあとの Esc は、情景文の中止に届く
    expect(pressEscape(view)).toBe(true);
    expect(fake.stopIllustration).toHaveBeenCalledTimes(1);
    expect(fake.state.generating).toBe(false);
  });

  it("情景文の生成中でも提案の表示中でもなければ、Esc は処理せずキーを下に流す", () => {
    const view = mountEditor({ doc: "雨の橋。" });

    expect(pressEscape(view)).toBe(false);

    expect(fake.stopIllustration).toHaveBeenCalledTimes(1);
    expect(fake.state.generating).toBe(false);
  });

  it("提案を無効にしたエディタでは、Esc が情景文の中止に届かない(1.5)", () => {
    const view = mountEditor({ doc: "メモ。", disableSuggestion: true });
    fake.state.generating = true;

    pressEscape(view);

    expect(fake.stopIllustration).not.toHaveBeenCalled();
    expect(fake.state.generating).toBe(true);
  });
});
