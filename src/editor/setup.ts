import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { rubyDecoration } from "@/editor/rubyDecoration";
import { suggestionExtension } from "@/editor/suggestion";
import { illustrationKeymap } from "@/editor/illustration/illustrationKeymap";
import { paneNavigation } from "@/editor/paneNavigation";
import { lineNumberSelect } from "@/editor/lineNumberSelect";

/**
 * Sumire 用の Markdown ハイライト調整。
 *
 * defaultHighlightStyle は `#219`(濃い青)や `#a11`(濃い赤)など、暗背景の本文・メモ・
 * 設定ペインで判読が辛い色を多用する。Sumire のテーマ(zinc 背景 + purple アクセント)に
 * 揃うよう、構造を示すトークンは薄い purple、本文・値は zinc に寄せる。
 *
 * 重要: `@lezer/markdown` は YAML フロントマターを理解しない。設定ファイルの
 * `title: 主要人物` 等は前後の `---` を SetextHeading2 のアンダーラインと解釈され、
 * `tags.heading2` として塗られている。`tags.heading` だけ指定しても heading1〜6 の
 * 個別タグに上書きされるので、heading2 を明示的に指定する必要がある。
 *
 * HeaderMark(`#` や setext のアンダーライン `---`)は `tags.processingInstruction`。
 */
const sumireHighlightStyle = HighlightStyle.define([
  // 区切り(`***` `---` の HorizontalRule): 構造を示す要素は薄い purple
  { tag: tags.contentSeparator, color: "rgb(168 85 247 / 0.7)" },
  // 見出し: heading1〜6 を個別指定して purple にまとめる
  // (`tags.heading` だけだと defaultHighlightStyle の heading1/2 個別指定に負ける)
  {
    tag: [
      tags.heading,
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ],
    fontWeight: "bold",
    color: "rgb(192 132 252)" /* purple-400 */,
    textDecoration: "none",
  },
  // 見出し記号 (`#` `##` 等) や引用記号などのマーク類: 控えめな zinc
  { tag: tags.processingInstruction, color: "rgb(113 113 122)" /* zinc-500 */ },
  // リンク・URL: アクセントとして残す
  { tag: [tags.link, tags.url], color: "rgb(161 161 170)" /* zinc-400 */ },
  // 強調: 装飾のみで色は本文寄り
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  // インラインコード: 本文より少し落とす
  { tag: tags.monospace, color: "rgb(212 212 216)" /* zinc-300 */ },
]);

/**
 * Sumire のエディタ用拡張セット。
 *
 * `disableSuggestion` が true の場合、提案 UX(Shift+Enter / Tab / Esc / Alt+]/[)と、
 * 挿し絵の情景文のキー(Alt+I / Esc)を組み込まない。設定タブのエディタなど、
 * AI による続き生成が不要な場面で使う。
 */
export function buildEditorExtensions(opts: {
  onChange: (doc: string) => void;
  readOnly?: boolean;
  disableSuggestion?: boolean;
}): Extension[] {
  return [
    basicSetup,
    // basicSetup の lineNumbers() を、クリック行選択ハンドラ付きに上書きする
    // (後勝ちで適用される)。
    lineNumberSelect(),
    history(),
    // suggestionExtension は内部で Prec.high キーマップを持っているため、
    // ここでの defaultKeymap より先に登録する必要は無い(優先度で勝つ)。
    ...(opts.disableSuggestion ? [] : [suggestionExtension()]),
    // 挿し絵の情景文の Alt+I / Esc。提案と同じ Prec.high で、提案の直後に置く。
    // 同じ優先度では配列の前が先に評価されるので、Esc は提案の停止・却下が優先される。
    // 提案を無効にしたエディタ(メモ・設定・履歴プレビュー)には入れない。
    ...(opts.disableSuggestion ? [] : [illustrationKeymap()]),
    paneNavigation(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(),
    syntaxHighlighting(sumireHighlightStyle),
    rubyDecoration(),
    EditorView.lineWrapping,
    EditorView.editable.of(!opts.readOnly),
    EditorView.theme({
      "&": {
        height: "100%",
        fontSize: "14px",
        backgroundColor: "transparent",
        color: "inherit",
      },
      ".cm-scroller": {
        fontFamily:
          "var(--font-serif), 'Hiragino Mincho ProN', 'Yu Mincho', 'MS Mincho', serif",
      },
      ".cm-content": {
        padding: "16px",
        caretColor: "rgb(168 85 247)" /* purple-500 */,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftWidth: "2px",
        borderLeftColor: "rgb(168 85 247)" /* purple-500 */,
      },
      ".cm-line": {
        padding: "0 4px",
      },
      // 行番号エリアと折り畳みガターをアプリのテーマに馴染ませる
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "rgb(113 113 122)" /* zinc-500 */,
        border: "none",
        borderRight: "1px solid rgba(113, 113, 122, 0.2)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "rgb(168 85 247)" /* purple-500 */,
      },
      ".cm-activeLine": {
        backgroundColor: "rgba(168, 85, 247, 0.06)",
      },
      // 選択範囲の色
      "&.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: "rgba(168, 85, 247, 0.25)",
      },
      // ゴーストテキスト直下の改行ぶら下がりを安定させる
      ".cm-ghost-suggestion": {
        userSelect: "none",
      },
      // フォーカス時のアウトラインを抑える
      "&.cm-focused": {
        outline: "none",
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        opts.onChange(update.state.doc.toString());
      }
    }),
  ];
}

/** 初期状態(空)の EditorState を作る。 */
export function makeInitialState(doc: string, extensions: Extension[]): EditorState {
  return EditorState.create({ doc, extensions });
}
