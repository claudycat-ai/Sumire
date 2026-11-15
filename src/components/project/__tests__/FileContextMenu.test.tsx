import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  FileContextMenu,
  FileTarget,
  MenuAction,
} from "@/components/project/FileContextMenu";

// FileContextMenu は素の UI コンポーネント。
// Props で渡された actions のうち visible(target) が true のものを描画し、
// クリック時は onSelect(target) と onClose() を呼ぶ。
// Esc / メニュー外クリック / 項目選択でクローズする。

afterEach(() => {
  cleanup();
});

const activeTarget: FileTarget = {
  category: "characters",
  relativePath: "characters/alice.md",
  name: "alice.md",
  archived: false,
};

const archivedTarget: FileTarget = {
  category: "characters",
  relativePath: "characters/bob.md",
  name: "bob.md",
  archived: true,
};

function buildActions() {
  const archive: MenuAction = {
    id: "archive",
    label: "アーカイブ",
    visible: (t: FileTarget) => !t.archived,
    onSelect: vi.fn(),
  };
  const unarchive: MenuAction = {
    id: "unarchive",
    label: "アーカイブを解除",
    visible: (t: FileTarget) => t.archived,
    onSelect: vi.fn(),
  };
  return { archive, unarchive };
}

describe("FileContextMenu", () => {
  it("open=true のとき visible(target) が true のアクションだけを描画する (アクティブ)", () => {
    const { archive, unarchive } = buildActions();

    render(
      <FileContextMenu
        open
        position={{ x: 100, y: 200 }}
        target={activeTarget}
        actions={[archive, unarchive]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("アーカイブ")).toBeTruthy();
    expect(screen.queryByText("アーカイブを解除")).toBeNull();
  });

  it("open=true のとき visible(target) が true のアクションだけを描画する (アーカイブ済み)", () => {
    const { archive, unarchive } = buildActions();

    render(
      <FileContextMenu
        open
        position={{ x: 100, y: 200 }}
        target={archivedTarget}
        actions={[archive, unarchive]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("アーカイブ")).toBeNull();
    expect(screen.getByText("アーカイブを解除")).toBeTruthy();
  });

  it("メニュー項目クリックで onSelect(target) と onClose() が呼ばれる", () => {
    const { archive, unarchive } = buildActions();
    const onClose = vi.fn();

    render(
      <FileContextMenu
        open
        position={{ x: 100, y: 200 }}
        target={activeTarget}
        actions={[archive, unarchive]}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText("アーカイブ"));

    expect(archive.onSelect).toHaveBeenCalledTimes(1);
    expect(archive.onSelect).toHaveBeenCalledWith(activeTarget);
    expect(unarchive.onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc キーで onClose() が呼ばれる", () => {
    const { archive, unarchive } = buildActions();
    const onClose = vi.fn();

    render(
      <FileContextMenu
        open
        position={{ x: 100, y: 200 }}
        target={activeTarget}
        actions={[archive, unarchive]}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("メニュー外クリックで onClose() が呼ばれる", () => {
    const { archive, unarchive } = buildActions();
    const onClose = vi.fn();

    const outside = document.createElement("div");
    outside.setAttribute("data-testid", "outside");
    document.body.appendChild(outside);

    render(
      <FileContextMenu
        open
        position={{ x: 100, y: 200 }}
        target={activeTarget}
        actions={[archive, unarchive]}
        onClose={onClose}
      />,
    );

    fireEvent.mouseDown(outside);

    expect(onClose).toHaveBeenCalledTimes(1);

    outside.remove();
  });

  it("open=false のときは何も描画されない", () => {
    const { archive, unarchive } = buildActions();

    render(
      <FileContextMenu
        open={false}
        position={{ x: 100, y: 200 }}
        target={activeTarget}
        actions={[archive, unarchive]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("アーカイブ")).toBeNull();
    expect(screen.queryByText("アーカイブを解除")).toBeNull();
  });

  it("target が null のときは何も描画されない (open=true でも)", () => {
    const { archive, unarchive } = buildActions();

    render(
      <FileContextMenu
        open
        position={{ x: 100, y: 200 }}
        target={null}
        actions={[archive, unarchive]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("アーカイブ")).toBeNull();
    expect(screen.queryByText("アーカイブを解除")).toBeNull();
  });

  it("position に応じてメニュー左上が配置される", () => {
    const { archive, unarchive } = buildActions();

    render(
      <FileContextMenu
        open
        position={{ x: 123, y: 456 }}
        target={activeTarget}
        actions={[archive, unarchive]}
        onClose={vi.fn()}
      />,
    );

    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("123px");
    expect(menu.style.top).toBe("456px");
  });
});
