import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/domain/llamaServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/llamaServer")>();
  return {
    ...actual,
    listGgufModels: vi.fn(),
    readLlamaServerLog: vi.fn(),
    startLlamaServer: vi.fn(),
    stopLlamaServer: vi.fn(),
    writeAppPreferences: vi.fn(),
  };
});
vi.mock("@/domain/project/projectApi", () => ({
  saveProjectMeta: vi.fn().mockResolvedValue(undefined),
}));

import { open } from "@tauri-apps/plugin-dialog";
import ja from "@/i18n/locales/ja.json";
import { LlamaServerSettings } from "@/components/settings/LlamaServerSettings";
import {
  readLlamaServerLog,
  startLlamaServer,
  stopLlamaServer,
  type LlamaServerPreferences,
  type LlamaServerStatus,
} from "@/domain/llamaServer";
import { saveProjectMeta } from "@/domain/project/projectApi";
import { useLlamaServerStore } from "@/stores/llamaServerStore";

// `llama-server-provider` spec task 4.4: AI 設定画面の llama-server 用の欄
// (Requirements 2.1, 2.3, 2.6, 2.7, 2.8, 2.10, 5.7)。

const TEXT = ja.llamaServer;

const Q3 = "gemma-4-31B-it-Q3_K_M.gguf";
const Q5 = "gemma-4-31B-it-Q5_K_M.gguf";
// 一覧に無いファイル名のエントリ(フォルダから一時的に外したモデル)。
const GONE = "gone.gguf";

const FAILED: Extract<LlamaServerStatus, { state: "failed" }> = {
  state: "failed",
  runId: 1,
  reason: "exited",
  executablePath: "D:\\llama\\llama-server.exe",
  modelPath: `D:\\models\\${Q3}`,
  message: "",
  exitCode: 1,
};

const openMock = vi.mocked(open);
const readLogMock = vi.mocked(readLlamaServerLog);

// 本物と同じく、ストアの設定を同期で書き換える(保存の I/O だけを省く)。
const updatePreferences = vi.fn(
  async (patch: Partial<LlamaServerPreferences>): Promise<void> => {
    useLlamaServerStore.setState((state) => ({
      preferences: { ...state.preferences, ...patch },
    }));
  },
);
const refreshModels = vi.fn().mockResolvedValue(undefined);

function contextLabel(fileName: string): string {
  return `${TEXT.contextSize}: ${fileName}`;
}

function contextInput(fileName: string): HTMLInputElement {
  return screen.getByLabelText(contextLabel(fileName)) as HTMLInputElement;
}

async function renderSettings() {
  render(<LlamaServerSettings inputClass="" labelClass="" />);
  // マウント時の「サーバーの出力」の読み込みを済ませる。
  await act(async () => {});
}

