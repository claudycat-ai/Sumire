import { create } from "zustand";
import i18next from "i18next";
import {
  buildEffectiveConfig,
  fileNameOf,
  listGgufModels,
  parsePreferences,
  readAppPreferences,
  readLlamaServerStatus,
  serializePreferences,
  startLlamaServer,
  stopLlamaServer,
  subscribeLlamaServerStatus,
  writeAppPreferences,
  type GgufModel,
  type LlamaServerPreferences,
  type LlamaServerStatus,
  type StartLlamaServerRequest,
} from "@/domain/llamaServer";
import { clearContextBuilderCache } from "@/domain/context/contextBuilder";
import type { AIConfig } from "@/domain/providers/types";
import { nativeFetch } from "@/domain/http";
import { toastError, toastInfo } from "@/components/ui/Toast";
import { emitDevEvent } from "@/lib/devLog";
import { useAIConfigStore } from "@/stores/aiConfigStore";

/**
 * Sumire が起動する `llama-server` の、アプリ側の設定・モデルの一覧・状態を持つストア
 * (`llama-server-provider` spec)。
 *
 * - 設定は `sumire.json` ではなく、アプリデータディレクトリの `preferences.json` に保存する
 *   (PC に固有の値で、どのプロジェクトでも共通)。
 * - 状態は Rust 側の監督が正。イベントも command の戻り値も `applyStatus` に通して写す。
 * - 初期化では `llama-server` を起動しない(Req 4.1)。起動するのは、提案か情景文の要求が
 *   `prepareLlamaServerConfig` を通ったときと、動いている間に別のモデルを選んだときだけ。
 * - 起動・停止の command を呼ぶ前に、ストアの状態を同期で書き換える。生成中のコントローラが
 *   購読で生成を中止してから、プロセスが止まるようにするため(Req 3.4, 6.6)。
 */
interface LlamaServerStoreState {
  preferences: LlamaServerPreferences;
  models: GgufModel[];
  /** モデルのフォルダを読めなかったときのメッセージ。読めていれば null */
  modelsError: string | null;
  status: LlamaServerStatus;
  /** `/props` で分かった、実際に確保されたコンテキスト長。準備完了でない・読めないときは null */
  actualContextSize: number | null;

  /** ストアを書き換えてから `preferences.json` に保存する。失敗はトーストで知らせる */
  updatePreferences: (patch: Partial<LlamaServerPreferences>) => Promise<void>;
  /** フォルダの今の中身で一覧を作り直す。モデルごとのコンテキスト長は消さない(Req 2.6) */
  refreshModels: () => Promise<void>;
  /**
   * 選択を保存する。動いている(読み込み中・準備完了)ときに別のモデルを選んだら、
   * そのモデルで起動し直す。止まっていれば保存するだけ(Req 3.2, 3.3)。
   */
  selectModel: (fileName: string) => Promise<void>;
  /** 動いている(読み込み中・準備完了)ときだけ止める。`trigger` は dev 操作ログ用 */
  stop: (trigger?: LlamaServerStopTrigger) => Promise<void>;
}

export type LlamaServerStopTrigger =
  | "user"
  | "providerSwitch"
  | "projectClose"
  | "modelSwitch";

export type PrepareResult =
  | { kind: "ready"; config: AIConfig }
  | { kind: "declined" };

const PROPS_TIMEOUT_MS = 5000;

// 読んだ preferences.json の全体。書き戻すときに `llamaServer` 以外のトップレベルのキーを保つ。
let rawPreferences: Record<string, unknown> = {};

let statusSubscription: Promise<() => void> | null = null;

let aiConfigSubscribed = false;

// 起動の command を呼ぶ前に書き換えた、仮の「読み込み中」。ストアの状態がこれである間は、
// 同じ通し番号の知らせ(置き換えられる前の llama-server のもの)を採らない。
let placeholderStatus: LlamaServerStatus | null = null;

// 起動の手順の世代。新しい起動を始めるたびと、停止のたびに進める。一覧の読み直しを待つ間に
// 進んでいたら、その起動は取りやめる。状態の同一性では判定しない(先行の command の結果が
// 仮の「読み込み中」を上書きしただけのときと、止められた・起動し直されたときを区別できないため)。
let startGeneration = 0;

// 関門が返した実効の設定の、直近 1 件。`getProvider` は設定の参照でアダプタをキャッシュするので、
// 条件が同じ間は同じ参照を返す。
let effectiveConfigMemo: {
  section: AIConfig;
  runId: number;
  actualContextSize: number | null;
  config: AIConfig;
} | null = null;

