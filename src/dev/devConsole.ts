/**
 * 開発モード(import.meta.env.DEV)時のみブラウザ DevTools コンソールから
 * Sumire の内部 API を叩けるよう、window に __sumire を生やす。
 *
 * 本番ビルドではこのモジュール自体が呼ばれない(main.tsx で DEV 条件分岐)。
 *
 * 例(DevTools コンソール):
 *   await window.__sumire.providers.generate({
 *     systemPrompt: "あなたは日本語 Web 小説の優秀な共著者です。",
 *     contextSections: [],
 *     body: "彼女は窓際に立ち、",
 *     parameters: { temperature: 0.8, topP: 0.9, maxTokens: 100 },
 *   });
 *
 *   // OS keychain への API キー保管(task 4.1)。キーの値は取得できない
 *   // (provider-http-rust Req 7.5)。設定済みかどうかだけを確かめられる。
 *   await window.__sumire.secrets.setSecret("openai", "sk-test");
 *   await window.__sumire.secrets.hasSecret("openai"); // true
 *   await window.__sumire.secrets.deleteSecret("openai");
 *   await window.__sumire.secrets.hasSecret("openai"); // false
 */
import { useAIConfigStore } from "@/stores/aiConfigStore";
import {
  AIConfig,
  GenerationRequest,
  ProviderError,
  getProvider,
} from "@/domain/providers";
import { SecretStore } from "@/domain/secrets";

declare global {
  interface Window {
    __sumire?: SumireDevApi;
  }
}

interface SumireDevApi {
  /** 現在 active なプロバイダの AIConfig(プロジェクト未オープン時は null)。 */
  getAIConfig(): AIConfig | null;

  providers: {
    /** 単発生成。AIConfig がストアに無ければエラー。 */
    generate: (request: GenerationRequest) => ReturnType<ReturnType<typeof getProvider>["generate"]>;
    /** トークン数計測。 */
    countTokens: (text: string) => Promise<number>;
  };

  /**
   * OS keychain への API キー保管薄ラッパー(task 4.1)。
   * `setSecret` / `deleteSecret` / `hasSecret` を提供する。キーの値を取得する
   * 操作は SecretStore に無いので、コンソールからも取れない(provider-http-rust Req 7.5)。
   */
  secrets: typeof SecretStore;
}

export function installDevConsole(): void {
  const requireConfig = (): AIConfig => {
    const cfg = useAIConfigStore.getState().getActiveConfig();
    if (!cfg) {
      throw new ProviderError(
        "config",
        "プロジェクトがまだ開かれていません。先にプロジェクトを開いてください。",
      );
    }
    return cfg;
  };

  window.__sumire = {
    getAIConfig: () => useAIConfigStore.getState().getActiveConfig(),
    providers: {
      generate: (request) => getProvider(requireConfig()).generate(request),
      countTokens: (text) => getProvider(requireConfig()).countTokens(text),
    },
    secrets: SecretStore,
  };

  console.info(
    "[sumire] dev console mounted. Try: await window.__sumire.providers.generate({...})",
  );
}
