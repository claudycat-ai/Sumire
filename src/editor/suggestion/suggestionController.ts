import { EditorView } from "@codemirror/view";
import i18n from "@/i18n";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { useIllustrationStore } from "@/stores/illustrationStore";
import { prepareLlamaServerConfig, useLlamaServerStore } from "@/stores/llamaServerStore";
import { useSuggestionStore } from "@/stores/suggestionStore";
import {
  AIConfig,
  GenerationChunk,
  GenerationRequest,
  ParsedPromptTemplate,
  PromptTemplateError,
  ProviderError,
  createThinkingSplitter,
  describeProviderError,
  getProvider,
  isLocalCompletionProvider,
  resolvePromptTemplate,
  resolveThinkingTags,
} from "@/domain/providers";
import { toastError } from "@/components/ui/Toast";
import { stripRuby } from "@/editor/rubyDecoration";
import { buildGenerationRequest } from "@/domain/context/contextBuilder";
import { appendToMemo } from "@/domain/memo/memoApi";
import { parseFile } from "@/domain/project/frontmatter";
import { toastInfo } from "@/components/ui/Toast";
import {
  clearSuggestionEffect,
  currentSuggestionText,
  setSuggestionEffect,
  suggestionField,
} from "./suggestionState";

/**
 * MVP の既定システムプロンプト。
 *
 * `aiConfig.systemPrompt` が文字列ならそちらが優先される。
 * 仕様 `01-ux.md` §107 の「カーソル位置までを文脈として渡す」+
 * `02-architecture.md`「Chat ではなく Completion を使う」に沿う。
 *
 * ルビ記法 `|漢字《かな》` を出力させない指示を含む。理由:
 * 入力本文にルビ記法が含まれていると、Instruct 系小規模モデルはそのパターンに
 * 強く引きずられて、ルビ不要な箇所にも `|彼女《かのじょ》` のように盛ってくる。
 * 入力側は `stripRuby` でルビを剥がした上で渡す(下記 runRequest)が、
 * モデルが学習データから別経路でパターンを覚えている場合の保険として指示も入れる。
 */
const DEFAULT_SYSTEM_PROMPT =
  "あなたは日本語 Web 小説の優秀な共著者です。続きを自然に書き継いでください。出力は本文の続きのみで、解説や前置きは付けないこと。ルビ記法 `|漢字《かな》` は使わず、すべて素のテキストで返すこと。";

/**
 * 進行中のリクエストを多重発火させないためのフラグ。
 * 二重トリガーは無視する。再生成したい場合は Esc(却下)→ Shift+Enter で行う。
 */
let inflight: { controller: AbortController } | null = null;

/**
 * 進行中の生成リクエストがあれば中断する。
 *
 * - HTTP リクエストを `AbortController.abort()` で切断(無駄なバイト消費を防ぐ)
 * - 戻り値 true なら中断した(=呼び出し側はゴーストクリアを併せて行うべき)
 *
 * Esc 押下と suggestionLifecycle の暗黙キャンセル(文字入力・カーソル移動)から呼ばれる。
 */
export function abortInflight(): boolean {
  if (!inflight) return false;
  inflight.controller.abort();
  inflight = null;
  useSuggestionStore.getState().setGenerating(false);
  return true;
}

/**
 * 提案を要求する(Shift+Enter)。
 * 既に生成中なら何もしない。
 *
 * 挿し絵の情景文の生成中(ストアに開始時刻がある)は、トーストを出して提案を始めない
 * (`illustration-prompt` 要件 5.6)。キーは吸い、表示中の確定済みの提案は消さない。
 * 情景文の側のモジュール(editor/illustration)は import せず、ストアだけを読む。
 */
export function requestSuggestion(view: EditorView): boolean {
  if (inflight) return true;
  if (useIllustrationStore.getState().startedAt !== null) {
    toastError(i18n.t("toast.suggestionIllustrationBusy"));
    return true;
  }
  void runRequest(view);
  return true;
}

/**
 * 表示中の候補を採用する(Tab)。挿入位置に candidate を流し込み、提案 state をクリア。
 * ストリーミング中は採用無効(キーは吸って何もしない)。完了を待つ運用。
 *
 * ストリーミング中かどうかは本文の有無より先に見る。思考中(や、本文が空のまま思考を
 * 抜けた直後)は本文が空の提案状態になるが、そこでもストリーミング中として Tab を吸うため。
 */
