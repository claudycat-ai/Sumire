import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// `template-settings-ui` spec task 1.3: 汎用の確認ダイアログ。Requirements: 4.2, 4.3, 4.4。

afterEach(() => {
  cleanup();
});

function renderDialog(open: boolean) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open={open}
      title="置き換えますか?"
      message="いまの記述は置き換わります"
      confirmLabel="置き換える"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

describe("ConfirmDialog", () => {
  it("閉じているときは何も出ない", () => {
    renderDialog(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("開くと、題と本文がダイアログとして出る", () => {
    renderDialog(true);
    const dialog = screen.getByRole("dialog", { name: "置き換えますか?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("いまの記述は置き換わります")).toBeTruthy();
  });

  it("取りやめのボタンで、取りやめの処理が 1 回呼ばれる", () => {
    const { onCancel, onConfirm } = renderDialog(true);
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("続行のボタンで、続行の処理が 1 回呼ばれる", () => {
    const { onCancel, onConfirm } = renderDialog(true);
    fireEvent.click(screen.getByRole("button", { name: "置き換える" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Esc で取りやめの処理が呼ばれる", () => {
    const { onCancel, onConfirm } = renderDialog(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("閉じているときは、Esc に反応しない", () => {
    const { onCancel } = renderDialog(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
