import { Extension } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import i18n from "@/i18n";
import { suggestionField } from "./suggestionState";

/**
 * 思考中の表示の経過秒数を書き換えるタイマー。Widget のインスタンスではなく DOM に紐づける。
 * CodeMirror は eq が真の新しい Widget に DOM を引き継ぎ、古い Widget の destroy を呼ばない。
 * DOM をキーにしておけば、最後にその DOM を持った Widget の destroy で確実に止められる。
 */
const thinkingTimers = new WeakMap<HTMLElement, number>();

function thinkingLabel(startedAt: number): string {
  // 時計が巻き戻っても負の秒数を出さない
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return i18n.t("editor.thinkingIndicator", { seconds });
}

/**
 * ゴーストテキスト Widget。
 * カーソル位置にインライン挿入する。複数行を含むテキストは pre-wrap で素直に流す。
 *
 * 思考中(thinkingStartedAt が null でない)は、本文の末尾に「思考中」と経過秒数を足す。
 * 本文が空でも思考中なら描くので、思考の前に本文が無ければカーソル位置に表示だけが出る。
 * 経過秒数は 1 秒ごとに表示の文言だけを書き換える(提案状態は変えないので、
 * トランザクションも再描画も起きない)。
 *
 * pointer-events: none で文字選択・クリックの邪魔をしない。
 */
class GhostTextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly thinkingStartedAt: number | null,
  ) {
    super();
  }
  eq(other: GhostTextWidget): boolean {
    return (
      other.text === this.text &&
      other.thinkingStartedAt === this.thinkingStartedAt
    );
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-suggestion";
    span.textContent = this.text;
    span.setAttribute("aria-hidden", "true");
    const startedAt = this.thinkingStartedAt;
    if (startedAt !== null) {
      const indicator = document.createElement("span");
      indicator.className = "cm-ghost-thinking";
      indicator.textContent = thinkingLabel(startedAt);
      span.appendChild(indicator);
      const timer = window.setInterval(() => {
        indicator.textContent = thinkingLabel(startedAt);
      }, 1000);
      thinkingTimers.set(span, timer);
    }
    return span;
  }
  destroy(dom: HTMLElement): void {
    const timer = thinkingTimers.get(dom);
    if (timer === undefined) return;
    window.clearInterval(timer);
    thinkingTimers.delete(dom);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const ghostPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      // StateField の値が変わったか、ドキュメント・ビューポートが変わったら再構築
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(suggestionField, false) !==
          update.state.field(suggestionField, false)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

function build(view: EditorView): DecorationSet {
  const state = view.state.field(suggestionField, false);
  if (!state) return Decoration.none;
  // 本文が空でも、思考中なら「思考中」の表示を出すために描く
  if (state.text.length === 0 && state.thinkingStartedAt === null) {
    return Decoration.none;
  }
  // insertPos が現在の doc 範囲外なら描画しない(防御的)
  if (state.insertPos < 0 || state.insertPos > view.state.doc.length) {
    return Decoration.none;
  }
  const widget = Decoration.widget({
    widget: new GhostTextWidget(state.text, state.thinkingStartedAt),
    side: 1, // カーソルより右側に表示
  });
  return Decoration.set([widget.range(state.insertPos)]);
}

const ghostTheme = EditorView.theme({
  ".cm-ghost-suggestion": {
    // ライトモード: zinc-500 を α=0.85 で本文より一段薄く。判読性を優先。
    color: "rgba(113, 113, 122, 0.85)",
    fontStyle: "normal",
    whiteSpace: "pre-wrap",
    pointerEvents: "none",
    // 本文と同じフォントサイズ・ファミリで揃える
    fontFamily: "inherit",
  },
  // 思考中の表示。色・aria-hidden はゴーストの span から継ぐ。
  // 本文の末尾に詰めて付くと本文の続きに見えるので、少しだけ間を空ける。
  // 秒数の途中で折り返さないよう nowrap にする。
  ".cm-ghost-thinking": {
    marginInlineStart: "0.5em",
    whiteSpace: "nowrap",
  },
  // ダークモード: zinc-400 を α=0.85。背景が暗いので明るめに振る。
  "@media (prefers-color-scheme: dark)": {
    ".cm-ghost-suggestion": {
      color: "rgba(161, 161, 170, 0.85)",
    },
  },
});

export function ghostSuggestionView(): Extension {
  return [ghostPlugin, ghostTheme];
}