// dev 操作ログの「読み込みのミリ秒」のために、読み込み中を受けた時刻を起動の通し番号と組で持つ。
let loadingStarted: { runId: number; at: number } | null = null;

export const useLlamaServerStore = create<LlamaServerStoreState>((set, get) => ({
  // DEFAULT_LLAMA_SERVER_PREFERENCES は中まで凍結してあるので、初期値には使わない。
  preferences: parsePreferences(null).llamaServer,
  models: [],
  modelsError: null,
  status: { state: "stopped", runId: 0, cause: "initial", exitCode: null },
  actualContextSize: null,

  updatePreferences: async (patch) => {
    const previous = get().preferences;
    const next: LlamaServerPreferences = { ...previous, ...patch };
    set({ preferences: next });
    try {
      await writeAppPreferences(serializePreferences(rawPreferences, next));
    } catch (e) {
      toastError(
        i18next.t("toast.llamaServerPreferencesSaveFailed", { message: String(e) }),
      );
    }
    if (next.modelsDir !== previous.modelsDir) {
      await get().refreshModels();
    }
  },

  refreshModels: async () => {
    const dir = get().preferences.modelsDir;
    if (dir === "") {
      set({ models: [], modelsError: null });
      return;
    }
    let result: Pick<LlamaServerStoreState, "models" | "modelsError">;
    try {
      result = { models: await listGgufModels(dir), modelsError: null };
    } catch (e) {
      result = { models: [], modelsError: String(e) };
    }
    // 読んでいる間にフォルダの指定が変わっていたら、古いフォルダの結果で上書きしない。
    if (get().preferences.modelsDir !== dir) return;
    set(result);
  },

  selectModel: async (fileName) => {
    // 保存の完了は待たない(選択はこの呼び出しの中で同期で書き換わる)。
    // 起動し直しは、生成中のコントローラを早く中止させるために、すぐ行う。
    const saving = get().updatePreferences({ selectedModel: fileName });

    const status = get().status;
    const running = status.state === "loading" || status.state === "ready";
    if (running && fileNameOf(status.modelPath) !== fileName) {
      const check = checkStartable();
      if (check.ok) {
        // 動いているプロセスは、Rust 側の起動の command が先に止める。
        emitDevEvent("llamaServer.stop", { trigger: "modelSwitch" });
        beginStart(check);
      } else {
        toastError(check.message);
        await get().stop("modelSwitch");
      }
    }
    await saving;
  },

  stop: async (trigger = "user") => {
    // 一覧の読み直しを待っている起動があれば、取りやめさせる。
    startGeneration += 1;
    const status = get().status;
    if (status.state !== "loading" && status.state !== "ready") return;
    set({
      status: {
        state: "stopped",
        runId: status.runId,
        cause: "requested",
        exitCode: null,
      },
      actualContextSize: null,
    });
    emitDevEvent("llamaServer.stop", { trigger });
    try {
      await applyStatus(await stopLlamaServer());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[llamaServerStore] llama-server を停止できませんでした:", e);
    }
  },
}));

/**
 * 起動の関門。提案・情景文のコントローラが、生成中の状態を作る直前に呼ぶ。
 *
 * - `llama-server` 以外の設定は、そのまま通す。
 * - 準備完了なら、起動した `llama-server` の接続先・モデル名・コンテキスト長を埋めた設定を返す。
 * - それ以外は断る(呼び出し側は生成しない)。止まっていて設定がそろっていれば、
 *   ここで読み込みを始める(Req 4.2)。準備完了を待ってからの生成はしない。
 */
export function prepareLlamaServerConfig(config: AIConfig): PrepareResult {
  if (config.provider !== "llama-server") return { kind: "ready", config };

  const { status, actualContextSize } = useLlamaServerStore.getState();
  switch (status.state) {
    case "ready": {
      const memo = effectiveConfigMemo;
      if (
        memo !== null &&
        memo.section === config &&
        memo.runId === status.runId &&
        memo.actualContextSize === actualContextSize
      ) {
        return { kind: "ready", config: memo.config };
      }
      const effective = buildEffectiveConfig(config, status, actualContextSize);
      effectiveConfigMemo = {
        section: config,
        runId: status.runId,
        actualContextSize,
        config: effective,
      };
      return { kind: "ready", config: effective };
    }
    case "loading":
      toastInfo(i18next.t("toast.llamaServerLoading"));
      return { kind: "declined" };
    case "stopped":
    case "failed": {
      const check = checkStartable();
      if (!check.ok) {
        toastError(check.message);
        return { kind: "declined" };
      }
      beginStart(check);
      return { kind: "declined" };
    }
  }
}

