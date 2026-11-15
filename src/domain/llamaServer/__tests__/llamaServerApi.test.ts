import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Tauri のイベントの差し替えの形(このリポジトリでの前例):
// `listen` を vi.fn にし、渡されたハンドラを `mock.calls` から取り出して
// `{ payload }` で呼ぶ。戻り値は、解除の関数で解決する Promise にする。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  listGgufModels,
  readAppPreferences,
  readLlamaServerLog,
  readLlamaServerStatus,
  startLlamaServer,
  stopLlamaServer,
  subscribeLlamaServerStatus,
  writeAppPreferences,
} from "@/domain/llamaServer/llamaServerApi";
import type {
  GgufModel,
  LlamaServerStatus,
  StartLlamaServerRequest,
} from "@/domain/llamaServer/types";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

const LOADING: LlamaServerStatus = {
  state: "loading",
  runId: 3,
  modelPath: "C:\\models\\a.gguf",
  contextSize: 8192,
  port: 51234,
};

const READY: LlamaServerStatus = { ...LOADING, state: "ready" };

const STOPPED: LlamaServerStatus = {
  state: "stopped",
  runId: 3,
  cause: "requested",
  exitCode: null,
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
});

describe("アプリ側の設定の command", () => {
  it("readAppPreferences は read_app_preferences を引数なしで呼び、文字列を返す", async () => {
    mockInvoke.mockResolvedValueOnce('{"llamaServer":{}}');

    expect(await readAppPreferences()).toBe('{"llamaServer":{}}');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0]).toEqual(["read_app_preferences"]);
  });

  it("readAppPreferences は、ファイルが無いときの null をそのまま返す", async () => {
    mockInvoke.mockResolvedValueOnce(null);

    expect(await readAppPreferences()).toBeNull();
  });

  it("writeAppPreferences は write_app_preferences を { json } で呼ぶ", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await writeAppPreferences('{"a":1}');

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("write_app_preferences", {
      json: '{"a":1}',
    });
  });

  it("listGgufModels は list_gguf_models を { dir } で呼び、一覧を返す", async () => {
    const models: GgufModel[] = [{ fileName: "a.gguf", sizeBytes: 123 }];
    mockInvoke.mockResolvedValueOnce(models);

    expect(await listGgufModels("C:\\models")).toEqual(models);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("list_gguf_models", {
      dir: "C:\\models",
    });
  });

  it("listGgufModels は、フォルダを読めないときのエラーをそのまま伝える", async () => {
    mockInvoke.mockRejectedValueOnce("フォルダを読めません");

    await expect(listGgufModels("C:\\none")).rejects.toBe(
      "フォルダを読めません",
    );
  });
});

describe("llama-server の command", () => {
  it("startLlamaServer は start_llama_server を { req } で呼び、状態を返す", async () => {
    const req: StartLlamaServerRequest = {
      executablePath: "C:\\bin\\llama-server.exe",
      modelPath: "C:\\models\\a.gguf",
      contextSize: 8192,
      extraArgs: ["--flash-attn", "on"],
    };
    mockInvoke.mockResolvedValueOnce(LOADING);

    expect(await startLlamaServer(req)).toEqual(LOADING);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("start_llama_server", { req });
  });

  it("stopLlamaServer は stop_llama_server を引数なしで呼び、状態を返す", async () => {
    mockInvoke.mockResolvedValueOnce(STOPPED);

    expect(await stopLlamaServer()).toEqual(STOPPED);
    expect(mockInvoke.mock.calls).toEqual([["stop_llama_server"]]);
  });

  it("readLlamaServerStatus は read_llama_server_status を引数なしで呼び、状態を返す", async () => {
    mockInvoke.mockResolvedValueOnce(READY);

    expect(await readLlamaServerStatus()).toEqual(READY);
    expect(mockInvoke.mock.calls).toEqual([["read_llama_server_status"]]);
  });

  it("readLlamaServerLog は read_llama_server_log を引数なしで呼び、行の配列を返す", async () => {
    mockInvoke.mockResolvedValueOnce(["line 1", "line 2"]);

    expect(await readLlamaServerLog()).toEqual(["line 1", "line 2"]);
    expect(mockInvoke.mock.calls).toEqual([["read_llama_server_log"]]);
  });

  it("command のエラーを握りつぶさない", async () => {
    mockInvoke.mockRejectedValueOnce("contextSize は 1 以上");

    await expect(
      startLlamaServer({
        executablePath: "x",
        modelPath: "y",
        contextSize: 0,
        extraArgs: [],
      }),
    ).rejects.toBe("contextSize は 1 以上");
  });
});

describe("subscribeLlamaServerStatus", () => {
  it("llama-server-status を購読し、イベントの payload だけをハンドラに渡す", async () => {
    mockListen.mockResolvedValueOnce(() => {});
    const handler = vi.fn();

    await subscribeLlamaServerStatus(handler);

    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockListen.mock.calls[0][0]).toBe("llama-server-status");

    const emit = mockListen.mock.calls[0][1] as (event: {
      payload: LlamaServerStatus;
    }) => void;
    emit({ payload: LOADING });
    emit({ payload: READY });

    expect(handler.mock.calls).toEqual([[LOADING], [READY]]);
  });

  it("listen が返した解除の関数を、そのまま返す", async () => {
    const unlisten = vi.fn();
    mockListen.mockResolvedValueOnce(unlisten);

    const unsubscribe = await subscribeLlamaServerStatus(() => {});
    expect(unlisten).not.toHaveBeenCalled();

    unsubscribe();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("購読の失敗をそのまま伝える", async () => {
    mockListen.mockRejectedValueOnce(new Error("listen failed"));

    await expect(subscribeLlamaServerStatus(() => {})).rejects.toThrow(
      "listen failed",
    );
  });
});
