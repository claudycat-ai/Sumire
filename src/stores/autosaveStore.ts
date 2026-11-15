import { create } from "zustand";

/** オートセーブの状態。 */
export type SaveStatus =
  | { kind: "idle" } // 編集していないか、まだ何も読み込んでいない
  | { kind: "dirty" } // 編集された、デバウンス待ち
  | { kind: "saving" } // ディスクに書き込み中
  | { kind: "saved"; at: number } // 最後に保存した Unix epoch ms
  | { kind: "error"; message: string };

interface AutosaveState {
  /** 現在エディタで開いているファイルの相対パス。null は未選択。 */
  activeRelativePath: string | null;
  status: SaveStatus;

  /** ファイル切替時に呼ぶ。新しいパスを記録、状態を idle に戻す。 */
  setActiveFile: (relativePath: string | null) => void;
  /** 編集が起きた時に呼ぶ。dirty 状態にする。 */
  markDirty: () => void;
  /** 書き込み開始時に呼ぶ。 */
  markSaving: () => void;
  /** 書き込み成功時に呼ぶ。 */
  markSaved: () => void;
  /** 書き込み失敗時に呼ぶ。 */
  markError: (message: string) => void;
}

export const useAutosaveStore = create<AutosaveState>((set) => ({
  activeRelativePath: null,
  status: { kind: "idle" },

  setActiveFile: (relativePath) =>
    set({ activeRelativePath: relativePath, status: { kind: "idle" } }),
  markDirty: () => set({ status: { kind: "dirty" } }),
  markSaving: () => set({ status: { kind: "saving" } }),
  markSaved: () => set({ status: { kind: "saved", at: Date.now() } }),
  markError: (message) => set({ status: { kind: "error", message } }),
}));
