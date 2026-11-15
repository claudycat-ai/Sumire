import { nativeFetch, NativeHttpError } from "@/domain/http";
import { emitDevEvent } from "@/lib/devLog";
import { toProviderErrorFromStart } from "./nativeErrors";
import {
  AIConfig,
  AIProvider,
  ContextSection,
  GenerationChunk,
  GenerationRequest,
  GenerationResponse,
  ProviderError,
} from "./types";

/**
 * OpenAI 公式 API(`/v1/chat/completions` / `/v1/completions`)を叩くアダプタ。
 *
 * - Chat / Completion 両系統に対応(モデル名末尾 `-instruct` で経路判定、Completion 経路は task 5.3 で実装)
 * - HTTP は `@/domain/http` の `nativeFetch` で Rust 側に送らせ、`authProvider: "openai"` を
 *   指定する。保存済みの API キーは Rust 側が送信のたびに keychain から読んで
 *   `Authorization: Bearer` を付ける(画面側はキーの値に触れず、ヘッダーも組み立てない。
 *   provider-http-rust Req 7.1 / 7.2)。キー未設定は Rust 側が送信前に検出し、
 *   `toProviderErrorFromStart` で config に変換する(Req 7.4)
 * - SSE で受信、`AbortSignal` で停止
 * - エラー分類: 401 → `auth` / 429 → `rateLimit` / その他 4xx・5xx → `http` /
 *   network → `network` / キー未設定などの開始時エラー → `config`
 *   (HTTP ステータスごとの分岐は `mapHttpStatusToProviderError` を参照、Req 3.6/3.7/3.8)
 *
 * design.md OpenAIAdapter section (L254-309) 参照。
 */
export class OpenAIAdapter implements AIProvider {
  constructor(private readonly config: AIConfig) {
    if (!config.endpoint) {
      throw new ProviderError(
        "config",
        "OpenAI エンドポイントが設定されていません",
      );
    }
  }

