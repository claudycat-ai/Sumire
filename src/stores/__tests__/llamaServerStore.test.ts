/**
 * `llama-server-provider` spec タスク 3.4 / 3.5: llamaServerStore(設定・モデルの一覧・状態、
 * 起動の関門・モデルの選択・停止・停止の時機)。
 *
 * Rust の command とイベント(`@/domain/llamaServer` の API)、HTTP(`nativeFetch`)、
 * トースト、dev 操作ログを差し替える。設定の解析と書き戻し(`parsePreferences` /
 * `serializePreferences`)は本物を使う。テスト時の言語は ja(`src/__tests__/setup.ts`)。
 *
 * 状態のイベントの購読はモジュールで 1 回だけなので、ハンドラは最初の初期化で受け取ったものを
 * ファイルの全体で使い回す。AI 接続設定のストア(`useAIConfigStore`)は本物を使い、
 * `setState` で `bundle` を差し替える(こちらの購読もモジュールで 1 回だけ)。
 *
 * Requirements: 1.2, 1.3, 2.6, 2.7, 3.2, 3.3, 3.4, 3.5, 3.7, 4.1, 4.2, 4.4, 4.5, 4.6,
 * 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 5.11, 5.12, 6.3, 6.4, 6.5, 6.6, 7.4, 7.5
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import {
  parsePreferences,
  type GgufModel,
  type LlamaServerStatus,
  type StartLlamaServerRequest,
} from "@/domain/llamaServer";
import {
  DEFAULT_AI_CONFIG_BUNDLE,
  type AIConfig,
  type AIConfigBundle,
  type ProviderId,
} from "@/domain/providers/types";

const mocks = vi.hoisted(() => ({
  readAppPreferences: vi.fn<() => Promise<string | null>>(),
  writeAppPreferences: vi.fn<(json: string) => Promise<void>>(),
  listGgufModels: vi.fn<(dir: string) => Promise<GgufModel[]>>(),
  startLlamaServer:
    vi.fn<(req: StartLlamaServerRequest) => Promise<LlamaServerStatus>>(),
  stopLlamaServer: vi.fn<() => Promise<LlamaServerStatus>>(),
  readLlamaServerStatus: vi.fn<() => Promise<LlamaServerStatus>>(),
  subscribeLlamaServerStatus:
    vi.fn<(handler: (status: LlamaServerStatus) => void) => Promise<() => void>>(),
  nativeFetch: vi.fn<(url: string) => Promise<Response>>(),
  toastError: vi.fn<(message: string) => void>(),
  toastInfo: vi.fn<(message: string) => void>(),
  emitDevEvent: vi.fn<(event: string, payload?: Record<string, unknown>) => void>(),
  clearContextBuilderCache: vi.fn<() => void>(),
  // vi.clearAllMocks で消えないよう、購読の回数とハンドラは別に持つ。
  subscribeCount: 0,
  statusHandler: null as ((status: LlamaServerStatus) => void) | null,
}));

vi.mock("@/domain/llamaServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/llamaServer")>();
  return {
    ...actual,
    readAppPreferences: mocks.readAppPreferences,
    writeAppPreferences: mocks.writeAppPreferences,
    listGgufModels: mocks.listGgufModels,
    startLlamaServer: mocks.startLlamaServer,
    stopLlamaServer: mocks.stopLlamaServer,
    readLlamaServerStatus: mocks.readLlamaServerStatus,
    subscribeLlamaServerStatus: mocks.subscribeLlamaServerStatus,
  };
});

vi.mock("@/domain/http", () => ({
  nativeFetch: mocks.nativeFetch,
}));

vi.mock("@/components/ui/Toast", () => ({
  toastError: mocks.toastError,
  toastInfo: mocks.toastInfo,
}));

vi.mock("@/lib/devLog", () => ({
  emitDevEvent: mocks.emitDevEvent,
}));

vi.mock("@/domain/context/contextBuilder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/domain/context/contextBuilder")>();
  return { ...actual, clearContextBuilderCache: mocks.clearContextBuilderCache };
});

import {
  applyStatus,
  initLlamaServerStore,
  prepareLlamaServerConfig,
  useLlamaServerStore,
} from "@/stores/llamaServerStore";
import { useAIConfigStore } from "@/stores/aiConfigStore";

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

const MODELS_DIR = "C:\\models";
const EXECUTABLE = "C:\\bin\\llama-server.exe";
const Q3 = "gemma.Q3_K_M.gguf";
const Q5 = "gemma.Q5_K_M.gguf";
const MODEL_PATH = `${MODELS_DIR}\\${Q3}`;

const INITIAL_STATUS: LlamaServerStatus = {
  state: "stopped",
  runId: 0,
  cause: "initial",
  exitCode: null,
};

function preferencesJson(llamaServer: Record<string, unknown>): string {
  return JSON.stringify({ theme: "dark", llamaServer });
}

function loading(runId: number, contextSize = 131072): LlamaServerStatus {
  return { state: "loading", runId, modelPath: MODEL_PATH, contextSize, port: 51234 };
}

function ready(runId: number, contextSize = 131072): LlamaServerStatus {
  return { state: "ready", runId, modelPath: MODEL_PATH, contextSize, port: 51234 };
}

function failed(
  runId: number,
  reason: "spawn" | "exited",
  exitCode: number | null = null,
): LlamaServerStatus {
  return {
    state: "failed",
    runId,
    reason,
    executablePath: EXECUTABLE,
    modelPath: MODEL_PATH,
    message: "boom",
    exitCode,
  };
}

function stopped(
  runId: number,
  cause: "requested" | "exited",
  exitCode: number | null = null,
): LlamaServerStatus {
  return { state: "stopped", runId, cause, exitCode };
}

function propsResponse(nCtx: unknown): Response {
  return new Response(
    JSON.stringify({ default_generation_settings: { n_ctx: nCtx } }),
  );
}

/** イベントとして状態を届け、受け口の非同期の処理(`/props`)が終わるまで待つ */
async function emitStatusEvent(status: LlamaServerStatus): Promise<void> {
  expect(mocks.statusHandler).not.toBeNull();
  mocks.statusHandler?.(status);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const t = (key: string, options?: Record<string, unknown>): string =>
  i18n.t(key, options);

beforeEach(() => {
  expect(i18n.language).toBe("ja");
  // 状態を先に「停止中」に戻す。前のテストの「動いている」状態が残ったまま bundle を空にすると、
  // 停止の時機の購読が停止の command を呼んでしまう。
  useLlamaServerStore.setState({
    preferences: parsePreferences(null).llamaServer,
    status: INITIAL_STATUS,
  });
  useAIConfigStore.setState({ bundle: null });
  vi.clearAllMocks();
  // 既定では返らないままにする。戻り値を受け口に通すテストだけ、値を返させる。
  mocks.startLlamaServer.mockImplementation(() => new Promise(() => {}));
  mocks.stopLlamaServer.mockImplementation(() => new Promise(() => {}));
  mocks.readAppPreferences.mockResolvedValue(null);
  mocks.writeAppPreferences.mockResolvedValue(undefined);
  mocks.listGgufModels.mockResolvedValue([]);
  mocks.readLlamaServerStatus.mockResolvedValue(INITIAL_STATUS);
  mocks.subscribeLlamaServerStatus.mockImplementation((handler) => {
    mocks.subscribeCount += 1;
    mocks.statusHandler = handler;
    return Promise.resolve(() => {});
  });
  mocks.nativeFetch.mockImplementation(() =>
    Promise.resolve(propsResponse(131072)),
  );
  useLlamaServerStore.setState({
    models: [],
    modelsError: null,
    status: INITIAL_STATUS,
    actualContextSize: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

describe("initLlamaServerStore", () => {
  it("設定を読み、一覧を作り、今の状態を写し、起動の command は呼ばない(4.1)", async () => {
    mocks.readAppPreferences.mockResolvedValue(
      preferencesJson({
        executablePath: EXECUTABLE,
        modelsDir: MODELS_DIR,
        selectedModel: Q3,
        models: { [Q3]: { contextSize: 131072 } },
      }),
    );
    mocks.listGgufModels.mockResolvedValue([{ fileName: Q3, sizeBytes: 10 }]);
    mocks.readLlamaServerStatus.mockResolvedValue(loading(3));

    await initLlamaServerStore();

    const state = useLlamaServerStore.getState();
    expect(state.preferences).toEqual({
      executablePath: EXECUTABLE,
      modelsDir: MODELS_DIR,
      extraArgs: [],
      selectedModel: Q3,
      models: { [Q3]: { contextSize: 131072 } },
    });
    expect(mocks.listGgufModels).toHaveBeenCalledWith(MODELS_DIR);
    expect(state.models).toEqual([{ fileName: Q3, sizeBytes: 10 }]);
    expect(state.modelsError).toBeNull();
    expect(state.status).toEqual(loading(3));
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
  });

  it("フォルダが未設定なら、一覧の command を呼ばない", async () => {
    await initLlamaServerStore();

    expect(mocks.listGgufModels).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().models).toEqual([]);
    expect(useLlamaServerStore.getState().modelsError).toBeNull();
  });

  it("何度呼んでも、状態のイベントの購読は 1 回だけ", async () => {
    await initLlamaServerStore();
    await initLlamaServerStore();
    await Promise.all([initLlamaServerStore(), initLlamaServerStore()]);

    expect(mocks.subscribeCount).toBe(1);
  });

  it("設定や状態を読めなくても、例外を出さずに既定値のままにする", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readAppPreferences.mockRejectedValue("command not found");
    mocks.readLlamaServerStatus.mockRejectedValue("command not found");

    await expect(initLlamaServerStore()).resolves.toBeUndefined();

    const state = useLlamaServerStore.getState();
    expect(state.preferences.executablePath).toBe("");
    expect(state.preferences.models).toEqual({});
    expect(state.status).toEqual(INITIAL_STATUS);
    expect(warn).toHaveBeenCalled();
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
  });

  it("購読したイベントが、状態の受け口に届く", async () => {
    await initLlamaServerStore();

    await emitStatusEvent(loading(1));

    expect(useLlamaServerStore.getState().status).toEqual(loading(1));
  });
});

// ---------------------------------------------------------------------------
// 設定の更新と一覧の読み直し
// ---------------------------------------------------------------------------

describe("updatePreferences", () => {
  it("ストアを書き換え、ほかのトップレベルのキーを保って保存する", async () => {
    mocks.readAppPreferences.mockResolvedValue(
      preferencesJson({ executablePath: "old.exe" }),
    );
    await initLlamaServerStore();

    await useLlamaServerStore
      .getState()
      .updatePreferences({ executablePath: EXECUTABLE, extraArgs: ["--flash-attn", "on"] });

    expect(useLlamaServerStore.getState().preferences.executablePath).toBe(EXECUTABLE);
    expect(mocks.writeAppPreferences).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mocks.writeAppPreferences.mock.calls[0][0]) as unknown;
    expect(written).toEqual({
      theme: "dark",
      llamaServer: {
        executablePath: EXECUTABLE,
        modelsDir: "",
        extraArgs: ["--flash-attn", "on"],
        selectedModel: null,
        models: {},
      },
    });
    expect(mocks.listGgufModels).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("保存に失敗したら、トーストで知らせる(ストアの値は書き換えたまま)", async () => {
    await initLlamaServerStore();
    mocks.writeAppPreferences.mockRejectedValue("disk full");

    await useLlamaServerStore.getState().updatePreferences({ executablePath: EXECUTABLE });

    expect(useLlamaServerStore.getState().preferences.executablePath).toBe(EXECUTABLE);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      t("toast.llamaServerPreferencesSaveFailed", { message: "disk full" }),
    );
  });

  it("フォルダが変わったら、一覧を作り直す", async () => {
    await initLlamaServerStore();
    mocks.listGgufModels.mockResolvedValue([{ fileName: Q5, sizeBytes: 20 }]);

    await useLlamaServerStore.getState().updatePreferences({ modelsDir: MODELS_DIR });

    expect(mocks.listGgufModels).toHaveBeenCalledWith(MODELS_DIR);
    expect(useLlamaServerStore.getState().models).toEqual([
      { fileName: Q5, sizeBytes: 20 },
    ]);
  });
});

describe("refreshModels", () => {
  beforeEach(async () => {
    mocks.readAppPreferences.mockResolvedValue(
      preferencesJson({
        modelsDir: MODELS_DIR,
        models: { [Q3]: { contextSize: 131072 }, [Q5]: { contextSize: 81920 } },
      }),
    );
    mocks.listGgufModels.mockResolvedValue([
      { fileName: Q3, sizeBytes: 10 },
      { fileName: Q5, sizeBytes: 20 },
    ]);
    await initLlamaServerStore();
  });

  it("フォルダの今の中身で一覧を作り直し、モデルごとのコンテキスト長は消さない(2.6)", async () => {
    // Q5 がフォルダから無くなった
    mocks.listGgufModels.mockResolvedValue([{ fileName: Q3, sizeBytes: 10 }]);

    await useLlamaServerStore.getState().refreshModels();

    const state = useLlamaServerStore.getState();
    expect(state.models).toEqual([{ fileName: Q3, sizeBytes: 10 }]);
    expect(state.modelsError).toBeNull();
    expect(state.preferences.models).toEqual({
      [Q3]: { contextSize: 131072 },
      [Q5]: { contextSize: 81920 },
    });
    expect(mocks.writeAppPreferences).not.toHaveBeenCalled();
  });

  it("フォルダを読めなければ、一覧を空にして誤りを持つ(2.7)", async () => {
    mocks.listGgufModels.mockRejectedValue("フォルダを読めません");

    await useLlamaServerStore.getState().refreshModels();

    const state = useLlamaServerStore.getState();
    expect(state.models).toEqual([]);
    expect(state.modelsError).toBe("フォルダを読めません");
    expect(state.preferences.models).toEqual({
      [Q3]: { contextSize: 131072 },
      [Q5]: { contextSize: 81920 },
    });
  });

  it("誤りのあとに読めたら、誤りを消す", async () => {
    mocks.listGgufModels.mockRejectedValueOnce("フォルダを読めません");
    await useLlamaServerStore.getState().refreshModels();

    await useLlamaServerStore.getState().refreshModels();

    expect(useLlamaServerStore.getState().modelsError).toBeNull();
    expect(useLlamaServerStore.getState().models).toHaveLength(2);
  });

  it("フォルダが空欄なら、command を呼ばずに一覧を空・誤りなしにする", async () => {
    await useLlamaServerStore.getState().updatePreferences({ modelsDir: "" });
    mocks.listGgufModels.mockClear();

    await useLlamaServerStore.getState().refreshModels();

    expect(mocks.listGgufModels).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().models).toEqual([]);
    expect(useLlamaServerStore.getState().modelsError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 状態の受け口
// ---------------------------------------------------------------------------

describe("applyStatus", () => {
  beforeEach(async () => {
    await initLlamaServerStore();
    vi.clearAllMocks();
  });

  it("準備完了で /props を読み、実際の長さを持ち、準備完了のトーストだけを出す(5.3)", async () => {
    await emitStatusEvent(loading(1));
    await emitStatusEvent(ready(1));

    expect(mocks.nativeFetch).toHaveBeenCalledTimes(1);
    expect(mocks.nativeFetch.mock.calls[0][0]).toBe("http://127.0.0.1:51234/props");
    const state = useLlamaServerStore.getState();
    expect(state.status).toEqual(ready(1));
    expect(state.actualContextSize).toBe(131072);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(t("toast.llamaServerReady", { model: Q3 }));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("実際の長さが指定と違えば、食い違いのトースト、続けて準備完了のトーストを出す(5.8)", async () => {
    mocks.nativeFetch.mockResolvedValue(propsResponse(65536));

    await applyStatus(ready(1, 131072));

    expect(useLlamaServerStore.getState().actualContextSize).toBe(65536);
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerContextMismatch", { requested: 131072, actual: 65536 }),
      t("toast.llamaServerReady", { model: Q3 }),
    ]);
  });

  it("/props を読めなければ、実際の長さは null のまま、食い違いのトーストは出さない", async () => {
    mocks.nativeFetch.mockRejectedValue(new Error("connection refused"));

    await applyStatus(ready(1));

    expect(useLlamaServerStore.getState().actualContextSize).toBeNull();
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(t("toast.llamaServerReady", { model: Q3 }));
  });

  it.each([
    ["HTTP の失敗", new Response("oops", { status: 500 })],
    ["JSON でない応答", new Response("not json")],
    ["n_ctx が 0", propsResponse(0)],
    ["n_ctx が小数", propsResponse(1024.5)],
    ["n_ctx が文字列", propsResponse("131072")],
    ["default_generation_settings が無い", new Response(JSON.stringify({}))],
  ])("/props が %s なら、実際の長さは null で、食い違いのトーストは出さない", async (_, response) => {
    mocks.nativeFetch.mockResolvedValue(response);

    await applyStatus(ready(1));

    expect(useLlamaServerStore.getState().actualContextSize).toBeNull();
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerReady", { model: Q3 }),
    ]);
  });

  it("手元より古い通し番号は捨てる", async () => {
    await applyStatus(loading(2));

    await emitStatusEvent(ready(1));
    await emitStatusEvent(failed(1, "exited", 1));
    await emitStatusEvent(stopped(1, "exited", 1));

    expect(useLlamaServerStore.getState().status).toEqual(loading(2));
    expect(mocks.nativeFetch).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("起動できない失敗が command の戻り値とイベントの両方で届いても、トーストは 1 回(5.5)", async () => {
    await applyStatus(failed(1, "spawn"));
    await emitStatusEvent(failed(1, "spawn"));

    expect(useLlamaServerStore.getState().status).toEqual(failed(1, "spawn"));
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      t("toast.llamaServerSpawnFailed", { path: EXECUTABLE }),
    );
    expect(mocks.emitDevEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitDevEvent).toHaveBeenCalledWith("llamaServer.failed", {
      reason: "spawn",
      exitCode: null,
    });
  });

  it("準備完了が 2 度届いても、/props とトーストは 1 回", async () => {
    await applyStatus(ready(1));
    await emitStatusEvent(ready(1));

    expect(mocks.nativeFetch).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
  });

  it("読み込みの途中の終了は、読み込みの失敗のトーストを 1 回出す(5.6)", async () => {
    await emitStatusEvent(loading(1));
    await emitStatusEvent(failed(1, "exited", 1));

    expect(useLlamaServerStore.getState().status).toEqual(failed(1, "exited", 1));
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(t("toast.llamaServerLoadFailed"));
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).toHaveBeenCalledWith("llamaServer.failed", {
      reason: "exited",
      exitCode: 1,
    });
  });

  it("準備完了のあとの終了は、終了のトーストを 1 回出し、実際の長さを消す(5.11)", async () => {
    await emitStatusEvent(ready(1));
    expect(useLlamaServerStore.getState().actualContextSize).toBe(131072);
    vi.clearAllMocks();

    await emitStatusEvent(stopped(1, "exited", -1));

    const state = useLlamaServerStore.getState();
    expect(state.status).toEqual(stopped(1, "exited", -1));
    expect(state.actualContextSize).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(t("toast.llamaServerExited"));
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitDevEvent).toHaveBeenCalledWith("llamaServer.exited", {
      exitCode: -1,
    });
  });

  it("操作での停止と読み込み中は、トーストも dev 操作ログも出さない", async () => {
    await emitStatusEvent(loading(1));
    await emitStatusEvent(stopped(1, "requested"));

    expect(useLlamaServerStore.getState().status).toEqual(stopped(1, "requested"));
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("/props の応答より先に通し番号が進んだら、結果を捨てる", async () => {
    let resolveProps: (response: Response) => void = () => {};
    mocks.nativeFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveProps = resolve;
        }),
    );

    const pending = applyStatus(ready(1));
    expect(useLlamaServerStore.getState().status).toEqual(ready(1));
    await applyStatus(loading(2, 81920));
    resolveProps(propsResponse(65536));
    await pending;

    const state = useLlamaServerStore.getState();
    expect(state.status).toEqual(loading(2, 81920));
    expect(state.actualContextSize).toBeNull();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("/props を待つ間に止められたら(通し番号は同じ)、結果を捨てる", async () => {
    let resolveProps: (response: Response) => void = () => {};
    mocks.nativeFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveProps = resolve;
        }),
    );

    const pending = applyStatus(ready(1));
    await applyStatus(stopped(1, "requested"));
    resolveProps(propsResponse(131072));
    await pending;

    expect(useLlamaServerStore.getState().actualContextSize).toBeNull();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("準備完了の dev 操作ログに、読み込みのミリ秒と実際の長さを出す(パスは入れない)", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    await applyStatus(loading(1));
    now.mockReturnValue(43_500);
    await applyStatus(ready(1));

    expect(mocks.emitDevEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitDevEvent).toHaveBeenCalledWith("llamaServer.ready", {
      durationMs: 42_500,
      actualContextSize: 131072,
    });
  });

  it("読み込み中を受けていない準備完了では、読み込みのミリ秒は null", async () => {
    mocks.nativeFetch.mockRejectedValue(new Error("connection refused"));

    await applyStatus(ready(4));

    expect(mocks.emitDevEvent).toHaveBeenCalledWith("llamaServer.ready", {
      durationMs: null,
      actualContextSize: null,
    });
  });
});

// ---------------------------------------------------------------------------
// タスク 3.5: 受け口の規則(同じ通し番号の中では前にしか進まない)
// ---------------------------------------------------------------------------

describe("applyStatus(同じ通し番号の中の順序)", () => {
  it.each([
    ["準備完了 → 読み込み中", ready(1), loading(1)],
    ["準備完了 → 失敗", ready(1), failed(1, "exited", 1)],
    ["停止中(操作) → 準備完了", stopped(1, "requested"), ready(1)],
    ["停止中(操作) → 読み込み中", stopped(1, "requested"), loading(1)],
    ["停止中(操作) → 失敗", stopped(1, "requested"), failed(1, "exited", 1)],
    ["失敗 → 読み込み中", failed(1, "exited", 1), loading(1)],
    ["失敗 → 準備完了", failed(1, "exited", 1), ready(1)],
    ["失敗 → 停止中(終了した)", failed(1, "exited", 1), stopped(1, "exited", 1)],
  ])("%s は捨てる", async (_, current, late) => {
    useLlamaServerStore.setState({ status: current });

    await applyStatus(late);

    expect(useLlamaServerStore.getState().status).toEqual(current);
    expect(mocks.nativeFetch).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("通し番号が進んだ知らせは、停止中・失敗からでも採る", async () => {
    useLlamaServerStore.setState({ status: stopped(1, "requested") });
    await applyStatus(loading(2));
    expect(useLlamaServerStore.getState().status).toEqual(loading(2));

    useLlamaServerStore.setState({ status: failed(2, "exited", 1) });
    await applyStatus(loading(3));
    expect(useLlamaServerStore.getState().status).toEqual(loading(3));
  });
});

// ---------------------------------------------------------------------------
// タスク 3.5: 起動の関門・モデルの選択・停止・停止の時機
// ---------------------------------------------------------------------------

const Q3_CONTEXT = 131072;
const Q5_CONTEXT = 81920;
const EXTRA_ARGS = ["--flash-attn", "on"];

const LISTED_MODELS: GgufModel[] = [
  { fileName: Q3, sizeBytes: 10 },
  { fileName: Q5, sizeBytes: 20 },
];

/** 4 つの検査をすべて通る設定と一覧にする。フォルダの今の中身(起動の直前の読み直し)も同じにする */
function configure(): void {
  mocks.listGgufModels.mockResolvedValue(LISTED_MODELS);
  useLlamaServerStore.setState({
    preferences: {
      executablePath: EXECUTABLE,
      modelsDir: MODELS_DIR,
      extraArgs: EXTRA_ARGS,
      selectedModel: Q3,
      models: { [Q3]: { contextSize: Q3_CONTEXT }, [Q5]: { contextSize: Q5_CONTEXT } },
    },
    models: [
      { fileName: Q3, sizeBytes: 10 },
      { fileName: Q5, sizeBytes: 20 },
    ],
  });
}

function patchPreferences(patch: Record<string, unknown>): void {
  useLlamaServerStore.setState((state) => ({
    preferences: { ...state.preferences, ...patch },
  }));
}

function llamaConfig(): AIConfig {
  return { ...DEFAULT_AI_CONFIG_BUNDLE.providers["llama-server"] };
}

function bundleWith(activeProvider: ProviderId): AIConfigBundle {
  return { ...DEFAULT_AI_CONFIG_BUNDLE, activeProvider };
}

/** 先に書き換える「読み込み中」。通し番号は手元のまま、ポートは仮の値 */
function placeholder(
  runId: number,
  fileName = Q3,
  contextSize = Q3_CONTEXT,
): LlamaServerStatus {
  return {
    state: "loading",
    runId,
    modelPath: `${MODELS_DIR}\\${fileName}`,
    contextSize,
    port: 0,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("prepareLlamaServerConfig", () => {
  beforeEach(() => {
    configure();
  });

  it("llama-server 以外の設定は、同じ参照のまま通す(トーストも起動も無い)", () => {
    const config = { ...DEFAULT_AI_CONFIG_BUNDLE.providers["openai-compatible"] };

    const result = prepareLlamaServerConfig(config);

    expect(result.kind).toBe("ready");
    expect(result.kind === "ready" && result.config).toBe(config);
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("4 つの検査を、パス → モデルの選択 → 一覧 → コンテキスト長の順に行い、当たれば起動しない(3.7, 4.4, 4.5, 4.6)", () => {
    // 4 つとも当たる状態から、1 つずつ直していく。
    useLlamaServerStore.setState({
      preferences: parsePreferences(null).llamaServer,
      models: [],
    });
    const expected: string[] = [];

    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    expected.push(t("toast.llamaServerNoExecutable"));

    patchPreferences({ executablePath: EXECUTABLE, modelsDir: MODELS_DIR });
    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    expected.push(t("toast.llamaServerNoModel"));

    patchPreferences({ selectedModel: Q3 });
    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    expected.push(t("toast.llamaServerModelMissing", { model: Q3 }));

    useLlamaServerStore.setState({ models: [{ fileName: Q3, sizeBytes: 10 }] });
    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    expected.push(t("toast.llamaServerNoContextSize", { model: Q3 }));

    expect(mocks.toastError.mock.calls.map((call) => call[0])).toEqual(expected);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(INITIAL_STATUS);
  });

  it("検査を通ると、状態を先に読み込み中にして断り、一覧を読み直してから起動の command を 1 回呼び、トーストを出す(4.2, 4.3)", async () => {
    let statusAtCall: LlamaServerStatus | null = null;
    mocks.startLlamaServer.mockImplementation(() => {
      statusAtCall = useLlamaServerStore.getState().status;
      return new Promise(() => {});
    });

    const result = prepareLlamaServerConfig(llamaConfig());

    // 関門は同期のまま: 戻った時点で、状態は仮の読み込み中。トーストと起動はまだ
    expect(result).toEqual({ kind: "declined" });
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(0));
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();

    await flush();

    expect(mocks.listGgufModels).toHaveBeenCalledTimes(1);
    expect(mocks.listGgufModels).toHaveBeenCalledWith(MODELS_DIR);
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer).toHaveBeenCalledWith({
      executablePath: EXECUTABLE,
      modelPath: `${MODELS_DIR}\\${Q3}`,
      contextSize: Q3_CONTEXT,
      extraArgs: EXTRA_ARGS,
    });
    expect(statusAtCall).toEqual(placeholder(0));
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(0));
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerStarting", { model: Q3 }),
    ]);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent.mock.calls).toEqual([
      ["llamaServer.start", { model: Q3, contextSize: Q3_CONTEXT }],
    ]);
    // 「読み込み始めました」は、一覧の確認が済んで、起動の command を呼ぶ直前に出す
    expect(mocks.listGgufModels.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.toastInfo.mock.invocationCallOrder[0],
    );
    expect(mocks.toastInfo.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startLlamaServer.mock.invocationCallOrder[0],
    );
  });

  it("起動の直前に一覧を読み直し、足された gguf をストアの一覧に入れる(3.7)", async () => {
    const added = { fileName: "added.gguf", sizeBytes: 30 };
    mocks.listGgufModels.mockResolvedValue([...LISTED_MODELS, added]);

    prepareLlamaServerConfig(llamaConfig());
    await flush();

    expect(useLlamaServerStore.getState().models).toEqual([...LISTED_MODELS, added]);
    expect(useLlamaServerStore.getState().modelsError).toBeNull();
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["停止中", stopped(2, "exited", 1)],
    ["失敗", failed(2, "exited", 1)],
  ])("%s からの要求で、選んだモデルがフォルダから消えていたら、起動せず、元の状態に戻して知らせる(3.7)", async (_, before) => {
    useLlamaServerStore.setState({ status: before });
    // ストアの一覧は古いまま(Q3 がある)。フォルダからは Q3 が消えている
    mocks.listGgufModels.mockResolvedValue([{ fileName: Q5, sizeBytes: 20 }]);

    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(2));
    await flush();

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(before);
    expect(useLlamaServerStore.getState().models).toEqual([
      { fileName: Q5, sizeBytes: 20 },
    ]);
    expect(mocks.toastError.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerModelMissing", { model: Q3 }),
    ]);
    // 「読み込み始めました」は出さない(トーストが 2 つ続かない)
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("起動の直前にフォルダを読めなければ、起動せず、誤りを持ち、フォルダを読めない旨を知らせる", async () => {
    const before = stopped(2, "requested");
    useLlamaServerStore.setState({ status: before });
    mocks.listGgufModels.mockRejectedValue("アクセスが拒否されました");

    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    await flush();

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    const state = useLlamaServerStore.getState();
    expect(state.status).toEqual(before);
    expect(state.models).toEqual([]);
    expect(state.modelsError).toBe("アクセスが拒否されました");
    expect(mocks.toastError.mock.calls.map((call) => call[0])).toEqual([
      t("llamaServer.modelsDirUnreadable", { message: "アクセスが拒否されました" }),
    ]);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("停止の command の戻りが、直後の要求の読み直し中に届いても、その要求の起動を捨てない", async () => {
    await initLlamaServerStore();
    configure();
    useLlamaServerStore.setState({ status: ready(4) });
    let resolveStop: (status: LlamaServerStatus) => void = () => {};
    mocks.stopLlamaServer.mockImplementation(
      () =>
        new Promise<LlamaServerStatus>((resolve) => {
          resolveStop = resolve;
        }),
    );
    let resolveList: (models: GgufModel[]) => void = () => {};
    mocks.listGgufModels.mockImplementation(
      () =>
        new Promise<GgufModel[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    void useLlamaServerStore.getState().stop();
    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(4));
    // 停止の戻り(通し番号が進んでいる)が、仮の読み込み中を上書きする
    resolveStop(stopped(5, "requested"));
    await flush();
    expect(useLlamaServerStore.getState().status).toEqual(stopped(5, "requested"));
    resolveList(LISTED_MODELS);
    await flush();

    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer.mock.calls[0][0].modelPath).toBe(
      `${MODELS_DIR}\\${Q3}`,
    );
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerStarting", { model: Q3 }),
    ]);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(5));
  });

  it("一覧を読み直している間に止められたら、起動しない", async () => {
    let resolveList: (models: GgufModel[]) => void = () => {};
    mocks.listGgufModels.mockImplementation(
      () =>
        new Promise<GgufModel[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    mocks.stopLlamaServer.mockResolvedValue(stopped(0, "requested"));

    prepareLlamaServerConfig(llamaConfig());
    await useLlamaServerStore.getState().stop();
    resolveList(LISTED_MODELS);
    await flush();

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(stopped(0, "requested"));
  });

  it.each([
    ["C:\\models\\", `C:\\models\\${Q3}`],
    ["C:/models/", `C:/models/${Q3}`],
    ["C:/models", `C:/models\\${Q3}`],
  ])("モデルのフォルダが %s のとき、区切りを重ねずにつなぐ", async (modelsDir, modelPath) => {
    patchPreferences({ modelsDir });

    prepareLlamaServerConfig(llamaConfig());
    await flush();

    expect(mocks.startLlamaServer.mock.calls[0][0].modelPath).toBe(modelPath);
  });

  it("起動の command の戻り値を受け口に通し、準備完了のあとは実効の設定を返す(1.3, 5.4)", async () => {
    await initLlamaServerStore();
    configure();
    mocks.startLlamaServer.mockResolvedValue(loading(1));

    prepareLlamaServerConfig(llamaConfig());
    await flush();
    expect(useLlamaServerStore.getState().status).toEqual(loading(1));

    await emitStatusEvent(ready(1));
    const config = llamaConfig();
    const result = prepareLlamaServerConfig(config);

    expect(result).toEqual({
      kind: "ready",
      config: {
        ...config,
        endpoint: "http://127.0.0.1:51234/v1",
        model: Q3,
        contextWindow: 131072,
      },
    });
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
  });

  it("読み込み中は、読み込み中のトーストを出して断り、起動しない(5.2)", () => {
    useLlamaServerStore.setState({ status: loading(1) });

    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });

    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerLoading"),
    ]);
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
  });

  it("先に書き換えた読み込み中の間の要求も、読み込み中として断る(起動は 1 回)", async () => {
    prepareLlamaServerConfig(llamaConfig());
    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    await flush();

    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    // 「読み込み始めました」は一覧の確認のあとなので、すぐ続けた要求の「読み込み中」が先に出る
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerLoading"),
      t("toast.llamaServerStarting", { model: Q3 }),
    ]);
  });

  it("準備完了なら、設定の参照・通し番号・実際の長さが同じ間は同じ参照を返す", () => {
    useLlamaServerStore.setState({ status: ready(1), actualContextSize: 65536 });
    const config = llamaConfig();

    const first = prepareLlamaServerConfig(config);
    const second = prepareLlamaServerConfig(config);

    if (first.kind !== "ready" || second.kind !== "ready") {
      throw new Error("準備完了なのに断られた");
    }
    expect(first.config.contextWindow).toBe(65536);
    expect(first.config.endpoint).toBe("http://127.0.0.1:51234/v1");
    expect(first.config.model).toBe(Q3);
    expect(second.config).toBe(first.config);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();

    // 設定の参照が変わる
    const other = prepareLlamaServerConfig({ ...config });
    expect(other.kind === "ready" && other.config).not.toBe(first.config);

    // 実際の長さが変わる
    useLlamaServerStore.setState({ actualContextSize: 32768 });
    const resized = prepareLlamaServerConfig(config);
    if (resized.kind !== "ready") throw new Error("準備完了なのに断られた");
    expect(resized.config).not.toBe(first.config);
    expect(resized.config.contextWindow).toBe(32768);

    // 通し番号が変わる
    useLlamaServerStore.setState({ status: ready(2) });
    const restarted = prepareLlamaServerConfig(config);
    if (restarted.kind !== "ready") throw new Error("準備完了なのに断られた");
    expect(restarted.config).not.toBe(resized.config);
    const again = prepareLlamaServerConfig(config);
    expect(again.kind === "ready" && again.config).toBe(restarted.config);
  });

  it.each([
    ["失敗", failed(3, "exited", 1)],
    ["停止中(終了した)", stopped(3, "exited", -1)],
    ["停止中(操作)", stopped(3, "requested")],
  ])("%s のあとの要求で、起動し直す(5.12)", async (_, status) => {
    useLlamaServerStore.setState({ status });

    expect(prepareLlamaServerConfig(llamaConfig())).toEqual({ kind: "declined" });
    await flush();

    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(3));
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      t("toast.llamaServerStarting", { model: Q3 }),
    );
  });

  it("起動の command が失敗を返したら、失敗の状態になり、トーストは 1 回", async () => {
    await initLlamaServerStore();
    configure();
    mocks.startLlamaServer.mockResolvedValue(failed(1, "spawn"));

    prepareLlamaServerConfig(llamaConfig());
    await flush();
    await emitStatusEvent(failed(1, "spawn"));

    expect(useLlamaServerStore.getState().status).toEqual(failed(1, "spawn"));
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      t("toast.llamaServerSpawnFailed", { path: EXECUTABLE }),
    );
  });

  it("起動の command が reject したら、先に書き換えた読み込み中を取り消して元の状態に戻し、トーストを出す", async () => {
    const before = stopped(2, "exited", 1);
    useLlamaServerStore.setState({ status: before });
    mocks.startLlamaServer.mockRejectedValue("command not found");

    prepareLlamaServerConfig(llamaConfig());
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(2));
    await flush();

    expect(useLlamaServerStore.getState().status).toEqual(before);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      t("toast.llamaServerSpawnFailed", { path: EXECUTABLE }),
    );
  });

  it("先に書き換えた読み込み中の間は、同じ通し番号の遅れた知らせを採らない", async () => {
    await initLlamaServerStore();
    configure();
    useLlamaServerStore.setState({ status: stopped(2, "requested") });
    prepareLlamaServerConfig(llamaConfig());
    // 起動の command を呼ぶところまで進める(戻り値は返らないので、仮の読み込み中のまま)
    await flush();
    vi.clearAllMocks();

    await emitStatusEvent(ready(2));
    await emitStatusEvent(stopped(2, "exited", 1));

    expect(useLlamaServerStore.getState().status).toEqual(placeholder(2));
    expect(mocks.nativeFetch).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    await emitStatusEvent(loading(3));
    expect(useLlamaServerStore.getState().status).toEqual(loading(3));
  });
});

