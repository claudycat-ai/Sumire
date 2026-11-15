import { EditorSelection, Extension, SelectionRange } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";

/**
 * 行番号クリックで「行頭から次の行頭まで」を選択する拡張。
 *
 * basicSetup が含む `lineNumbers()` を `domEventHandlers` 付きの版で
 * 上書きする(後勝ちで適用される)。
 *
 * 仕様:
 *   - クリック: その行を単独選択。既存選択は置き換え。
 *   - Shift+クリック: 既存選択のアンカー位置から、クリックした行までを
 *     1 つの範囲に拡張。
 *   - Ctrl/Cmd+クリック: 既存選択を残したまま、クリックした行を追加範囲
 *     として加える(マルチセレクション)。
 *   - ドラッグ: mousedown した行をアンカーとして、ドラッグ中の行までを
 *     連続的に範囲更新。Ctrl/Cmd 押下中は既存選択を残したまま追加。
 *
 * 行範囲の作り方:
 *   - 通常行: 行頭(line.from) から次の行頭(line.to + 1) まで。
 *     改行を含むので、そのまま Delete / Cut すると行ごと消える(Sublime 流)。
 *   - 最終行: 次の行頭が無いので line.from..line.to(行末) で止める。
 *
 * 触発元: docs/spec/polish-backlog.md「行番号クリックで行選択」
 *         (dogfooding 2026-05-07、VS Code 等で標準の挙動)
 */
export function lineNumberSelect(): Extension {
  return lineNumbers({
    domEventHandlers: {
      mousedown(view, block, event) {
        const e = event as MouseEvent;
        if (e.button !== 0) return false;

        const anchorLineNumber = view.state.doc.lineAt(block.from).number;
        const additive = e.ctrlKey || e.metaKey;
        const extending = e.shiftKey && !additive;

        if (extending) {
          applyShiftExtend(view, anchorLineNumber);
        } else {
          applyDragSelection(view, anchorLineNumber, anchorLineNumber, additive);
        }

        // ドラッグ追従: document に move/up を張って、行番号ガター外に出ても
        // 行をまたいだ範囲更新を続けられるようにする。Shift+クリック時は
        // ドラッグ追従を有効にしないほうが自然(VS Code もそう振る舞う)。
        if (!extending) {
          startDragTracking(view, anchorLineNumber, additive);
        }

        view.focus();
        e.preventDefault();
        return true;
      },
    },
  });
}

/**
 * 行範囲の作り方(line.number → SelectionRange)。
 * 範囲の向き(anchor < head か anchor > head か)は呼び出し側で決める。
 */
function lineRangeBetween(
  view: EditorView,
  anchorLineNumber: number,
  headLineNumber: number,
): SelectionRange {
  const doc = view.state.doc;
  const anchorLine = doc.line(anchorLineNumber);
  const headLine = doc.line(headLineNumber);
  if (anchorLineNumber <= headLineNumber) {
    // 下方向に伸びる: アンカーは行頭、ヘッドは headLine の次の行頭まで
    const isLast = headLine.number === doc.lines;
    const head = isLast ? headLine.to : headLine.to + 1;
    return EditorSelection.range(anchorLine.from, head);
  }
  // 上方向に伸びる: アンカーは anchorLine の次の行頭、ヘッドは headLine の行頭
  const isAnchorLast = anchorLine.number === doc.lines;
  const anchor = isAnchorLast ? anchorLine.to : anchorLine.to + 1;
  return EditorSelection.range(anchor, headLine.from);
}

/**
 * Shift+クリック: 現在の主選択のアンカー側を起点として、クリック行までを
 * 1 範囲にまとめる。アンカー側の行頭 / 次の行頭は適宜揃える。
 */