  async *generateStream(
    request: GenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<GenerationChunk> {
    // モデル名末尾が `-instruct` 系なら Completion 経路、それ以外は Chat 経路(設計 L263)。
    if (isCompletionModel(this.config.model)) {
      yield* this.generateCompletionStream(request, signal);
    } else {
      yield* this.generateChatStream(request, signal);
    }
  }

  /**
   * `/v1/chat/completions` 経路の SSE ストリーミング生成。
   *
   * - 内蔵指示を system message にし、`request.systemPrompt`(=上流で
   *   `config.systemPrompt` または DEFAULT_SYSTEM_PROMPT が入っている)が非空なら
   *   改行 2 つで連結する(設計 L264)。
   * - 本文 + コンテキストを 1 本の user メッセージに束ねる(AC 3.2「本文を user メッセージとして送信」)。
   * - API キーは Rust 側が送信のたびに付ける(`authProvider: "openai"`、画面側はキーを読まない)。
   * - 外部 `signal` と内部タイムアウト用 controller を OR 合成して nativeFetch / 受信ループに連動。
   */
  private async *generateChatStream(
    request: GenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<GenerationChunk> {
    // 送信を試みる時点の記録。キーの有無は送信時に Rust 側で確かめるので、キー未設定の
    // ときは start の後に generate.error(config)が続く(toStartError 参照)。
    emitDevEvent("generate.start", {
      provider: "openai",
      path: "chat",
      model: this.config.model,
    });

    const systemMessageContent = composeSystemMessage(request.systemPrompt);
    const userContent = buildUserContent(request);
    const messages = [
      { role: "system", content: systemMessageContent },
      { role: "user", content: userContent },
    ];

    // 出力上限は全モデルで `max_completion_tokens`(`max_tokens` は公式に deprecated で、
    // 推論モデルは HTTP 400 で拒否する)。推論モデルは temperature / top_p を既定値以外で
    // 拒否することがあるので送らない。どうしても送りたい場合は extras で上書きできる。
    const body = {
      model: this.config.model,
      messages,
      ...(isReasoningModel(this.config.model)
        ? {}
        : {
            temperature: request.parameters.temperature,
            top_p: request.parameters.topP,
          }),
      max_completion_tokens: request.parameters.maxTokens,
      stream: true,
      ...(request.parameters.extras ?? {}),
    };

    const url = joinUrl(this.config.endpoint, "/chat/completions");
    const timeoutMs = this.config.timeoutMs ?? 60000;
    // 内部のタイムアウト用 controller を、外から渡された signal と OR 合成する。
    // どちらかが abort したら nativeFetch / SSE 受信ループも中断される(AC 3.9)。
    const inner = new AbortController();
    const onOuterAbort = () => inner.abort();
    if (signal.aborted) inner.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => inner.abort(), timeoutMs);

    let res: Response;
    try {
      res = await nativeFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: inner.signal,
        authProvider: "openai",
      });
    } catch (e) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      // 開始時エラー(キー未設定・URL のスキーム等。HTTP は送られていない)は設定不備として返す。
      const startError = toStartError(e, "chat");
      if (startError) throw startError;
      // 外部 signal による abort は静かに終わる(呼び出し側の意図的停止)
      if (signal.aborted) return;
      if (inner.signal.aborted) {
        throw new ProviderError("timeout", `応答がタイムアウトしました (${timeoutMs}ms)`, e);
      }
      throw new ProviderError("network", `OpenAI API に接続できません (${url})`, e);
    }

    if (!res.ok) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      const detail = await safeReadText(res);
      throw mapHttpStatusToProviderError(res.status, res.statusText, detail);
    }

    if (!res.body) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      throw new ProviderError("parse", "レスポンスボディがストリームではありません");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // CRLF / CR を LF に正規化してから連結。サーバが \r\n\r\n でイベント区切りを
        // 送ってくる実装(HTTP 標準)があり、\n\n だけ見てると残った \r で JSON パースがコケる。
        const text = decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        buffer += text;

        // SSE は \n\n でイベント区切り。完了済みイベントだけ取り出して処理。
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const chunk = parseChatSSEEvent(event);
          if (chunk === "DONE") return;
          if (chunk) yield chunk;
        }
      }
      // ストリーム終端到達(サーバが [DONE] を送らずに閉じるケース)
      if (buffer.trim().length > 0) {
        const chunk = parseChatSSEEvent(buffer);
        if (chunk && chunk !== "DONE") yield chunk;
      }
    } catch (e) {
      // 外部 signal による abort は静かに終わる
      if (signal.aborted) return;
      if (inner.signal.aborted) {
        throw new ProviderError("timeout", `応答がタイムアウトしました (${timeoutMs}ms)`, e);
      }
      throw new ProviderError("network", "ストリーム受信中にエラーが発生しました", e);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  /**
   * `/v1/completions` 経路の SSE ストリーミング生成(legacy completion API)。
   *
   * - `gpt-3.5-turbo-instruct` などの `-instruct` 系モデルが対象(設計 L263)。
   * - prompt は `request.systemPrompt`(=上流で `config.systemPrompt` または
   *   DEFAULT_SYSTEM_PROMPT が入っている)+ コンテキスト + 本文 を `\n\n` で連結する
   *   (設計 L264-265「Completion 経路でも合成ポリシーは同型」)。
   * - Chat 経路と同じく `authProvider: "openai"` でのキー付与(Rust 側)と AbortSignal の
   *   OR 合成を行う(AC 3.4 / 3.9)。
   * - SSE は `choices[0].text` を差分として読む(`OpenAICompatibleAdapter` と同型)。
   */
  private async *generateCompletionStream(
    request: GenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<GenerationChunk> {
    // 送信を試みる時点の記録。キーの有無は送信時に Rust 側で確かめるので、キー未設定の
    // ときは start の後に generate.error(config)が続く(toStartError 参照)。
    emitDevEvent("generate.start", {
      provider: "openai",
      path: "completion",
      model: this.config.model,
    });

    const prompt = buildCompletionPrompt(request);
    // `/v1/completions` には `max_completion_tokens` が無いので `max_tokens` のまま。
    const body = {
      model: this.config.model,
      prompt,
      temperature: request.parameters.temperature,
      top_p: request.parameters.topP,
      max_tokens: request.parameters.maxTokens,
      stream: true,
      ...(request.parameters.extras ?? {}),
    };

    const url = joinUrl(this.config.endpoint, "/completions");
    const timeoutMs = this.config.timeoutMs ?? 60000;
    // 内部のタイムアウト用 controller を、外から渡された signal と OR 合成する(AC 3.9)。
    const inner = new AbortController();
    const onOuterAbort = () => inner.abort();
    if (signal.aborted) inner.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => inner.abort(), timeoutMs);

    let res: Response;
    try {
      res = await nativeFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: inner.signal,
        authProvider: "openai",
      });
    } catch (e) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      // 開始時エラー(キー未設定・URL のスキーム等。HTTP は送られていない)は設定不備として返す。
      const startError = toStartError(e, "completion");
      if (startError) throw startError;
      if (signal.aborted) return;
      if (inner.signal.aborted) {
        throw new ProviderError("timeout", `応答がタイムアウトしました (${timeoutMs}ms)`, e);
      }
      throw new ProviderError("network", `OpenAI API に接続できません (${url})`, e);
    }

    if (!res.ok) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      const detail = await safeReadText(res);
      throw mapHttpStatusToProviderError(res.status, res.statusText, detail);
    }

    if (!res.body) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      throw new ProviderError("parse", "レスポンスボディがストリームではありません");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        buffer += text;

        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const chunk = parseCompletionSSEEvent(event);
          if (chunk === "DONE") return;
          if (chunk) yield chunk;
        }
      }
      if (buffer.trim().length > 0) {
        const chunk = parseCompletionSSEEvent(buffer);
        if (chunk && chunk !== "DONE") yield chunk;
      }
    } catch (e) {
      if (signal.aborted) return;
      if (inner.signal.aborted) {
        throw new ProviderError("timeout", `応答がタイムアウトしました (${timeoutMs}ms)`, e);
      }
      throw new ProviderError("network", "ストリーム受信中にエラーが発生しました", e);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }

  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    const inner = new AbortController();
    let text = "";
    let finishReason: GenerationResponse["finishReason"] = "stop";
    for await (const chunk of this.generateStream(request, inner.signal)) {
      text += chunk.textDelta;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    return { text, finishReason };
  }

  async countTokens(text: string): Promise<number> {
    // task 5.2 完成後にトークンカウント方式を確定する。
    // 現状は一旦文字数 × 1.5 のヒューリスティック(OpenAICompatibleAdapter と同じ式)。
    // 公式 tiktoken-style API は OpenAI 互換サーバーには無いため、当面はヒューリスティック方式で進む。
    return Math.ceil(Array.from(text).length * 1.5);
  }
}

