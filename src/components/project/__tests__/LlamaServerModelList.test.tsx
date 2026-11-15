import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import ja from "@/i18n/locales/ja.json";
import { LlamaServerModelList } from "@/components/project/LlamaServerModelList";
import type {
  LlamaServerPreferences,
  LlamaServerStatus,
} from "@/domain/llamaServer";
import { useLlamaServerStore } from "@/stores/llamaServerStore";

// `llama-server-provider` spec task 4.3: 左ペインの llama-server の行を展開した中身
// (状態の 1 行、停止、モデルの一覧。Requirements 3.1, 5.1, 6.5)。

const TEXT = ja.llamaServer;

const Q3 = "gemma-4-31B-it-Q3_K_M.gguf";
const Q5 = "gemma-4-31B-it-Q5_K_M.gguf";
const MODEL_PATH = `D:\\models\\${Q3}`;

const STATUSES: Record<LlamaServerStatus["state"], LlamaServerStatus> = {
  stopped: { state: "stopped", runId: 0, cause: "initial", exitCode: null },
  loading: {
    state: "loading",
    runId: 1,
    modelPath: MODEL_PATH,
    contextSize: 8192,
    port: 51234,
  },
  ready: {
    state: "ready",
    runId: 1,
    modelPath: MODEL_PATH,
    contextSize: 8192,
    port: 51234,
  },
  failed: {
    state: "failed",
    runId: 1,
    reason: "exited",
    executablePath: "D:\\llama\\llama-server.exe",
    modelPath: MODEL_PATH,
    message: "",
    exitCode: 1,
  },
};

const selectModel = vi.fn().mockResolvedValue(undefined);
const stop = vi.fn().mockResolvedValue(undefined);
// マウント時の読み直しが、テストで入れた一覧を(Tauri の無い環境の失敗で)上書きしないようにする。
const refreshModels = vi.fn().mockResolvedValue(undefined);

function preferences(
  patch: Partial<LlamaServerPreferences> = {},
): LlamaServerPreferences {
  return {
    ...useLlamaServerStore.getInitialState().preferences,
    modelsDir: "D:\\models",
    selectedModel: Q3,
    models: { [Q3]: { contextSize: 8192 } },
    ...patch,
  };
}

beforeEach(() => {
  selectModel.mockClear();
  stop.mockClear();
  refreshModels.mockClear();
  useLlamaServerStore.setState({
    ...useLlamaServerStore.getInitialState(),
    preferences: preferences(),
    models: [
      { fileName: Q3, sizeBytes: 1 },
      { fileName: Q5, sizeBytes: 2 },
    ],
    selectModel,
    stop,
    refreshModels,
  });
});

afterEach(() => {
  cleanup();
  useLlamaServerStore.setState(useLlamaServerStore.getInitialState(), true);
});

function modelButton(fileName: string): HTMLElement {
  return screen.getByTitle(fileName).closest("button") as HTMLElement;
}

describe("LlamaServerModelList の状態の 1 行(5.1)", () => {
  it.each([
    ["stopped", TEXT.stateStopped],
    ["loading", TEXT.stateLoading],
    ["ready", TEXT.stateReady],
    ["failed", TEXT.stateFailed],
  ] as const)("%s のとき、その状態の文言を出す", (state, text) => {
    useLlamaServerStore.setState({ status: STATUSES[state] });
    render(<LlamaServerModelList />);

    expect(screen.getByText(text)).toBeTruthy();
    for (const other of [
      TEXT.stateStopped,
      TEXT.stateLoading,
      TEXT.stateReady,
      TEXT.stateFailed,
    ]) {
      if (other !== text) expect(screen.queryByText(other)).toBeNull();
    }
  });
});

describe("LlamaServerModelList の停止(6.5)", () => {
  it.each(["loading", "ready"] as const)(
    "%s のとき「停止」が出て、押すと停止を呼ぶ",
    (state) => {
      useLlamaServerStore.setState({ status: STATUSES[state] });
      render(<LlamaServerModelList />);

      fireEvent.click(screen.getByRole("button", { name: TEXT.stop }));

      expect(stop).toHaveBeenCalledTimes(1);
      // trigger は渡さない(ストアの既定の "user" になる)。
      expect(stop.mock.calls[0]).toEqual([]);
    },
  );

  it.each(["stopped", "failed"] as const)(
    "%s のとき「停止」を出さない",
    (state) => {
      useLlamaServerStore.setState({ status: STATUSES[state] });
      render(<LlamaServerModelList />);

      expect(screen.queryByRole("button", { name: TEXT.stop })).toBeNull();
    },
  );
});

