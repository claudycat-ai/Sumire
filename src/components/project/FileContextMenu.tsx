import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { FileCategory } from "@/domain/project/filesApi";

/**
 * 右クリックメニューが対象とするファイルの最小情報。
 * `archived` フラグはアクションの `visible` 判定で使う。
 */
export interface FileTarget {
  category: FileCategory;
  relativePath: string;
  name: string;
  archived: boolean;
}

/**
 * メニューに並べる 1 アクションの宣言。
 * - `visible(target)` が `true` の項目のみ描画される。
 * - `onSelect(target)` は項目クリック時に呼ばれる。Promise を返してもメニューは
 *   即座に閉じる(await しない)。エラーハンドリングは呼び出し側の責務。
 */
export interface MenuAction {
  id: string;
  label: string;
  visible: (target: FileTarget) => boolean;
  onSelect: (target: FileTarget) => void | Promise<void>;
}

export interface FileContextMenuProps {
  open: boolean;
  position: { x: number; y: number };
  target: FileTarget | null;
  actions: MenuAction[];
  onClose: () => void;
}

/**
 * ファイル操作の汎用コンテキストメニュー。
 *
 * 自前の軽量 Popover として実装し、Radix UI 等の追加依存を持たない。
 * 表示位置は props.position(viewport 座標)。画面端で見切れる場合は反転して
 * 内側に収める。本コンポーネントはアクションロジックを持たず、props 経由の
 * 純粋な制御に閉じる(`archiveApi` の呼び出し等は呼び出し側 = `FileTreePane` の
 * 責務)。
 */
export function FileContextMenu({
  open,
  position,
  target,
  actions,
  onClose,
}: FileContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 画面端反転後の最終座標。レイアウト確定後(描画の前)に補正する。
  // 位置を決めるのはこの useLayoutEffect だけにする。以前は position の変化で
  // 補正前の値に戻す useEffect があり、補正の後に走って補正を消していた。
  const [adjusted, setAdjusted] = useState(position);

  // メニュー描画後にビューポート端と比較して反転する。
  useLayoutEffect(() => {
    if (!open || !target) return;
    const el = menuRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nextX = position.x;
    let nextY = position.y;
    if (position.x + rect.width > vw) {
      nextX = Math.max(0, position.x - rect.width);
    }
    if (position.y + rect.height > vh) {
      nextY = Math.max(0, position.y - rect.height);
    }
    setAdjusted((prev) =>
      prev.x === nextX && prev.y === nextY ? prev : { x: nextX, y: nextY },
    );
    // position・open・target が変わったときだけ測り直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, position.x, position.y, target]);

  // Esc + メニュー外クリックで閉じる。
  useEffect(() => {
    if (!open || !target) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    function handleMouseDown(e: MouseEvent) {
      const el = menuRef.current;
      if (!el) return;
      const targetNode = e.target as Node | null;
      if (targetNode && el.contains(targetNode)) return;
      onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open, target, onClose]);

  if (!open || !target) return null;

  const visibleActions = actions.filter((a) => a.visible(target));
  if (visibleActions.length === 0) return null;

  function handleSelect(action: MenuAction) {
    if (!target) return;
    // Promise の場合も await せず即クローズ。エラーは呼び出し側の責務。
    void action.onSelect(target);
    onClose();
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("archive.contextMenuAria")}
      style={{
        position: "fixed",
        left: `${adjusted.x}px`,
        top: `${adjusted.y}px`,
      }}
      className="z-50 min-w-40 whitespace-nowrap rounded-md border border-zinc-200 bg-white py-1 text-sm text-zinc-900 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {visibleActions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          onClick={() => handleSelect(action)}
          className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