export function acceptSuggestion(view: EditorView): boolean {
  const state = view.state.field(suggestionField, false);
  if (!state) return false;
  if (state.streaming) return true; // 吸うが何もしない
  const text = currentSuggestionText(state);
  if (!text) return false;
  view.dispatch({
    changes: { from: state.insertPos, to: state.insertPos, insert: text },
    selection: { anchor: state.insertPos + text.length },
    effects: clearSuggestionEffect.of(null),
    userEvent: "input.suggestion.accept",
  });
  return true;
}

/**
 * Esc の挙動はモードで切り替わる:
 *  - 生成中(=ストリーム受信中) → 停止(HTTP 切断 + ゴースト破棄)
 *  - 提案表示中(=ストリーム完了後の確定表示) → 却下
 *  - どちらでもない → 何もしない(キーは下層に通す)
 *
 * 停止後は何も表示されない状態に戻る。中途半端なテキストは採用 UI として残さない
 * (押し間違えで採用してしまうリスクを回避)。
 */
export function dismissSuggestion(view: EditorView): boolean {
  const state = view.state.field(suggestionField, false);
  // 生成中でゴースト未表示でも、リクエストが進行中なら停止する
  if (inflight) {
    abortInflight();
    if (state) {
      view.dispatch({ effects: clearSuggestionEffect.of(null) });
    }
    return true;
  }
  if (!state) return false;
  view.dispatch({ effects: clearSuggestionEffect.of(null) });
  return true;
}

/**
 * メモペイン転記(Alt+M)。
 *
 * 仕様 `01-ux.md` 提案ログ節に従い、優先順は:
 *  (1) 提案表示中: 現在のテキストを memo.md 末尾に追記。提案ゴーストは消えない。
 *  (2) 本文に選択範囲がある: 選択範囲を本文から **切り取って** メモ末尾に追記。
 *  (3) どちらでもない: 何もしない(false を返してキーマップを通す)。
 *
 * 転記先はメモペイン(常駐)の EditorView または memo.md ファイル(フォールバック)。
 * フォーマットは `formatMemoEntry`(区切り線 + タイムスタンプ + 本文)。
 */
export function saveSuggestionToMemo(view: EditorView): boolean {
  // (1) 提案表示中なら表示中の 1 案を転記
  const state = view.state.field(suggestionField, false);
  const suggText = currentSuggestionText(state ?? null);
  // ストリーミング中はまだ確定していないのでメモ転記は無視。本文選択時の動線も封じる
  // (Alt+M 全体を吸って何もしない、書き手の意図と乖離するため)。
  if (state?.streaming) return true;
  if (state && suggText) {
    void appendToMemo(suggText);
    toastInfo("メモに転記しました");
    return true;
  }

  // (2) 本文に選択範囲があれば切り取って転記
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (text.trim()) {
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: "" },
        selection: { anchor: sel.from },
        userEvent: "delete.cut.toMemo",
      });
      void appendToMemo(text);
      toastInfo("メモに移動しました");
      return true;
    }
  }

  // (3) 何もしない
  return false;
}

async function runRequest(view: EditorView): Promise<void> {
  const section = useAIConfigStore.getState().getActiveConfig();
  if (!section) {
    toastError("プロジェクトを開いてください");
    return;
  }

  const insertPos = view.state.selection.main.head;
  // カーソル位置までのドキュメントを取り出した上で、AI に渡すためにフロントマターを剥がす。
  // `title:` などのメタデータが本文として解釈されると生成が崩れるため。
  // フロントマター末尾より前にカーソルがある場合(=フロントマター編集中)は parseFile が
  // frontmatter なしと判定し、そのまま渡る(=メタデータ部分のみ渡る)が、
  // フロントマター内で Shift+Enter する運用は想定外なので許容する。
  const upToCursor = view.state.doc.sliceString(0, insertPos);
  const parsed = parseFile(upToCursor);
  // 本文先頭の余分な空白(フロントマター直後の改行)を 1 段だけ剥がす。
  const bodyText = parsed.body.replace(/^\n+/, "");
  // ルビ記法を剥がす(`|漢字《かな》` → `漢字`)。モデルがルビパターンに引きずられないため。
  const rawBody = stripRuby(bodyText);
  const systemPrompt =
    typeof section.systemPrompt === "string" && section.systemPrompt.trim()
      ? section.systemPrompt
      : DEFAULT_SYSTEM_PROMPT;

  // プロンプトテンプレートは要求のたびに解決する(`sumire.json` を直せば次の要求から効く)。
  // 不備は生成中の表示や inflight を作る前に伝えて終える。OpenAI プロバイダでは読まない。
  let promptTemplate: ParsedPromptTemplate | undefined;
  if (isLocalCompletionProvider(section.provider)) {
    const resolution = resolvePromptTemplate(section.template);
    if (resolution.kind === "error") {
      toastError(templateErrorMessage(resolution.error));
      return;
    }
    if (resolution.kind === "ok") promptTemplate = resolution.template;
  }

  // 起動の関門は、ほかの開始条件をすべて通ってから呼ぶ(不備のある要求で llama-server を
  // 起動しない)。断られたときのトーストは関門が出す。通ったら、接続先などを埋めた設定を使う。
  const prepared = prepareLlamaServerConfig(section);
  if (prepared.kind === "declined") return;
  const config = prepared.config;

  const controller = new AbortController();
  inflight = { controller };
  useSuggestionStore.getState().setGenerating(true);

  const stopWatching = watchLlamaServer(view, config, controller);
  try {
    await generateSuggestion(view, config, systemPrompt, rawBody, promptTemplate, controller);
  } finally {
    stopWatching();
  }
}

