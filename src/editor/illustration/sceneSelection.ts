/**
 * 本文エディタから、挿し絵の場面と、その前後の本文を取り出す。
 * `illustration-prompt` spec の design.md「sceneSelection」に対応する(要件 1.1〜1.3, 2.2)。
 *
 * - 選択があれば選択範囲を、無ければカーソルのある行を場面にする。日本語 Web 小説では
 *   1 行が 1 段落になる書き方が主なので、「カーソル位置の段落」をカーソルのある行とする
 * - 前の本文はフロントマターの後ろから、後ろの本文は文書の末尾まで。今の章ファイル
 *   (= この EditorState の文書)の外は読まない
 * - 場面・前・後のそれぞれのルビを剥がす
 */

import type { EditorState } from "@codemirror/state";

import type { SceneText } from "@/domain/illustration/illustrationContext";
import { parseFile } from "@/domain/project/frontmatter";
import { stripRuby } from "@/editor/rubyDecoration";

export interface ExtractedScene extends SceneText {
  /** 場面の冒頭。改行と空白の連続を 1 つの半角空白にし、前後の空白(全角空白を含む)を除いて先頭 20 文字。超えたら末尾に「…」。 */
  sceneHead: string;
}

/** 場面の冒頭に残す文字数(コードポイント単位)。 */
const SCENE_HEAD_LENGTH = 20;

/** 場面の冒頭を作る。`\s` は改行・全角空白も含む。 */
function makeSceneHead(scene: string): string {
  const collapsed = scene.replace(/\s+/g, " ").trim();
  const chars = Array.from(collapsed);
  if (chars.length <= SCENE_HEAD_LENGTH) return collapsed;
  return chars.slice(0, SCENE_HEAD_LENGTH).join("") + "…";
}

/** 場面が無い(選択が空白だけ、選択が無くカーソル行が空白だけ、場面がまるごとフロントマターの中)ときは null。 */
export function extractScene(state: EditorState): ExtractedScene | null {
  const doc = state.doc;
  const text = doc.toString();
  // parseFile の body は文書の末尾部分そのままなので、その長さから本文の開始位置が決まる。
  const bodyStart = text.length - parseFile(text).body.length;

  const main = state.selection.main;
  let sceneFrom: number;
  let sceneTo: number;
  if (!main.empty) {
    sceneFrom = main.from;
    sceneTo = main.to;
  } else {
    const line = doc.lineAt(main.head);
    sceneFrom = line.from;
    sceneTo = line.to;
  }

  // 場面がまるごとフロントマターの中(閉じの `---` の行を含む)なら、場面なし。
  // フロントマターにかかる場合は、本文の開始位置から切る。
  if (sceneTo <= bodyStart) return null;
  sceneFrom = Math.max(sceneFrom, bodyStart);

  const scene = stripRuby(text.slice(sceneFrom, sceneTo));
  if (scene.trim() === "") return null;

  // 前の本文は本文の開始位置から場面の手前まで(場面の開始は本文の開始位置より前にならない)。
  const beforeEnd = sceneFrom;
  // 改行だけを剥がす。行頭の全角空白の字下げなど、改行以外の空白は残す。
  // 先頭の改行の剥がしは続き生成の runRequest と同じ(フロントマター直後の改行)。
  const before = stripRuby(
    text.slice(bodyStart, beforeEnd).replace(/^\n+/, "").replace(/\n+$/, ""),
  );
  const after = stripRuby(text.slice(sceneTo).replace(/^\n+/, ""));

  return { scene, before, after, sceneHead: makeSceneHead(scene) };
}