describe("selectModel", () => {
  beforeEach(async () => {
    await initLlamaServerStore();
    configure();
    vi.clearAllMocks();
  });

  function writtenSelectedModel(): unknown {
    expect(mocks.writeAppPreferences).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mocks.writeAppPreferences.mock.calls[0][0]) as {
      llamaServer: { selectedModel: unknown };
    };
    return written.llamaServer.selectedModel;
  }

  it.each([
    ["停止中", stopped(1, "requested")],
    ["失敗", failed(1, "exited", 1)],
  ])("%s なら、選択を保存するだけで起動しない(3.2, 3.5)", async (_, status) => {
    useLlamaServerStore.setState({ status });

    await useLlamaServerStore.getState().selectModel(Q5);

    expect(useLlamaServerStore.getState().preferences.selectedModel).toBe(Q5);
    expect(writtenSelectedModel()).toBe(Q5);
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(status);
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["準備完了", ready(4)],
    ["読み込み中", loading(4)],
  ])("%s で別のモデルを選ぶと、状態を先に読み込み中にしてから起動し直す(3.3, 3.4)", async (_, status) => {
    useLlamaServerStore.setState({ status, actualContextSize: 131072 });
    let statusAtCall: LlamaServerStatus | null = null;
    mocks.startLlamaServer.mockImplementation(() => {
      statusAtCall = useLlamaServerStore.getState().status;
      return Promise.resolve(loading(5, Q5_CONTEXT));
    });

    const pending = useLlamaServerStore.getState().selectModel(Q5);
    // 生成中のコントローラが購読で中止できるよう、状態は同期で書き換わる
    expect(useLlamaServerStore.getState().status).toEqual(
      placeholder(4, Q5, Q5_CONTEXT),
    );
    await pending;
    await flush();

    expect(writtenSelectedModel()).toBe(Q5);
    expect(mocks.listGgufModels).toHaveBeenCalledWith(MODELS_DIR);
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer).toHaveBeenCalledWith({
      executablePath: EXECUTABLE,
      modelPath: `${MODELS_DIR}\\${Q5}`,
      contextSize: Q5_CONTEXT,
      extraArgs: EXTRA_ARGS,
    });
    expect(statusAtCall).toEqual(placeholder(4, Q5, Q5_CONTEXT));
    // 動いているプロセスを止めるのは、Rust 側の起動の command
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(loading(5, Q5_CONTEXT));
    expect(useLlamaServerStore.getState().actualContextSize).toBeNull();
    expect(mocks.emitDevEvent.mock.calls).toEqual([
      ["llamaServer.stop", { trigger: "modelSwitch" }],
      ["llamaServer.start", { model: Q5, contextSize: Q5_CONTEXT }],
    ]);
    // 読み込みを始めたことを、関門からの起動と同じトーストで知らせる
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerStarting", { model: Q5 }),
    ]);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("保存の完了を待たずに、状態を書き換えて起動の command を呼ぶ", async () => {
    useLlamaServerStore.setState({ status: ready(4) });
    let resolveWrite: () => void = () => {};
    mocks.writeAppPreferences.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const pending = useLlamaServerStore.getState().selectModel(Q5);

    expect(useLlamaServerStore.getState().preferences.selectedModel).toBe(Q5);
    expect(useLlamaServerStore.getState().status.state).toBe("loading");
    await flush();
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    resolveWrite();
    await pending;
  });

  it("今動いているのと同じモデルを選び直しただけなら、保存だけ", async () => {
    patchPreferences({ selectedModel: Q5 });
    useLlamaServerStore.setState({ status: ready(4) });

    await useLlamaServerStore.getState().selectModel(Q3);

    expect(writtenSelectedModel()).toBe(Q3);
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(ready(4));
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("動いているときに検査に当たれば、トーストを出して止める(起動しない)", async () => {
    useLlamaServerStore.setState({ status: ready(4) });
    patchPreferences({ models: { [Q3]: { contextSize: Q3_CONTEXT } } });
    mocks.stopLlamaServer.mockResolvedValue(stopped(4, "requested"));

    await useLlamaServerStore.getState().selectModel(Q5);

    expect(writtenSelectedModel()).toBe(Q5);
    expect(mocks.toastError.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerNoContextSize", { model: Q5 }),
    ]);
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(useLlamaServerStore.getState().status).toEqual(stopped(4, "requested"));
    expect(mocks.emitDevEvent.mock.calls).toEqual([
      ["llamaServer.stop", { trigger: "modelSwitch" }],
    ]);
  });

  it("一覧に無いモデルを選ぶと、動いていればトーストを出して止める(3.7)", async () => {
    useLlamaServerStore.setState({ status: loading(4) });
    mocks.stopLlamaServer.mockResolvedValue(stopped(4, "requested"));

    await useLlamaServerStore.getState().selectModel("gone.gguf");

    expect(mocks.toastError).toHaveBeenCalledWith(
      t("toast.llamaServerModelMissing", { model: "gone.gguf" }),
    );
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
  });

  it("起動し直す直前に、選んだモデルがフォルダから消えていたら、起動せず、動いているものを止めて知らせる(3.7)", async () => {
    useLlamaServerStore.setState({ status: ready(4), actualContextSize: 131072 });
    // ストアの一覧は古いまま(Q5 がある)。フォルダからは Q5 が消えている
    mocks.listGgufModels.mockResolvedValue([{ fileName: Q3, sizeBytes: 10 }]);
    mocks.stopLlamaServer.mockResolvedValue(stopped(4, "requested"));

    await useLlamaServerStore.getState().selectModel(Q5);
    await flush();

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(useLlamaServerStore.getState().status).toEqual(stopped(4, "requested"));
    expect(useLlamaServerStore.getState().models).toEqual([
      { fileName: Q3, sizeBytes: 10 },
    ]);
    expect(mocks.toastError.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerModelMissing", { model: Q5 }),
    ]);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent.mock.calls).toEqual([
      ["llamaServer.stop", { trigger: "modelSwitch" }],
    ]);
  });

  /** `listGgufModels` を、呼ばれた順に手で解決できる形にする */
  function holdListings(): ((models: GgufModel[]) => void)[] {
    const resolvers: ((models: GgufModel[]) => void)[] = [];
    mocks.listGgufModels.mockImplementation(
      () =>
        new Promise<GgufModel[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    return resolvers;
  }

  it("読み直し中に別のモデルを選んだら、古い読み直しの結果が新しい起動を取り消さない(起動は新しいモデルで 1 回)", async () => {
    useLlamaServerStore.setState({ status: ready(4) });
    const listings = holdListings();

    void useLlamaServerStore.getState().selectModel(Q5);
    void useLlamaServerStore.getState().selectModel(Q3);
    listings[0](LISTED_MODELS);
    await flush();
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    listings[1](LISTED_MODELS);
    await flush();

    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer.mock.calls[0][0].modelPath).toBe(
      `${MODELS_DIR}\\${Q3}`,
    );
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerStarting", { model: Q3 }),
    ]);
  });

  it("読み直し中に、先行の起動の command の結果が届いても、あとから選んだモデルの起動を捨てない", async () => {
    useLlamaServerStore.setState({ status: ready(4) });
    // B(Q5)を選び、起動の command まで進める(戻り値はまだ返らない)
    await useLlamaServerStore.getState().selectModel(Q5);
    await flush();
    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    // C(Q3)を選ぶ。読み直しの間に、B の起動の結果が届く
    const listings = holdListings();
    void useLlamaServerStore.getState().selectModel(Q3);
    const loadingB: LlamaServerStatus = {
      state: "loading",
      runId: 5,
      modelPath: `${MODELS_DIR}\\${Q5}`,
      contextSize: Q5_CONTEXT,
      port: 51234,
    };
    await applyStatus(loadingB);
    expect(useLlamaServerStore.getState().status).toEqual(loadingB);
    listings[0](LISTED_MODELS);
    await flush();

    expect(mocks.startLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer).toHaveBeenCalledWith({
      executablePath: EXECUTABLE,
      modelPath: `${MODELS_DIR}\\${Q3}`,
      contextSize: Q3_CONTEXT,
      extraArgs: EXTRA_ARGS,
    });
    expect(mocks.toastInfo.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerStarting", { model: Q3 }),
    ]);
    // 仮の読み込み中を、届いた通し番号で書き直してから起動する
    expect(useLlamaServerStore.getState().status).toEqual(placeholder(5, Q3, Q3_CONTEXT));
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
  });

  it("読み直し中に、先行の起動の結果が届いたあとでモデルが無いと分かったら、届いた通し番号で止める", async () => {
    useLlamaServerStore.setState({ status: ready(4) });
    await useLlamaServerStore.getState().selectModel(Q5);
    await flush();
    vi.clearAllMocks();
    mocks.stopLlamaServer.mockResolvedValue(stopped(6, "requested"));

    const listings = holdListings();
    void useLlamaServerStore.getState().selectModel(Q3);
    await applyStatus({
      state: "loading",
      runId: 5,
      modelPath: `${MODELS_DIR}\\${Q5}`,
      contextSize: Q5_CONTEXT,
      port: 51234,
    });
    let statusAtStop: LlamaServerStatus | null = null;
    mocks.stopLlamaServer.mockImplementation(() => {
      statusAtStop = useLlamaServerStore.getState().status;
      return Promise.resolve(stopped(6, "requested"));
    });
    listings[0]([{ fileName: Q5, sizeBytes: 20 }]);
    await flush();

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(statusAtStop).toEqual(stopped(5, "requested"));
    expect(useLlamaServerStore.getState().status).toEqual(stopped(6, "requested"));
    expect(mocks.toastError.mock.calls.map((call) => call[0])).toEqual([
      t("toast.llamaServerModelMissing", { model: Q3 }),
    ]);
  });

  it("起動し直す直前にフォルダを読めなければ、起動せず、動いているものを止めて知らせる", async () => {
    useLlamaServerStore.setState({ status: loading(4) });
    mocks.listGgufModels.mockRejectedValue("アクセスが拒否されました");
    mocks.stopLlamaServer.mockResolvedValue(stopped(4, "requested"));

    await useLlamaServerStore.getState().selectModel(Q5);
    await flush();

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(useLlamaServerStore.getState().status).toEqual(stopped(4, "requested"));
    expect(useLlamaServerStore.getState().modelsError).toBe("アクセスが拒否されました");
    expect(mocks.toastError.mock.calls.map((call) => call[0])).toEqual([
      t("llamaServer.modelsDirUnreadable", { message: "アクセスが拒否されました" }),
    ]);
  });
});

