/**
 * AI プロバイダ抽象。
 * `02-architecture.md` §98-157 のインターフェース定義に対応する。
 *
 * MVP では OpenAICompatibleAdapter のみ。将来 ClaudeAdapter / GeminiAdapter を追加する。
 */

import type { ParsedPromptTemplate } from "./promptTemplate";

export interface AIProvider {
  /**
   * `request.body` の **続き** をストリーミングで生成する(チャット応答ではない)。
   * Sumire は AI と会話するツールではなく、本文の続きをゴーストテキストとして提案するツール。
   * このため OpenAI 互換アダプタは内部で `/v1/completions`(レガシー補完)を使う。
   * Chat 系 API しか提供しないクラウドプロバイダ用のアダプタを将来実装する際は、
   * その内部で chat メッセージへの変換を行ってこの契約を満たすこと。
   *
   * 各チャンクには **その回の差分テキストのみ** を載せる(累積テキストではない)。
   * 呼び出し側で連結する。`AbortSignal` を渡すことで途中停止できる。
   */
  generateStream(
    request: GenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<GenerationChunk>;

  /**
   * 単発生成。デバッグ用途・シンプルな呼び出し向け。
   * 実装は `generateStream` を内部で呼んで集約する thin wrapper。
   */
  generate(request: GenerationRequest): Promise<GenerationResponse>;

  /** トークン数を計測する。プロバイダの API を介して正確な値を返す。 */
  countTokens(text: string): Promise<number>;
}

/**
 * ストリーミング生成の 1 チャンク。
 * `textDelta` はその回の差分のみ。`finishReason` は最終チャンクでのみ設定される。
 */
export interface GenerationChunk {
  textDelta: string;
  finishReason?: GenerationResponse["finishReason"];
}

export interface GenerationRequest {
  systemPrompt: string;
  /** 設定情報など、構造化された前置き。 */
  contextSections: ContextSection[];
  /**
   * 直前の本文(プロンプトの末尾)。
   * AI はこの文字列の **続き** を生成する(チャット応答ではない)。
   * 末尾の改行・空白はモデルの解釈に影響するため、呼び出し側が意図して整形する。
   */
  body: string;
  parameters: GenerationParameters;
  /**
   * OpenAI 互換アダプタだけが使う。解決済みのプロンプトテンプレート。無ければ素の連結。
   * 推論サーバーへの送信本文には含めない(包んだ結果の `prompt` としてだけ送る)。
   */
  promptTemplate?: ParsedPromptTemplate;
}

export interface ContextSection {
  /** 例: "キャラ設定: アリス" */
  label: string;
  content: string;
  /**
   * セクションの所属カテゴリ識別子(例: "characters" / "worldbuilding")。
   * `OpenAICompatibleAdapter` は同一カテゴリのセクションを単一改行でベタ連結し、
   * 異なるカテゴリ間は空行(\n\n)で区切る。
   * 未指定の場合は同一カテゴリ扱い(1 ブロックにまとめて連結される)。
   */
  category?: string;
}

export interface GenerationParameters {
  temperature: number;
  topP: number;
  maxTokens: number;
  /** モデル固有の追加パラメータを吸収する。 */
  extras?: Record<string, unknown>;
}

export interface GenerationResponse {
  text: string;
  finishReason: "stop" | "length" | "error";
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * `sumire.json` の `ai` セクションに対応する設定。
 */
export interface AIConfig {
  /** プロバイダ識別子。MVP では "openai-compatible" のみ。 */
  provider: string;
  endpoint: string;
  model: string;
  parameters: GenerationParameters;
  /** null の場合はアプリ内蔵の既定プロンプトを使う。 */
  systemPrompt: string | null;
  /** リクエストタイムアウト(ミリ秒)。未指定なら 60000。 */
  timeoutMs?: number;
  /**
   * 設定情報(includeInContext: true の設定ファイル)に割り当てるトークン予算上限。
   * ContextBuilder はこの上限内に収まるよう、超過分のファイルを丸ごと外す。
   * 既定 500。仕様 §322 参照。
   */
  settingsTokenBudget?: number;
  /**
   * モデルのコンテキスト窓(トークン数)。本文切り詰めの基準に使う。
   * 既定 2048(初期検証モデル japanese-stablelm-instruct-alpha-7b-v2 の値)。
   */
  contextWindow?: number;
  /**
   * 思考の分離の設定。未設定なら undefined。実行時の既定値は `resolveThinkingTags` が補う。
   * `parameters` の中には置かない(`parameters.extras` はリクエスト本文に展開され、
   * 推論サーバーに送られてしまうため)。
   */
  thinking?: ThinkingConfig;
  /**
   * プロンプトテンプレートの指定。`sumire.json` の値を型を検査せずに生のまま持つ。
   * 未設定なら undefined。解釈と不備の判定は `resolvePromptTemplate` が行い、
   * この値を読む口はその関数に限る。
   * `parameters` の中には置かない(`parameters.extras` はリクエスト本文に展開され、
   * 推論サーバーに送られてしまうため)。
   */
  template?: unknown;
  /**
   * 挿し絵の情景文の設定(`illustration-prompt` spec)。`sumire.json` の値を型を検査せずに
   * 生のまま持つ。未設定なら undefined で、既定値では埋めない。解釈と既定値の補完は
   * 挿し絵の設定の解決が行う。
   * `parameters` の中には置かない(`parameters.extras` はリクエスト本文に展開され、
   * 推論サーバーに送られてしまうため)。
   */
  illustration?: unknown;
}

/** 思考ブロックとみなすタグの組。 */
export interface ThinkingTagPair {
  open: string;
  close: string;
}

/**
 * `sumire.json` の `aiConfig.providers.<id>.thinking`。読めた値をそのまま持つ。
 * 省略や空文字の組を含みうるので、実行時のタグの組は `resolveThinkingTags` で決める。
 */
export interface ThinkingConfig {
  enabled?: boolean;
  tags?: ThinkingTagPair[];
}

/** 新規プロジェクトの sumire.json に書く思考の分離の既定値。 */
export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  enabled: true,
  tags: [{ open: "<think>", close: "</think>" }],
};

/** 既定のバンドルの各セクションに入れる、`DEFAULT_THINKING_CONFIG` の deep copy。 */
function copyDefaultThinkingConfig(): ThinkingConfig {
  return {
    enabled: DEFAULT_THINKING_CONFIG.enabled,
    tags: DEFAULT_THINKING_CONFIG.tags?.map((pair) => ({ ...pair })),
  };
}

/**
 * Sumire がサポートするプロバイダ種別の識別子。
 * `cloud-providers` spec 以降、ローカル(openai-compatible)とクラウド(openai)を切り替える。
 * `llama-server` は、Sumire が `llama-server` を自分で起動するプロバイダ(`llama-server-provider` spec)。
 */
export type ProviderId = "openai-compatible" | "openai" | "llama-server";

/**
 * `/v1/completions` に素のプロンプトを送るローカルのプロバイダかを判定する。
 * プロンプトテンプレートと挿し絵の情景文を使える条件になる。
 */
export function isLocalCompletionProvider(provider: string): boolean {
  return provider === "openai-compatible" || provider === "llama-server";
}

/**
 * プロバイダ種別ごとに `AIConfig` を保持し、現在使う種別を `activeProvider` で示すバンドル。
 * `sumire.json` の `ai` セクションは将来このバンドルに置き換わる(後続タスクで吸収)。
 *
 * 不変条件:
 * - `providers` は全 `ProviderId` のキーを必ず持つ(`Record<ProviderId, AIConfig>`)。
 * - `activeProvider` は必ず `providers` のキーのいずれかを指す。
 */
export interface AIConfigBundle {
  /** 現在使うプロバイダ種別 */
  activeProvider: ProviderId;
  /** プロバイダ種別ごとの設定。全 ProviderId キーが必ず存在する */
  providers: Record<ProviderId, AIConfig>;
}

/**
 * MVP の既定 AI 設定。新規プロジェクト作成時や、`sumire.json` の ai セクション欠落時のフォールバック。
 */
export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: "openai-compatible",
  endpoint: "http://127.0.0.1:5000/v1",
  model: "japanese-stablelm-instruct-alpha-7b-v2",
  parameters: {
    temperature: 0.8,
    topP: 0.9,
    maxTokens: 200,
  },
  systemPrompt: null,
  timeoutMs: 60000,
  settingsTokenBudget: 500,
  contextWindow: 2048,
  thinking: copyDefaultThinkingConfig(),
};

