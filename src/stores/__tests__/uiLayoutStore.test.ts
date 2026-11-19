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

// `file-tree-placement` spec task 1.1: ファイル一覧の配置(左・右)の既定値・切り替え・保存と、
// 保存データの読み込みでの正規化。

function savedLayout(): { state: Record<string, unknown>; version: number } {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw == null) throw new Error("保存データが無い");
  return JSON.parse(raw);
}

describe("fileTreePlacement", () => {
  it("既定値は左", () => {
    expect(useUILayoutStore.getState().fileTreePlacement).toBe("left");
  });

  it("切り替えると左 → 右 → 左になり、そのたびに保存先に書かれる", () => {
    useUILayoutStore.getState().toggleFileTreePlacement();
    expect(useUILayoutStore.getState().fileTreePlacement).toBe("right");
    expect(savedLayout().state.fileTreePlacement).toBe("right");

    useUILayoutStore.getState().toggleFileTreePlacement();
    expect(useUILayoutStore.getState().fileTreePlacement).toBe("left");
    expect(savedLayout().state.fileTreePlacement).toBe("left");
  });

  it("保存データの版は 1 のまま", () => {
    useUILayoutStore.getState().toggleFileTreePlacement();

    expect(savedLayout().version).toBe(1);
  });

  it("配置のキーが無い保存データ(本機能より前の形)を読むと左で、ほかの値は保存データのまま", async () => {
    useUILayoutStore.setState({ fileTreePlacement: "right" });
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          chapterGroupLayout: { editor: 60, right: 40 },
          rightColumnLayout: { memo: 30, settings: 70 },
          fileTreeCategoryExpanded: {
            chapters: false,
            characters: true,
            worldbuilding: false,
            glossary: true,
            plot: false,
          },
          fileTreeArchivedExpanded: {
            chapters: true,
            characters: false,
            worldbuilding: false,
            glossary: false,
            plot: false,
          },
          llmSwitcherExpanded: false,
          historyPaneExpanded: false,
        },
        version: 1,
      }),
    );

    await useUILayoutStore.persist.rehydrate();

    const state = useUILayoutStore.getState();
    expect(state.fileTreePlacement).toBe("left");
    expect(state.chapterGroupLayout).toEqual({ editor: 60, right: 40 });
    expect(state.rightColumnLayout).toEqual({ memo: 30, settings: 70 });
    expect(state.fileTreeCategoryExpanded).toEqual({
      chapters: false,
      characters: true,
      worldbuilding: false,
      glossary: true,
      plot: false,
    });
    expect(state.fileTreeArchivedExpanded.chapters).toBe(true);
    expect(state.llmSwitcherExpanded).toBe(false);
    expect(state.historyPaneExpanded).toBe(false);
  });

  it("保存データの配置が右なら右で読み込む", async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { fileTreePlacement: "right" }, version: 1 }),
    );

    await useUILayoutStore.persist.rehydrate();

    expect(useUILayoutStore.getState().fileTreePlacement).toBe("right");
  });

  it.each([["top"], [""], [null], [1], [{ side: "right" }]])(
    "保存データの配置が壊れた値(%j)なら左で読み込む",
    async (broken) => {
      useUILayoutStore.setState({ fileTreePlacement: "right" });
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: { fileTreePlacement: broken }, version: 1 }),
      );

      await useUILayoutStore.persist.rehydrate();

      expect(useUILayoutStore.getState().fileTreePlacement).toBe("left");
    },
  );
});
