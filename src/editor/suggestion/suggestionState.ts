import { StateEffect, StateField } from "@codemirror/state";

/**
 * ゴーストテキストとして表示される提案。
 *
 * - text: 表示中のテキスト(ストリーミング中はチャンク到達ごとに伸びる)
 * - insertPos: 提案表示時のカーソル位置(=ゴーストが描画される位置)。
 *              この位置からカーソルが離れた時点で自動キャンセルする。
 * - streaming: true の間は生成中。Tab 採用と Alt+M 転記は無効化される。
 *              false で確定状態(通常の提案表示)。
 * - thinkingStartedAt: 思考ブロックを受信している間だけ、そのブロックの開始時刻(Date.now())。
 *              それ以外は null。非 null のとき streaming は必ず true。
 *              思考中は text が空でも null(提案非表示)にしない。思考中の文字入力や
 *              カーソル移動でも、ライフサイクルの暗黙のキャンセルを働かせるため。
 *
 * 提案非表示時は null。
 *
 * 別案サイクル機能は M8 で撤去済み(常に 1 案)。サイクル比較より
 * 「メモに退避 → 再生成」の動線が太いという運用判断による。
 */
export interface SuggestionState {
  text: string;
  insertPos: number;
  streaming: boolean;
  thinkingStartedAt: number | null;
}

export const setSuggestionEffect = StateEffect.define<SuggestionState>();
export const clearSuggestionEffect = StateEffect.define<null>();

export const suggestionField = StateField.define<SuggestionState | null>({
  create: () => null,
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setSuggestionEffect)) {
        next = e.value;
      } else if (e.is(clearSuggestionEffect)) {
        next = null;
      }
    }
    return next;
  },
});

/** 現在表示中の提案テキストを取り出す。提案非表示なら null。 */
export function currentSuggestionText(state: SuggestionState | null): string | null {
  if (!state || state.text.length === 0) return null;
  return state.text;
}
