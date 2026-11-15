/**
 * WebView 標準のコンテキストメニュー(戻る・最新の情報に更新・印刷・名前を付けて保存
 * 等)が Sumire のアプリ内で出るのは違和感が強いため、`window` レベルで
 * `contextmenu` イベントの既定動作を抑止する。
 *
 * ただし入力系の要素では抑止しない:
 * - `<input>` / `<textarea>`(コピペ・スペルチェック・候補メニュー等が必要)
 * - `[contenteditable="true"]` 配下(CodeMirror のエディタ DOM もここに含まれる)
 *
 * 使い方:
 *   - `main.tsx` から起動時に 1 回だけ `installContextmenuGuard()` を呼ぶ。
 *   - 戻り値の disposer は通常運用では使わないが、テスト等で listener を
 *     解除したい場合に利用できる。
 */
export function installContextmenuGuard(): () => void {
  function handler(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
      // テキストノード等は通常 contextmenu の target にならないが、念のため抑止対象とする
      event.preventDefault();
      return;
    }

    if (target instanceof HTMLInputElement) return;
    if (target instanceof HTMLTextAreaElement) return;
    if (target.closest('[contenteditable="true"]') !== null) return;

    event.preventDefault();
  }

  window.addEventListener("contextmenu", handler);
  return () => {
    window.removeEventListener("contextmenu", handler);
  };
}
