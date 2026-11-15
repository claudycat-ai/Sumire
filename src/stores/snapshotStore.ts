import { create } from "zustand";
import type { SnapshotPayload } from "@/domain/snapshot/snapshotApi";

/**
 * スナップショットの履歴モード状態。
 *
 * `current` が null の時は通常モード(現在の編集状態を表示)。
 * `current` が非 null の時は履歴モード:全エディタが履歴時点の内容を読み取り専用で表示する。
 */
interface SnapshotState {
  /** 現在プレビュー中のスナップショット名(`history/` 内のファイル名)。 */
  currentName: string | null;
  /** 現在プレビュー中のスナップショット内容。 */
  current: SnapshotPayload | null;
  /**
   * 履歴一覧の世代カウンタ。
   * スナップショット保存完了・復元完了などディスク上の `history/` が変化したタイミングで
   * インクリメントする。HistoryPane が変化を購読して一覧を再取得する。
   */
  historyVersion: number;
  enterPreview: (name: string, payload: SnapshotPayload) => void;
  exitPreview: () => void;
  bumpHistoryVersion: () => void;
}

export const useSnapshotStore = create<SnapshotState>((set) => ({
  currentName: null,
  current: null,
  historyVersion: 0,
  enterPreview: (name, payload) =>
    set({ currentName: name, current: payload }),
  exitPreview: () => set({ currentName: null, current: null }),
  bumpHistoryVersion: () =>
    set((s) => ({ historyVersion: s.historyVersion + 1 })),
}));

/** 履歴モードかどうかの便利フック。 */
export function isInHistoryMode(): boolean {
  return useSnapshotStore.getState().current !== null;
}
