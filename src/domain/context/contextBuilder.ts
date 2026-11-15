import i18n from "@/i18n";
import {
  AIConfig,
  AIProvider,
  ContextSection,
  GenerationRequest,
  ParsedPromptTemplate,
  getProvider,
  templateLiteralText,
} from "@/domain/providers";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import {
  CATEGORY_ORDER,
  FileCategory,
} from "@/domain/project/filesApi";

/**
 * ContextBuilder の本実装(M3-b)。
 *
 * 仕様 `02-architecture.md` §164-172 のトークン予算配分に従って、
 * AI に渡すリクエストを組み立てる:
 *
 *   システムプロンプト → 設定セクション → 本文 → 生成余地(maxTokens)
 *
 * - **設定セクション**: AIConfig.settingsTokenBudget(既定 500)を上限に、
 *   ファイル単位で詰める。挿入順(=settingsContextStore の Map 順)で先頭から
 *   評価し、入らないファイルは丸ごと外す(本文を行/文字単位で切らない)。
 * - **本文**: コンテキスト窓(AIConfig.contextWindow、既定 2048)から
 *   システム・設定・生成余地を引いた残りに収まるよう、**先頭から削る**
 *   (カーソル直前の文脈を優先するため)。
 *
 * トークン計測は `provider.countTokens` を利用する。設定セクションの本文は
 * Map<string, number> でキャッシュし、繰り返し提案要求時の API 呼び出しを抑える。
 *
 * 章ごとに含める設定セットを切り替える機能は MVP 後の拡張(仕様 §97 周辺の注記参照)。
 *
 * **プロンプトテンプレート**(`prompt-template` spec): 解決済みのテンプレートが渡されたときは、
 * 差し込み口以外の文字列のトークン数も本文枠から引く。テンプレートの文字列は削らない。
 * `{{system}}` / `{{settings}}` の差し込み口が無ければ、その内容はプロンプトに入らないので
 * 数えない(設定ファイルも詰めない)。テンプレートが無ければ従来の計算のまま。
 */

interface BuildContextInput {
  /** 提案リクエストの直前本文(ルビ剥がし済み)。 */
  body: string;
  /** 適用する systemPrompt(`null` の場合は呼び出し側で fallback 済みの想定)。 */
  systemPrompt: string;
  /** 現在のプロジェクトの AI 設定。プロバイダの取得とトークン予算に使う。 */
  aiConfig: AIConfig;
  /** 生成余地として確保するトークン数(=parameters.maxTokens)。 */
  maxTokens: number;
  /** 解決済みのテンプレート。無ければ今の計算のまま。 */
  promptTemplate?: ParsedPromptTemplate;
}

export interface BuiltContext {
  systemPrompt: string;
  contextSections: ContextSection[];
  body: string;
  /** 内部で使った計測値(デバッグ・将来のステータスバー表示用)。 */
  usedTokens: {
    system: number;
    sections: number;
    body: number;
    /** 生成余地として確保している分。 */
    reserved: number;
    /** コンテキスト窓上限。 */
    window: number;
    /** テンプレートの差し込み口以外の文字列の分。テンプレートなしは 0。 */
    template: number;
  };
}

/** 設定ファイルを予算まで詰めた結果(続き生成と挿し絵の文脈で共有)。 */
export interface PackedSettings {
  /** 採用した設定セクション。挿入順。 */
  accepted: ContextSection[];
  /** 予算に入らず外したファイルの表示名(`ContextSection.label`)。挿入順。 */
  dropped: string[];
  /** 採用したセクションのトークン数の合計。 */
  tokens: number;
}

/** 設定ファイル本文 → トークン数 のキャッシュ。同一文字列に対する API 連打を抑制。 */
const sectionTokenCache = new Map<string, number>();

/** 計測キャッシュをクリアする(プロジェクト切替や設定大量変更時に呼ぶ想定)。 */
export function clearContextBuilderCache(): void {
  sectionTokenCache.clear();
}

