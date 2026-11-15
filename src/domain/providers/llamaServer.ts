import { estimateTokens, OpenAICompatibleAdapter } from "./openaiCompatible";
import { AIConfig } from "./types";

/**
 * Sumire が起動した `llama-server` を叩くアダプタ(`llama-server-provider` spec)。
 *
 * 生成(`generateStream` / `generate`)は OpenAI 互換アダプタのものをそのまま使う。
 * プロンプトの組み立ても SSE の解釈も同じコードを通るので、OpenAI 互換のときに無い
 * 文字や構造は足されない(Req 8.8)。差し替えるのはトークン数の計測だけ。
 *
 * 接続先(ポート)とコンテキスト長は、呼び出し側が「実効の `AIConfig`」として渡す。
 */
export class LlamaServerAdapter extends OpenAICompatibleAdapter {
  private readonly serverRoot: string;

  constructor(config: AIConfig) {
    super(config);
    this.serverRoot = stripV1(config.endpoint);
  }

  /**
   * 読み込んだモデルのトークナイザで数える(Req 7.4、7.5)。
   * `/tokenize` は OpenAI 互換の `/v1` の外にあり、`{ tokens: number[] }` を返す。
   * 失敗したとき・形が違うときは、OpenAI 互換アダプタと同じ推定に落とす。
   */
  override async countTokens(text: string): Promise<number> {
    try {
      const data = await this.postJson("/tokenize", { content: text }, this.serverRoot);
      const tokens = (data as { tokens?: unknown } | null)?.tokens;
      if (Array.isArray(tokens)) return tokens.length;
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn("[providers] llama-server countTokens fallback to heuristic:", e);
      }
    }
    return estimateTokens(text);
  }
}

function stripV1(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base.slice(0, -3) : base;
}