describe("LlamaServerModelList のモデルの一覧(3.1)", () => {
  it("モデルのファイル名を一覧の順に並べる", () => {
    render(<LlamaServerModelList />);

    const names = screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector("[title]")?.getAttribute("title"));
    expect(names).toEqual([Q3, Q5]);
  });

  it("いま使うモデルにだけ印を付ける", () => {
    render(<LlamaServerModelList />);

    const selected = modelButton(Q3);
    const other = modelButton(Q5);
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.textContent).toContain("●");
    expect(other.getAttribute("aria-pressed")).toBe("false");
    expect(other.textContent).toContain("○");
    expect(other.textContent).not.toContain("●");
  });

  it("モデルが選ばれていなければ、どれにも印を付けない", () => {
    useLlamaServerStore.setState({
      preferences: preferences({ selectedModel: null }),
    });
    render(<LlamaServerModelList />);

    expect(modelButton(Q3).getAttribute("aria-pressed")).toBe("false");
    expect(modelButton(Q5).getAttribute("aria-pressed")).toBe("false");
  });

  it("モデルをクリックすると、そのファイル名で選択を呼ぶ", () => {
    render(<LlamaServerModelList />);

    fireEvent.click(modelButton(Q5));

    expect(selectModel).toHaveBeenCalledTimes(1);
    expect(selectModel).toHaveBeenCalledWith(Q5);
  });

  it("コンテキスト長が未設定のモデルにだけ、その旨を添える", () => {
    render(<LlamaServerModelList />);

    expect(modelButton(Q3).textContent).not.toContain(TEXT.contextSizeUnset);
    expect(modelButton(Q5).textContent).toContain(TEXT.contextSizeUnset);
  });

  it("継承したプロパティの名前のモデルも、コンテキスト長が未設定として扱う", () => {
    useLlamaServerStore.setState({
      models: [{ fileName: "constructor", sizeBytes: 1 }],
    });
    render(<LlamaServerModelList />);

    expect(modelButton("constructor").textContent).toContain(
      TEXT.contextSizeUnset,
    );
  });

  it("フォルダが未設定で一覧が空のとき、AI 設定画面でフォルダを指すよう案内する", () => {
    useLlamaServerStore.setState({
      preferences: preferences({ modelsDir: "" }),
      models: [],
    });
    render(<LlamaServerModelList />);

    expect(screen.getByText(TEXT.modelsEmpty)).toBeTruthy();
    expect(screen.queryByText(TEXT.modelsDirNoGguf)).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("フォルダが指定済みで gguf が無いとき、その旨を出す", () => {
    useLlamaServerStore.setState({ models: [] });
    render(<LlamaServerModelList />);

    expect(screen.getByText(TEXT.modelsDirNoGguf)).toBeTruthy();
    expect(screen.queryByText(TEXT.modelsEmpty)).toBeNull();
  });

  it("フォルダを読めないとき、その旨を出す", () => {
    useLlamaServerStore.setState({
      models: [],
      modelsError: "アクセスが拒否されました",
    });
    render(<LlamaServerModelList />);

    expect(
      screen.getByText(
        TEXT.modelsDirUnreadable.replace("{{message}}", "アクセスが拒否されました"),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(TEXT.modelsEmpty)).toBeNull();
    expect(screen.queryByText(TEXT.modelsDirNoGguf)).toBeNull();
  });

  it("一覧があるとき、案内を出さない", () => {
    render(<LlamaServerModelList />);

    expect(screen.queryByText(TEXT.modelsEmpty)).toBeNull();
    expect(screen.queryByText(TEXT.modelsDirNoGguf)).toBeNull();
  });
});

describe("LlamaServerModelList の一覧の読み直し", () => {
  it("マウントしたとき(行を展開したとき)に 1 回だけ読み直し、描画のたびには呼ばない", () => {
    const { rerender } = render(<LlamaServerModelList />);
    expect(refreshModels).toHaveBeenCalledTimes(1);

    rerender(<LlamaServerModelList />);
    act(() => {
      useLlamaServerStore.setState({ status: STATUSES.loading });
      useLlamaServerStore.setState({ models: [{ fileName: Q3, sizeBytes: 1 }] });
    });

    expect(refreshModels).toHaveBeenCalledTimes(1);
  });
});
