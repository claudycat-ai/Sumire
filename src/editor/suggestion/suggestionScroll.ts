import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { suggestionField } from "./suggestionState";

/**
 * 提案ゴーストの末尾と、採用直後のカーソル位置を可視領域に追随させる。
 *
 * 仕様 `01-ux.md` §「スクロール追随」:
 *  - ゴースト表示時: ゴースト末尾が画面に入るようスクロール
 *  - ストリーミング中はチャンク到達ごとに末尾が伸びるため、末尾位置の変化に追随
 *  - 思考中(thinking-output spec): 本文が空でも「思考中」の表示がゴーストとして出るので
 *    追随の対象にする。表示が出た時点でも追随する(本文の末尾は変わらないため、
 *    末尾の変化の判定に思考中かどうかを含める)。表示はゴーストの子要素なので計測に含まれる
 *  - 採用時(Tab): 挿入後のカーソル位置を可視領域に
 *
 * 実装上の注意:
 *  ゴーストは `Decoration.widget` で描画される **仮想要素** で、ドキュメントの
 *  文字オフセットには寄与しない。このため `EditorView.scrollIntoView(insertPos + text.length)`
 *  ではゴーストの物理的な高さを反映できない(本文上のオフセットしか見ない)。
 *  唯一の解は描画後の DOM を取って bottom を測ること。`requestAnimationFrame` で
 *  描画完了を待ってから `getBoundingClientRect` で比較する。
 *
 *  `update` 中に直接 `scrollDOM.scrollTop` を書いても再描画ループには入らないため
 *  再帰の心配はないが、描画完了前に測ると古い座標になるので rAF で 1 ティック待つ。
 */
export function suggestionScroll(): Extension {
  return ViewPlugin.fromClass(
    class {
      view: EditorView;
      lastEnd = -1;
      lastThinking = false;

      constructor(view: EditorView) {
        this.view = view;
      }

      update(update: import("@codemirror/view").ViewUpdate) {
        const before = update.startState.field(suggestionField, false) ?? null;
        const after = update.state.field(suggestionField, false) ?? null;

        // ゴーストが表示されている(新規 or 末尾が伸びた or 思考中の表示が出入りした)
        // → 末尾を可視領域へ
        if (after && (after.text.length > 0 || after.thinkingStartedAt !== null)) {
          const afterEnd = after.insertPos + after.text.length;
          const afterThinking = after.thinkingStartedAt !== null;
          if (afterEnd !== this.lastEnd || afterThinking !== this.lastThinking) {
            this.lastEnd = afterEnd;
            this.lastThinking = afterThinking;
            // rAF で描画完了を待ってから DOM 計測
            requestAnimationFrame(() => this.scrollGhostIntoView());
          }
          return;
        }

        // ゴーストが描かれていない → 末尾追跡をリセット。
        // 本文が空のまま思考を抜けた状態(提案状態は残る)も含める。次に思考中の表示が
        // 同じ位置に出たときにも追随させるため。
        this.lastEnd = -1;
        this.lastThinking = false;

        // ゴーストが消えた
        if (before && !after) {
          // 採用時のみ、挿入後のカーソル位置を中央寄せ
          if (update.docChanged) {
            const head = update.state.selection.main.head;
            queueMicrotask(() => {
              this.view.dispatch({
                effects: EditorView.scrollIntoView(head, { y: "center" }),
              });
            });
          }
        }
      }

      /**
       * ゴースト Widget の DOM 要素を取り、scroller の可視領域より下に
       * はみ出していたらスクロールして見せる。
       */
      scrollGhostIntoView() {
        const ghost = this.view.dom.querySelector<HTMLElement>(
          ".cm-ghost-suggestion",
        );
        if (!ghost) return;
        const scroller = this.view.scrollDOM;
        const ghostRect = ghost.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        // ゴースト末尾が見える位置に来るよう、はみ出し分だけスクロールを下に動かす。
        // 余白として 8px だけ下に空ける(完全密着だと見切れた感が残る)。
        const margin = 8;
        const overflow = ghostRect.bottom + margin - scrollerRect.bottom;
        if (overflow > 0) {
          scroller.scrollTop += overflow;
        }
      }
    },
  );
}
