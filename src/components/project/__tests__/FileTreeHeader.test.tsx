import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

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

import { FileTreeHeader } from "@/components/project/FileTreeHeader";
import { useAppStore, type SelectedFile } from "@/stores/appStore";
import { useUILayoutStore } from "@/stores/uiLayoutStore";

// `file-tree-placement` spec task 2.1: ファイル一覧のヘッダ。
// 左から「すべて折りたたむ」「すべて展開する」「配置の切り替え」(Requirements 3.2〜3.6)。

const CHAPTER: SelectedFile = {
  category: "chapters",
  relativePath: "chapters/01.md",
  name: "01.md",
};

function getButtons() {
  const toolbar = screen.getByRole("toolbar", { name: "ファイル一覧の操作" });
  return within(toolbar).getAllByRole("button");
}

beforeEach(() => {
  useUILayoutStore.setState({
    fileTreePlacement: "left",
    fileTreeCategoryExpanded: {
      chapters: true,
      characters: false,
      worldbuilding: true,
      glossary: false,
      plot: true,
    },
  });
  useAppStore.setState({
    selectedChapter: CHAPTER,
    selectedFile: CHAPTER,
  });
});

afterEach(() => {
  cleanup();
});

describe("FileTreeHeader のボタンの並びと名前", () => {
  it("左のとき、左から「すべて折りたたむ」「すべて展開する」「ファイル一覧を右へ移す」の順で、aria-label と title を持つ(3.2, 3.4, 3.5)", () => {
    render(<FileTreeHeader />);

    const buttons = getButtons();
    const names = ["すべて折りたたむ", "すべて展開する", "ファイル一覧を右へ移す"];
    expect(buttons).toHaveLength(3);
    buttons.forEach((button, i) => {
      expect(button.getAttribute("aria-label")).toBe(names[i]);
      expect(button.getAttribute("title")).toBe(names[i]);
      expect(button.getAttribute("type")).toBe("button");
    });
  });

  it("右のとき、3 つ目の名前が「ファイル一覧を左へ移す」に変わり、並びは同じ(3.3, 3.5)", () => {
    useUILayoutStore.setState({ fileTreePlacement: "right" });
    render(<FileTreeHeader />);

    const buttons = getButtons();
    const names = ["すべて折りたたむ", "すべて展開する", "ファイル一覧を左へ移す"];
    expect(buttons).toHaveLength(3);
    buttons.forEach((button, i) => {
      expect(button.getAttribute("aria-label")).toBe(names[i]);
      expect(button.getAttribute("title")).toBe(names[i]);
    });
  });

  it("配置を切り替えると、表示中のヘッダの 3 つ目の名前も追従する(1.4, 3.5)", () => {
    render(<FileTreeHeader />);

    fireEvent.click(
      screen.getByRole("button", { name: "ファイル一覧を右へ移す" }),
    );

    expect(
      screen.getByRole("button", { name: "ファイル一覧を左へ移す" }),
    ).toBeTruthy();
    expect(getButtons()[2].getAttribute("title")).toBe(
      "ファイル一覧を左へ移す",
    );
  });
});

describe("FileTreeHeader を押したときのストアの変化", () => {
  it("配置の切り替えを押すと、左と右が入れ替わる(1.4)", () => {
    render(<FileTreeHeader />);

    fireEvent.click(
      screen.getByRole("button", { name: "ファイル一覧を右へ移す" }),
    );
    expect(useUILayoutStore.getState().fileTreePlacement).toBe("right");

    fireEvent.click(
      screen.getByRole("button", { name: "ファイル一覧を左へ移す" }),
    );
    expect(useUILayoutStore.getState().fileTreePlacement).toBe("left");
  });

  it("「すべて折りたたむ」で 5 カテゴリがすべて閉じる(4.1)", () => {
    render(<FileTreeHeader />);

    fireEvent.click(screen.getByRole("button", { name: "すべて折りたたむ" }));

    expect(useUILayoutStore.getState().fileTreeCategoryExpanded).toEqual({
      chapters: false,
      characters: false,
      worldbuilding: false,
      glossary: false,
      plot: false,
    });
  });

  it("「すべて展開する」で 5 カテゴリがすべて開く(4.2)", () => {
    render(<FileTreeHeader />);

    fireEvent.click(screen.getByRole("button", { name: "すべて展開する" }));

    expect(useUILayoutStore.getState().fileTreeCategoryExpanded).toEqual({
      chapters: true,
      characters: true,
      worldbuilding: true,
      glossary: true,
      plot: true,
    });
  });

  it("3 つのボタンを押しても、選んでいるファイルは変わらない(4.6)", () => {
    render(<FileTreeHeader />);

    for (const button of getButtons()) {
      fireEvent.click(button);
    }

    const app = useAppStore.getState();
    expect(app.selectedFile).toEqual(CHAPTER);
    expect(app.selectedChapter).toEqual(CHAPTER);
  });
});
