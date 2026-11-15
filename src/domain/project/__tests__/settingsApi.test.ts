import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `settingsApi.refreshIncludedSettings` は filesApi (Tauri command ラッパ) を経由して
// プロジェクトの設定ファイル一覧を読み出す。テストでは vi.mock で filesApi を差し替え、
// in-memory な仮ファイルシステム + listProjectFiles 結果で擬似する。
//
// 仮想 FS は `(projectPath, relativePath) -> content` のマップ。
// listProjectFiles は (projectPath, category) -> FileEntry[] のマップを返す。

const hoisted = vi.hoisted(() => {
  const fakeFs = new Map<string, string>();
  // (projectPath, category) -> FileEntry[]
  const fakeListing = new Map<
    string,
    Array<{ relativePath: string; name: string }>
  >();
  const fsKey = (projectPath: string, relativePath: string): string =>
    `${projectPath}::${relativePath}`;
  const listKey = (projectPath: string, category: string): string =>
    `${projectPath}##${category}`;
  return { fakeFs, fakeListing, fsKey, listKey };
});

vi.mock("@/domain/project/filesApi", async () => {
  // CATEGORY_ORDER / categoryKind / 型は実装をそのまま使うため、
  // 元モジュールを取り出してから一部 export を上書きする。
  const actual =
    await vi.importActual<typeof import("@/domain/project/filesApi")>(
      "@/domain/project/filesApi",
    );
  return {
    ...actual,
    listProjectFiles: vi.fn(
      async (
        projectPath: string,
        category: string,
      ): Promise<Array<{ relativePath: string; name: string }>> => {
        return hoisted.fakeListing.get(hoisted.listKey(projectPath, category)) ?? [];
      },
    ),
    readFileText: vi.fn(
      async (projectPath: string, relativePath: string): Promise<string> => {
        const key = hoisted.fsKey(projectPath, relativePath);
        const v = hoisted.fakeFs.get(key);
        if (v === undefined) {
          throw new Error(`fake fs: not found ${key}`);
        }
        return v;
      },
    ),
    writeFileText: vi.fn(
      async (
        projectPath: string,
        relativePath: string,
        content: string,
      ): Promise<void> => {
        hoisted.fakeFs.set(hoisted.fsKey(projectPath, relativePath), content);
      },
    ),
  };
});

const { fakeFs, fakeListing, fsKey, listKey } = hoisted;

import {
  refreshIncludedSettings,
  setIncludeInContext,
  syncIncludedBody,
} from "@/domain/project/settingsApi";
import { getBoolean, parseFile } from "@/domain/project/frontmatter";
import { useSettingsContextStore } from "@/stores/settingsContextStore";

const PROJECT_PATH = "/fake/project";

const buildContent = (opts: {
  title: string;
  includeInContext: boolean;
  archived?: boolean;
  body?: string;
}): string => {
  const lines = ["---", `title: ${opts.title}`, `includeInContext: ${opts.includeInContext}`];
  if (opts.archived !== undefined) {
    lines.push(`archived: ${opts.archived}`);
  }
  lines.push("---", opts.body ?? "本文");
  return lines.join("\n");
};

