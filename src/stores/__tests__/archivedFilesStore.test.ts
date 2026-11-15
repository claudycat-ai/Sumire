import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `archivedFilesStore` は filesApi (Tauri command ラッパ) を経由して
// プロジェクト全体の Markdown ファイルをスキャンし、frontmatter の
// archived キーが true のものを Set<relativePath> として保持する。
//
// テストでは vi.mock で filesApi を差し替え、in-memory な仮 FS で
// listProjectFiles / readFileText を擬似する。

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
  };
});

const { fakeFs, fakeListing, fsKey, listKey } = hoisted;

import {
  refreshArchivedFiles,
  useArchivedFilesStore,
} from "@/stores/archivedFilesStore";

const PROJECT_PATH = "/fake/project";

const buildContent = (opts: {
  title: string;
  archived?: boolean;
  body?: string;
}): string => {
  const lines = ["---", `title: ${opts.title}`];
  if (opts.archived !== undefined) {
    lines.push(`archived: ${opts.archived}`);
  }
  lines.push("---", opts.body ?? "本文");
  return lines.join("\n");
};

beforeEach(() => {
  fakeFs.clear();
  fakeListing.clear();
  useArchivedFilesStore.getState().clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("archivedFilesStore.refreshArchivedFiles", () => {
  it("archived: true のファイルだけが Set に入る", async () => {
    fakeListing.set(listKey(PROJECT_PATH, "characters"), [
      { relativePath: "characters/active.md", name: "active.md" },
      { relativePath: "characters/archived.md", name: "archived.md" },
    ]);
    fakeFs.set(
      fsKey(PROJECT_PATH, "characters/active.md"),
      buildContent({ title: "アクティブ", archived: false }),
    );
    fakeFs.set(
      fsKey(PROJECT_PATH, "characters/archived.md"),
      buildContent({ title: "アーカイブ済み", archived: true }),
    );

    await refreshArchivedFiles(PROJECT_PATH);

    const archived = useArchivedFilesStore.getState().relativePaths;
    expect(archived.has("characters/archived.md")).toBe(true);
    expect(archived.has("characters/active.md")).toBe(false);
    expect(archived.size).toBe(1);
  });

  it("archived キーが無いファイルはアクティブ扱いで Set に入らない", async () => {
    fakeListing.set(listKey(PROJECT_PATH, "characters"), [
      { relativePath: "characters/no-key.md", name: "no-key.md" },
    ]);
    fakeFs.set(
      fsKey(PROJECT_PATH, "characters/no-key.md"),
      buildContent({ title: "キーなし" }),
    );

    await refreshArchivedFiles(PROJECT_PATH);

    expect(useArchivedFilesStore.getState().relativePaths.size).toBe(0);
  });

  it("章ファイルもスキャン対象に含まれる(章のアーカイブも検出される)", async () => {
    fakeListing.set(listKey(PROJECT_PATH, "chapters"), [
      { relativePath: "chapters/001.md", name: "001.md" },
    ]);
    fakeFs.set(
      fsKey(PROJECT_PATH, "chapters/001.md"),
      buildContent({ title: "第 1 章", archived: true }),
    );

    await refreshArchivedFiles(PROJECT_PATH);

    expect(
      useArchivedFilesStore.getState().relativePaths.has("chapters/001.md"),
    ).toBe(true);
  });

  it("再呼び出し時に過去の状態が破棄される(stale な archived 情報を残さない)", async () => {
    // 1 回目: archived: true
    fakeListing.set(listKey(PROJECT_PATH, "characters"), [
      { relativePath: "characters/x.md", name: "x.md" },
    ]);
    fakeFs.set(
      fsKey(PROJECT_PATH, "characters/x.md"),
      buildContent({ title: "X", archived: true }),
    );
    await refreshArchivedFiles(PROJECT_PATH);
    expect(
      useArchivedFilesStore.getState().relativePaths.has("characters/x.md"),
    ).toBe(true);

    // 2 回目: archived: false に書き換え
    fakeFs.set(
      fsKey(PROJECT_PATH, "characters/x.md"),
      buildContent({ title: "X", archived: false }),
    );
    await refreshArchivedFiles(PROJECT_PATH);
    expect(
      useArchivedFilesStore.getState().relativePaths.has("characters/x.md"),
    ).toBe(false);
  });
});
