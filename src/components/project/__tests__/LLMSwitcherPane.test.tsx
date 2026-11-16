import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

// この環境の vitest では `localStorage` が undefined。展開の状態(persist 付きの uiLayoutStore)を
// 書き換えるので、ストアの import より前にメモリ上の保存先へ差し替える
// (`src/stores/__tests__/uiLayoutStore.test.ts` と同じ)。
vi.hoisted(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  });
});

vi.mock("@/domain/project/projectApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/domain/project/projectApi")>();
  return {
    ...actual,
    saveProjectMeta: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/domain/secrets", () => ({
  SecretStore: {
    hasSecret: vi.fn().mockResolvedValue(true),
    setSecret: vi.fn().mockResolvedValue(undefined),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
  },
}));

import ja from "@/i18n/locales/ja.json";
import en from "@/i18n/locales/en.json";
import { LLMSwitcherPane } from "@/components/project/LLMSwitcherPane";
import { DEFAULT_AI_CONFIG_BUNDLE } from "@/domain/providers/types";
import type { SumireProjectMeta } from "@/domain/project/types";
import { saveProjectMeta } from "@/domain/project/projectApi";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { useAppStore } from "@/stores/appStore";
import { useLlamaServerStore } from "@/stores/llamaServerStore";
import { useUILayoutStore } from "@/stores/uiLayoutStore";

// `llama-server-provider` spec task 1.1: 左ペインの LLM 切り替えに llama-server の行が並び、
// 「現在使うプロバイダ」として選べること(Requirements 1.1, 1.2)。

const mockSaveProjectMeta = saveProjectMeta as unknown as ReturnType<
  typeof vi.fn
>;

const LLAMA_SERVER_NAME_JA = "llama.cpp(Sumire が起動)";
const LLAMA_SERVER_NAME_EN = "llama.cpp (started by Sumire)";

// 展開したときの読み直しが、テストで入れた一覧を上書きしないようにする
// (本物は、フォルダが未設定なら一覧を空にする)。
const refreshModels = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  mockSaveProjectMeta.mockClear();
  refreshModels.mockClear();
  useLlamaServerStore.setState({ refreshModels });
  useAppStore.setState({
    currentProject: { path: "/test/project", title: "T" },
  });
  const bundle = structuredClone(DEFAULT_AI_CONFIG_BUNDLE);
  useAIConfigStore.setState({
    bundle,
    currentMeta: {
      schemaVersion: "1.0",
      title: "T",
      author: "A",
      created: "2026-01-01",
      aiConfig: bundle,
    } as unknown as SumireProjectMeta,
  });
});

afterEach(() => {
  cleanup();
});

describe("LLMSwitcherPane の llama-server の行", () => {
  it("OpenAI 互換・OpenAI のあとに、llama-server を画面での名前で並べる(1.1)", () => {
    render(<LLMSwitcherPane />);

    const rows = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("OpenAI 互換");
    expect(rows[1]).toContain("OpenAI");
    expect(rows[2]).toContain(LLAMA_SERVER_NAME_JA);
  });

  it("llama-server の左のスイッチで、現在使うプロバイダとして選び、保存する(1.2)", async () => {
    render(<LLMSwitcherPane />);

    const row = screen.getAllByRole("listitem")[2];
    const activate = row?.querySelector("button[aria-pressed]");
    expect(activate).toBeTruthy();
    fireEvent.click(activate as Element);

    await vi.waitFor(() => {
      expect(mockSaveProjectMeta).toHaveBeenCalledTimes(1);
    });
    expect(useAIConfigStore.getState().bundle?.activeProvider).toBe(
      "llama-server",
    );
    const [, saved] = mockSaveProjectMeta.mock.calls[0] as [
      string,
      { aiConfig: { activeProvider: string } },
    ];
    expect(saved.aiConfig.activeProvider).toBe("llama-server");
  });
});

