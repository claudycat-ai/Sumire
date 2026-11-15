import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileCategory } from "@/domain/project/filesApi";
import type { ProviderId } from "@/domain/providers/types";

/**
 * react-resizable-panels v4 の Layout 形(panelId → flexGrow 値)。
 * 初回(未保存)は null。`Group.defaultLayout` に渡すと続きから復元できる。
 */
export type PanelLayout = Record<string, number>;

interface UILayoutState {
  chapterGroupLayout: PanelLayout | null;
  rightColumnLayout: PanelLayout | null;

  fileTreeCategoryExpanded: Record<FileCategory, boolean>;
  fileTreeArchivedExpanded: Record<FileCategory, boolean>;

  llmSwitcherExpanded: boolean;
  llmProviderExpanded: Record<ProviderId, boolean>;

  historyPaneExpanded: boolean;

  setChapterGroupLayout: (layout: PanelLayout) => void;
  setRightColumnLayout: (layout: PanelLayout) => void;
  toggleFileTreeCategory: (category: FileCategory) => void;
  toggleFileTreeArchived: (category: FileCategory) => void;
  toggleLLMSwitcher: () => void;
  toggleLLMProvider: (id: ProviderId) => void;
  toggleHistoryPane: () => void;
}

const DEFAULT_CATEGORY_EXPANDED: Record<FileCategory, boolean> = {
  chapters: true,
  characters: true,
  worldbuilding: true,
  glossary: true,
  plot: true,
};

const DEFAULT_ARCHIVED_EXPANDED: Record<FileCategory, boolean> = {
  chapters: false,
  characters: false,
  worldbuilding: false,
  glossary: false,
  plot: false,
};

const DEFAULT_PROVIDER_EXPANDED: Record<ProviderId, boolean> = {
  "openai-compatible": true,
  openai: true,
  "llama-server": true,
};

/**
 * UI レイアウト永続化ストア(per-machine, localStorage)。
 *
 * 対象:
 * - スプリットバー位置(中央 vertical / 右ペイン内 horizontal)
 * - ファイルツリーのカテゴリ折りたたみ + アーカイブサブグループ折りたたみ
 * - LLM 切替ペインのヘッダ折りたたみ + プロバイダ行折りたたみ
 * - 履歴ペインのヘッダ折りたたみ
 *
 * プロジェクト切替で変わらない(カテゴリ・プロバイダ識別子は固定)ためグローバル保存。
 * 章ファイル選択や AI 設定値などの「コンテンツ寄り」は別ストアで管理。
 */
export const useUILayoutStore = create<UILayoutState>()(
  persist(
    (set) => ({
      chapterGroupLayout: null,
      rightColumnLayout: null,
      fileTreeCategoryExpanded: DEFAULT_CATEGORY_EXPANDED,
      fileTreeArchivedExpanded: DEFAULT_ARCHIVED_EXPANDED,
      llmSwitcherExpanded: true,
      llmProviderExpanded: DEFAULT_PROVIDER_EXPANDED,
      historyPaneExpanded: true,

      setChapterGroupLayout: (layout) => set({ chapterGroupLayout: layout }),
      setRightColumnLayout: (layout) => set({ rightColumnLayout: layout }),
      toggleFileTreeCategory: (category) =>
        set((state) => ({
          fileTreeCategoryExpanded: {
            ...state.fileTreeCategoryExpanded,
            [category]: !state.fileTreeCategoryExpanded[category],
          },
        })),
      toggleFileTreeArchived: (category) =>
        set((state) => ({
          fileTreeArchivedExpanded: {
            ...state.fileTreeArchivedExpanded,
            [category]: !state.fileTreeArchivedExpanded[category],
          },
        })),
      toggleLLMSwitcher: () =>
        set((state) => ({ llmSwitcherExpanded: !state.llmSwitcherExpanded })),
      toggleLLMProvider: (id) =>
        set((state) => ({
          llmProviderExpanded: {
            ...state.llmProviderExpanded,
            [id]: !state.llmProviderExpanded[id],
          },
        })),
      toggleHistoryPane: () =>
        set((state) => ({ historyPaneExpanded: !state.historyPaneExpanded })),
    }),
    {
      name: "sumire-ui-layout",
      version: 1,
      // 既定の merge は 1 段目だけを上書きするので、プロバイダの種別が増える前に保存した
      // `llmProviderExpanded` には新しい種別のキーが無い。既定値に重ねて補う。
      merge: (persisted, current) => {
        const saved =
          persisted != null && typeof persisted === "object"
            ? (persisted as Partial<UILayoutState>)
            : {};
        return {
          ...current,
          ...saved,
          llmProviderExpanded: {
            ...current.llmProviderExpanded,
            ...saved.llmProviderExpanded,
          },
        };
      },
    },
  ),
);
