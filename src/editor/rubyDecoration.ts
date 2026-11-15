import { Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/**
 * カクヨム式ルビ記法の厳密形 |ベース《ふりがな》 を装飾する。
 * 簡易記法(パイプ無し)はサポートしない。
 *
 * 装飾内容:
 *  - パイプ「|」と山括弧「《》」を薄く表示
 *  - ふりがな部分を小さめのグレー字で表示
 *  - ベース文字はそのまま
 */

const rubyMarkDeco = Decoration.mark({ class: "cm-ruby-mark" });
const rubyReadingDeco = Decoration.mark({ class: "cm-ruby-reading" });

// `|` 必須、`《》` 内側は山括弧と改行を含まない 1〜32 文字程度
// ベースは改行と `|` `《》` を含まない
const RUBY_PATTERN = /\|([^\n|《》]+?)《([^\n《》]+?)》/g;

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    let match: RegExpExecArray | null;
    RUBY_PATTERN.lastIndex = 0;
    while ((match = RUBY_PATTERN.exec(text)) !== null) {
      const matchStart = from + match.index;
      const baseText = match[1];
      const readingText = match[2];

      // |
      const pipeFrom = matchStart;
      const pipeTo = pipeFrom + 1;

      // ベース文字
      const baseFrom = pipeTo;
      const baseTo = baseFrom + baseText.length;

      // 《
      const openFrom = baseTo;
      const openTo = openFrom + 1;

      // ふりがな
      const readingFrom = openTo;
      const readingTo = readingFrom + readingText.length;

      // 》
      const closeFrom = readingTo;
      const closeTo = closeFrom + 1;

      builder.add(pipeFrom, pipeTo, rubyMarkDeco);
      // ベース文字は装飾しない
      builder.add(openFrom, openTo, rubyMarkDeco);
      builder.add(readingFrom, readingTo, rubyReadingDeco);
      builder.add(closeFrom, closeTo, rubyMarkDeco);

      // ループの暴走防止(マッチ長 0 は本来発生しないが念のため)
      if (match.index === RUBY_PATTERN.lastIndex) RUBY_PATTERN.lastIndex++;
    }
  }

  return builder.finish();
}

const rubyPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

const rubyTheme = EditorView.theme({
  ".cm-ruby-mark": {
    color: "rgba(168, 85, 247, 0.55)" /* purple-500 半透明 */,
  },
  ".cm-ruby-reading": {
    fontSize: "0.8em",
    color: "rgb(113 113 122)" /* zinc-500 */,
  },
});

export function rubyDecoration(): Extension {
  return [rubyPlugin, rubyTheme];
}

/**
 * テキストからルビ記法を取り除いた本文だけを返す。
 * 文字数カウント用。
 *
 * 例: "私は|彼《かれ》と歩いた" → "私は彼と歩いた"
 */
export function stripRuby(text: string): string {
  return text.replace(/\|([^\n|《》]+?)《[^\n《》]+?》/g, "$1");
}
