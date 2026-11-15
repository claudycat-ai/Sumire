/**
 * `illustration-prompt` spec task 1.1: 設定ファイルの連結規則(`joinSections`)をアダプタの外から使う。
 *
 * 挙動は OpenAI 互換アダプタの素の連結と同じ: 同じカテゴリは改行 1 つ、カテゴリ間は空行、
 * 各ファイルは前後の空白を除き、空になったものは飛ばす。
 *
 * Requirements(illustration-prompt): 2.8
 */
import { describe, expect, it } from "vitest";

import { joinSections, type ContextSection } from "@/domain/providers";

function section(label: string, content: string, category?: string): ContextSection {
  return { label, content, category };
}

describe("joinSections", () => {
  it("同じカテゴリは改行 1 つ、カテゴリ間は空行でつなぐ", () => {
    expect(
      joinSections([
        section("a", "A1", "人物"),
        section("b", "A2", "人物"),
        section("c", "B1", "世界"),
      ]),
    ).toBe("A1\nA2\n\nB1");
  });

  it("各ファイルの前後の空白を除き、空のものは飛ばす", () => {
    expect(
      joinSections([
        section("a", "\n A1 \n", "人物"),
        section("b", "  \n", "人物"),
        section("c", "B1\n", "世界"),
      ]),
    ).toBe("A1\n\nB1");
  });

  it("カテゴリが無いものは 1 つの暗黙のカテゴリにまとめる", () => {
    expect(joinSections([section("a", "X"), section("b", "Y")])).toBe("X\nY");
  });

  it("空の配列は空文字列になる", () => {
    expect(joinSections([])).toBe("");
  });
});
