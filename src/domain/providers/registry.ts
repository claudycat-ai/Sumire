import { AIConfig, AIProvider, ProviderError } from "./types";
import { OpenAICompatibleAdapter } from "./openaiCompatible";
import { OpenAIAdapter } from "./openai";
import { LlamaServerAdapter } from "./llamaServer";

/**
 * AIConfig.provider に応じてアダプタを返す薄い factory。
 *
 * 対応プロバイダ: "openai-compatible"(ローカル / 互換サーバ)、"openai"(OpenAI クラウド API)、
 * "llama-server"(Sumire が起動する llama-server。実効の AIConfig を渡す)。
 * 将来 Claude / Gemini を加える際はここに分岐を増やす。
 * インスタンスは config 同一性に対してキャッシュし、設定が変わったら再生成する。
 *
 * キャッシュ戦略は WeakMap による参照同一性ベース。
 * `useAIConfigStore.updateProviderSection` は新しい AIConfig オブジェクトを生成するため、
 * 設定変更時はキャッシュミスとなり新しい Adapter インスタンスが生成される(意図通り)。
 */
const cache = new WeakMap<AIConfig, AIProvider>();

export function getProvider(config: AIConfig): AIProvider {
  const cached = cache.get(config);
  if (cached) return cached;

  const provider = createProvider(config);
  cache.set(config, provider);
  return provider;
}

function createProvider(config: AIConfig): AIProvider {
  switch (config.provider) {
    case "openai-compatible":
      return new OpenAICompatibleAdapter(config);
    case "llama-server":
      return new LlamaServerAdapter(config);
    case "openai":
      return new OpenAIAdapter(config);
    default:
      throw new ProviderError(
        "config",
        `未知のプロバイダ: ${config.provider}(対応: openai-compatible / openai / llama-server)`,
      );
  }
}
