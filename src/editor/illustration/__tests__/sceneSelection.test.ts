/**
 * `extractScene`(本文エディタから場面と前後の本文を取り出す)の単体テスト。
 * `illustration-prompt` spec の要件 1.1〜1.3, 2.2 と design.md「sceneSelection」に対応する。
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { extractScene } from "@/editor/illustration/sceneSelection";

/** カーソルだけを置いた状態。 */
function cursorAt(doc: string, pos: number): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.cursor(pos) });
}

/** `from`〜`to` を選択した状態。 */
function selecting(doc: string, from: number, to: number): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.range(from, to) });
}

const FRONTMATTER = "---\ntitle: 第一話\n---\n";

describe("extractScene: 選択がある(要件 1.1)", () => {
  it("選択範囲を場面にし、前は本文の開始から、後は文書の末尾まで", () => {
    const body = "　朝の駅は混んでいた。\n　改札の前で立ち止まる。\n　電車が来た。";
    const doc = FRONTMATTER + body;
    const target = "改札の前で立ち止まる。";
    const from = doc.indexOf(target);
    const result = extractScene(selecting(doc, from, from + target.length));
    expect(result).not.toBeNull();
    expect(result!.scene).toBe(target);
    // 前の本文: フロントマターを含まない。行頭の字下げは残し、末尾の改行は無い(選択が行の途中から)。
    expect(result!.before).toBe("　朝の駅は混んでいた。\n　");
    // 後の本文: 先頭の改行を剥がし、次の行の字下げは残す。
    expect(result!.after).toBe("　電車が来た。");
  });

  it("逆向きの選択(head < anchor)でも同じ範囲を場面にする", () => {
    const doc = "一行目。\n二行目。\n三行目。";
    const from = doc.indexOf("二行目。");
    const to = from + "二行目。".length;
    const result = extractScene(selecting(doc, to, from));
    expect(result!.scene).toBe("二行目。");
    expect(result!.before).toBe("一行目。");
    expect(result!.after).toBe("三行目。");
  });

  it("複数行にまたがる選択を、そのまま場面にする", () => {
    const doc = "前の段落。\n　一つ目。\n　二つ目。\n後の段落。";
    const from = doc.indexOf("　一つ目。");
    const to = doc.indexOf("　二つ目。") + "　二つ目。".length;
    const result = extractScene(selecting(doc, from, to));
    expect(result!.scene).toBe("　一つ目。\n　二つ目。");
    expect(result!.before).toBe("前の段落。");
    expect(result!.after).toBe("後の段落。");
  });

  it("選択が空白だけ(全角空白と改行を含む)なら null(要件 1.3)", () => {
    const doc = "一行目。\n　 \n\n三行目。";
    const from = doc.indexOf("\n");
    const to = doc.indexOf("三行目。");
    expect(extractScene(selecting(doc, from, to))).toBeNull();
  });
});

describe("extractScene: 選択が無い(要件 1.2)", () => {
  it("カーソルのある行を場面にする", () => {
    const doc = FRONTMATTER + "　一段落目。\n　二段落目の途中にカーソル。\n　三段落目。";
    const pos = doc.indexOf("途中") + 1;
    const result = extractScene(cursorAt(doc, pos));
    expect(result).not.toBeNull();
    expect(result!.scene).toBe("　二段落目の途中にカーソル。");
    // 前の本文の末尾の改行と、後の本文の先頭の改行を剥がす。字下げは残す。
    expect(result!.before).toBe("　一段落目。");
    expect(result!.after).toBe("　三段落目。");
  });

  it("行頭・行末のカーソルでも、その行を場面にする", () => {
    const doc = "一行目。\n二行目。\n三行目。";
    const lineStart = doc.indexOf("二行目。");
    const lineEnd = lineStart + "二行目。".length;
    expect(extractScene(cursorAt(doc, lineStart))!.scene).toBe("二行目。");
    expect(extractScene(cursorAt(doc, lineEnd))!.scene).toBe("二行目。");
  });

  it("最初の行・最後の行では、前・後の本文が空になる", () => {
    const doc = "一行目。\n二行目。";
    const first = extractScene(cursorAt(doc, 0))!;
    expect(first.before).toBe("");
    expect(first.after).toBe("二行目。");
    const last = extractScene(cursorAt(doc, doc.length))!;
    expect(last.before).toBe("一行目。");
    expect(last.after).toBe("");
  });

  it("カーソル行が空なら null(要件 1.3)", () => {
    const doc = "一行目。\n\n三行目。";
    expect(extractScene(cursorAt(doc, doc.indexOf("\n") + 1))).toBeNull();
  });

  it("カーソル行が半角・全角空白だけなら null(要件 1.3)", () => {
    const doc = "一行目。\n　 　\t\n三行目。";
    expect(extractScene(cursorAt(doc, doc.indexOf("　") + 1))).toBeNull();
  });

  it("空の文書なら null", () => {
    expect(extractScene(cursorAt("", 0))).toBeNull();
  });
});

