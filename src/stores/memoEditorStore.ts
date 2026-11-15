import { create } from "zustand";
import type { EditorView } from "@codemirror/view";

/**
 * メモペインの EditorView 参照を保持する。
 *
 * 提案転記(Ctrl+Shift+M)時に suggestionController からこのビューに直接挿入することで、
 * エディタ内の未保存編集とのコンフリクトを避け、即座に画面に反映する。
 *
 * MemoPane のマウント・アンマウントで set/clear する。
 */
interface MemoEditorState {
  view: EditorView | null;
  setView: (view: EditorView | null) => void;
}

export const useMemoEditorStore = create<MemoEditorState>((set) => ({
  view: null,
  setView: (view) => set({ view }),
}));