async function change(element: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(element, { target: { value } });
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  updatePreferences.mockClear();
  refreshModels.mockClear();
  openMock.mockReset();
  readLogMock.mockReset();
  readLogMock.mockResolvedValue(["line 1", "line 2"]);
  vi.mocked(startLlamaServer).mockClear();
  vi.mocked(stopLlamaServer).mockClear();
  vi.mocked(saveProjectMeta).mockClear();
  useLlamaServerStore.setState({
    ...useLlamaServerStore.getInitialState(),
    preferences: {
      executablePath: "D:\\llama\\llama-server.exe",
      modelsDir: "D:\\models",
      extraArgs: ["--flash-attn"],
      selectedModel: Q3,
      models: { [Q3]: { contextSize: 8192 }, [GONE]: { contextSize: 4096 } },
    },
    models: [
      { fileName: Q3, sizeBytes: 1 },
      { fileName: Q5, sizeBytes: 2 },
    ],
    updatePreferences,
    refreshModels,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useLlamaServerStore.setState(useLlamaServerStore.getInitialState(), true);
});

describe("LlamaServerSettings の欄", () => {
  it("パス・フォルダ・読み直し・モデルごとのコンテキスト長・追加の引数・サーバーの出力が出る", async () => {
    await renderSettings();

    expect(
      (screen.getByLabelText(TEXT.executablePath) as HTMLInputElement).value,
    ).toBe("D:\\llama\\llama-server.exe");
    expect(
      (screen.getByLabelText(TEXT.modelsDir) as HTMLInputElement).value,
    ).toBe("D:\\models");
    expect(screen.getAllByRole("button", { name: TEXT.browse })).toHaveLength(2);
    expect(screen.getByRole("button", { name: TEXT.refreshModels })).toBeTruthy();
    expect(contextInput(Q3).value).toBe("8192");
    expect(contextInput(Q5).value).toBe("");
    expect(screen.queryByLabelText(contextLabel(GONE))).toBeNull();
    expect(
      (screen.getByLabelText(TEXT.extraArgs) as HTMLTextAreaElement).value,
    ).toBe("--flash-attn");
    expect(screen.getByText(TEXT.extraArgsHelp)).toBeTruthy();
    expect(screen.getByLabelText(TEXT.serverLog)).toBeTruthy();
  });

  it("モデルのファイル名は title でも読める", async () => {
    await renderSettings();
    expect(screen.getByTitle(Q3).textContent).toBe(Q3);
  });
});

describe("LlamaServerSettings の保存", () => {
  it("実行ファイルのパスは、入力から 1 秒後にアプリ側の設定に保存する", async () => {
    await renderSettings();
    await change(screen.getByLabelText(TEXT.executablePath), "E:\\bin\\llama-server.exe");

    await advance(999);
    expect(updatePreferences).not.toHaveBeenCalled();

    await advance(1);
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({
      executablePath: "E:\\bin\\llama-server.exe",
    });

    // 自分の保存でストアが変わっても、もう一度は保存しない。
    await advance(30_000);
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(saveProjectMeta).not.toHaveBeenCalled();
  });

  it("モデルのフォルダは、入力から 1 秒後にアプリ側の設定に保存する", async () => {
    await renderSettings();
    await change(screen.getByLabelText(TEXT.modelsDir), "E:\\gguf");
    await advance(1000);

    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({ modelsDir: "E:\\gguf" });
    expect(saveProjectMeta).not.toHaveBeenCalled();
  });

  it("何も操作しなければ保存しない", async () => {
    await renderSettings();
    await advance(30_000);
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it("設定を変えても、llama-server を起動も停止もしない", async () => {
    useLlamaServerStore.setState({
      status: {
        state: "ready",
        runId: 1,
        modelPath: `D:\\models\\${Q3}`,
        contextSize: 8192,
        port: 51234,
      },
    });
    await renderSettings();
    await change(screen.getByLabelText(TEXT.executablePath), "E:\\x.exe");
    await change(contextInput(Q3), "4096");
    await change(screen.getByLabelText(TEXT.extraArgs), "--threads\n8");
    await advance(1000);

    expect(updatePreferences).toHaveBeenCalled();
    expect(startLlamaServer).not.toHaveBeenCalled();
    expect(stopLlamaServer).not.toHaveBeenCalled();
  });

  it("追加の起動引数は、行ごとの配列で保存する(空行は捨てる)", async () => {
    await renderSettings();
    const textarea = screen.getByLabelText(TEXT.extraArgs) as HTMLTextAreaElement;
    await change(textarea, "--flash-attn\n\n  --threads  \n8\n");
    await advance(1000);

    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({
      extraArgs: ["--flash-attn", "--threads", "8"],
    });
    // 入力中の文字(末尾の改行や空行)は、保存のあとも書き換えない。
    expect(textarea.value).toBe("--flash-attn\n\n  --threads  \n8\n");
  });

  it("ストアの値が外から変わったら、欄に写す", async () => {
    await renderSettings();
    await act(async () => {
      useLlamaServerStore.setState((state) => ({
        preferences: {
          ...state.preferences,
          executablePath: "F:\\other.exe",
          modelsDir: "F:\\models",
          extraArgs: ["-ngl", "99"],
          models: { [Q5]: { contextSize: 2048 } },
        },
      }));
    });

    expect(
      (screen.getByLabelText(TEXT.executablePath) as HTMLInputElement).value,
    ).toBe("F:\\other.exe");
    expect(
      (screen.getByLabelText(TEXT.modelsDir) as HTMLInputElement).value,
    ).toBe("F:\\models");
    expect(
      (screen.getByLabelText(TEXT.extraArgs) as HTMLTextAreaElement).value,
    ).toBe("-ngl\n99");
    expect(contextInput(Q3).value).toBe("");
    expect(contextInput(Q5).value).toBe("2048");

    await advance(30_000);
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});

describe("LlamaServerSettings の「参照」", () => {
  it("実行ファイルはファイルを選び、選んだパスをすぐ保存する", async () => {
    openMock.mockResolvedValue("E:\\picked\\llama-server.exe");
    await renderSettings();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: TEXT.browse })[0]);
    });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0][0]).toMatchObject({ multiple: false });
    expect(openMock.mock.calls[0][0]?.directory ?? false).toBe(false);
    expect(updatePreferences).toHaveBeenCalledWith({
      executablePath: "E:\\picked\\llama-server.exe",
    });
    expect(
      (screen.getByLabelText(TEXT.executablePath) as HTMLInputElement).value,
    ).toBe("E:\\picked\\llama-server.exe");

    await advance(30_000);
    expect(updatePreferences).toHaveBeenCalledTimes(1);
  });

  it("モデルのフォルダはフォルダを選び、選んだパスをすぐ保存する", async () => {
    openMock.mockResolvedValue("E:\\picked");
    await renderSettings();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: TEXT.browse })[1]);
    });

    expect(openMock.mock.calls[0][0]).toMatchObject({
      directory: true,
      multiple: false,
    });
    expect(updatePreferences).toHaveBeenCalledWith({ modelsDir: "E:\\picked" });
    expect(
      (screen.getByLabelText(TEXT.modelsDir) as HTMLInputElement).value,
    ).toBe("E:\\picked");
  });

  it("選ばずに閉じたら保存しない", async () => {
    openMock.mockResolvedValue(null);
    await renderSettings();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: TEXT.browse })[0]);
    });
    await advance(30_000);
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});

