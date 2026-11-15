/**
 * プロバイダのエラーの分類を、トーストの文言にする共有口(`illustration-prompt` spec の
 * design.md「errorMessage」)。続き生成と挿し絵の情景文で同じ分類と文言を使う(要件 7.5)。
 *
 * 文言は続き生成の提案コントローラが出していたものをそのまま移したもので、日本語の直書きの
 * まま持つ(英語表示でもこの文言だけは日本語で出る。i18n 化は続き生成と合わせて行う)。
 */

import type { ProviderError } from "./types";

/**
 * `ProviderError` の分類をトーストの文言にする。文言を持たない分類は null。
 *
 * `auth` / `rateLimit` は OpenAI 互換プロバイダでは起きない(クラウドのアダプタだけが投げる)。
 * 今の続き生成もこの 2 つには文言を持たないので、同じく null を返す。
 * 呼び出し側は null のときと `ProviderError` でないときの扱いを自分で決める。
 */
export function describeProviderError(e: ProviderError): string | null {
  switch (e.kind) {
    case "network":
      return "推論サーバーに接続できません";
    case "timeout":
      return "応答がタイムアウトしました";
    case "http":
      return `推論サーバーがエラーを返しました: ${e.message}`;
    case "parse":
      return "推論サーバーの応答を解析できませんでした";
    case "config":
      return e.message;
    case "auth":
    case "rateLimit":
      return null;
  }
}