export async function buildContext(input: BuildContextInput): Promise<BuiltContext> {
  const provider = getProvider(input.aiConfig);
  const window = input.aiConfig.contextWindow ?? 2048;
  const settingsBudget = input.aiConfig.settingsTokenBudget ?? 500;
  const reserved = Math.max(0, input.maxTokens);
  const template = input.promptTemplate;
  // テンプレートに差し込み口が無い内容はプロンプトに入らないので数えない。
  const includeSystem = !template || template.slots.has("system");
  const includeSettings = !template || template.slots.has("settings");

  // 1. システムプロンプトのトークン数を計測
  const systemTokens =
    includeSystem && input.systemPrompt.trim()
      ? await provider.countTokens(input.systemPrompt)
      : 0;

  // 2. 設定セクションを挿入順で詰める(ファイル単位、settings 予算上限)
  const packed: PackedSettings = includeSettings
    ? await packSettingSections(provider, settingsBudget)
    : { accepted: [], dropped: [], tokens: 0 };
  const acceptedSections = packed.accepted;
  const usedSettingsTokens = packed.tokens;

  // 3. テンプレートの差し込み口以外の文字列を計測(同じ文字列はキャッシュを使う)。
  //    この文字列は削らないので、本文枠から丸ごと引く。
  const templateTokens = template
    ? await measureSectionCached(provider, templateLiteralText(template))
    : 0;

  // 4. 本文枠を計算: 窓 - システム - 設定 - テンプレート - 生成余地
  const bodyBudget = Math.max(
    0,
    window - systemTokens - usedSettingsTokens - templateTokens - reserved,
  );

  // 5. 本文を切り詰める(先頭から削る)
  const trimmedBody = await trimBodyHead(provider, input.body, bodyBudget);
  const bodyTokens = await provider.countTokens(trimmedBody);

  return {
    systemPrompt: input.systemPrompt,
    contextSections: acceptedSections,
    body: trimmedBody,
    usedTokens: {
      system: systemTokens,
      sections: usedSettingsTokens,
      body: bodyTokens,
      reserved,
      window,
      template: templateTokens,
    },
  };
}

/**
 * settingsContextStore から includeInContext: true の設定ファイルを集める。
 * 順序は CATEGORY_ORDER(章を除く)→ 同一カテゴリ内は Map の挿入順。
 */
function collectSettingSections(): ContextSection[] {
  const files = useSettingsContextStore.getState().files;
  if (files.size === 0) return [];

  const byCategory = new Map<FileCategory, ContextSection[]>();
  for (const f of files.values()) {
    const sec: ContextSection = {
      label: `${i18n.t(`category.${f.category}`)}: ${f.title}`,
      content: f.body,
      category: f.category,
    };
    const arr = byCategory.get(f.category);
    if (arr) arr.push(sec);
    else byCategory.set(f.category, [sec]);
  }
  const ordered: ContextSection[] = [];
  for (const cat of CATEGORY_ORDER) {
    if (cat === "chapters") continue;
    const arr = byCategory.get(cat);
    if (!arr) continue;
    ordered.push(...arr);
  }
  return ordered;
}

/**
 * `includeInContext: true` の設定ファイルを、挿入順に budget まで詰める(ファイル単位)。
 *
 * 入らないファイルは丸ごと外し、続くファイルが小さければ入れる(continue)。
 * 外したファイルの表示名は `dropped` に挿入順で返す。
 */
export async function packSettingSections(
  provider: AIProvider,
  budget: number,
): Promise<PackedSettings> {
  const accepted: ContextSection[] = [];
  const dropped: string[] = [];
  let tokens = 0;
  for (const sec of collectSettingSections()) {
    const n = await measureSectionCached(provider, sec.content);
    if (tokens + n > budget) {
      // ファイル単位で諦める。続くファイルが小さければ入る可能性もあるので continue。
      dropped.push(sec.label);
      continue;
    }
    accepted.push(sec);
    tokens += n;
  }
  return { accepted, dropped, tokens };
}

