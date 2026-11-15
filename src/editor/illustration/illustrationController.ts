/**
 * 挿し絵の情景文の生成のライフサイクル(開始の条件、生成、思考の分離、メモへの追記)。
 * `illustration-prompt` spec の design.md「illustrationController」に対応する。
 *
 * - 開始の条件を順に確かめ、満たさなければトーストを出して、生成中の状態を作らずに戻る
 * - 文脈を組み立て、挿し絵用のテンプレートと値でストリーミング送信し、思考を分けて受け取る
 * - 終わり方を 1 か所で決め、本文があれば出所の行つきでメモに追記する。それ以外はトーストで理由を伝える
 * - Esc(`stopIllustration`)とプロジェクトの変更で中止する。中止は静かに終える(要件 5.3, 5.8)
 * - `llama-server` では、開始の条件の最後に起動の関門を通し、生成中に `llama-server` が
 *   止められた・起動し直されたら中止する(`llama-server-provider` spec の要件 3.4, 4.2, 6.6)
 * - どの終わり方でも `finally` で購読を解き、状態を戻す(要件 7.6)
 *
 * 生成中も本文には dispatch しない。提案のライフサイクル(suggestionLifecycle)にも登録しないので、
 * 入力・カーソル移動・章の切り替えでは止まらない(要件 1.4, 4.5, 5.2)。
 * `editor/suggestion` は import せず、提案の生成中かどうかはストアだけを読む。
 */
import type { EditorView } from "@codemirror/view";

import i18n from "@/i18n";
import { toastError, toastInfo } from "@/components/ui/Toast";
import {
  createThinkingSplitter,
  describeProviderError,
  getProvider,
  isLocalCompletionProvider,
  ProviderError,
  resolveThinkingTags,
  type AIConfig,
  type GenerationChunk,
  type GenerationRequest,
  type PromptTemplateError,
  type ParsedPromptTemplate,
  type ThinkingResult,
  type ThinkingSplitter,
} from "@/domain/providers";
import {
  resolveIllustrationConfig,
  type IllustrationConfigError,
  type IllustrationSettings,
} from "@/domain/illustration/illustrationConfig";
import { buildIllustrationContext } from "@/domain/illustration/illustrationContext";
import {
  formatIllustrationEntry,
  type IllustrationEntrySource,
} from "@/domain/illustration/illustrationEntry";
import { appendToMemo } from "@/domain/memo/memoApi";
import { emitDevEvent } from "@/lib/devLog";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { useAppStore } from "@/stores/appStore";
import { useIllustrationStore } from "@/stores/illustrationStore";
import { prepareLlamaServerConfig, useLlamaServerStore } from "@/stores/llamaServerStore";
import { useSuggestionStore } from "@/stores/suggestionStore";
import { extractScene, type ExtractedScene } from "./sceneSelection";

/**
 * 進行中の生成。同時に 1 つだけ持つ(design.md「State Management」)。
 * `projectPath` は開始時のプロジェクトのパス(プロジェクトが開かれていなければ null)。
 * `unsubscribe` は、プロジェクトの変更と `llama-server` の状態を見張る購読を解く。
 */
let inflight: {
  controller: AbortController;
  projectPath: string | null;
  unsubscribe: () => void;
} | null = null;

type FinishReason = GenerationChunk["finishReason"];

/**
 * 生成の終わり方。`finish()` の結果と終了理由、例外、中止から決める(design.md「終わり方」の表)。
 *
 * - `appended`: 本文あり、終了理由が上限以外。メモに追記する
 * - `truncated`: 本文あり、上限で途切れた。注記つきでメモに追記する
 * - `thinkingMaxTokens` / `thinkingUnfinished`: 思考が終わらないまま応答が終わった
 * - `empty`: 思考を除いた本文が空
 * - `sceneTooLong`: 場面がコンテキストに収まらず、送信しなかった
 * - `aborted`: Esc、プロジェクトの変更、`llama-server` の停止・起動し直しで中止した。追記もトーストもしない
 * - `failed`: 例外(`ProviderError` を含む)
 */
type IllustrationOutcome =
  | { kind: "appended"; text: string }
  | { kind: "truncated"; text: string }
  | { kind: "thinkingMaxTokens" }
  | { kind: "thinkingUnfinished" }
  | { kind: "empty" }
  | { kind: "sceneTooLong" }
  | { kind: "aborted" }
  | { kind: "failed"; error: unknown };

/**
 * 1 回の生成で、終わり方の判定と dev ログのために持ち回る値。
 * 文字数はどれも UTF-16 の単位(`String.prototype.length`)で数える。トークン数は
 * ストリーミングの応答に含まれないので、思考の長さの目安として文字数で代える(design.md「State Management」)。
 */
