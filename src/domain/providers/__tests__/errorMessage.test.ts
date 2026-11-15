/**
 * `illustration-prompt` spec task 1.1: プロバイダのエラーの文言の共有口(`describeProviderError`)。
 *
 * 続き生成の提案コントローラ(`suggestionController.handleError`)が出していた文言と
 * 同じ文字列を返すこと、文言を持たない分類(`auth` / `rateLimit`)は null を返すことを確かめる。
 *
 * Requirements(illustration-prompt): 7.5
 */
import { describe, expect, it } from "vitest";

import { describeProviderError, ProviderError } from "@/domain/providers";

describe("describeProviderError", () => {
  it("network は接続できない旨を返す", () => {
    expect(describeProviderError(new ProviderError("network", "fetch failed"))).toBe(
      "推論サーバーに接続できません",
    );
  });

  it("timeout はタイムアウトの旨を返す", () => {
    expect(describeProviderError(new ProviderError("timeout", "aborted"))).toBe(
      "応答がタイムアウトしました",
    );
  });

  it("http はエラーのメッセージを添えて返す", () => {
    expect(describeProviderError(new ProviderError("http", "HTTP 500: boom"))).toBe(
      "推論サーバーがエラーを返しました: HTTP 500: boom",
    );
  });

  it("parse は解析できない旨を返す", () => {
    expect(describeProviderError(new ProviderError("parse", "bad json"))).toBe(
      "推論サーバーの応答を解析できませんでした",
    );
  });

  it("config はエラーのメッセージをそのまま返す", () => {
    expect(
      describeProviderError(new ProviderError("config", "エンドポイントが未設定です")),
    ).toBe("エンドポイントが未設定です");
  });

  it.each(["auth", "rateLimit"] as const)("%s は文言を持たず null を返す", (kind) => {
    expect(describeProviderError(new ProviderError(kind, "x"))).toBeNull();
  });
});
