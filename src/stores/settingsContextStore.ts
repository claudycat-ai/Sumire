import { create } from "zustand";
import type { FileCategory } from "@/domain/project/filesApi";

/**
 * `includeInContext: true` でマークされた設定ファイルの集計と内容キャッシュ。
 *
 * - count: ステータスバーに「設定情報: N 件」を表示するための件数
 * - includedFiles: lightContextBuilder が生成リクエスト時に参照する、
 *   実際の本文(フロントマター除外後)を含む集合
 *
 * 各設定ファイルの編集・トグル時に upsertFile で更新する。
 * カテゴリは UI 表示順を決めるためだけに保持する(将来 ContextBuilder が
 * 優先度判定に使えるよう)。
 */
export interface IncludedFile {
  relativePath: string;
  category: FileCategory;
  title: string;
  body: string;
}

interface SettingsContextState {
  files: Map<string, IncludedFile>;
  upsertFile: (file: IncludedFile) => void;
  removeFile: (relativePath: string) => void;
  clear: () => void;
}

export const useSettingsContextStore = create<SettingsContextState>((set) => ({
  files: new Map(),
  upsertFile: (file) =>
    set((state) => {
      const next = new Map(state.files);
      next.set(file.relativePath, file);
      return { files: next };
    }),
  removeFile: (relativePath) =>
    set((state) => {
      if (!state.files.has(relativePath)) return state;
      const next = new Map(state.files);
      next.delete(relativePath);
      return { files: next };
    }),
  clear: () => set({ files: new Map() }),
}));