describe("stop", () => {
  beforeEach(() => {
    configure();
  });

  it.each([
    ["準備完了", ready(4)],
    ["読み込み中", loading(4)],
  ])("%s なら、状態を先に停止中にしてから停止の command を呼ぶ(6.5, 6.6)", async (_, status) => {
    useLlamaServerStore.setState({ status, actualContextSize: 131072 });
    let statusAtCall: LlamaServerStatus | null = null;
    mocks.stopLlamaServer.mockImplementation(() => {
      statusAtCall = useLlamaServerStore.getState().status;
      return Promise.resolve(stopped(5, "requested"));
    });

    await useLlamaServerStore.getState().stop();

    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(statusAtCall).toEqual(stopped(4, "requested"));
    // 戻り値は受け口に通す
    expect(useLlamaServerStore.getState().status).toEqual(stopped(5, "requested"));
    expect(useLlamaServerStore.getState().actualContextSize).toBeNull();
    expect(mocks.emitDevEvent.mock.calls).toEqual([
      ["llamaServer.stop", { trigger: "user" }],
    ]);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["停止中", stopped(4, "exited", 1)],
    ["失敗", failed(4, "exited", 1)],
  ])("%s なら何もしない", async (_, status) => {
    useLlamaServerStore.setState({ status });

    await useLlamaServerStore.getState().stop();

    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(status);
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("止めたあとに、同じ通し番号の遅れた準備完了が届いても戻らない", async () => {
    await initLlamaServerStore();
    useLlamaServerStore.setState({ status: loading(4) });
    vi.clearAllMocks();

    void useLlamaServerStore.getState().stop();
    await emitStatusEvent(ready(4));

    expect(useLlamaServerStore.getState().status).toEqual(stopped(4, "requested"));
    expect(mocks.nativeFetch).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});

describe("停止の時機(AI 接続設定のストアの購読)", () => {
  beforeEach(async () => {
    await initLlamaServerStore();
    configure();
    useAIConfigStore.setState({ bundle: bundleWith("llama-server") });
    vi.clearAllMocks();
  });

  it("現在使うプロバイダを llama-server からほかに変えると、動いていれば止める(6.3)", () => {
    useLlamaServerStore.setState({ status: ready(4) });

    useAIConfigStore.setState({ bundle: bundleWith("openai") });

    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(useLlamaServerStore.getState().status).toEqual(stopped(4, "requested"));
    expect(mocks.emitDevEvent.mock.calls).toEqual([
      ["llamaServer.stop", { trigger: "providerSwitch" }],
    ]);
  });

  it("プロジェクトを閉じて設定が空になると、読み込み中でも止める(6.4)", () => {
    useLlamaServerStore.setState({ status: loading(4) });

    useAIConfigStore.getState().clear();

    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(useLlamaServerStore.getState().status).toEqual(stopped(4, "requested"));
    expect(mocks.emitDevEvent.mock.calls).toEqual([
      ["llamaServer.stop", { trigger: "projectClose" }],
    ]);
  });

  it("止まっているときは、プロバイダを変えても停止の command を呼ばない", () => {
    useLlamaServerStore.setState({ status: failed(4, "exited", 1) });

    useAIConfigStore.setState({ bundle: bundleWith("openai-compatible") });
    useAIConfigStore.getState().clear();

    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(mocks.emitDevEvent).not.toHaveBeenCalled();
  });

  it("llama-server に切り替えただけでは、起動も停止もしない(1.2)", () => {
    useAIConfigStore.setState({ bundle: bundleWith("openai") });
    vi.clearAllMocks();

    useAIConfigStore.setState({ bundle: bundleWith("llama-server") });
    useAIConfigStore.setState({ bundle: null });
    useAIConfigStore.setState({ bundle: bundleWith("llama-server") });

    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(INITIAL_STATUS);
  });

  it("llama-server のまま設定が変わっただけでは止めない", () => {
    useLlamaServerStore.setState({ status: ready(4) });

    useAIConfigStore.setState({
      bundle: {
        ...bundleWith("llama-server"),
        providers: {
          ...DEFAULT_AI_CONFIG_BUNDLE.providers,
          "llama-server": { ...llamaConfig(), systemPrompt: "x" },
        },
      },
    });
    useAIConfigStore.setState({
      secretAvailability: {
        "openai-compatible": null,
        openai: true,
        "llama-server": null,
      },
    });

    expect(mocks.stopLlamaServer).not.toHaveBeenCalled();
    expect(useLlamaServerStore.getState().status).toEqual(ready(4));
  });

  it("初期化を何度呼んでも、購読は 1 つ(停止は 1 回)", async () => {
    await initLlamaServerStore();
    await initLlamaServerStore();
    configure();
    vi.clearAllMocks();
    useLlamaServerStore.setState({ status: ready(4) });

    useAIConfigStore.setState({ bundle: bundleWith("openai") });

    expect(mocks.stopLlamaServer).toHaveBeenCalledTimes(1);
    expect(mocks.emitDevEvent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// トークン数のキャッシュを消す時機(7.4, 7.5)
// ---------------------------------------------------------------------------

describe("トークン数のキャッシュを消す時機", () => {
  beforeEach(async () => {
    await initLlamaServerStore();
    useAIConfigStore.setState({ bundle: bundleWith("openai-compatible") });
    vi.clearAllMocks();
  });

  it("準備完了を採ったときに消す(同じ知らせが 2 度届いても 1 回)", async () => {
    await applyStatus(loading(1));
    expect(mocks.clearContextBuilderCache).not.toHaveBeenCalled();

    await applyStatus(ready(1));
    await emitStatusEvent(ready(1));

    expect(mocks.clearContextBuilderCache).toHaveBeenCalledTimes(1);
  });

  it("起動し直して準備完了になるたびに消す", async () => {
    await applyStatus(ready(1));
    await applyStatus(loading(2));
    await applyStatus(ready(2));

    expect(mocks.clearContextBuilderCache).toHaveBeenCalledTimes(2);
  });

  it("捨てた準備完了(古い通し番号、止めたあとの遅れた知らせ)では消さない", async () => {
    await applyStatus(stopped(3, "requested"));

    await applyStatus(ready(2));
    await applyStatus(ready(3));

    expect(mocks.clearContextBuilderCache).not.toHaveBeenCalled();
  });

  it.each([
    ["OpenAI 互換 → OpenAI", "openai-compatible", "openai"],
    ["OpenAI 互換 → llama-server", "openai-compatible", "llama-server"],
    ["llama-server → OpenAI 互換", "llama-server", "openai-compatible"],
  ] as const)("現在使うプロバイダが変わったら消す(%s)", (_, from, to) => {
    useAIConfigStore.setState({ bundle: bundleWith(from) });
    vi.clearAllMocks();

    useAIConfigStore.setState({ bundle: bundleWith(to) });

    expect(mocks.clearContextBuilderCache).toHaveBeenCalledTimes(1);
  });

  it("現在使うプロバイダが同じままの変更では消さない", () => {
    useAIConfigStore.setState({ bundle: bundleWith("openai-compatible") });
    useAIConfigStore.setState({
      secretAvailability: {
        "openai-compatible": null,
        openai: true,
        "llama-server": null,
      },
    });

    expect(mocks.clearContextBuilderCache).not.toHaveBeenCalled();
  });
});
