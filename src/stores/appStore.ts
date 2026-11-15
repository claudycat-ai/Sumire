import { create } from "zustand";
import { categoryKind, type FileCategory } from "@/domain/project/filesApi";
import type { ProviderId } from "@/domain/providers/types";

export type Screen = "welcome" | "project";

/**
 * 設定パネル(右下ペイン)のアクティブタブ識別子。
 * - `FileCategory`(characters / worldbuilding / glossary / plot): 既存の設定エディタタブ
 * - `"ai"`: AI プロバイダ設定タブ(cloud-providers spec で追加、AISettingsPane を表示)
 */
export type SettingsTab = FileCategory | "ai";

export interface ProjectMeta {
  path: string;
  title: string;
  lastOpenedAt?: string;
}

export interface SelectedFile {
  category: FileCategory;
  /** プロジェクトルートからの相対パス(POSIX 区切り)。 */
  relativePath: string;
  /** ファイル名(拡張子含む)。 */
  name: string;
}

interface AppState {
  screen: Screen;
  currentProject: ProjectMeta | null;
  /**
   * 上ペインに表示する章ファイル。章ファイルがクリックされた時にだけ更新する。
   * 設定ファイルをクリックしても保持され続ける。
   */
  selectedChapter: SelectedFile | null;
  /**
   * カテゴリごとに「最後に開いていた設定ファイル」を保持する。
   * 設定ペインはアクティブタブのカテゴリでこのマップを引いてエディタ内容を決める。
   * これにより、タブを切り替えても各カテゴリの編集対象が独立して保たれる。
   */
  selectedSettingsByCategory: Partial<Record<FileCategory, SelectedFile>>;
  /**
   * 左ペインのファイル一覧でハイライトする「最後にクリックされた」ファイル。
   * カテゴリ問わず常に最新に更新される。
   */
  selectedFile: SelectedFile | null;
  /**
   * AI タブで現在編集対象としているプロバイダ識別子。
   * LLMSwitcherPane の行クリックで更新される。null は未選択(プレースホルダー表示)。
   */
  selectedAIProvider: ProviderId | null;
  /**
   * 設定パネルで現在アクティブなタブ。
   * 既存はキャラ設定固定だったが、cloud-providers spec で「AI」タブが追加され
   * 全タブクリックで切替可能になる(task 8.1 で SettingsTabBar 側を有効化)。
   */
  activeSettingsTab: SettingsTab;

  setScreen: (screen: Screen) => void;
  setCurrentProject: (project: ProjectMeta | null) => void;
  setSelectedFile: (file: SelectedFile | null) => void;
  selectAIProvider: (id: ProviderId | null) => void;
  setActiveSettingsTab: (tab: SettingsTab) => void;
}

/**
 * 設定ペインで「いま表示すべき設定ファイル」を返す派生セレクタ。
 * - AI タブのときは null(SettingsPane 側で AISettingsPane を出す分岐に使う)
 * - それ以外はアクティブタブのカテゴリで最後に開いていたファイル(無ければ null = プレースホルダ)
 */
export function selectSelectedSettings(state: AppState): SelectedFile | null {
  if (state.activeSettingsTab === "ai") return null;
  return state.selectedSettingsByCategory[state.activeSettingsTab] ?? null;
}

export const useAppStore = create<AppState>((set) => ({
  screen: "welcome",
  currentProject: null,
  selectedChapter: null,
  selectedSettingsByCategory: {},
  selectedFile: null,
  selectedAIProvider: null,
  activeSettingsTab: "characters",

  setScreen: (screen) => set({ screen }),
  setCurrentProject: (project) =>
    set({
      currentProject: project,
      screen: project ? "project" : "welcome",
      // プロジェクトを切り替えたら選択中ファイルもリセット
      selectedFile: null,
      selectedChapter: null,
      selectedSettingsByCategory: {},
      selectedAIProvider: null,
      activeSettingsTab: "characters",
    }),
  setSelectedFile: (file) =>
    set((state) => {
      if (file === null) {
        return { selectedFile: null };
      }
      const kind = categoryKind(file.category);
      if (kind === "chapter") {
        return {
          selectedFile: file,
          selectedChapter: file,
        };
      }
      // 設定ファイル: カテゴリごとの記憶を更新し、タブもその category に合わせる。
      // これでツリークリック → 設定ペイン連動が成立する(cloud-providers task 8.1 の回帰修正)。
      return {
        selectedFile: file,
        selectedSettingsByCategory: {
          ...state.selectedSettingsByCategory,
          [file.category]: file,
        },
        activeSettingsTab: file.category,
      };
    }),
  selectAIProvider: (id) => set({ selectedAIProvider: id }),
  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),
}));