/**
 * 既知 OpenAI モデルの context window(入力 + 出力トークンの上限)。
 *
 * AISettingsPane (task 7.4) でモデル選択時に contextWindow を自動補完するために使う。
 * 未知モデルは undefined となり、ユーザー手動入力で contextWindow を設定する設計
 * (Req 4.5、design L268)。
 *
 * 値は OpenAI 公式ドキュメント(2026-05 時点)に基づく:
 * - gpt-4o / gpt-4o-mini / gpt-4-turbo: 128000
 * - gpt-4: 8192
 * - gpt-3.5-turbo: 16385(2024 年以降の 0125 以降)
 * - gpt-3.5-turbo-instruct: 4096
 *
 * 将来モデルが追加・廃止された場合は手動更新する(自動取得 API は提供されていない)。
 */
export const OPENAI_CONTEXT_WINDOW_MAP: Readonly<Record<string, number>> = {
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4o-2024-11-20": 128000,
  "gpt-4o-2024-08-06": 128000,
  "gpt-4o-mini-2024-07-18": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4-turbo-2024-04-09": 128000,
  "gpt-4": 8192,
  "gpt-4-0613": 8192,
  "gpt-3.5-turbo": 16385,
  "gpt-3.5-turbo-0125": 16385,
  "gpt-3.5-turbo-instruct": 4096,
};

/**
 * OpenAI の `/v1/models` を叩いてモデル ID の配列を返す静的ヘルパー。
 *
 * AISettingsPane (task 7.4) の「モデル一覧を更新」ボタンから呼ばれる想定。
 * 結果のキャッシュは呼び出し側 React state に持たせる(永続化しない、設計 L267)。
 *
 * HTTP は `nativeFetch` で Rust 側に送らせ、`authProvider: "openai"` を指定する。
 * 保存済みの API キーは Rust 側が付けるので、引数にキーを取らず Authorization も
 * 組み立てない(provider-http-rust Req 7.3)。キー未設定は Rust 側が送信前に検出し、
 * 「OpenAI API キーが設定されていません」の config に変換する(Req 7.4)。
 *
 * @param endpoint OpenAI エンドポイント(例: "https://api.openai.com/v1")
 * @param signal AbortSignal、呼び出し側からキャンセル可能
 * @returns モデル ID の配列(例: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, ...])
 * @throws ProviderError(`config` / `auth` / `rateLimit` / `http` / `network` / `parse`)
 *
 * @internal exported for test in task 11.5
 */
