import { create } from "zustand";

/**
 * 挿し絵の情景文の生成のうち、エディタ外(ステータスバー、続き生成の開始の条件)から
 * 参照したい状態だけを保持するストア。
 *
 * 進行中の生成そのもの(AbortController やプロジェクトの購読)は
 * src/editor/illustration のコントローラがモジュール内に持つ。
 */
interface IllustrationUiState {
  /** 生成を始めた時刻(ms)。生成中でなければ null。 */
  startedAt: number | null;
  start: (now: number) => void;
  finish: () => void;
}

export const useIllustrationStore = create<IllustrationUiState>((set) => ({
  startedAt: null,
  start: (now) => set({ startedAt: now }),
  finish: () => set({ startedAt: null }),
}));