function applyShiftExtend(view: EditorView, headLineNumber: number) {
  const main = view.state.selection.main;
  const anchorLine = view.state.doc.lineAt(main.anchor);
  const range = lineRangeBetween(view, anchorLine.number, headLineNumber);
  view.dispatch({
    selection: EditorSelection.create(
      [
        ...view.state.selection.ranges.slice(0, view.state.selection.mainIndex),
        range,
        ...view.state.selection.ranges.slice(view.state.selection.mainIndex + 1),
      ],
      view.state.selection.mainIndex,
    ),
  });
}

/**
 * 通常クリック / Ctrl+クリック / ドラッグ更新の選択を反映する。
 *
 * additive=true なら既存選択を残して新しい範囲を追加(マルチセレクション)。
 * false なら既存選択を置き換える。
 *
 * ドラッグ中は同じ呼び出しを連続で行うため、additive 時は「ドラッグ開始時に
 * 追加した範囲」だけを差し替える必要がある(=過去の選択は保持、自分が追加した
 * 範囲だけ更新)。これを ID で管理するのは大げさなので、additive 時は
 * 「mainIndex の範囲をドラッグ範囲として上書きする」運用にする。
 * (mousedown 時に範囲を末尾に追加 → mainIndex を末尾に → ドラッグ中は
 *  mainIndex を更新)。
 */
function applyDragSelection(
  view: EditorView,
  anchorLineNumber: number,
  headLineNumber: number,
  additive: boolean,
) {
  const range = lineRangeBetween(view, anchorLineNumber, headLineNumber);
  if (!additive) {
    view.dispatch({ selection: EditorSelection.create([range], 0) });
    return;
  }
  // additive: 既存選択(主含む全範囲)を残して末尾に新範囲を追加・更新する。
  // mousedown 直後の呼び出しでは末尾が「クリック行 1 行」、ドラッグ中は
  // 同じ末尾要素が更新される、という形になる。これを実現するため、
  // 既存 ranges のうち「アンカー行から始まり 1 行ぶんの範囲」と一致する
  // 末尾要素があればそれを置き換え、なければ末尾に追加する。
  const existing = view.state.selection.ranges;
  const last = existing[existing.length - 1];
  // 末尾範囲がドラッグ中の自分自身か判定: アンカー行頭から始まる範囲なら自分。
  const lastAnchorLine = last
    ? view.state.doc.lineAt(Math.min(last.from, last.to)).number
    : -1;
  const isOurOwnRange =
    last !== undefined &&
    (lastAnchorLine === anchorLineNumber ||
      // 上方向ドラッグの場合、last.from は head 行頭になっているので
      // anchor 行は last.to の側にいる
      (last.to !== last.from && view.state.doc.lineAt(last.to).number === anchorLineNumber));

  let nextRanges: SelectionRange[];
  let nextMainIndex: number;
  if (isOurOwnRange) {
    nextRanges = [...existing.slice(0, -1), range];
    nextMainIndex = nextRanges.length - 1;
  } else {
    nextRanges = [...existing, range];
    nextMainIndex = nextRanges.length - 1;
  }
  view.dispatch({ selection: EditorSelection.create(nextRanges, nextMainIndex) });
}

/**
 * ドラッグ中の行追従。document に move/up を張って、行番号ガター外
 * (本文側にカーソルが流れたとき)でも当該 Y 座標から行を逆引きして
 * 範囲を更新する。
 */
function startDragTracking(
  view: EditorView,
  anchorLineNumber: number,
  additive: boolean,
) {
  let lastHead = anchorLineNumber;
  const onMove = (e: MouseEvent) => {
    if (e.buttons === 0) {
      // ボタンが離れていたら念のため終了(mouseup を取りこぼした場合の保険)
      cleanup();
      return;
    }
    const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
    const headLine = view.state.doc.lineAt(block.from).number;
    if (headLine === lastHead) return;
    lastHead = headLine;
    applyDragSelection(view, anchorLineNumber, headLine, additive);
  };
  const onUp = () => cleanup();
  const cleanup = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