export async function listOpenAIModels(
  endpoint: string,
  signal?: AbortSignal,
): Promise<{ id: string }[]> {
  if (!endpoint) {
    throw new ProviderError("config", "OpenAI エンドポイントが設定されていません");
  }

  const url = joinUrl(endpoint, "/models");
  let res: Response;
  try {
    res = await nativeFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      authProvider: "openai",
      signal,
    });
  } catch (e) {
    // 開始時エラー(キー未設定・URL のスキーム等。HTTP は送られていない)は設定不備として返す。
    const startError = toProviderErrorFromStart(e, { secretLabel: "OpenAI" });
    if (startError) throw startError;
    if (signal?.aborted) {
      // 呼び出し側 abort は静かに ProviderError を投げない方針もあるが、
      // ここでは「abort されたら例外」のパターンを採用してフロー単純化
      throw new ProviderError("network", "モデル一覧取得が中断されました", e);
    }
    throw new ProviderError("network", `OpenAI に接続できません (${url})`, e);
  }

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw mapHttpStatusToProviderError(res.status, res.statusText, detail);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (e) {
    throw new ProviderError("parse", "モデル一覧 JSON のパースに失敗しました", e);
  }

  // OpenAI のレスポンス形式: { object: "list", data: [{ id: string, ... }, ...] }
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as { data?: unknown }).data)
  ) {
    throw new ProviderError("parse", "モデル一覧の形式が不正です(data 配列が見つかりません)");
  }

  const items = (data as { data: unknown[] }).data;
  return items
    .filter((item): item is { id: string } => {
      return (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string"
      );
    })
    .map((item) => ({ id: item.id }));
}

/**
 * 生成経路の nativeFetch の開始時エラーを `ProviderError`(config)に変換する。開始時エラー
 * でなければ `null`(呼び出し側の既存の分岐に任せる)。
 *
 * キー未設定(`missingSecret`)のときは、移行前(画面側でキーを確かめていた頃)と同じ
 * `generate.error` の dev イベントを、変換したこの時点で出す。
 */
function toStartError(e: unknown, path: "chat" | "completion"): ProviderError | null {
  const err = toProviderErrorFromStart(e, { secretLabel: "OpenAI" });
  if (err && e instanceof NativeHttpError && e.kind === "missingSecret") {
    emitDevEvent("generate.error", {
      provider: "openai",
      path,
      kind: "config",
      message: err.message,
    });
  }
  return err;
}

/**
 * Chat 経路で system message として送る内蔵指示。
 *
 * 設計 L264 / tasks 5.2 で要求される固定文言。`config.systemPrompt`(non-null の場合)は
 * この後ろに改行 2 つで連結される(`composeSystemMessage` 参照)。
 *
 * 上流の suggestionController は `config.systemPrompt` が文字列で非空ならそれを、
 * そうでなければ DEFAULT_SYSTEM_PROMPT を `request.systemPrompt` に詰めて渡してくる
 * (suggestionController.ts L175-178)。よって `request.systemPrompt` が非空なら
 * その内容(=ユーザー固有の作品指示)を内蔵指示の後ろに足す。
 */
const INTERNAL_CHAT_INSTRUCTION =
  "以下の本文の続きを書いてください。挨拶・要約・解説は不要です。続きの文章のみを返してください。";

/**
 * 内蔵指示と `request.systemPrompt` を改行 2 つで連結して system message 本文を作る。
 * `requestSystemPrompt` が null / 空白のみなら内蔵指示のみを返す。
 *
 * @internal exported for test in task 11.2
 */
export function composeSystemMessage(requestSystemPrompt: string | null | undefined): string {
  const extra = (requestSystemPrompt ?? "").trim();
  if (!extra) return INTERNAL_CHAT_INSTRUCTION;
  return `${INTERNAL_CHAT_INSTRUCTION}\n\n${extra}`;
}

/**
 * 1 つの SSE イベント(`\n\n` 区切り単位)を Chat 経路用にパースする。
 * 戻り値:
 *   - "DONE": `data: [DONE]` を受信(ストリーム終端)
 *   - GenerationChunk: 通常チャンク(`choices[0].delta.content` を textDelta に詰める)
 *   - null: 空イベント・コメント行のみ・パース不能(=スキップ)
 *
 * Chat ストリームでは終盤に `delta.content` が空かつ `finish_reason` のみ立ったチャンクが
 * 来ることがある。その場合は textDelta="" + finishReason 付きの空チャンクとして返し、
 * 呼び出し側に finishReason を伝搬する。
 *
 * @internal exported for test in task 11.2
 */