type StartCheck =
  | { ok: true; model: string; modelsDir: string; request: StartLlamaServerRequest }
  | { ok: false; message: string };

/** いま選ばれているモデルで起動できるかを検査し、起動の要求を組み立てる。 */
function checkStartable(): StartCheck {
  const { preferences, models } = useLlamaServerStore.getState();
  if (preferences.executablePath === "") {
    return { ok: false, message: i18next.t("toast.llamaServerNoExecutable") };
  }
  const model = preferences.selectedModel;
  if (model === null) {
    return { ok: false, message: i18next.t("toast.llamaServerNoModel") };
  }
  if (!models.some((entry) => entry.fileName === model)) {
    return {
      ok: false,
      message: i18next.t("toast.llamaServerModelMissing", { model }),
    };
  }
  // 自分のプロパティだけを見る(`constructor` のような名前で、継承したものを拾わない)。
  const contextSize = Object.prototype.hasOwnProperty.call(preferences.models, model)
    ? preferences.models[model]?.contextSize
    : undefined;
  if (contextSize === undefined) {
    return {
      ok: false,
      message: i18next.t("toast.llamaServerNoContextSize", { model }),
    };
  }
  return {
    ok: true,
    model,
    modelsDir: preferences.modelsDir,
    request: {
      executablePath: preferences.executablePath,
      modelPath: joinModelPath(preferences.modelsDir, model),
      contextSize,
      extraArgs: preferences.extraArgs,
    },
  };
}

function joinModelPath(modelsDir: string, fileName: string): string {
  return /[\\/]$/.test(modelsDir)
    ? `${modelsDir}${fileName}`
    : `${modelsDir}\\${fileName}`;
}

type StartableCheck = Extract<StartCheck, { ok: true }>;

/**
 * 状態を先に「読み込み中」に書き換えてから、起動の手順(`runStart`)を始める(戻りは待たない)。
 *
 * 仮の状態は、通し番号を手元のまま、ポートを 0 にする。本物の状態は、command の戻り値か
 * イベントで届く(通し番号が進んでいるので、受け口が採る)。
 */
function beginStart(check: StartableCheck): void {
  const { request } = check;
  const previous = useLlamaServerStore.getState().status;
  const placeholder: LlamaServerStatus = {
    state: "loading",
    runId: previous.runId,
    modelPath: request.modelPath,
    contextSize: request.contextSize,
    port: 0,
  };
  placeholderStatus = placeholder;
  useLlamaServerStore.setState({ status: placeholder, actualContextSize: null });

  // 起動を取りやめた・command そのものが失敗したときに戻す先。動いていたものを起動し直す
  // ときは、生成中のコントローラをもう中止させているので、「準備完了」には戻さない。
  const wasRunning = previous.state === "loading" || previous.state === "ready";
  const fallback: LlamaServerStatus = wasRunning
    ? { state: "stopped", runId: previous.runId, cause: "requested", exitCode: null }
    : previous;
  startGeneration += 1;
  void runStart(check, startGeneration, placeholder, fallback, wasRunning);
}

function isRunning(status: LlamaServerStatus): boolean {
  return status.state === "loading" || status.state === "ready";
}

/**
 * フォルダの今の中身で一覧を作り直し、選んだモデルがあることを確かめてから、起動の command を呼ぶ。
 *
 * ストアの一覧は、最後に読んだときのもの。そのあとで消えた・改名された gguf を起動に渡さないよう、
 * ここで読み直す(Req 3.7)。「読み込み始めました」のトーストは、確かめ終えてから出す
 * (無いと分かったときに、トーストが 2 つ続かないようにするため)。
 */