interface IllustrationRun {
  config: AIConfig;
  settings: IllustrationSettings;
  scene: ExtractedScene;
  signal: AbortSignal;
  /** 中止されたか、プロジェクトが開始時から変わったか */
  isCancelled: () => boolean;
  /** 受け取った最後の終了理由(dev ログ用) */
  finishReason: FinishReason;
  /** 受け取った応答の総文字数(dev ログ用)。応答を受け取る前に終わったら 0 のまま */
  responseChars: number;
  /** 思考を除いた情景文の文字数(dev ログ用)。思考の分離を終える(`finish()`)前に終わったら null */
  textChars: number | null;
}

/**
 * Alt+I。開始の条件を満たせば情景文の生成を始める。キーは常に吸う(true)。
 *
 * 開始の条件は「情景文の生成中 → 提案の生成中 → プロジェクト → プロバイダ → 挿し絵の設定 → 場面
 * → `llama-server` の起動の関門」の順に確かめ、満たさなければトーストを出して戻る
 * (関門のトーストは関門の側が出す)。このとき生成中の状態は作らない。
 */
export function requestIllustration(view: EditorView): boolean {
  // 1. 情景文の生成中(5.5)
  if (inflight) {
    toastError(i18n.t("toast.illustrationBusy"));
    return true;
  }
  // 2. 提案の生成中(5.7)
  if (useSuggestionStore.getState().generating) {
    toastError(i18n.t("toast.illustrationSuggestionBusy"));
    return true;
  }
  // 3. 設定が無い(プロジェクトが開かれていない)。文言は続き生成と同じ直書き
  const activeConfig = useAIConfigStore.getState().getActiveConfig();
  if (!activeConfig) {
    toastError("プロジェクトを開いてください");
    return true;
  }
  // 4. ローカルの Completion のプロバイダ(OpenAI 互換・llama-server)でない(7.1)
  if (!isLocalCompletionProvider(activeConfig.provider)) {
    toastError(i18n.t("toast.illustrationProviderUnsupported"));
    return true;
  }
  // 5. 挿し絵用の設定の不備(7.2)。要求のたびに解決する
  const resolution = resolveIllustrationConfig(activeConfig.illustration);
  if (resolution.kind === "error") {
    toastError(configErrorMessage(resolution.error));
    return true;
  }
  // 6. 場面が無い(1.3)
  const scene = extractScene(view.state);
  if (!scene) {
    toastError(i18n.t("toast.illustrationNoScene"));
    return true;
  }
  // 7. llama-server が準備完了でない。断るときのトースト(と読み込みの開始)は関門が行う。
  // 以後は、関門が返した設定(起動した llama-server の接続先を埋めたもの)を使う
  const prepared = prepareLlamaServerConfig(activeConfig);
  if (prepared.kind === "declined") return true;
  const config = prepared.config;

  // 開始。章ファイル名はここで記録し、生成中に章を切り替えても開始時の章名で追記する(4.5)
  const source: IllustrationEntrySource = {
    chapterName: useAppStore.getState().selectedChapter?.name ?? "",
    sceneHead: scene.sceneHead,
  };
  // プロジェクトのパスを記録し、変わったら(閉じたときの null を含む)中止する(5.8)
  const projectPath = currentProjectPath();
  const controller = new AbortController();
  const unsubscribeProject = useAppStore.subscribe((state) => {
    if ((state.currentProject?.path ?? null) !== projectPath) controller.abort();
  });
  const unsubscribeLlamaServer = watchLlamaServer(config, controller);
  const unsubscribe = () => {
    unsubscribeProject();
    unsubscribeLlamaServer();
  };
  inflight = { controller, projectPath, unsubscribe };
  const startedAt = Date.now();
  useIllustrationStore.getState().start(startedAt);

  const settings = resolution.settings;
  const template = templateSourceName(settings.template);
  emitDevEvent("illustration.start", { template });

  const run: IllustrationRun = {
    config,
    settings,
    scene,
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted || currentProjectPath() !== projectPath,
    finishReason: undefined,
    responseChars: 0,
    textChars: null,
  };
  void (async () => {
    let outcome: IllustrationOutcome;
    try {
      outcome = await generate(run);
      // 追記の直前に、中止されていないことと、プロジェクトが変わっていないことを確かめる
      if (run.isCancelled()) outcome = { kind: "aborted" };
      await settle(outcome, source);
    } catch (e) {
      // 中止のあとに届いた例外は、失敗として伝えない
      outcome = run.isCancelled() ? { kind: "aborted" } : { kind: "failed", error: e };
      await settle(outcome, source);
    } finally {
      unsubscribe();
      if (inflight?.controller === controller) {
        inflight = null;
        useIllustrationStore.getState().finish();
      }
    }
    logOutcome(outcome, {
      template,
      durationMs: Date.now() - startedAt,
      finishReason: run.finishReason ?? null,
      responseChars: run.responseChars,
      textChars: run.textChars,
      // 応答の総文字数から情景文の文字数を引いた残り(思考ブロックとタグ、つなぎで除いた空白など)
      thinkingChars: run.textChars === null ? null : run.responseChars - run.textChars,
    });
  })();
  return true;
}

