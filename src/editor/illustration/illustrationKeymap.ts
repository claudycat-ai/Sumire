import { keymap } from "@codemirror/view";
import { Extension, Prec } from "@codemirror/state";
import { requestIllustration, stopIllustration } from "./illustrationController";

/**
 * 挿し絵の情景文のキーバインド(`illustration-prompt` spec の design.md「illustrationKeymap」)。
 *
 *   Alt+I : 情景文の生成を始める(要件 1.1, 1.2)。条件を満たさないときもキーは吸う
 *   Esc   : 情景文の生成中なら中止する(要件 5.3)。生成中でなければ false を返し、キーを下に流す
 *
 * `setup.ts` で `suggestionExtension()` の直後に、同じ「提案を無効にしたエディタには入れない」
 * 条件で置く(要件 1.5)。提案の keymap と同じ `Prec.high` なので、配列の前にある提案の keymap が
 * 先に評価され、Esc は提案の停止・却下が優先される。提案側が処理しなかったときだけ、
 * 情景文の中止に届く(要件 5.4)。
 */
export function illustrationKeymap(): Extension {
  return Prec.high(
    keymap.of([
      { key: "Alt-i", run: requestIllustration },
      { key: "Escape", run: stopIllustration },
    ]),
  );
}