describe("LlamaServerSettings のコンテキスト長", () => {
  it.each(["abc", "0", "1.5", "-1"])(
    "「%s」は保存せず、欄の下に誤りを出す",
    async (value) => {
      await renderSettings();
      expect(screen.queryByText(TEXT.contextSizeInvalid)).toBeNull();

      await change(contextInput(Q5), value);
      await advance(30_000);

      expect(updatePreferences).not.toHaveBeenCalled();
      const error = screen.getByText(TEXT.contextSizeInvalid);
      expect(error.id).not.toBe("");
      expect(contextInput(Q5).getAttribute("aria-describedby")).toBe(error.id);
      expect(contextInput(Q3).getAttribute("aria-describedby")).toBeNull();
      expect(contextInput(Q5).value).toBe(value);
      expect(useLlamaServerStore.getState().preferences.models).toEqual({
        [Q3]: { contextSize: 8192 },
        [GONE]: { contextSize: 4096 },
      });
    },
  );

  it("正の整数は保存し、ほかのモデルのエントリは消さない", async () => {
    await renderSettings();
    await change(contextInput(Q5), " 16384 ");
    await advance(1000);

    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({
      models: {
        [Q3]: { contextSize: 8192 },
        [GONE]: { contextSize: 4096 },
        [Q5]: { contextSize: 16384 },
      },
    });
    expect(screen.queryByText(TEXT.contextSizeInvalid)).toBeNull();
  });

  it("空欄にすると未設定になり(エントリを消す)、ほかのモデルのエントリは消さない", async () => {
    await renderSettings();
    await change(contextInput(Q3), "");
    await advance(1000);

    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(updatePreferences).toHaveBeenCalledWith({
      models: { [GONE]: { contextSize: 4096 } },
    });
    expect(contextInput(Q3).value).toBe("");
    expect(screen.queryByText(TEXT.contextSizeInvalid)).toBeNull();
  });

  it("Rust 側の u32 に収まらない値は保存せず、誤りを出す(上限ちょうどは保存する)", async () => {
    await renderSettings();
    await change(contextInput(Q5), "4294967296");
    await advance(30_000);
    expect(updatePreferences).not.toHaveBeenCalled();
    expect(screen.getByText(TEXT.contextSizeInvalid)).toBeTruthy();

    await change(contextInput(Q5), "4294967295");
    await advance(1000);
    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(
      useLlamaServerStore.getState().preferences.models[Q5],
    ).toEqual({ contextSize: 4294967295 });
    expect(screen.queryByText(TEXT.contextSizeInvalid)).toBeNull();
  });

  it("誤りのある欄があっても、ほかの欄の正しい値は保存する", async () => {
    await renderSettings();
    await change(contextInput(Q3), "abc");
    await change(contextInput(Q5), "4096");
    await advance(1000);

    expect(updatePreferences).toHaveBeenCalledWith({
      models: {
        [Q3]: { contextSize: 8192 },
        [GONE]: { contextSize: 4096 },
        [Q5]: { contextSize: 4096 },
      },
    });
    expect(contextInput(Q3).value).toBe("abc");
    expect(screen.getAllByText(TEXT.contextSizeInvalid)).toHaveLength(1);
  });
});