/** 文字列のトークン数を測る。同じ文字列はモジュール共有のキャッシュを使う。 */
export async function measureSectionCached(
  provider: AIProvider,
  content: string,
): Promise<number> {
  const cached = sectionTokenCache.get(content);
  if (cached !== undefined) return cached;
  const n = await provider.countTokens(content);
  sectionTokenCache.set(content, n);
  return n;
}

/**
 * 本文を末尾から見て、トークン予算に収まる最長の suffix を返す。
 *
 * 二分探索の素朴版:文字単位で前から削る位置を二分探索する。
 * 日本語の文字数とトークン数はおおむね線形関係(係数 ~1.5)なので、
 * 計測 API 呼び出しは log 回程度で収束する。
 *
 * budget が 0 以下ならば空文字を返す。
 */
export async function trimBodyHead(
  provider: AIProvider,
  body: string,
  budget: number,
): Promise<string> {
  if (budget <= 0) return "";

  // まず全体が入るかを確認。入るならそのまま返す(計測 1 回で済む)。
  const total = await provider.countTokens(body);
  if (total <= budget) return body;

  // 入らない場合: 文字配列(サロゲートペア対応)で先頭から削る位置を二分探索。
  // 不変条件: lo は「budget を超える(=削りすぎ ↓ 余地)」、hi は「budget に入る(=これ以上削らなくていい)」境界。
  // 文字数が n のとき、削る文字数 k ∈ [0, n]。k=0 が「削らない」(=超過)、k=n が「全削除」(=入る)。
  const chars = Array.from(body);
  let lo = 0; // ここまでは超過(=もっと削る必要)
  let hi = chars.length; // ここまで削れば入る

  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = chars.slice(mid).join("");
    const tokens = await provider.countTokens(candidate);
    if (tokens <= budget) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return chars.slice(hi).join("");
}

/**
 * 本文を先頭から見て、トークン予算に収まる最長の prefix を返す(末尾から削る)。
 *
 * `trimBodyHead` と対称。挿し絵の文脈で、場面より後の本文を場面から遠い側
 * (末尾)から削るために使う。budget が 0 以下ならば空文字を返す。
 */
export async function trimBodyTail(
  provider: AIProvider,
  body: string,
  budget: number,
): Promise<string> {
  if (budget <= 0) return "";

  const total = await provider.countTokens(body);
  if (total <= budget) return body;

  // 残す文字数 k ∈ [0, n] を二分探索する。
  // 不変条件: lo 文字残せば入る(k=0 は空なので入る)、hi 文字残すと超過(k=n は超過済み)。
  const chars = Array.from(body);
  let lo = 0;
  let hi = chars.length;

  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join("");
    const tokens = await provider.countTokens(candidate);
    if (tokens <= budget) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return chars.slice(0, lo).join("");
}

/**
 * suggestionController から呼ぶ:カーソル位置までの本文(ルビ剥がし済み)を渡し、
 * 切り詰め後の GenerationRequest 部品を取得する。
 */
export async function buildGenerationRequest(
  aiConfig: AIConfig,
  systemPrompt: string,
  body: string,
  promptTemplate?: ParsedPromptTemplate,
): Promise<Pick<GenerationRequest, "systemPrompt" | "contextSections" | "body"> & {
  usedTokens: BuiltContext["usedTokens"];
}> {
  const built = await buildContext({
    aiConfig,
    systemPrompt,
    body,
    maxTokens: aiConfig.parameters.maxTokens,
    promptTemplate,
  });
  return {
    systemPrompt: built.systemPrompt,
    contextSections: built.contextSections,
    body: built.body,
    usedTokens: built.usedTokens,
  };
}
