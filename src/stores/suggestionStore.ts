import { create } from "zustand";

/**
 * 提案 UX のうち、エディタ外(ステータスバー等)から参照したいフラグだけを保持するストア。
 *
 * 候補配列・index・挿入位置などゴーストテキスト描画に必要な状態は CodeMirror の
 * StateField 側に閉じ込めてある(src/editor/suggestion)。
 */
interface SuggestionUiState {
  /** 推論サーバーへの提案要求が進行中。 */
  generating: boolean;
  setGenerating: (v: boolean) => void;
}

export const useSuggestionStore = create<SuggestionUiState>((set) => ({
  generating: false,
  setGenerating: (v) => set({ generating: v }),
}));
