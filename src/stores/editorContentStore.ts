import { create } from "zustand";

/**
 * 現在エディタで開いている本文の最新スナップショット。
 * 文字数カウントなど「他コンポーネントから本文を参照したい」用途のためのストア。
 *
 * エディタが閉じている時は null。
 */
interface EditorContentState {
  doc: string | null;
  setDoc: (doc: string | null) => void;
}

export const useEditorContentStore = create<EditorContentState>((set) => ({
  doc: null,
  setDoc: (doc) => set({ doc }),
}));
