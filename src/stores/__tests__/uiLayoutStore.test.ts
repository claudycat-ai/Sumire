import { beforeEach, describe, expect, it, vi } from "vitest";

// テストの実行環境によっては `localStorage` が使えない(Node 本体のグローバルが jsdom の
// ものを隠し、値が undefined になる)。zustand の persist はストアを作るときに保存先を
// つかむので、ストアの import より前にメモリ上の保存先へ差し替える。
const storage = vi.hoisted(() => {
  const items = new Map<string, string>();
  const memoryStorage = {
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
  };
  vi.stubGlobal("localStorage", memoryStorage);
  return memoryStorage;
});

import { useUILayoutStore } from "@/stores/uiLayoutStore";

// `llama-server-provider` spec task 1.1: 左ペインの展開状態(`llmProviderExpanded`)の
// 既定値と、プロバイダの種別が増える前に保存された値の読み込み。

const STORAGE_KEY = "sumire-ui-layout";

beforeEach(() => {
  useUILayoutStore.setState(useUILayoutStore.getInitialState(), true);
  storage.clear();
});

describe("llmProviderExpanded", () => {
  it("既定値は 3 つのプロバイダをすべて展開する", () => {
    expect(useUILayoutStore.getState().llmProviderExpanded).toEqual({
      "openai-compatible": true,
      openai: true,
      "llama-server": true,
    });
  });

  it("保存済みの値に llama-server のキーが無くても、既定値で補い、保存済みの値は保つ", async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          llmSwitcherExpanded: false,
          llmProviderExpanded: { "openai-compatible": false, openai: true },
        },
        version: 1,
      }),
    );

    await useUILayoutStore.persist.rehydrate();

    const state = useUILayoutStore.getState();
    expect(state.llmProviderExpanded).toEqual({
      "openai-compatible": false,
      openai: true,
      "llama-server": true,
    });
    expect(state.llmSwitcherExpanded).toBe(false);
  });

  it("保存済みの llama-server の値は、既定値で上書きしない", async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          llmProviderExpanded: {
            "openai-compatible": true,
            openai: true,
            "llama-server": false,
          },
        },
        version: 1,
      }),
    );

    await useUILayoutStore.persist.rehydrate();

    expect(
      useUILayoutStore.getState().llmProviderExpanded["llama-server"],
    ).toBe(false);
  });

  it("llama-server の展開を切り替えられる", () => {
    useUILayoutStore.getState().toggleLLMProvider("llama-server");

    expect(useUILayoutStore.getState().llmProviderExpanded).toEqual({
      "openai-compatible": true,
      openai: true,
      "llama-server": false,
    });
  });
});