/**
 * 生成の間、`llama-server` が止められる・別のモデルで起動し直されるのを見張り、
 * そうなったら Esc の停止と同じ経路で生成を中止する(失敗のトーストは出ない。Req 3.4, 6.6)。
 * ストアは、プロセスを止める command を呼ぶ前に状態を書き換えるので、接続が切れるより先に中止できる。
 *
 * 戻り値は見張りを解く関数。`llama-server` 以外の設定では見張らない。
 */
function watchLlamaServer(
  view: EditorView,
  config: AIConfig,
  controller: AbortController,
): () => void {
  if (config.provider !== "llama-server") return () => {};
  const runId = useLlamaServerStore.getState().status.runId;
  return useLlamaServerStore.subscribe(({ status }) => {
    if (status.state === "ready" && status.runId === runId) return;
    if (inflight?.controller !== controller) return;
    abortInflight();
    if (view.state.field(suggestionField, false)) {
      view.dispatch({ effects: clearSuggestionEffect.of(null) });
    }
  });
}

/** コンテキストを組み立てて生成し、ゴーストに流す。`inflight` と生成中の表示は呼び出し側が作る。 */
async function generateSuggestion(
  view: EditorView,
  config: AIConfig,
  systemPrompt: string,
  rawBody: string,
  promptTemplate: ParsedPromptTemplate | undefined,
  controller: AbortController,
): Promise<void> {
  let request: GenerationRequest;
  try {
    // ContextBuilder にトークン予算配分・切り詰めを任せる。M3-b で本実装。
    const built = await buildGenerationRequest(config, systemPrompt, rawBody, promptTemplate);
    if (controller.signal.aborted) return;
    request = {
      systemPrompt: built.systemPrompt,
      contextSections: built.contextSections,
      body: built.body,
      parameters: config.parameters,
    };
    if (promptTemplate) request.promptTemplate = promptTemplate;
  } catch (e) {
    if (!controller.signal.aborted) handleError(e);
    if (inflight?.controller === controller) {
      inflight = null;
      useSuggestionStore.getState().setGenerating(false);
    }
    return;
  }
  // リクエスト送信前にカーソル位置を確定。以後ゴーストはこの位置から伸びる。
  // ライフサイクル側はカーソルが insertPos から動いたら自動キャンセルするので、
  // ストリーム中に書き手が動かしたら停止される。
  const currentHead = view.state.selection.main.head;
  // 思考ブロック(`<think>…</think>` など)を本文から分ける。分離器は状態を持つので生成ごとに作る。
  // 思考の中身は分離器の外に出てこないので、ここでも生のテキストは持たない(ログにも出さない)。
  const splitter = createThinkingSplitter(resolveThinkingTags(config.thinking));
  // 最後に送った提案状態の中身。まだ何も送っていない間は「本文が空で思考中でない」とみなし、
  // 保留だけが起きたスナップショット(先頭の改行、開始タグの切れ端)を送らないようにする。
  let shown = { text: "", inThinking: false };
  let thinkingStartedAt: number | null = null;
  // 思考が終わらないまま応答が終わったときに、上限到達(length)かどうかで案内を分けるために使う
  let lastFinishReason: GenerationChunk["finishReason"];

  try {
    const provider = getProvider(config);
    for await (const chunk of provider.generateStream(request, controller.signal)) {
      if (controller.signal.aborted) return;
      // 終了理由は本文が空のチャンク(`"text": ""` と finish_reason だけ)で届くことがあるので、
      // 本文が空のチャンクを読み飛ばす前に記録する
      if (chunk.finishReason !== undefined) lastFinishReason = chunk.finishReason;
      if (!chunk.textDelta) continue;
      const snapshot = splitter.push(chunk.textDelta);
      // 思考中にチャンクが届き続けてもスナップショットは変わらないので、トランザクションを増やさない
      if (snapshot.text === shown.text && snapshot.inThinking === shown.inThinking) continue;
      // 経過秒数は思考ブロックごとに 0 から数え直す。思考ブロックの中では本文が増えないので、
      // 思考中のまま本文が変わったら、1 つのチャンクの中でブロックが閉じて次が始まっている。
      if (snapshot.inThinking && (!shown.inThinking || snapshot.text !== shown.text)) {
        thinkingStartedAt = Date.now();
      } else if (!snapshot.inThinking) {
        thinkingStartedAt = null;
      }
      // 思考を抜けた時点では本文が空でも送る。送らないと「思考中」の表示が残る。
      // streaming: true のままなので、本文が空でも Tab は吸われ、暗黙のキャンセルも働く。
      view.dispatch({
        effects: setSuggestionEffect.of({
          text: snapshot.text,
          insertPos: currentHead,
          streaming: true,
          thinkingStartedAt,
        }),
      });
      shown = { text: snapshot.text, inThinking: snapshot.inThinking };
    }
    if (controller.signal.aborted) return;

    // 終わり方の判定と確定は、最後のスナップショットではなく finish() の結果で行う。応答の末尾の
    // 思考ブロックの直前の改行や、保留していた末尾は、ここで初めて決まるため。開始タグ同士に
    // 接頭辞関係があると、最後のスナップショットが思考中でなくても思考が終わっていないことがある。
    const result = splitter.finish();
    // 思考が終わっていなければ、思考前の本文も含めて提案を出さない。空の判定より先に見ないと、
    // 思考前の本文が無い応答で「応答が空です」になり、maxTokens の見直しに気づけない
    if (result.unfinishedThinking) {
      toastError(
        i18n.t(lastFinishReason === "length" ? "toast.thinkingMaxTokens" : "toast.thinkingUnfinished"),
      );
      view.dispatch({ effects: clearSuggestionEffect.of(null) });
      return;
    }
    // 空の判定も思考を除いた本文で行う(思考だけの応答で、空の提案を確定させない)
    if (result.text.length === 0) {
      toastError("提案を取得できませんでした(応答が空です)");
      view.dispatch({ effects: clearSuggestionEffect.of(null) });
      return;
    }

    // ストリーム完了 → streaming: false に遷移して通常の提案表示に確定。採用・メモ転記はこの本文を使う
    view.dispatch({
      effects: setSuggestionEffect.of({
        text: result.text,
        insertPos: currentHead,
        streaming: false,
        thinkingStartedAt: null,
      }),
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    // 部分的に表示していたゴーストはエラー時に消す(中途半端な採用 UI を残さない)
    view.dispatch({ effects: clearSuggestionEffect.of(null) });
    handleError(e);
  } finally {
    if (inflight?.controller === controller) {
      inflight = null;
      useSuggestionStore.getState().setGenerating(false);
    }
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
      return i18n.t("toast.templateUnreadable");
    case "unknownPreset":
      return i18n.t("toast.templatePresetUnknown", { name: error.name });
    case "missingBody":
      return i18n.t("toast.templateMissingBody", { slot: "{{body}}" });
    case "duplicateSlot":
      return i18n.t("toast.templateDuplicateSlot", { slot: `{{${error.slot}}}` });
  }
}

/**
 * 提案の失敗をトーストで伝える。`ProviderError` の文言は挿し絵の情景文と共有する
 * (`describeProviderError`)。文言を持たない分類(`auth` / `rateLimit`)は今と同じく黙って戻る。
 */
function handleError(e: unknown): void {
  if (e instanceof ProviderError) {
    const message = describeProviderError(e);
    if (message !== null) toastError(message);
    return;
  }
  toastError(`提案要求に失敗しました: ${String(e)}`);
}