/**
 * 全プロバイダ種別の既定 `AIConfig` を含むバンドルの初期値。
 * `activeProvider` は既存ユーザーの後方互換のため `openai-compatible` を採用する。
 *
 * - `openai-compatible`: 既存の `DEFAULT_AI_CONFIG`(localhost:5000, japanese-stablelm)
 * - `openai`: gpt-4o-mini / contextWindow 128000(API キーは別経路で注入する想定)
 * - `llama-server`: 生成パラメータ・思考の分離は `openai-compatible` の既定と同じ。
 *   接続先とモデル名は空文字で、`contextWindow` は持たせない(接続先・モデル・コンテキスト長は
 *   PC ごとのアプリ側の設定から決まり、`sumire.json` には書かないため)
 *
 * 各セクションの `thinking` は `DEFAULT_THINKING_CONFIG` のコピーで、参照を共有しない。
 */
export const DEFAULT_AI_CONFIG_BUNDLE: AIConfigBundle = {
  activeProvider: "openai-compatible",
  providers: {
    "openai-compatible": DEFAULT_AI_CONFIG,
    openai: {
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      parameters: {
        temperature: 0.8,
        topP: 0.9,
        maxTokens: 200,
      },
      systemPrompt: null,
      timeoutMs: 60000,
      settingsTokenBudget: 500,
      contextWindow: 128000,
      thinking: copyDefaultThinkingConfig(),
    },
    "llama-server": {
      provider: "llama-server",
      endpoint: "",
      model: "",
      parameters: { ...DEFAULT_AI_CONFIG.parameters },
      systemPrompt: DEFAULT_AI_CONFIG.systemPrompt,
      timeoutMs: DEFAULT_AI_CONFIG.timeoutMs,
      settingsTokenBudget: DEFAULT_AI_CONFIG.settingsTokenBudget,
      thinking: copyDefaultThinkingConfig(),
    },
  },
};

/**
 * プロバイダ層から投げる例外。トースト表示や UI 分岐で instanceof 判定する。
 *
 * - ネットワーク断・タイムアウト・5xx 等の「リクエスト自体が成立しなかった」失敗は例外で返す。
 * - サーバーが正常応答した上で生成が破綻した場合は GenerationResponse.finishReason = "error" を使う。
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly cause?: unknown;

  constructor(kind: ProviderErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.cause = cause;
  }
}

export type ProviderErrorKind =
  | "network" // fetch そのものの失敗
  | "timeout" // AbortController によるタイムアウト
  | "http" // 4xx/5xx 応答
  | "parse" // 応答 JSON のパース失敗・期待フィールド欠落
  | "config" // endpoint 未設定など利用前の設定不備
  | "auth" // 401 認証失敗(API キー不正・欠落など。Req 3.7)
  | "rateLimit"; // 429 レート制限・クォータ超過(Req 3.8)