/**
 * Esc。情景文の生成中なら中止して true、そうでなければ false(キーを下に流す)。
 * 中止は静かに終える(追記もトーストもしない)。状態は生成の `finally` で戻る。
 * すでに中止したあとなら、もう一度は中止せず false を返す。
 */
export function stopIllustration(_view: EditorView): boolean {
  if (!inflight || inflight.controller.signal.aborted) return false;
  inflight.controller.abort();
  return true;
}

/**
 * 設定が `llama-server` のものなら、生成の間ストアを見張り、準備完了でなくなるか、起動の
 * 通し番号が変わったら中止する(停止・モデルの切り替え)。戻り値で購読を解く。
 * ストアは command を呼ぶ前に状態を書き換えるので、プロセスが止まる前に中止でき、
 * 接続の失敗のトーストにならない。
 */
function watchLlamaServer(config: AIConfig, controller: AbortController): () => void {
  if (config.provider !== "llama-server") return () => {};
  const runId = useLlamaServerStore.getState().status.runId;
  return useLlamaServerStore.subscribe((state) => {
    if (state.status.state !== "ready" || state.status.runId !== runId) controller.abort();
  });
}

function currentProjectPath(): string | null {
  return useAppStore.getState().currentProject?.path ?? null;
}

/** dev ログに出すテンプレートの出典。プリセットなら名前、自由記述なら "custom" */
function templateSourceName(template: ParsedPromptTemplate): string {
  return template.source.kind === "preset" ? template.source.name : "custom";
}

/**
 * 文脈を組み立てて送信し、終わり方を決める。追記とトーストは `settle` に任せる。
 * 中止されていたら、その時点で `aborted` を返す(送信の前、外した設定のトーストの前)。
 */
async function generate(run: IllustrationRun): Promise<IllustrationOutcome> {
  const { config, settings, scene } = run;
  const built = await buildIllustrationContext({ aiConfig: config, settings, scene });
  if (run.isCancelled()) return { kind: "aborted" };
  if (built.kind === "sceneTooLong") return { kind: "sceneTooLong" };
  // 外した設定は、送信の前に 1 回だけ伝える(2.6)
  if (built.droppedSettings.length > 0) {
    toastInfo(
      i18n.t("toast.illustrationSettingsDropped", { names: built.droppedSettings.join("、") }),
    );
  }

  // 温度・最大トークンは挿し絵用、topP・extras は続き生成の値をそのまま使う(6.1)
  const request: GenerationRequest = {
    systemPrompt: built.systemPrompt,
    contextSections: [],
    body: built.body,
    parameters: {
      ...config.parameters,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    },
    promptTemplate: settings.template,
  };
  const provider = getProvider({ ...config, timeoutMs: settings.timeoutMs });
  return receive(
    provider.generateStream(request, run.signal),
    createThinkingSplitter(resolveThinkingTags(config.thinking)),
    run,
  );
}

/**
 * ストリームを受け取り、思考を分けて、終わり方を決める。
 * スナップショットは使わない(本文に何も出さないため)。終わり方は `finish()` の結果で決める。
 */
async function receive(
  stream: AsyncIterable<GenerationChunk>,
  splitter: ThinkingSplitter,
  run: IllustrationRun,
): Promise<IllustrationOutcome> {
  for await (const chunk of stream) {
    // 終了理由は本文が空のチャンクで届くことがあるので、読み飛ばす前に記録する
    if (chunk.finishReason !== undefined) run.finishReason = chunk.finishReason;
    if (!chunk.textDelta) continue;
    run.responseChars += chunk.textDelta.length;
    splitter.push(chunk.textDelta);
  }
  const result = splitter.finish();
  run.textChars = result.text.length;
  return decideOutcome(result, run.finishReason);
}

/**
 * `finish()` の結果と終了理由から終わり方を決める。思考が終わっていないことを空より先に見る
 * (思考前の本文が無い応答で「空」にすると、maxTokens の見直しに気づけないため)。
 */
