import type { AIConfig } from "@/domain/providers/types";
import type { LlamaServerStatus } from "./types";

/**
 * `sumire.json` の `providers["llama-server"]` のセクションに、起動した `llama-server` から
 * 決まる接続先・モデル名・コンテキスト長を埋めた、実効の設定を返す。
 * 戻り値は生成に渡すだけで、保存しない(これらは PC ごとの値で、`sumire.json` には書かない)。
 *
 * @param actualContextSize `/props` で分かった、実際に確保された長さ。取れなければ null
 */
export function buildEffectiveConfig(
  section: AIConfig,
  status: Extract<LlamaServerStatus, { state: "ready" }>,
  actualContextSize: number | null,
): AIConfig {
  return {
    ...section,
    endpoint: `http://127.0.0.1:${status.port}/v1`,
    model: fileNameOf(status.modelPath),
    // section.contextWindow は見ない。コンテキスト長はモデルごとにアプリ側で決めた値が正で、
    // llama-server が指定より小さく確保したときは、実際の長さで予算を計算する。
    contextWindow: actualContextSize ?? status.contextSize,
  };
}

/** パスの最後の要素。Windows の `\` と `/` のどちらの区切りでも切る。 */
export function fileNameOf(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(lastSeparator + 1);
}
