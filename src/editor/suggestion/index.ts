import { Extension } from "@codemirror/state";
import { suggestionField } from "./suggestionState";
import { ghostSuggestionView } from "./suggestionDecorator";
import { suggestionKeymap } from "./suggestionKeymap";
import { suggestionLifecycle } from "./suggestionLifecycle";
import { suggestionScroll } from "./suggestionScroll";

/**
 * 提案 UX(Copilot 風ゴーストテキスト + キーバインド + ライフサイクル管理)を
 * 一括で組み込む拡張セット。
 */
export function suggestionExtension(): Extension {
  return [
    suggestionField,
    ghostSuggestionView(),
    suggestionLifecycle(),
    suggestionScroll(),
    suggestionKeymap(),
  ];
}
