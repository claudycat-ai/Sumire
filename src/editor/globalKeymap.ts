import { useEffect } from "react";
import { performSnapshotSave } from "@/domain/snapshot/saveSnapshotFlow";
import { flushAll } from "@/stores/flushRegistry";
import { toastError } from "@/components/ui/Toast";

/**
 * ウィンドウグローバルなショートカットを document に貼る React フック。
 *
 * 役割分担:
 * - Ctrl+S          : 全エディタの保留中オートセーブを即時フラッシュ。スナップショットは作らない
 * - Ctrl+Shift+S    : 明示的にスナップショットを作成(フラッシュは内部で行われる)
 *
 * 他エディタの癖で Ctrl+S を連打しがちなのに、毎回スナップショットが積まれるのは煩わしい
 * という dogfooding フィードバック(2026-05-07)に基づき、Ctrl+S と Ctrl+Shift+S を分けた。
 *
 * エディタにフォーカスがあっても無くても効くべき動作なので、CodeMirror の keymap ではなく
 * document レベルで捕捉する。ブラウザの「ページを保存」(Ctrl+S 既定動作)を preventDefault で抑止。
 */
export function useGlobalKeymap(): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Mod+S(Win/Linux: Ctrl、Mac: Cmd)
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey || e.key.toLowerCase() !== "s") return;

      e.preventDefault();
      if (e.shiftKey) {
        void performSnapshotSave();
      } else {
        void flushAll().catch((err) => toastError(`保存に失敗しました: ${err}`));
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
