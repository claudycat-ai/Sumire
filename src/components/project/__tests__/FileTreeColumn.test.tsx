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

// 子の 3 部品は中身を問わないので、マウントの回数だけ数える置き換えにする。
const mounts = vi.hoisted(() => ({ fileTree: 0, llm: 0, history: 0 }));

vi.mock("@/components/project/FileTreePane", async () => {
  const { useEffect } = await import("react");
  return {
    FileTreePane: ({ projectPath }: { projectPath: string }) => {
      useEffect(() => {
        mounts.fileTree += 1;
      }, []);
      return <div data-testid="stub-file-tree">{projectPath}</div>;
    },
  };
});

vi.mock("@/components/project/LLMSwitcherPane", async () => {
  const { useEffect } = await import("react");
  return {
    LLMSwitcherPane: () => {
      useEffect(() => {
        mounts.llm += 1;
      }, []);
      return <div data-testid="stub-llm" />;
    },
  };
});

vi.mock("@/components/project/HistoryPane", async () => {
  const { useEffect } = await import("react");
  return {
    HistoryPane: ({ projectPath }: { projectPath: string }) => {
      useEffect(() => {
        mounts.history += 1;
      }, []);
      return <div data-testid="stub-history">{projectPath}</div>;
    },
  };
});

import { FileTreeColumn } from "@/components/project/FileTreeColumn";
import { useUILayoutStore } from "@/stores/uiLayoutStore";

// `file-tree-placement` spec task 2.2: ファイル一覧の列の部品。
// ヘッダ + ファイル一覧(スクロール域)+ LLM 切替 + 履歴を 1 列に並べ、
// 配置に応じて order と境界線を変える(Requirements 1.2, 1.3, 1.5, 1.6, 3.1, 3.7)。

const PROJECT_PATH = "Z:/novels/sample";

function getAside() {
  const aside = screen.getByRole("toolbar").closest("aside");
  if (!aside) throw new Error("aside が見つからない");
  return aside;
}

beforeEach(() => {
  mounts.fileTree = 0;
  mounts.llm = 0;
  mounts.history = 0;
  useUILayoutStore.setState({ fileTreePlacement: "left" });
});

afterEach(() => {
  cleanup();
});

describe("FileTreeColumn の中の並び", () => {
  it("ヘッダが列のいちばん上にあり、スクロール域の外にある(3.1, 3.7)", () => {
    render(<FileTreeColumn projectPath={PROJECT_PATH} />);

    const aside = getAside();
    const toolbar = screen.getByRole("toolbar", { name: "ファイル一覧の操作" });
    expect(aside.firstElementChild).toBe(toolbar);

    const scroll = screen.getByTestId("stub-file-tree").parentElement!;
    expect(scroll.className).toContain("overflow-y-auto");
    expect(scroll.className).toContain("flex-1");
    expect(scroll.contains(toolbar)).toBe(false);
  });

  it("ファイル一覧・LLM 切替・履歴を、この順に 1 つの列に並べ、projectPath を渡す(1.5)", () => {
    render(<FileTreeColumn projectPath={PROJECT_PATH} />);

    const aside = getAside();
    const fileTree = screen.getByTestId("stub-file-tree");
    const llm = screen.getByTestId("stub-llm");
    const history = screen.getByTestId("stub-history");

    expect(aside.contains(fileTree)).toBe(true);
    expect(aside.children).toHaveLength(4);
    expect(aside.children[1]).toBe(fileTree.parentElement);
    expect(aside.children[2]).toBe(llm);
    expect(aside.children[3]).toBe(history);
    expect(fileTree.textContent).toBe(PROJECT_PATH);
    expect(history.textContent).toBe(PROJECT_PATH);
  });
});

describe("FileTreeColumn の配置ごとの見た目", () => {
  it("左のとき、border-r を付け、order-last は付けない(1.2)", () => {
    render(<FileTreeColumn projectPath={PROJECT_PATH} />);

    const classes = getAside().classList;
    expect(classes.contains("border-r")).toBe(true);
    expect(classes.contains("border-l")).toBe(false);
    expect(classes.contains("order-last")).toBe(false);
  });

  it("右のとき、order-last と border-l を付け、border-r は付けない(1.3)", () => {
    useUILayoutStore.setState({ fileTreePlacement: "right" });
    render(<FileTreeColumn projectPath={PROJECT_PATH} />);

    const classes = getAside().classList;
    expect(classes.contains("order-last")).toBe(true);
    expect(classes.contains("border-l")).toBe(true);
    expect(classes.contains("border-r")).toBe(false);
  });

  it("どちらの配置でも幅は w-[260px] で縮まない(1.6)", () => {
    render(<FileTreeColumn projectPath={PROJECT_PATH} />);
    expect(getAside().classList.contains("w-[260px]")).toBe(true);
    expect(getAside().classList.contains("flex-shrink-0")).toBe(true);

    act(() => {
      useUILayoutStore.setState({ fileTreePlacement: "right" });
    });
    expect(getAside().classList.contains("w-[260px]")).toBe(true);
    expect(getAside().classList.contains("flex-shrink-0")).toBe(true);
  });
});

describe("FileTreeColumn の配置の切り替え", () => {
  it("配置を左右に切り替えても、子の 3 部品はマウントし直されない(1.5, 1.8)", () => {
    render(<FileTreeColumn projectPath={PROJECT_PATH} />);
    expect(mounts).toEqual({ fileTree: 1, llm: 1, history: 1 });
    const asideBefore = getAside();

    act(() => {
      useUILayoutStore.getState().toggleFileTreePlacement();
    });
    expect(getAside().classList.contains("order-last")).toBe(true);

    act(() => {
      useUILayoutStore.getState().toggleFileTreePlacement();
    });
    expect(getAside().classList.contains("order-last")).toBe(false);

    expect(mounts).toEqual({ fileTree: 1, llm: 1, history: 1 });
    expect(getAside()).toBe(asideBefore);
  });
});
