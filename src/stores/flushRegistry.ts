import { create } from "zustand";

/**
 * 各エディタ(章 / 設定 / メモ)の「保留中の保存を即時フラッシュする」関数を集約するレジストリ。
 *
 * Ctrl+S(スナップショット保存)時に、各エディタのデバウンス中の onChange を確実に
 * ディスクへ反映するために使う。各エディタがマウント時に flush 関数を register、
 * アンマウント時に unregister する。
 */
type FlushFn = () => Promise<void>;

interface FlushRegistry {
  /** key は識別用(章: 'chapter:<path>'、設定: 'settings:<path>'、メモ: 'memo')。 */
  flushers: Map<string, FlushFn>;
  register: (key: string, fn: FlushFn) => void;
  unregister: (key: string) => void;
}

export const useFlushRegistry = create<FlushRegistry>((set, get) => ({
  flushers: new Map(),
  register: (key, fn) => {
    const next = new Map(get().flushers);
    next.set(key, fn);
    set({ flushers: next });
  },
  unregister: (key) => {
    const current = get().flushers;
    if (!current.has(key)) return;
    const next = new Map(current);
    next.delete(key);
    set({ flushers: next });
  },
}));

/** 登録されている全エディタの flush を並列実行して待つ。 */
export async function flushAll(): Promise<void> {
  const fns = Array.from(useFlushRegistry.getState().flushers.values());
  await Promise.all(fns.map((f) => f()));
}
