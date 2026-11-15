import { describe, expect, it } from "vitest";

import { sanitizeFolderName } from "@/lib/folderName";

// `sanitizeFolderName` の純関数仕様を検証する単体テスト。
//
// design.md welcome-create-flow §Testing Strategy の 8 ケースを必須カバー。
// 各ケースは判別共用体 `SanitizeResult` の `ok` フラグで分岐させてから
// `folderName` または `error.kind` を assert する(TypeScript の narrowing)。

describe("sanitizeFolderName — 正常系(ok=true)", () => {
  it("プレーンな日本語タイトルをそのまま返す", () => {
    const result = sanitizeFolderName("四月八日の物語");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe("四月八日の物語");
    }
  });

  it("Windows 予約文字(/ \\ : * ?)を除去する", () => {
    // backslash は JS 文字列リテラル中で `\\` と書くため、
    // 実際の入力は `a/b\c:d*e?f`(9 文字)になる。
    const result = sanitizeFolderName("a/b\\c:d*e?f");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe("abcdef");
    }
  });

  it("ASCII 制御文字(U+0001 / U+001F / U+007F)を除去する", () => {
    // 入力: `foo` + U+0001 + `bar` + U+001F + `baz` + U+007F
    // 期待: 制御文字のみ除去されて `foobarbaz` になる
    const input = "foobarbaz";
    const result = sanitizeFolderName(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe("foobarbaz");
    }
  });

  it("末尾の半角スペースとピリオドを除去する", () => {
    const result = sanitizeFolderName("hello.   ");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe("hello");
    }
  });

  it("全角スペース(U+3000)は保持する", () => {
    const result = sanitizeFolderName("四月　八日");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe("四月　八日");
    }
  });

  // 推奨ケース: 末尾全角スペースは保持される(U+3000 は trim 対象外)
  it("末尾の全角スペース(U+3000)は保持する", () => {
    const result = sanitizeFolderName("hello　");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe("hello　");
    }
  });

  // 推奨ケース: backslash 除去によりパストラバーサル文字列が無害化される
  it("パストラバーサル文字列(..\\evil)から backslash を除去する", () => {
    const result = sanitizeFolderName("..\\evil");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe("..evil");
    }
  });

  // 推奨ケース: 240 文字ちょうどはセーフ(strict `>` での判定なので)
  it("ちょうど 240 文字ならエラーにならない", () => {
    const input = "あ".repeat(240);
    const result = sanitizeFolderName(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.folderName).toBe(input);
      expect(result.folderName.length).toBe(240);
    }
  });
});

describe("sanitizeFolderName — エラー系(ok=false)", () => {
  it("サニタイズ結果が空ならば error.kind=empty を返す", () => {
    // `?` は予約文字なので 3 文字とも除去され、空になる
    const result = sanitizeFolderName("???");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.folderName).toBe("");
      expect(result.error.kind).toBe("empty");
    }
  });

  it("空文字入力ならば error.kind=empty を返す", () => {
    const result = sanitizeFolderName("");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.folderName).toBe("");
      expect(result.error.kind).toBe("empty");
    }
  });

  it("長すぎる入力(300 文字)は error.kind=tooLong を返し length を含む", () => {
    const input = "あ".repeat(300);
    const result = sanitizeFolderName(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.folderName).toBe(input);
      expect(result.error.kind).toBe("tooLong");
      if (result.error.kind === "tooLong") {
        expect(result.error.length).toBe(300);
      }
    }
  });

  // 推奨ケース: 241 文字(境界の +1)も tooLong になり length が一致する
  it("241 文字(境界 +1)は error.kind=tooLong / length=241 を返す", () => {
    const input = "a".repeat(241);
    const result = sanitizeFolderName(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.folderName).toBe(input);
      expect(result.error.kind).toBe("tooLong");
      if (result.error.kind === "tooLong") {
        expect(result.error.length).toBe(241);
      }
    }
  });
});
