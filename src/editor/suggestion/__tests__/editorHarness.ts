/**
 * エディタのテスト用の補助(jsdom で CodeMirror の EditorView を動かす)。
 *
 * - jsdom にはレイアウトが無く、`Range` の矩形取得(`getClientRects` / `getBoundingClientRect`)が
 *   実装されていない。CodeMirror は座標の計算(`coordsAtPos`、`EditorView.scrollIntoView` の
 *   計測。採用後のスクロール追随が使う)でこれらを呼び、無いと TypeError になるので、
 *   空の矩形を返す stub を入れる。
 * - `mountSuggestionEditor` は、アプリと同じ提案拡張一式(`suggestionExtension()`)を載せた
 *   EditorView を document に取り付ける。キー操作のテストなどで別の拡張が要るときは
 *   `extensions` で足す。
 *
 * store・プロバイダ・トーストなどの差し替え(`vi.mock`)は、この補助ではなく
 * テストファイル側で行う。
 */
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { suggestionExtension } from "@/editor/suggestion";

function emptyRectList(): DOMRectList {
  const list: DOMRect[] = [];
  return Object.assign(list, {
    item: (index: number) => list[index] ?? null,
  }) as unknown as DOMRectList;
}

/** CodeMirror が jsdom で計測できるようにする stub を入れる。何度呼んでもよい。 */
export function installCodeMirrorDomStubs(): void {
  const proto = Range.prototype as Partial<Range>;
  if (typeof proto.getClientRects !== "function") {
    Range.prototype.getClientRects = emptyRectList;
  }
  if (typeof proto.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
}

export interface SuggestionEditorOptions {
  /** 初期の文書。省略時は空 */
  doc?: string;
  /** 初期のカーソル位置。省略時は文書の末尾 */
  cursor?: number;
  /** 提案拡張一式の後ろに足す拡張 */
  extensions?: Extension[];
}

export interface SuggestionEditor {
  view: EditorView;
  /** EditorView を破棄し、親要素を document から外す */
  destroy(): void;
}

const mounted = new Set<SuggestionEditor>();

/** 提案拡張一式を載せた EditorView を document に取り付ける。 */
export function mountSuggestionEditor(
  options: SuggestionEditorOptions = {},
): SuggestionEditor {
  installCodeMirrorDomStubs();
  const doc = options.doc ?? "";
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: options.cursor ?? doc.length },
      extensions: [suggestionExtension(), ...(options.extensions ?? [])],
    }),
    parent,
  });
  const editor: SuggestionEditor = {
    view,
    destroy() {
      if (!mounted.delete(editor)) return;
      view.destroy();
      parent.remove();
    },
  };
  mounted.add(editor);
  return editor;
}

/** `mountSuggestionEditor` で取り付けたまま残っているエディタをすべて破棄する(afterEach 用)。 */
export function destroyMountedEditors(): void {
  for (const editor of [...mounted]) editor.destroy();
}

/** 表示中のゴーストの要素。無ければ null */
export function ghostElement(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(".cm-ghost-suggestion");
}

/** ゴーストの中の「思考中」の表示の要素。無ければ null */
export function thinkingIndicatorElement(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(".cm-ghost-suggestion .cm-ghost-thinking");
}
