/**
 * `llama-server-provider` spec タスク 4.5: アプリの起動時に llamaServerStore を初期化する。
 *
 * App を StrictMode(`main.tsx` と同じ)で描画し、初期化が 1 回だけ呼ばれることと、
 * 起動の command が呼ばれないことを確かめる。ストアは本物を通し(初期化の呼び出しだけ数える)、
 * Rust の command とイベント(`@/domain/llamaServer` の API)を差し替える。
 * 重い子コンポーネント(ProjectView など)と Tauri の API は差し替える。
 *
 * App の初期化の印はモジュールのスコープにあるので、呼び出しの回数はファイルの全体で通して数える
 * (テストごとに消さない)。
 *
 * Requirements: 2.4, 2.5, 3.5, 4.1
 */

import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { GgufModel, LlamaServerStatus } from "@/domain/llamaServer";

const MODELS_DIR = "C:\\models";
const MODEL = "gemma.Q3_K_M.gguf";

const mocks = vi.hoisted(() => ({
  initLlamaServerStore: vi.fn<() => Promise<void>>(),
  readAppPreferences: vi.fn<() => Promise<string | null>>(),
  writeAppPreferences: vi.fn<(json: string) => Promise<void>>(),
  listGgufModels: vi.fn<(dir: string) => Promise<GgufModel[]>>(),
  startLlamaServer: vi.fn<() => Promise<LlamaServerStatus>>(),
  stopLlamaServer: vi.fn<() => Promise<LlamaServerStatus>>(),
  readLlamaServerStatus: vi.fn<() => Promise<LlamaServerStatus>>(),
  subscribeLlamaServerStatus: vi.fn<() => Promise<() => void>>(),
}));

vi.mock("@/stores/llamaServerStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/llamaServerStore")>();
  mocks.initLlamaServerStore.mockImplementation(actual.initLlamaServerStore);
  return { ...actual, initLlamaServerStore: mocks.initLlamaServerStore };
});

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

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/domain/project/projectApi", () => ({
  createProject: vi.fn(),
  isProjectRoot: vi.fn(),
  openProject: vi.fn(),
  pushRecentProject: vi.fn(),
  readRecentProjects: vi.fn().mockResolvedValue([]),
  removeRecentProject: vi.fn(),
}));
vi.mock("@/domain/project/settingsApi", () => ({
  refreshIncludedSettings: vi.fn(),
}));
vi.mock("@/domain/http", () => ({ nativeFetch: vi.fn() }));
vi.mock("@/lib/devLog", () => ({ emitDevEvent: vi.fn() }));
vi.mock("@/editor/globalKeymap", () => ({ useGlobalKeymap: vi.fn() }));
vi.mock("@/components/welcome/WelcomeScreen", () => ({
  WelcomeScreen: () => <div data-testid="welcome" />,
}));
vi.mock("@/components/welcome/NewProjectDialog", () => ({
  NewProjectDialog: () => null,
}));
vi.mock("@/components/project/ProjectView", () => ({
  ProjectView: () => <div data-testid="project-view" />,
}));

import App from "@/App";
import { useLlamaServerStore } from "@/stores/llamaServerStore";

// 起動に要る設定(実行ファイル・フォルダ・いま使うモデル・コンテキスト長)がすべて揃っている。
// それでも、アプリの起動だけでは `llama-server` を起動しないことを確かめるため。
const PREFERENCES_JSON = JSON.stringify({
  llamaServer: {
    executablePath: "C:\\bin\\llama-server.exe",
    modelsDir: MODELS_DIR,
    selectedModel: MODEL,
    contextSizes: { [MODEL]: 8192 },
    extraArgs: [],
  },
});

const INITIAL_STATUS: LlamaServerStatus = {
  state: "stopped",
  runId: 0,
  cause: "initial",
  exitCode: null,
};

mocks.readAppPreferences.mockResolvedValue(PREFERENCES_JSON);
mocks.writeAppPreferences.mockResolvedValue(undefined);
mocks.listGgufModels.mockResolvedValue([{ fileName: MODEL, sizeBytes: 1 }]);
mocks.readLlamaServerStatus.mockResolvedValue(INITIAL_STATUS);
mocks.subscribeLlamaServerStatus.mockResolvedValue(() => {});

function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

afterEach(() => {
  cleanup();
});

describe("App: llama-server のストアの初期化(タスク 4.5)", () => {
  it("アプリの起動で初期化を 1 回だけ呼び、llama-server は起動しない", async () => {
    renderApp();

    expect(screen.getByTestId("welcome")).toBeTruthy();
    // 初期化が最後まで走った(今の状態を読んだ)ことを待つ。
    await waitFor(() => {
      expect(mocks.readLlamaServerStatus).toHaveBeenCalledTimes(1);
    });

    expect(mocks.initLlamaServerStore).toHaveBeenCalledTimes(1);
    expect(mocks.readAppPreferences).toHaveBeenCalledTimes(1);
    expect(mocks.listGgufModels).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeLlamaServerStatus).toHaveBeenCalledTimes(1);
    // 設定はアプリ側のものなので、プロジェクトを開いていなくても読み込まれている。
    expect(useLlamaServerStore.getState().preferences.selectedModel).toBe(MODEL);
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
    expect(mocks.writeAppPreferences).not.toHaveBeenCalled();
  });

  it("App を描画し直しても、初期化を呼び直さない", async () => {
    renderApp();
    await screen.findByTestId("welcome");
    // 呼び直していれば届くはずの時間を置く。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.initLlamaServerStore).toHaveBeenCalledTimes(1);
    expect(mocks.readAppPreferences).toHaveBeenCalledTimes(1);
    expect(mocks.startLlamaServer).not.toHaveBeenCalled();
  });
});