function decideOutcome(result: ThinkingResult, finishReason: FinishReason): IllustrationOutcome {
  if (result.unfinishedThinking) {
    return { kind: finishReason === "length" ? "thinkingMaxTokens" : "thinkingUnfinished" };
  }
  if (result.text.trim() === "") return { kind: "empty" };
  if (finishReason === "length") return { kind: "truncated", text: result.text };
  return { kind: "appended", text: result.text };
}

/**
 * 終わり方に応じて、追記とトーストを行う(design.md「終わり方」の表)。
 * 本文があるときだけメモに追記する。上限で途切れたときは「追加しました」の代わりに
 * 途切れのトーストだけを出す(2 枚重ねない、7.7)。中止は何もしない。
 */
async function settle(
  outcome: IllustrationOutcome,
  source: IllustrationEntrySource,
): Promise<void> {
  switch (outcome.kind) {
    case "appended":
      await appendToMemo(formatIllustrationEntry(source, outcome.text, false));
      toastInfo(i18n.t("toast.illustrationAppended"));
      return;
    case "truncated":
      await appendToMemo(formatIllustrationEntry(source, outcome.text, true));
      toastError(i18n.t("toast.illustrationTruncated"));
      return;
    case "thinkingMaxTokens":
      toastError(i18n.t("toast.illustrationThinkingMaxTokens"));
      return;
    case "thinkingUnfinished":
      toastError(i18n.t("toast.illustrationThinkingUnfinished"));
      return;
    case "empty":
      toastError(i18n.t("toast.illustrationEmpty"));
      return;
    case "sceneTooLong":
      toastError(i18n.t("toast.illustrationSceneTooLong"));
      return;
    case "failed":
      toastError(failureMessage(outcome.error));
      return;
    case "aborted":
      // 中止は静かに終える(5.3, 5.8)
      return;
  }
}

/**
 * 失敗の文言。`ProviderError` は続き生成と同じ分類の文言(7.5)。文言を持たない分類
 * (`auth` / `rateLimit`)と `ProviderError` でない例外は「情景文の生成に失敗しました: …」。
 * 続き生成と違い、文言を持たない分類でも黙らない(design.md「errorMessage」)。
 */
function failureMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return (
      describeProviderError(error) ??
      i18n.t("toast.illustrationFailed", { message: error.message })
    );
  }
  return i18n.t("toast.illustrationFailed", { message: String(error) });
}

/**
 * 終わり方を dev ログに出す。失敗は `illustration.error`、それ以外は `illustration.end`。
 * 本文・情景文・思考・指示文・エラーの本文は入れない(エラーは分類だけ、長さは文字数だけ)。
 * 文字数の内訳は UTF-16 の単位。`textChars` と `thinkingChars` は、思考の分離を終える前に
 * 終わったとき(送信しなかった、受信中の失敗・中止)は null。
 */
function logOutcome(
  outcome: IllustrationOutcome,
  base: {
    template: string;
    durationMs: number;
    finishReason: FinishReason | null;
    responseChars: number;
    textChars: number | null;
    thinkingChars: number | null;
  },
): void {
  if (outcome.kind === "failed") {
    emitDevEvent("illustration.error", {
      ...base,
      outcome: outcome.kind,
      errorKind: outcome.error instanceof ProviderError ? outcome.error.kind : "unknown",
    });
    return;
  }
  emitDevEvent("illustration.end", { ...base, outcome: outcome.kind });
}

/** 挿し絵用の設定の不備を、トーストの文言にする(design.md「設定の不備のトースト」)。 */
function configErrorMessage(error: IllustrationConfigError): string {
  switch (error.kind) {
    case "missingTemplate":
      return i18n.t("toast.illustrationTemplateMissing");
    case "unreadable":
      return i18n.t("toast.illustrationConfigUnreadable");
    case "template":
      return templateErrorMessage(error.error);
  }
}

/**
 * テンプレートの指定の不備を、トーストの文言にする。
 * 差し込み口の表記(`{{body}}` など)は補間値として渡す。文言に直接書くと
 * i18next の補間記法と衝突するため。
 */
function templateErrorMessage(error: PromptTemplateError): string {
  switch (error.kind) {
    case "unreadable":
      return i18n.t("toast.illustrationTemplateUnreadable");
    case "unknownPreset":
      return i18n.t("toast.illustrationTemplatePresetUnknown", { name: error.name });
    case "missingBody":
      return i18n.t("toast.illustrationTemplateMissingBody", { slot: "{{body}}" });
    case "duplicateSlot":
      return i18n.t("toast.illustrationTemplateDuplicateSlot", { slot: `{{${error.slot}}}` });
  }
}