async function runStart(
  check: StartableCheck,
  generation: number,
  placeholder: LlamaServerStatus,
  fallback: LlamaServerStatus,
  wasRunning: boolean,
): Promise<void> {
  const { request, model, modelsDir } = check;
  const store = useLlamaServerStore;

  let listed: GgufModel[] | null = null;
  let listError: string | null = null;
  try {
    listed = await listGgufModels(modelsDir);
  } catch (e) {
    listError = String(e);
  }
  // 読んでいる間にフォルダの指定が変わっていたら、古いフォルダの結果で上書きしない。
  if (store.getState().preferences.modelsDir === modelsDir) {
    store.setState({ models: listed ?? [], modelsError: listError });
  }
  // 読んでいる間に止められた・別の起動が始まったなら、この起動はもう要らない。
  if (startGeneration !== generation) return;

  // 世代が同じまま状態が仮のものでなくなっているのは、先行の command(停止・前の起動)の結果が
  // 届いて上書きしたとき。起動は続ける。戻す先と、止めるものがあるかは、届いた状態から決め直す。
  const current = store.getState().status;
  const overwritten = current !== placeholder;
  let pending = placeholder;
  let restore = fallback;
  let running = wasRunning;
  if (overwritten) {
    running = isRunning(current);
    restore = running
      ? { state: "stopped", runId: current.runId, cause: "requested", exitCode: null }
      : current;
  }

  const problem =
    listed === null
      ? i18next.t("llamaServer.modelsDirUnreadable", { message: listError })
      : listed.some((entry) => entry.fileName === model)
        ? null
        : i18next.t("toast.llamaServerModelMissing", { model });
  if (problem !== null) {
    if (current !== restore) store.setState({ status: restore, actualContextSize: null });
    toastError(problem);
    if (running) {
      // 起動し直しのつもりで、動いていたものの生成はもう中止させている。プロセスも止める。
      try {
        await applyStatus(await stopLlamaServer());
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[llamaServerStore] llama-server を停止できませんでした:", e);
      }
    }
    return;
  }

  if (overwritten) {
    // 仮の「読み込み中」を、届いた通し番号で書き直す。生成中のコントローラの中止と、
    // 関門の「読み込み中は断る」を保つため。
    pending = {
      state: "loading",
      runId: current.runId,
      modelPath: request.modelPath,
      contextSize: request.contextSize,
      port: 0,
    };
    placeholderStatus = pending;
    store.setState({ status: pending, actualContextSize: null });
  }

  toastInfo(i18next.t("toast.llamaServerStarting", { model }));
  emitDevEvent("llamaServer.start", { model, contextSize: request.contextSize });
  let started: LlamaServerStatus;
  try {
    started = await startLlamaServer(request);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[llamaServerStore] 起動の command が失敗しました:", e);
    if (store.getState().status === pending) {
      store.setState({ status: restore });
    }
    toastError(
      i18next.t("toast.llamaServerSpawnFailed", { path: request.executablePath }),
    );
    return;
  }
  await applyStatus(started);
}

/**
 * アプリの起動時に呼ぶ。設定を読み、フォルダが設定されていれば一覧を作り、
 * 状態のイベントを購読して、今の状態を写す。`llama-server` は起動しない(Req 4.1)。
 *
 * 何度呼んでも、状態のイベントの購読は 1 つ。読み込みの失敗ではアプリの起動を止めない。
 */
export async function initLlamaServerStore(): Promise<void> {
  try {
    const parsed = parsePreferences(await readAppPreferences());
    rawPreferences = parsed.raw;
    useLlamaServerStore.setState({ preferences: parsed.llamaServer });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[llamaServerStore] preferences.json を読めませんでした:", e);
  }

  if (useLlamaServerStore.getState().preferences.modelsDir !== "") {
    await useLlamaServerStore.getState().refreshModels();
  }

  // 購読を先にする。今の状態を読んでから購読するまでの間のイベントを取りこぼさないため
  // (順が前後しても、受け口が通し番号で古いものを捨てる)。
  if (statusSubscription === null) {
    statusSubscription = subscribeLlamaServerStatus((status) => {
      void applyStatus(status);
    });
    try {
      await statusSubscription;
    } catch (e) {
      statusSubscription = null;
      // eslint-disable-next-line no-console
      console.warn("[llamaServerStore] 状態のイベントを購読できませんでした:", e);
    }
  }

  subscribeAIConfigOnce();

  try {
    await applyStatus(await readLlamaServerStatus());
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[llamaServerStore] llama-server の状態を読めませんでした:", e);
  }
}

/**
 * 停止の時機(Req 6.3, 6.4): 「現在使うプロバイダ」が `llama-server` からほかに変わったとき、
 * プロジェクトが閉じられて設定が空になったときに止める。`llama-server` に変わっただけでは
 * 起動しない(Req 1.2)。
 *
 * 「現在使うプロバイダ」が変わったときは、どの向きでも、トークン数のキャッシュを消す(Req 7.4, 7.5)。
 */
