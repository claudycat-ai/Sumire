import { nativeFetch } from "@/domain/http";
import { toProviderErrorFromStart } from "./nativeErrors";
import { renderPromptTemplate } from "./promptTemplate";
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
 * OpenAI 互換 HTTP API を叩くアダプタ(続き生成用)。
 *
 * - text-generation-webui の `--api` モード、Ollama、LM Studio など、レガシーな
 *   `/v1/completions`(=テキスト続き生成)互換のサーバーを対象とする。
 * - **Chat ではなく Completion を使う**。Sumire は AI と会話するツールではなく、
 *   本文の続きをゴーストテキストとして提案するツールであり、
 *   chat 経路だと Instruct モデルが「ユーザー発言への応答」と解釈してしまうため。
 * - HTTP は `@/domain/http` の `nativeFetch` で Rust 側に送らせる(WebView の `fetch` は
 *   推論サーバーのアクセス元制限(CORS)に阻まれるため)。応答は Web 標準の `Response`
 *   なので、SSE の解釈とステータスの分類は `fetch` のときと同じ。開始時エラー
 *   (HTTP を送る前の設定不備)は `toProviderErrorFromStart` で config に変換する。
 * - **既定はストリーミング**。SSE で受信し、チャンクごとに textDelta を yield する。
 *
 * `02-architecture.md` §98-157 の方針に従う。
 */
export class OpenAICompatibleAdapter implements AIProvider {
  constructor(private readonly config: AIConfig) {
    if (!config.endpoint) {
      throw new ProviderError("config", "AI エンドポイントが設定されていません");
    }
  }

  async *generateStream(
    request: GenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<GenerationChunk> {
    const prompt = buildPrompt(request);
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
    // 内部のタイムアウト用 controller を、外から渡された signal と OR 合成する。
    // どちらかが abort したら nativeFetch も中断される(応答前は AbortError で reject、
    // 受信中は本文ストリームの error。どちらも下の signal 判定で振り分ける)。
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
      });
    } catch (e) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      // 開始時エラー(URL のスキーム等。HTTP は送られていない)は設定不備として返す。
      const startError = toProviderErrorFromStart(e, {});
      if (startError) throw startError;
      // 外部 signal による abort は静かに終わる(呼び出し側の意図的停止)
      if (signal.aborted) return;
      if (inner.signal.aborted) {
        throw new ProviderError("timeout", `応答がタイムアウトしました (${timeoutMs}ms)`, e);
      }
      throw new ProviderError("network", `推論サーバーに接続できません (${url})`, e);
    }

    if (!res.ok) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      const detail = await safeReadText(res);
      throw new ProviderError(
        "http",
        `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      );
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
          const chunk = parseSSEEvent(event);
          if (chunk === "DONE") return;
          if (chunk) yield chunk;
        }
      }
      // ストリーム終端到達(サーバが [DONE] を送らずに閉じるケース)
      if (buffer.trim().length > 0) {
        const chunk = parseSSEEvent(buffer);
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
    // text-generation-webui の `/v1/internal/token-count` は `{ length: N }` を返す
    // (`tokens` キーは存在しない: modules/api/tokens.py token_count() 参照)。
    // 接続不可・404 等で失敗した場合は estimate fallback(文字数 × 1.5)。
    // fallback は日本語 stablelm 系の実係数(約 0.5)に対して過大評価になるが、
    // 実係数はモデル/トークナイザ依存で確実に当てられないため当たり障りのない倍率に倒す。
    try {
      const data = await this.postJson("/internal/token-count", { text });
      const length = (data as { length?: unknown }).length;
      if (typeof length === "number" && Number.isFinite(length)) {
        return Math.max(0, Math.floor(length));
      }
    } catch (e) {
      if (import.meta.env.DEV) {
        console.warn("[providers] countTokens fallback to heuristic:", e);
      }
    }
    return estimateTokens(text);
  }

  /**
   * JSON を POST して応答の JSON を返す。`baseUrl` は、`/v1` の外にあるエンドポイント
   * (llama-server の `/tokenize` など)を継承先から叩くための口。省けば設定の接続先。
   */
  protected async postJson(
    path: string,
    body: unknown,
    baseUrl: string = this.config.endpoint,
  ): Promise<unknown> {
    const url = joinUrl(baseUrl, path);
    const timeoutMs = this.config.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await nativeFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // 開始時エラーも投げる。countTokens 経由なら推定値に落ちる(Req 5.5)。
      const startError = toProviderErrorFromStart(e, {});
      if (startError) throw startError;
      if (controller.signal.aborted) {
        throw new ProviderError("timeout", `応答がタイムアウトしました (${timeoutMs}ms)`, e);
      }
      throw new ProviderError("network", `推論サーバーに接続できません (${url})`, e);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new ProviderError(
        "http",
        `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }

    try {
      return await res.json();
    } catch (e) {
      throw new ProviderError("parse", "応答 JSON をパースできませんでした", e);
    }
  }
}