export function parseChatSSEEvent(event: string): GenerationChunk | "DONE" | null {
  const lines = event.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]") return "DONE";
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload) as {
        choices?: Array<{
          delta?: { content?: unknown };
          finish_reason?: unknown;
        }>;
      };
      const choice = obj.choices?.[0];
      const content = choice?.delta?.content;
      const fr = choice?.finish_reason;
      const finishReason =
        fr === "stop" || fr === "length"
          ? (fr as GenerationResponse["finishReason"])
          : fr === null || fr === undefined
            ? undefined
            : "error";
      if (typeof content !== "string") {
        // finish_reason のみのチャンクは textDelta="" + finishReason として伝える
        if (finishReason !== undefined) {
          return { textDelta: "", finishReason };
        }
        return null;
      }
      return { textDelta: content, finishReason };
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn("[providers/openai] SSE chat chunk JSON parse failed:", payload, e);
      }
      return null;
    }
  }
  return null;
}

/**
 * Chat 経路の user メッセージ本文を組み立てる。
 *
 * 構造(空セクションは省略):
 *   コンテキスト1の本文
 *
 *   コンテキスト2の本文
 *
 *   [body]                ← ここから続きが生成される
 *
 * `OpenAICompatibleAdapter.buildPrompt` の構造から **systemPrompt の prefix を除いた** 形。
 * systemPrompt は別途 system message に乗せているので、ここでは設定情報 + 本文だけを束ねる。
 *
 * `body` は末尾改行を入れない(モデルが「段落を切って次の段落」と解釈するのを避ける)。
 *
 * @internal exported for test in task 11.2
 */
export function buildUserContent(req: GenerationRequest): string {
  const blocks: string[] = [];
  if (req.contextSections.length > 0) {
    const joined = joinSections(req.contextSections);
    if (joined) blocks.push(joined);
  }
  const head = blocks.join("\n\n");
  return head ? `${head}\n\n${req.body}` : req.body;
}

/**
 * モデル名末尾が `-instruct` 系かを判定する(`/v1/completions` 経路の対象)。
 * `gpt-3.5-turbo-instruct` 等が該当する。
 *
 * 設計 L263 「明示の `apiKind` フィールド導入は次バージョン課題」のため、
 * 当面はモデル名サフィックスでヒューリスティック判定する。
 */
function isCompletionModel(model: string): boolean {
  return model.toLowerCase().endsWith("-instruct");
}

/**
 * 推論モデル(gpt-5 以降の `gpt-N` と、o1 / o3 / o4-mini などの o-series)かを判定する。
 * Chat 経路で temperature / top_p を送らない対象。
 *
 * `isCompletionModel` と同じく、モデル名の前方一致で判定する。gpt-5-chat-latest のような
 * 非推論の派生も推論側に倒す(temperature が効かないだけで、400 にはならない安全側)。
 * AI 設定画面の「このモデルには送信されません」の注記もこの判定を使う。
 */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  if (/^o\d/.test(m)) return true;
  const gpt = /^gpt-(\d+)/.exec(m);
  return gpt != null && Number(gpt[1]) >= 5;
}

/**
 * Completion 経路の prompt を組み立てる。
 *
 * 構造(空セクションは省略):
 *   [systemPrompt]
 *
 *   コンテキスト1の本文
 *
 *   コンテキスト2の本文
 *
 *   [body]                ← ここから続きが生成される
 *
 * `OpenAICompatibleAdapter.buildPrompt` と同じ合成ポリシー(設計 L264-265「Completion 経路でも
 * 合成ポリシーは同型」)。`body` は末尾改行を入れない(モデルが「段落を切って次の段落」と
 * 解釈するのを避ける)。
 *
 * `request.systemPrompt` は上流(suggestionController)で `config.systemPrompt` または
 * DEFAULT_SYSTEM_PROMPT が詰められて渡ってくる。
 *
 * @internal exported for test in task 11.2
 */
