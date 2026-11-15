import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TRUNCATED_NOTE,
  formatIllustrationEntry,
  type IllustrationEntrySource,
} from "../illustrationEntry";

const SOURCE: IllustrationEntrySource = {
  chapterName: "03_雨の橋.md",
  sceneHead: "雨脚が強まる中、リナは崩れかけた…",
};

describe("formatIllustrationEntry: 出所の行(4.2)", () => {
  it("1 行目が 〔挿し絵〕{章ファイル名}「{場面の冒頭}」 で、2 行目に情景文が続く", () => {
    const entry = formatIllustrationEntry(SOURCE, "橋の上に少女が立っている。", false);
    expect(entry).toBe(
      "〔挿し絵〕03_雨の橋.md「雨脚が強まる中、リナは崩れかけた…」\n" +
        "橋の上に少女が立っている。",
    );
  });

  it("複数行の情景文は、内側の改行と空行をそのまま残す", () => {
    const entry = formatIllustrationEntry(
      SOURCE,
      "一段落目。\n\n二段落目。\n三行目。",
      false,
    );
    expect(entry.split("\n")).toEqual([
      "〔挿し絵〕03_雨の橋.md「雨脚が強まる中、リナは崩れかけた…」",
      "一段落目。",
      "",
      "二段落目。",
      "三行目。",
    ]);
  });

  it("末尾に改行を付けない(区切りと日時と末尾の改行は formatMemoEntry が付ける)", () => {
    const entry = formatIllustrationEntry(SOURCE, "情景。", false);
    expect(entry.endsWith("\n")).toBe(false);
    expect(entry.startsWith("***")).toBe(false);
  });
});

describe("formatIllustrationEntry: 情景文の前後の空白の除去", () => {
  it("前後の改行・半角空白・タブを除く", () => {
    const entry = formatIllustrationEntry(SOURCE, "\n\n  \t情景。\t \n\n", false);
    expect(entry.split("\n")).toEqual([
      "〔挿し絵〕03_雨の橋.md「雨脚が強まる中、リナは崩れかけた…」",
      "情景。",
    ]);
  });

  it("前後の全角空白(U+3000)も除く", () => {
    const entry = formatIllustrationEntry(SOURCE, "　　情景。　\n", false);
    expect(entry.split("\n")[1]).toBe("情景。");
  });

  it("情景文の内側の空白は残す", () => {
    const entry = formatIllustrationEntry(SOURCE, "  雨の中、　少女が立つ。  ", false);
    expect(entry.split("\n")[1]).toBe("雨の中、　少女が立つ。");
  });
});

describe("formatIllustrationEntry: 途中切れの注記(7.7)", () => {
  it("注記の文言は固定", () => {
    expect(ILLUSTRATION_TRUNCATED_NOTE).toBe("(生成の上限に達したため、ここで途切れています)");
  });

  it("truncated のとき、空行を挟まず情景文の次の行に注記を足す", () => {
    const entry = formatIllustrationEntry(SOURCE, "途中までの情景", true);
    expect(entry).toBe(
      "〔挿し絵〕03_雨の橋.md「雨脚が強まる中、リナは崩れかけた…」\n" +
        "途中までの情景\n" +
        "(生成の上限に達したため、ここで途切れています)",
    );
  });

  it("truncated のとき、情景文の末尾の空白・改行を除いてから注記を足す(空行が入らない)", () => {
    const entry = formatIllustrationEntry(SOURCE, "途中までの情景\n\n", true);
    expect(entry.split("\n")).toEqual([
      "〔挿し絵〕03_雨の橋.md「雨脚が強まる中、リナは崩れかけた…」",
      "途中までの情景",
      "(生成の上限に達したため、ここで途切れています)",
    ]);
  });

  it("truncated でないときは注記を足さない", () => {
    const entry = formatIllustrationEntry(SOURCE, "最後までの情景。", false);
    expect(entry).not.toContain(ILLUSTRATION_TRUNCATED_NOTE);
    expect(entry.split("\n")).toHaveLength(2);
  });
});
