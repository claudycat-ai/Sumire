import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// この環境の vitest では `localStorage` が undefined。persist 付きの uiLayoutStore を
// 書き換えるので、ストアの import より前にメモリ上の保存先へ差し替える
// (`src/stores/__tests__/uiLayoutStore.test.ts` と同じ)。
vi.hoisted(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  });
});

// 子の部品は中身を問わないので、マウントとアンマウントの回数だけ数える置き換えにする。
type StubName =
  | "chapterEditor"
  | "memo"
  | "settings"
  | "fileTree"
  | "llm"
  | "history"
  | "statusBar";

const counts = vi.hoisted(() => ({
  mounts: {} as Record<string, number>,
  unmounts: {} as Record<string, number>,
}));

vi.mock("@/components/editor/ChapterEditor", async () => {
  const { useEffect } = await import("react");
  return {
    ChapterEditor: ({ relativePath }: { relativePath: string }) => {
      useEffect(() => {
        counts.mounts.chapterEditor = (counts.mounts.chapterEditor ?? 0) + 1;
        return () => {
          counts.unmounts.chapterEditor =
            (counts.unmounts.chapterEditor ?? 0) + 1;
        };
      }, []);
      return <div data-testid="stub-chapter-editor">{relativePath}</div>;
    },
  };
});

vi.mock("@/components/memo/MemoPane", async () => {
  const { useEffect } = await import("react");
  return {
    MemoPane: () => {
      useEffect(() => {
        counts.mounts.memo = (counts.mounts.memo ?? 0) + 1;
        return () => {
          counts.unmounts.memo = (counts.unmounts.memo ?? 0) + 1;
        };
      }, []);
      return <div data-testid="stub-memo" />;
    },
  };
});

vi.mock("@/components/settings/SettingsPane", async () => {
  const { useEffect } = await import("react");
  return {
    SettingsPane: () => {
      useEffect(() => {
        counts.mounts.settings = (counts.mounts.settings ?? 0) + 1;
        return () => {
          counts.unmounts.settings = (counts.unmounts.settings ?? 0) + 1;
        };
      }, []);
      return <div data-testid="stub-settings" />;
    },
  };
});

vi.mock("@/components/project/FileTreePane", async () => {
  const { useEffect } = await import("react");
  return {
    FileTreePane: () => {
      useEffect(() => {
        counts.mounts.fileTree = (counts.mounts.fileTree ?? 0) + 1;
        return () => {
          counts.unmounts.fileTree = (counts.unmounts.fileTree ?? 0) + 1;
        };
      }, []);
      return <div data-testid="stub-file-tree" />;
    },
  };
});

vi.mock("@/components/project/LLMSwitcherPane", async () => {
  const { useEffect } = await import("react");
  return {
    LLMSwitcherPane: () => {
      useEffect(() => {
        counts.mounts.llm = (counts.mounts.llm ?? 0) + 1;
        return () => {
          counts.unmounts.llm = (counts.unmounts.llm ?? 0) + 1;
        };
      }, []);
      return <div data-testid="stub-llm" />;
    },
  };
});

vi.mock("@/components/project/HistoryPane", async () => {
  const { useEffect } = await import("react");
  return {
    HistoryPane: () => {
      useEffect(() => {
        counts.mounts.history = (counts.mounts.history ?? 0) + 1;
        return () => {
          counts.unmounts.history = (counts.unmounts.history ?? 0) + 1;
        };
      }, []);
      return <div data-testid="stub-history" />;
    },
  };
});

vi.mock("@/components/project/StatusBar", async () => {
  const { useEffect } = await import("react");
  return {
    StatusBar: () => {
      useEffect(() => {
        counts.mounts.statusBar = (counts.mounts.statusBar ?? 0) + 1;
        return () => {
          counts.unmounts.statusBar = (counts.unmounts.statusBar ?? 0) + 1;
        };
      }, []);
      return <div data-testid="stub-status-bar" />;
    },
  };
});

// 復元の流れは Tauri のファイル操作を呼ぶので、読み込みごと差し替える。
vi.mock("@/domain/snapshot/restoreFlow", () => ({
  performRestore: vi.fn(),
}));