describe("extractScene: 前後の本文の範囲(要件 2.2)", () => {
  it("フロントマターを前の本文に入れず、フロントマター直後の改行を剥がす", () => {
    const doc = FRONTMATTER + "\n\n　最初の段落。\n　場面の段落。";
    const result = extractScene(cursorAt(doc, doc.indexOf("場面")))!;
    expect(result.before).toBe("　最初の段落。");
    expect(result.before).not.toContain("title");
    expect(result.before).not.toContain("---");
  });

  it("本文の最初の行が場面なら、前の本文は空", () => {
    const doc = FRONTMATTER + "　最初の段落。\n　次の段落。";
    const result = extractScene(cursorAt(doc, doc.indexOf("最初")))!;
    expect(result.scene).toBe("　最初の段落。");
    expect(result.before).toBe("");
    expect(result.after).toBe("　次の段落。");
  });

  it("フロントマターが無い文書では、文書の先頭から前の本文にする", () => {
    const doc = "\n一行目。\n二行目。";
    const result = extractScene(cursorAt(doc, doc.indexOf("二行目")))!;
    expect(result.before).toBe("一行目。");
  });

  it("カーソルがフロントマターの中にあるときは、場面なし(null)", () => {
    const doc = FRONTMATTER + "　本文の段落。";
    expect(extractScene(cursorAt(doc, doc.indexOf("第一話")))).toBeNull();
  });

  it("選択がまるごとフロントマターの中にあるときは、場面なし(null)", () => {
    const doc = FRONTMATTER + "　本文の段落。";
    const from = doc.indexOf("title");
    expect(extractScene(selecting(doc, from, from + "title".length))).toBeNull();
  });

  it("選択がフロントマターから本文にかかっていたら、場面は本文の開始位置から", () => {
    const doc = FRONTMATTER + "　本文の段落。\n　次の段落。";
    const from = doc.indexOf("title");
    const to = doc.indexOf("　次の段落。");
    const result = extractScene(selecting(doc, from, to));
    expect(result).not.toBeNull();
    expect(result!.scene).toBe("　本文の段落。\n");
    expect(result!.scene).not.toContain("title");
    expect(result!.before).toBe("");
    expect(result!.after).toBe("　次の段落。");
  });

  it("前の本文の末尾・後の本文の先頭は改行だけを剥がし、全角空白の字下げは残す", () => {
    const doc = "一行目。\n\n\n二行目。\n\n\n　三行目。";
    const result = extractScene(cursorAt(doc, doc.indexOf("二行目")))!;
    expect(result.before).toBe("一行目。");
    expect(result.after).toBe("　三行目。");
  });
});

describe("extractScene: ルビを剥がす", () => {
  it("場面・前・後のそれぞれのルビを剥がす", () => {
    const doc =
      FRONTMATTER + "|朝霧《あさぎり》の町。\n|少女《しょうじょ》が振り返る。\n|鐘楼《しょうろう》が鳴る。";
    const result = extractScene(cursorAt(doc, doc.indexOf("振り返る")))!;
    expect(result.scene).toBe("少女が振り返る。");
    expect(result.before).toBe("朝霧の町。");
    expect(result.after).toBe("鐘楼が鳴る。");
    expect(result.sceneHead).toBe("少女が振り返る。");
  });
});

describe("extractScene: 場面の冒頭(sceneHead)", () => {
  it("改行と空白の連続を 1 つの半角空白にし、前後の空白(全角空白を含む)を除く", () => {
    const doc = "前。\n　　彼は\n\n　 振り返った。　\n後。";
    const from = doc.indexOf("　　彼は");
    const to = doc.indexOf("\n後。");
    const result = extractScene(selecting(doc, from, to))!;
    expect(result.sceneHead).toBe("彼は 振り返った。");
  });

  it("20 文字ちょうどなら「…」を付けない", () => {
    const line = "あいうえおかきくけこさしすせそたちつてと";
    expect(Array.from(line)).toHaveLength(20);
    expect(extractScene(cursorAt(line, 0))!.sceneHead).toBe(line);
  });

  it("20 文字を超えたら先頭 20 文字に「…」を付ける", () => {
    const line = "あいうえおかきくけこさしすせそたちつてとなにぬ";
    expect(extractScene(cursorAt(line, 0))!.sceneHead).toBe(
      "あいうえおかきくけこさしすせそたちつてと…",
    );
  });

  it("字下げの全角空白は数えない", () => {
    const line = "　あいうえおかきくけこさしすせそたちつてと";
    expect(extractScene(cursorAt(line, 0))!.sceneHead).toBe(
      "あいうえおかきくけこさしすせそたちつてと",
    );
  });

  it("文字数はコードポイント単位で数え、サロゲートペアを割らない", () => {
    const line = "𠮷".repeat(25);
    const head = extractScene(cursorAt(line, 0))!.sceneHead;
    expect(head).toBe("𠮷".repeat(20) + "…");
  });
});