describe("LlamaServerSettings のモデルの一覧", () => {
  it("「一覧を読み直す」で一覧を作り直す", async () => {
    await renderSettings();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: TEXT.refreshModels }));
    });
    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it("フォルダを読めないときは、その旨を出す", async () => {
    useLlamaServerStore.setState({ models: [], modelsError: "アクセスが拒否されました" });
    await renderSettings();
    expect(
      screen.getByText(
        TEXT.modelsDirUnreadable.replace("{{message}}", "アクセスが拒否されました"),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(TEXT.modelsEmpty)).toBeNull();
  });

  it("フォルダが未設定なら、フォルダを指定するよう案内する", async () => {
    useLlamaServerStore.setState((state) => ({
      preferences: { ...state.preferences, modelsDir: "" },
      models: [],
      modelsError: null,
    }));
    await renderSettings();
    expect(screen.getByText(TEXT.modelsDirUnset)).toBeTruthy();
    expect(screen.queryByText(TEXT.modelsDirNoGguf)).toBeNull();
    expect(screen.queryByText(TEXT.modelsEmpty)).toBeNull();
  });

  it("フォルダが指定済みで gguf が無ければ、その旨を出す", async () => {
    useLlamaServerStore.setState({ models: [], modelsError: null });
    await renderSettings();
    expect(screen.getByText(TEXT.modelsDirNoGguf)).toBeTruthy();
    expect(screen.queryByText(TEXT.modelsDirUnset)).toBeNull();
    expect(screen.queryByText(TEXT.modelsEmpty)).toBeNull();
  });

  it("案内の出し分けは、入力中の値ではなく保存済みのフォルダで決める", async () => {
    useLlamaServerStore.setState({ models: [], modelsError: null });
    await renderSettings();
    await change(screen.getByLabelText(TEXT.modelsDir), "");
    expect(screen.getByText(TEXT.modelsDirNoGguf)).toBeTruthy();
  });
});

describe("LlamaServerSettings の「サーバーの出力」", () => {
  it("マウント時に 1 回読んで表示する", async () => {
    await renderSettings();
    expect(readLogMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(TEXT.serverLog).textContent).toBe("line 1\nline 2");
  });

  it("「更新」で読み直す", async () => {
    await renderSettings();
    readLogMock.mockResolvedValue(["line 1", "line 2", "line 3"]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: TEXT.serverLogRefresh }),
      );
    });

    expect(readLogMock).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(TEXT.serverLog).textContent).toBe(
      "line 1\nline 2\nline 3",
    );
  });

  it("状態が失敗になったら、自動で読み直す", async () => {
    await renderSettings();
    readLogMock.mockResolvedValue(["error: failed to load model"]);
    await act(async () => {
      useLlamaServerStore.setState({ status: FAILED });
    });

    expect(readLogMock).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(TEXT.serverLog).textContent).toBe(
      "error: failed to load model",
    );
  });

  it("読めなかったときは、その内容を出す", async () => {
    readLogMock.mockRejectedValue("read failed");
    await renderSettings();
    expect(screen.getByLabelText(TEXT.serverLog).textContent).toBe(
      TEXT.serverLogUnreadable.replace("{{message}}", "read failed"),
    );
  });
});

describe("LlamaServerSettings の失敗の説明", () => {
  const FAILURE_PREFIXES = [
    TEXT.failureSpawn.split("{{")[0],
    TEXT.failureExited.split("{{")[0],
  ];

  function failureLines(): HTMLElement[] {
    return FAILURE_PREFIXES.flatMap((prefix) =>
      screen.queryAllByText((content) => content.startsWith(prefix)),
    );
  }

  it("起動できなかったときは、OS のエラー文を添えて、サーバーの出力の上に出す", async () => {
    useLlamaServerStore.setState({
      status: {
        ...FAILED,
        reason: "spawn",
        message: "指定されたファイルが見つかりません。 (os error 2)",
        exitCode: null,
      },
    });
    await renderSettings();

    const line = screen.getByText(
      TEXT.failureSpawn.replace(
        "{{message}}",
        "指定されたファイルが見つかりません。 (os error 2)",
      ),
    );
    const log = screen.getByLabelText(TEXT.serverLog);
    expect(
      line.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(failureLines()).toHaveLength(1);
  });

  it("読み込みの途中で終了したときは、終了コードを添えて出す", async () => {
    useLlamaServerStore.setState({ status: { ...FAILED, exitCode: -1073741515 } });
    await renderSettings();

    expect(
      screen.getByText(TEXT.failureExited.replace("{{code}}", "-1073741515")),
    ).toBeTruthy();
    expect(failureLines()).toHaveLength(1);
  });

  it("終了コードが分からないときは「不明」を入れる", async () => {
    useLlamaServerStore.setState({ status: { ...FAILED, exitCode: null } });
    await renderSettings();

    expect(
      screen.getByText(
        TEXT.failureExited.replace("{{code}}", TEXT.exitCodeUnknown),
      ),
    ).toBeTruthy();
  });

  it("失敗でないときは出さない", async () => {
    await renderSettings();
    expect(failureLines()).toHaveLength(0);

    await act(async () => {
      useLlamaServerStore.setState({
        status: {
          state: "ready",
          runId: 2,
          modelPath: `D:\\models\\${Q3}`,
          contextSize: 8192,
          port: 51234,
        },
      });
    });
    expect(failureLines()).toHaveLength(0);
  });
});
