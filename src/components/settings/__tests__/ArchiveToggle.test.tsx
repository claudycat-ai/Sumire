import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// archiveApi.setArchived をモックして、ArchiveToggle 単体のクリック → 呼び出しを検証する。
// vi.hoisted で setArchived 関数を持ち上げて、各テストで挙動を差し替えられるようにする。
const hoisted = vi.hoisted(() => {
  const setArchived = vi.fn();
  return { setArchived };
});

vi.mock("@/domain/project/archiveApi", () => {
  return {
    setArchived: hoisted.setArchived,
  };
});

import { ArchiveToggle } from "@/components/settings/ArchiveToggle";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  hoisted.setArchived.mockReset();
  hoisted.setArchived.mockResolvedValue(undefined);
});

describe("ArchiveToggle", () => {
  it("archived=false のときアクティブ向けの「アーカイブ」ボタンを表示する", () => {
    render(
      <ArchiveToggle
        projectPath="/proj"
        relativePath="characters/alice.md"
        archived={false}
      />,
    );

    const button = screen.getByRole("button", { name: /アーカイブ/ });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain("アーカイブ");
    // アーカイブ中バッジは出ていない
    expect(screen.queryByText("アーカイブ中")).toBeNull();
  });

  it("archived=true のとき「アーカイブ中」バッジを兼ねた解除ボタンを表示する", () => {
    render(
      <ArchiveToggle
        projectPath="/proj"
        relativePath="characters/alice.md"
        archived
      />,
    );

    expect(screen.getByText("アーカイブ中")).toBeTruthy();
    // 解除動作のボタン(role=button)が存在する
    const button = screen.getByRole("button");
    expect(button).toBeTruthy();
    // ボタン内に「解除」または同等のラベルが含まれる(title でも可)
    const labelText = `${button.textContent ?? ""} ${button.getAttribute("title") ?? ""} ${button.getAttribute("aria-label") ?? ""}`;
    expect(labelText).toMatch(/解除/);
  });

  it("archived=false のクリックで setArchived(_, _, true) が呼ばれる", async () => {
    render(
      <ArchiveToggle
        projectPath="/proj"
        relativePath="characters/alice.md"
        archived={false}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(hoisted.setArchived).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.setArchived).toHaveBeenCalledWith(
      "/proj",
      "characters/alice.md",
      true,
    );
  });

  it("archived=true のクリックで setArchived(_, _, false) が呼ばれる", async () => {
    render(
      <ArchiveToggle
        projectPath="/proj"
        relativePath="characters/alice.md"
        archived
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(hoisted.setArchived).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.setArchived).toHaveBeenCalledWith(
      "/proj",
      "characters/alice.md",
      false,
    );
  });

  it("setArchived が pending の間に再クリックしても 2 回目の呼び出しが起きない (多重クリック防止)", async () => {
    // 解決を保留する Promise を持たせ、1 回目の click 後に pending 状態を作り出す
    let resolveFirst: (() => void) | null = null;
    hoisted.setArchived.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = () => resolve();
        }),
    );

    render(
      <ArchiveToggle
        projectPath="/proj"
        relativePath="characters/alice.md"
        archived={false}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // 1 回目の Promise を resolve する前後を含めて、setArchived は 1 回しか呼ばれない
    expect(hoisted.setArchived).toHaveBeenCalledTimes(1);

    // pending を解放しても 2 回目以降が遅延発火しないことも確認
    if (resolveFirst) {
      (resolveFirst as () => void)();
    }
    await waitFor(() => {
      // 安全側: 連打中に追加で呼ばれていないこと
      expect(hoisted.setArchived).toHaveBeenCalledTimes(1);
    });
  });
});