export function buildCompletionPrompt(request: GenerationRequest): string {
  const blocks: string[] = [];
  const sys = request.systemPrompt?.trim();
  if (sys) blocks.push(sys);
  if (request.contextSections.length > 0) {
    const joined = joinSections(request.contextSections);
    if (joined) blocks.push(joined);
  }
  const head = blocks.join("\n\n");
  return head ? `${head}\n\n${request.body}` : request.body;
}

/**
 * 1 つの SSE イベント(`\n\n` 区切り単位)を Completion 経路用にパースする。
 * 戻り値:
 *   - "DONE": `data: [DONE]` を受信(ストリーム終端)
 *   - GenerationChunk: 通常チャンク(`choices[0].text` を textDelta に詰める)
 *   - null: 空イベント・コメント行のみ・パース不能(=スキップ)
 *
 * `OpenAICompatibleAdapter.parseSSEEvent` と同型。boundary 単純化のためここに複製する
 * (両アダプタで共通化したくなったら `_shared.ts` 抽出を検討)。
 *
 * @internal exported for test in task 11.2
 */
export function parseCompletionSSEEvent(event: string): GenerationChunk | "DONE" | null {
  const lines = event.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]") return "DONE";
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload) as {
        choices?: Array<{ text?: unknown; finish_reason?: unknown }>;
      };
      const choice = obj.choices?.[0];
      const text = choice?.text;
      if (typeof text !== "string") {
        if (import.meta.env.DEV) {
          console.warn("[providers/openai] SSE completion chunk had no choices[0].text:", payload);
        }
        return null;
      }
      const fr = choice?.finish_reason;
      const finishReason =
        fr === "stop" || fr === "length"
          ? (fr as GenerationResponse["finishReason"])
          : fr === null || fr === undefined
            ? undefined
            : "error";
      return { textDelta: text, finishReason };
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn("[providers/openai] SSE completion chunk JSON parse failed:", payload, e);
      }
      return null;
    }
  }
  return null;
}

/**
 * カテゴリ単位で連結方式を切り替える:
 *   同一カテゴリ内 → "\n"(ベタ連結)
 *   異なるカテゴリ間 → "\n\n"(空行 1 行)
 *
 * `OpenAICompatibleAdapter.joinSections` と同じ仕様。boundary 単純化のためにここで複製する
 * (ヘルパーが膨らんだら `_shared.ts` 抽出を検討、task 5.3 以降の判断)。
 */
function joinSections(sections: ContextSection[]): string {
  const groups: { category: string; contents: string[] }[] = [];
  for (const s of sections) {
    const c = s.content.trim();
    if (!c) continue;
    const key = s.category ?? "__uncategorized__";
    const last = groups[groups.length - 1];
    if (last && last.category === key) {
      last.contents.push(c);
    } else {
      groups.push({ category: key, contents: [c] });
    }
  }
  return groups.map((g) => g.contents.join("\n")).join("\n\n");
}

/**
 * `OpenAICompatibleAdapter.joinUrl` と同じ。boundary 単純化のため複製。
 */
function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * OpenAI からの HTTP non-OK レスポンスを `ProviderError` に変換する。
 *
 * - 401 → `auth`(「API キーが無効です」、Req 3.7)
 * - 429 → `rateLimit`(「レート制限に達しました」、Req 3.8)
 * - その他 4xx / 5xx → `http`(既存挙動、Req 3.6 の対比対象)
 *
 * `generateChatStream` / `generateCompletionStream` の `if (!res.ok)` 分岐から共通で呼ばれる。
 * design.md OpenAIAdapter Responsibilities (~L271) / Error Handling (~L640-651) /
 * ProviderErrorKind 拡張 (~L354-367) 参照。
 *
 * @internal exported for test in task 11.2
 */
export function mapHttpStatusToProviderError(
  status: number,
  statusText: string,
  detail: string | null,
): ProviderError {
  const detailSuffix = detail ? `: ${detail}` : "";
  if (status === 401) {
    return new ProviderError(
      "auth",
      `API キーが無効です (HTTP 401${statusText ? ` ${statusText}` : ""})${detailSuffix}`,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "rateLimit",
      `レート制限に達しました (HTTP 429${statusText ? ` ${statusText}` : ""})${detailSuffix}`,
    );
  }
  return new ProviderError(
    "http",
    `HTTP ${status} ${statusText}${detailSuffix}`,
  );
}

/**
 * `OpenAICompatibleAdapter.safeReadText` と同じ。boundary 単純化のため複製。
 */
async function safeReadText(res: Response): Promise<string | null> {
  try {
    const t = await res.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return null;
  }
}