/**
 * 1 つの SSE イベント(`\n\n` 区切り単位)をパースする。
 * 戻り値:
 *   - "DONE": `data: [DONE]` を受信(ストリーム終端)
 *   - GenerationChunk: 通常チャンク
 *   - null: 空イベント・コメント行のみ・パース不能(=スキップ)
 *
 * SSE は複数行の `data: ` を改行で連結する仕様(MDN 参照)だが、
 * OpenAI 互換は実質 1 イベント 1 data 行なので素直に最初の data: 行のみ拾う。
 */
function parseSSEEvent(event: string): GenerationChunk | "DONE" | null {
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
          console.warn("[providers] SSE chunk had no choices[0].text:", payload);
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
        console.warn("[providers] SSE chunk JSON parse failed:", payload, e);
      }
      return null;
    }
  }
  return null;
}

/**
 * GenerationRequest を 1 本のプロンプト文字列に組み立てる。
 *
 * 構造は次の通り(空セクションは省略):
 *   [systemPrompt]
 *
 *   コンテキスト1の本文
 *
 *   コンテキスト2の本文
 *
 *   [body]                ← ここから続きが生成される
 *
 * **ラベル(`# キャラ設定: すみれ` 等)はプロンプトに出さない。**
 * Instruct 系の小規模モデルが見出しパターンに引きずられて妙な出力を返すのを避ける、
 * かつ書き手が「ファイル冒頭にどう見出しを書くか」を自分で決められるようにするため。
 * `ContextSection.label` はログ・将来の chat 系アダプタ用にデータとして保持されるが、
 * ここでは使わない。
 *
 * `body` は末尾改行を入れない。改行を入れるとモデルが「段落を切って次の段落を始めろ」と
 * 解釈しがちなため、書き手のカーソル位置からシームレスに続けるには末尾を素のままにする。
 *
 * `02-architecture.md` §164-172 の優先順位(システム → 設定 → 本文 → 生成余地)を踏襲。
 * ContextBuilder 側でトークン予算を割り当てたあと、ここで文字列整形だけ行う想定。
 *
 * `req.promptTemplate`(解決済みのテンプレート)があるときは、上の素の連結の代わりに
 * テンプレートの差し込み口へ内容を入れた文字列を返す(`prompt-template` spec)。
 * 差し込む内容は素の連結と同じ: システムプロンプトは前後の空白を除いたもの、設定は
 * `joinSections` の連結規則でつないだもの、本文はそのまま。テンプレートの文字列と
 * 差し込み口の内容のほかには何も付け足さない。
 */
function buildPrompt(req: GenerationRequest): string {
  if (req.promptTemplate) {
    return renderPromptTemplate(req.promptTemplate, {
      system: req.systemPrompt.trim(),
      settings: joinSections(req.contextSections),
      body: req.body,
    });
  }
  const blocks: string[] = [];
  if (req.systemPrompt.trim()) {
    blocks.push(req.systemPrompt.trim());
  }
  if (req.contextSections.length > 0) {
    // 仕様 `01-ux.md` §97 周辺:
    //   - 同一カテゴリのファイル間は単一改行でベタ連結(=同セクションのリスト/段落として連続)
    //   - 異なるカテゴリ間は空行(\n\n)で区切る(=セクション境界として認識)
    //   - 段落区切りや空行は同一ファイル内で表現する
    const joined = joinSections(req.contextSections);
    if (joined) blocks.push(joined);
  }
  // システムプロンプト・設定全体・本文 の境目は 1 行空け(\n\n)。これは論理境界の区切り。
  const head = blocks.join("\n\n");
  return head ? `${head}\n\n${req.body}` : req.body;
}

/**
 * カテゴリ単位で連結方式を切り替える:
 *   同一カテゴリ内 → "\n"(ベタ連結)
 *   異なるカテゴリ間 → "\n\n"(空行 1 行)
 * 同じカテゴリのセクションが連続して並んでいる前提(ContextBuilder 側でカテゴリ順に整列済み)。
 * `category` が未指定のものは便宜上の暗黙カテゴリ key("__uncategorized__")にまとめる。
 *
 * 挿し絵の文脈の `【設定】` ブロックでも同じ連結規則を使うため export する
 * (`illustration-prompt` spec)。挙動はアダプタの素の連結・テンプレートの描画と共通。
 */
export function joinSections(sections: ContextSection[]): string {
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
 * 文字数からトークン数を雑に推定する。日本語の text-generation-webui 系トークナイザでは
 * おおむね 1 文字 ≒ 1.5 トークン程度になる経験則を採用。
 * 継承先(`LlamaServerAdapter`)の計測の失敗時にも同じ推定を使うため export する。
 */
export function estimateTokens(text: string): number {
  // Array.from で正しく文字単位(サロゲートペア含む)で数える
  return Math.ceil(Array.from(text).length * 1.5);
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function safeReadText(res: Response): Promise<string | null> {
  try {
    const t = await res.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return null;
  }
}
