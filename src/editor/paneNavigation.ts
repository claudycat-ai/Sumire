import { Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEditorViewStore } from "@/stores/editorViewStore";
import { useMemoEditorStore } from "@/stores/memoEditorStore";

/**
 * 本文 / メモ / 設定 の 3 ペイン間でフォーカスをサイクル移動する。
 *
 * Ctrl+PageDown : 本文 → メモ → 設定 → 本文…
 * Ctrl+PageUp   : 逆順
 *
 * いずれかのペインのエディタが未マウント(=設定ファイル未選択など)ならスキップする。
 * 全ペイン共通で同じ拡張を登録する想定。
 */

type Pane = "chapter" | "memo" | "settings";
const ORDER: Pane[] = ["chapter", "memo", "settings"];

function getView(pane: Pane): EditorView | null {
  switch (pane) {
    case "chapter":
      return useEditorViewStore.getState().chapterView;
    case "memo":
      return useMemoEditorStore.getState().view;
    case "settings":
      return useEditorViewStore.getState().settingsView;
  }
}

function detectPane(view: EditorView): Pane | null {
  for (const p of ORDER) {
    if (getView(p) === view) return p;
  }
  return null;
}

function focusNext(view: EditorView, dir: 1 | -1): boolean {
  const current = detectPane(view);
  if (!current) return false;
  const len = ORDER.length;
  let idx = ORDER.indexOf(current);
  for (let i = 0; i < len; i++) {
    idx = (idx + dir + len) % len;
    const next = ORDER[idx];
    const target = getView(next);
    if (target && target !== view) {
      target.focus();
      return true;
    }
  }
  return false;
}

export function paneNavigation(): Extension {
  return Prec.high(
    keymap.of([
      { key: "Ctrl-PageDown", run: (v) => focusNext(v, 1) },
      { key: "Ctrl-PageUp", run: (v) => focusNext(v, -1) },
    ]),
  );
}
