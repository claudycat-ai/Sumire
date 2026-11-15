import { create } from "zustand";
import type { EditorView } from "@codemirror/view";

/**
 * 章エディタ・設定エディタの EditorView 参照を保持する。
 *
 * ペイン間カーソル移動(Ctrl+PageUp/PageDown)、本文選択 Alt+M、
 * D&D from chapter to memo などのために、各 EditorView へ外部から触れる必要がある。
 *
 * メモエディタは別途 `memoEditorStore` を使う(M5 で先に作ったため互換性のため分離維持)。
 */
interface EditorViewState {
  chapterView: EditorView | null;
  settingsView: EditorView | null;
  setChapterView: (v: EditorView | null) => void;
  setSettingsView: (v: EditorView | null) => void;
}

export const useEditorViewStore = create<EditorViewState>((set) => ({
  chapterView: null,
  settingsView: null,
  setChapterView: (v) => set({ chapterView: v }),
  setSettingsView: (v) => set({ settingsView: v }),
}));