function subscribeAIConfigOnce(): void {
  if (aiConfigSubscribed) return;
  aiConfigSubscribed = true;
  useAIConfigStore.subscribe((state, previous) => {
    const before = previous.bundle?.activeProvider;
    if (state.bundle?.activeProvider === before) return;
    // トークン数のキャッシュは文字列だけがキーなので、数え方の違うプロバイダに持ち越さない。
    clearContextBuilderCache();
    if (before !== "llama-server") return;
    void useLlamaServerStore
      .getState()
      .stop(state.bundle === null ? "projectClose" : "providerSwitch");
  });
}

/**
 * 状態の受け口。状態のイベントも、起動・停止の command の戻り値も、ここに通す。
 *
 * - 手元より古い通し番号は捨てる。通し番号も状態も手元と同じなら何もしない
 *   (同じ知らせが command の戻り値とイベントの両方で届いても、トーストは 1 回)。
 * - 同じ通し番号の中では、前にしか進まない(`isForward`)。先に書き換えた「停止中」のあとに、
 *   遅れた「準備完了」が届いても戻さない。
 * - ストアの書き換えは同期で行う(呼び出しが戻った時点で `status` は新しい)。
 *   準備完了のときだけ、`/props` を読んでからトーストを出すので、その分を待つ Promise を返す。
 */
export async function applyStatus(next: LlamaServerStatus): Promise<void> {
  const current = useLlamaServerStore.getState().status;
  if (next.runId < current.runId) return;
  if (next.runId === current.runId) {
    if (current === placeholderStatus) return;
    if (!isForward(current.state, next.state)) return;
  }

  useLlamaServerStore.setState({ status: next, actualContextSize: null });

  switch (next.state) {
    case "loading":
      loadingStarted = { runId: next.runId, at: Date.now() };
      return;
    case "ready":
      // ここから `/tokenize` で数えられる。それまでの推定値や、前のモデルでの値を捨てる
      // (トークン数のキャッシュは文字列だけがキーで、プロバイダもモデルも区別しない)。
      clearContextBuilderCache();
      await onReady(next);
      return;
    case "failed":
      toastError(
        next.reason === "spawn"
          ? i18next.t("toast.llamaServerSpawnFailed", { path: next.executablePath })
          : i18next.t("toast.llamaServerLoadFailed"),
      );
      emitDevEvent("llamaServer.failed", {
        reason: next.reason,
        exitCode: next.exitCode,
      });
      return;
    case "stopped":
      if (next.cause === "exited") {
        toastError(i18next.t("toast.llamaServerExited"));
        emitDevEvent("llamaServer.exited", { exitCode: next.exitCode });
      }
      return;
  }
}

function isForward(
  from: LlamaServerStatus["state"],
  to: LlamaServerStatus["state"],
): boolean {
  if (from === "loading") return to !== "loading";
  if (from === "ready") return to === "stopped";
  return false;
}

async function onReady(
  status: Extract<LlamaServerStatus, { state: "ready" }>,
): Promise<void> {
  const durationMs =
    loadingStarted !== null && loadingStarted.runId === status.runId
      ? Date.now() - loadingStarted.at
      : null;

  const actualContextSize = await readActualContextSize(status.port);

  // 待っている間に起動し直された・止められたなら、この結果はもう今の llama-server のものではない。
  const now = useLlamaServerStore.getState().status;
  if (now.runId !== status.runId || now.state !== "ready") return;

  useLlamaServerStore.setState({ actualContextSize });
  if (actualContextSize !== null && actualContextSize !== status.contextSize) {
    toastInfo(
      i18next.t("toast.llamaServerContextMismatch", {
        requested: status.contextSize,
        actual: actualContextSize,
      }),
    );
  }
  toastInfo(
    i18next.t("toast.llamaServerReady", { model: fileNameOf(status.modelPath) }),
  );
  emitDevEvent("llamaServer.ready", { durationMs, actualContextSize });
}

/**
 * `/props` の `default_generation_settings.n_ctx`。読めない・正の整数でないときは null
 * (指定したコンテキスト長をそのまま使う)。
 */
async function readActualContextSize(port: number): Promise<number | null> {
  // 応答が返らないと準備完了のトーストが出ないままになるので、待ちに上限を付ける。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROPS_TIMEOUT_MS);
  try {
    const response = await nativeFetch(`http://127.0.0.1:${port}/props`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const settings = isRecord(body) ? body.default_generation_settings : null;
    const nCtx = isRecord(settings) ? settings.n_ctx : null;
    return typeof nCtx === "number" && Number.isInteger(nCtx) && nCtx > 0
      ? nCtx
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
