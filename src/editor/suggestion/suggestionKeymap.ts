import { keymap } from "@codemirror/view";
import { Extension, Prec } from "@codemirror/state";
import {
  acceptSuggestion,
  dismissSuggestion,
  requestSuggestion,
  saveSuggestionToMemo,
} from "./suggestionController";

/**
 * 提案 UX のキーバインド。
 *
 * 仕様 `01-ux.md` キーバインド表に準拠:
 *   Shift+Enter           : 提案を要求(手動トリガー)
 *   Tab                   : 提案を採用(全文挿入)。提案非表示時は defaultKeymap に流す
 *   Esc                   : 提案を却下 / 生成中なら停止(M8 で拡張予定)
 *   Alt+M                 : 提案候補をメモペインに保存(M5 で本実装)
 *
 * 別案サイクル(Alt+] / Alt+[)は M8 で撤去済み。気に入らない案は Esc → Shift+Enter で
 * 取り直すか、Alt+M でメモに退避してから再生成する運用に統一した。
 *
 * Alt+M を採用した経緯: 仕様初版では Ctrl+Shift+M だったが、ATOK MiRA など IME 付属ツールの
 * グローバルホットキーと衝突する報告があり、Alt+M に変更した(2026-04-28)。
 *
 * Q8 採用: Sumire のキーマップを `defaultKeymap` より先に置く。
 * `Prec.high` を付けることで CodeMirror 内蔵の Enter 系コマンドより優先される。
 */
export function suggestionKeymap(): Extension {
  return Prec.high(
    keymap.of([
      { key: "Shift-Enter", run: requestSuggestion },
      // 提案表示中のみ Tab を採用に転用。非表示時は run が false を返し defaultKeymap に流れる
      { key: "Tab", run: acceptSuggestion },
      { key: "Escape", run: dismissSuggestion },
      // Alt+M: 提案表示中ならその案を、選択範囲があればその範囲を切り取ってメモへ。
      // どちらでもなければ saveSuggestionToMemo が false を返し他のキーマップに流れる。
      { key: "Alt-m", run: saveSuggestionToMemo },
    ]),
  );
}