// task 4.3: llama-server の行の件数と、展開した中身(Requirements 1.1, 3.1)。
describe("LLMSwitcherPane の llama-server の行の件数と中身", () => {
  afterEach(() => {
    useLlamaServerStore.setState(useLlamaServerStore.getInitialState(), true);
  });

  it("llama-server の行の件数は、モデルの一覧の数にする", () => {
    useLlamaServerStore.setState({
      models: [
        { fileName: "a.gguf", sizeBytes: 1 },
        { fileName: "b.gguf", sizeBytes: 2 },
        { fileName: "c.gguf", sizeBytes: 3 },
      ],
    });
    render(<LLMSwitcherPane />);

    const rows = screen.getAllByRole("listitem");
    expect(rows[2]?.textContent).toContain(`${LLAMA_SERVER_NAME_JA}(3)`);
  });

  it("一覧が空なら、llama-server の行の件数は 0 にする", () => {
    render(<LLMSwitcherPane />);

    const rows = screen.getAllByRole("listitem");
    expect(rows[2]?.textContent).toContain(`${LLAMA_SERVER_NAME_JA}(0)`);
  });

  it("llama-server の行を展開した中身は、状態とモデルの一覧にする", () => {
    useLlamaServerStore.setState({
      models: [{ fileName: "a.gguf", sizeBytes: 1 }],
    });
    render(<LLMSwitcherPane />);

    const row = screen.getAllByRole("listitem")[2] as HTMLElement;
    expect(row.textContent).toContain(ja.llamaServer.stateStopped);
    expect(within(row).getByTitle("a.gguf")).toBeTruthy();
  });

  it("OpenAI 互換・OpenAI の行は、件数 1 と登録モデル名のまま", () => {
    useLlamaServerStore.setState({
      models: [
        { fileName: "a.gguf", sizeBytes: 1 },
        { fileName: "b.gguf", sizeBytes: 2 },
      ],
    });
    render(<LLMSwitcherPane />);

    const rows = screen.getAllByRole("listitem");
    const providers = DEFAULT_AI_CONFIG_BUNDLE.providers;
    expect(rows[0]?.textContent).toBe(
      `○▾OpenAI 互換(1)${providers["openai-compatible"].model}`,
    );
    expect(rows[1]?.textContent).toBe(`○▾OpenAI(1)${providers.openai.model}`);
    expect(rows[0]?.textContent).not.toContain(ja.llamaServer.stateStopped);
    expect(rows[1]?.textContent).not.toContain(ja.llamaServer.stateStopped);
  });
});

// 統合検証の指摘 I-1: 行を展開したときに、モデルの一覧を読み直す(Requirements 3.1, 3.7)。
describe("LLMSwitcherPane の llama-server の一覧の読み直し", () => {
  const initialExpanded = useUILayoutStore.getState().llmProviderExpanded;

  afterEach(() => {
    useUILayoutStore.setState({ llmProviderExpanded: initialExpanded });
    useLlamaServerStore.setState(useLlamaServerStore.getInitialState(), true);
  });

  function llamaServerToggle(label: string): HTMLElement {
    const row = screen.getAllByRole("listitem")[2] as HTMLElement;
    return within(row).getByLabelText(label);
  }

  it("展開された状態でマウントされたら、1 回だけ読み直す", () => {
    const { rerender } = render(<LLMSwitcherPane />);
    rerender(<LLMSwitcherPane />);

    expect(refreshModels).toHaveBeenCalledTimes(1);
  });

  it("畳まれている間は読み直さず、展開したときに 1 回読み直す", () => {
    useUILayoutStore.setState({
      llmProviderExpanded: { ...initialExpanded, "llama-server": false },
    });
    render(<LLMSwitcherPane />);
    expect(refreshModels).not.toHaveBeenCalled();

    fireEvent.click(llamaServerToggle(ja.aiProvider.expandModels));
    expect(refreshModels).toHaveBeenCalledTimes(1);

    fireEvent.click(llamaServerToggle(ja.aiProvider.collapseModels));
    expect(refreshModels).toHaveBeenCalledTimes(1);

    fireEvent.click(llamaServerToggle(ja.aiProvider.expandModels));
    expect(refreshModels).toHaveBeenCalledTimes(2);
  });
});

describe("llama-server の画面での名前", () => {
  it("ja と en の両方にある", () => {
    const jaNames: Record<string, string> = ja.aiProvider;
    const enNames: Record<string, string> = en.aiProvider;
    expect(jaNames["llama-server"]).toBe(LLAMA_SERVER_NAME_JA);
    expect(enNames["llama-server"]).toBe(LLAMA_SERVER_NAME_EN);
  });
});
