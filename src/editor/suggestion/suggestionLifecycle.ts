import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  clearSuggestionEffect,
  suggestionField,
  type SuggestionState,
} from "./suggestionState";
import { abortInflight } from "./suggestionController";

/**
 * 提案のライフサイクル管理(自動キャンセル)。
 *
 * 仕様 `01-ux.md` 提案のキャンセル挙動 / ストリーミング表示:
 *  - 提案表示中に文字を入力 → キャンセル
 *  - 提案表示中にカーソルを挿入位置から動かす → キャンセル
 *  - ストリーミング生成中に上記が起きた場合は HTTP リクエストも中断する
 *
 * IME(変換中)の特別扱いはしない:
 *  ユーザーが IME を起動した時点で「自分で書こうとしている」意思表示と解釈する。
 *  変換確定前であってもゴーストは消す方が UX として一貫する。
 *
 * 実装方針:
 *  - ViewPlugin の update で「docChanged」または「カーソルが insertPos から離れた」を検知してキャンセル。
 *  - 自分で投げた setSuggestionEffect / clearSuggestionEffect だけが乗ったトランザクションでは
 *    docChanged も selection 変化も起きない(候補挿入は accept 側で完結)ので、誤検出しない。
 *  - キャンセル時は `abortInflight()` で進行中の HTTP リクエストも併せて切断する。
 *  - 提案を消す dispatch は、更新が終わってから(マイクロタスクで)行う。CodeMirror は更新中の
 *    dispatch を許さず、例外を投げてこのプラグインごと無効にするため。文字入力と同じ
 *    トランザクションで消さないのは、採用時だけ走るスクロール(`suggestionScroll` の
 *    「消えた + 文書が変わった」)と区別するため。
 */
export function suggestionLifecycle(): Extension {
  return ViewPlugin.fromClass(
    class {
      view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
      }

      update(update: import("@codemirror/view").ViewUpdate) {
        const before = update.startState.field(suggestionField, false);
        if (!before) return;

        // 提案が今のトランザクションで明示的にクリア/設定された場合は介入しない
        const after = update.state.field(suggestionField, false);
        if (before !== after) return;

        if (update.docChanged) {
          this.cancel(before);
          return;
        }
        if (update.selectionSet) {
          const head = update.state.selection.main.head;
          if (head !== before.insertPos) {
            this.cancel(before);
          }
        }
      }

      cancel(target: SuggestionState) {
        // 進行中の HTTP リクエストを切断(ストリーミング中なら無駄なバイト消費を防ぐ)
        abortInflight();
        const view = this.view;
        queueMicrotask(() => {
          // その間に別の提案が表示された・既に消えた場合は触らない
          if (view.state.field(suggestionField, false) !== target) return;
          view.dispatch({ effects: clearSuggestionEffect.of(null) });
        });
      }
    },
  );
}