beforeEach(() => {
  fakeFs.clear();
  fakeListing.clear();
  useSettingsContextStore.getState().clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("settingsApi.refreshIncludedSettings (archived 流入除外)", () => {
  it("archived: true + includeInContext: true のファイルは store に流入しない", async () => {
    const rel = "characters/archived-on.md";
    fakeListing.set(listKey(PROJECT_PATH, "characters"), [
      { relativePath: rel, name: "archived-on.md" },
    ]);
    fakeFs.set(
      fsKey(PROJECT_PATH, rel),
      buildContent({ title: "アーカイブ済み", includeInContext: true, archived: true }),
    );

    await refreshIncludedSettings(PROJECT_PATH);

    expect(useSettingsContextStore.getState().files.has(rel)).toBe(false);
  });

  it("archived: false + includeInContext: true のファイルは store に流入する", async () => {
    const rel = "characters/active.md";
    fakeListing.set(listKey(PROJECT_PATH, "characters"), [
      { relativePath: rel, name: "active.md" },
    ]);
    fakeFs.set(
      fsKey(PROJECT_PATH, rel),
      buildContent({ title: "アクティブ", includeInContext: true, archived: false }),
    );

    await refreshIncludedSettings(PROJECT_PATH);

    const file = useSettingsContextStore.getState().files.get(rel);
    expect(file).toBeDefined();
    expect(file?.title).toBe("アクティブ");
  });

  it("archived: true + includeInContext: false のファイルも store に流入しない(優先順位確認)", async () => {
    const rel = "characters/archived-off.md";
    fakeListing.set(listKey(PROJECT_PATH, "characters"), [
      { relativePath: rel, name: "archived-off.md" },
    ]);
    fakeFs.set(
      fsKey(PROJECT_PATH, rel),
      buildContent({ title: "両方 false", includeInContext: false, archived: true }),
    );

    await refreshIncludedSettings(PROJECT_PATH);

    expect(useSettingsContextStore.getState().files.has(rel)).toBe(false);
  });
});

describe("settingsApi.setIncludeInContext (archived ガード)", () => {
  it("archived: true のファイルに setIncludeInContext(_, _, _, true) を呼んでも store には投入されない", async () => {
    const rel = "characters/archived-toggle.md";
    fakeFs.set(
      fsKey(PROJECT_PATH, rel),
      buildContent({
        title: "アーカイブ済み",
        includeInContext: false,
        archived: true,
      }),
    );

    await setIncludeInContext(PROJECT_PATH, "characters", rel, true);

    // frontmatter は書き換えられている(将来の archived 解除時のため)
    const after = fakeFs.get(fsKey(PROJECT_PATH, rel));
    expect(after).toBeDefined();
    const parsed = parseFile(after as string);
    expect(getBoolean(parsed.frontmatter, "includeInContext")).toBe(true);
    expect(getBoolean(parsed.frontmatter, "archived")).toBe(true);

    // しかし store には投入されない
    expect(useSettingsContextStore.getState().files.has(rel)).toBe(false);
  });

  it("archived: false のファイルに setIncludeInContext(_, _, _, true) を呼ぶと store に投入される(回帰確認)", async () => {
    const rel = "characters/active-toggle.md";
    fakeFs.set(
      fsKey(PROJECT_PATH, rel),
      buildContent({
        title: "アクティブ",
        includeInContext: false,
        archived: false,
      }),
    );

    await setIncludeInContext(PROJECT_PATH, "characters", rel, true);

    const file = useSettingsContextStore.getState().files.get(rel);
    expect(file).toBeDefined();
    expect(file?.title).toBe("アクティブ");
  });
});

describe("settingsApi.syncIncludedBody (archived ガード)", () => {
  it("archived: true + includeInContext: true の content を渡しても store には投入されない", () => {
    const rel = "characters/archived-sync.md";
    const text = buildContent({
      title: "アーカイブ済み(同期)",
      includeInContext: true,
      archived: true,
      body: "新しい本文",
    });

    syncIncludedBody(rel, "characters", text);

    expect(useSettingsContextStore.getState().files.has(rel)).toBe(false);
  });

  it("archived: false + includeInContext: true の content を渡すと store に投入される(回帰確認)", () => {
    const rel = "characters/active-sync.md";
    const text = buildContent({
      title: "アクティブ(同期)",
      includeInContext: true,
      archived: false,
      body: "新しい本文",
    });

    syncIncludedBody(rel, "characters", text);

    const file = useSettingsContextStore.getState().files.get(rel);
    expect(file).toBeDefined();
    expect(file?.title).toBe("アクティブ(同期)");
  });
});