vi.mock("@/components/ui/Toast", () => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

import { ProjectView } from "@/components/project/ProjectView";
import { useAppStore } from "@/stores/appStore";
import { useSnapshotStore } from "@/stores/snapshotStore";
import { useUILayoutStore } from "@/stores/uiLayoutStore";

// `file-tree-placement` spec task 3: プロジェクトの画面にファイル一覧の列の部品を組み込む。
// 列は常に本文・右カラムの Group の前の兄弟に置き、配置は order-last で見た目だけ変える。
// 切り替えで本文側も列の側もマウントし直されないことを確かめる
// (Requirements 1.2, 1.3, 1.7, 1.8, 1.9)。

const PROJECT_PATH = "Z:/novels/sample";
const CHAPTER_PATH = "chapters/001.md";

const ALL_STUBS: StubName[] = [
  "chapterEditor",
  "memo",
  "settings",
  "fileTree",
  "llm",
  "history",
  "statusBar",
];

// react-resizable-panels は大きさの計測に ResizeObserver を使う。jsdom には無いので、
// 何もしない置き換えを入れる(計測の結果はこのテストでは見ない)。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function getAside() {
  const aside = screen.getByTestId("stub-file-tree").closest("aside");
  if (!aside) throw new Error("aside が見つからない");
  return aside;
}

function expectEachMountedOnceAndNeverUnmounted() {
  for (const name of ALL_STUBS) {
    expect(counts.mounts[name], `${name} のマウント回数`).toBe(1);
    expect(counts.unmounts[name] ?? 0, `${name} のアンマウント回数`).toBe(0);
  }
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  counts.mounts = {};
  counts.unmounts = {};
  useUILayoutStore.setState({ fileTreePlacement: "left" });
  useSnapshotStore.setState({ current: null, currentName: null });
  const app = useAppStore.getState();
  app.setCurrentProject({ path: PROJECT_PATH, title: "サンプル" });
  app.setSelectedFile({
    category: "chapters",
    relativePath: CHAPTER_PATH,
    name: "001.md",
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setCurrentProject(null);
});

describe("ProjectView の列の並び", () => {
  it("左のとき、列の aside は Group の直前の兄弟で、order-last を付けず border-r を付ける(1.2)", () => {
    render(<ProjectView />);

    const aside = getAside();
    const group = aside.nextElementSibling;
    expect(group).not.toBeNull();
    expect(group!.contains(screen.getByTestId("stub-chapter-editor"))).toBe(
      true,
    );
    expect(group!.contains(screen.getByTestId("stub-memo"))).toBe(true);
    expect(group!.contains(screen.getByTestId("stub-settings"))).toBe(true);
    expect(aside.classList.contains("order-last")).toBe(false);
    expect(aside.classList.contains("border-r")).toBe(true);
  });

  it("右のとき、DOM の順は変えずに、列の aside に order-last と border-l を付ける(1.3)", () => {
    useUILayoutStore.setState({ fileTreePlacement: "right" });
    render(<ProjectView />);

    const aside = getAside();
    expect(aside.nextElementSibling!.contains(
      screen.getByTestId("stub-chapter-editor"),
    )).toBe(true);
    expect(aside.classList.contains("order-last")).toBe(true);
    expect(aside.classList.contains("border-l")).toBe(true);
    expect(aside.classList.contains("border-r")).toBe(false);
  });

  it("列の aside の最初の子は、スクロール域の外にあるヘッダ(3.1, 3.7)", () => {
    render(<ProjectView />);

    const aside = getAside();
    const toolbar = screen.getByRole("toolbar", { name: "ファイル一覧の操作" });
    expect(aside.firstElementChild).toBe(toolbar);
  });
});

describe("ProjectView の配置の切り替え", () => {
  it("左 → 右 → 左と切り替えても、本文・メモ・設定・列の子の部品はマウントし直されない(1.7, 1.8, 1.9)", () => {
    render(<ProjectView />);
    expectEachMountedOnceAndNeverUnmounted();

    const asideBefore = getAside();
    const groupBefore = asideBefore.nextElementSibling;
    const editorBefore = screen.getByTestId("stub-chapter-editor");

    act(() => {
      useUILayoutStore.getState().toggleFileTreePlacement();
    });
    expect(useUILayoutStore.getState().fileTreePlacement).toBe("right");
    expect(getAside().classList.contains("order-last")).toBe(true);
    expectEachMountedOnceAndNeverUnmounted();

    act(() => {
      useUILayoutStore.getState().toggleFileTreePlacement();
    });
    expect(useUILayoutStore.getState().fileTreePlacement).toBe("left");
    expect(getAside().classList.contains("order-last")).toBe(false);
    expectEachMountedOnceAndNeverUnmounted();

    // DOM も同じ要素のまま(挿し直されていない)。
    expect(getAside()).toBe(asideBefore);
    expect(getAside().nextElementSibling).toBe(groupBefore);
    expect(screen.getByTestId("stub-chapter-editor")).toBe(editorBefore);
  });
});
