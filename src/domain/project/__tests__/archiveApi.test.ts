import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `archiveApi` は filesApi (Tauri command ラッパ) と settingsApi (store 同期)
// に依存する。テストでは vi.mock で両方を差し替え、in-memory な仮ファイルシステム
// で round-trip を擬似する。
//
// 仮想 FS は `(projectPath, relativePath) -> content` のマップで保持。
// readFileText / writeFileText の呼び出しはこのマップに対して直接読み書きする。

// vi.mock の factory は import より前にホイストされるため、外側の変数を参照すると
// "Cannot access ... before initialization" になる。vi.hoisted を使って
// fakeFs と refresh 系 spy をホイスト境界の上に持ち上げる。
const hoisted = vi.hoisted(() => {
  const fakeFs = new Map<string, string>();
  const refreshIncludedSettings = vi.fn(async (_projectPath: string) => {
    // store 同期の中身は別タスクの責務。本テストでは呼ばれた事実のみ検証する。
  });
  const refreshArchivedFiles = vi.fn(async (_projectPath: string) => {
    // 同上。`useArchivedFilesStore` の同期はストア側のテストで担保。
  });
  const fsKey = (projectPath: string, relativePath: string): string =>
    `${projectPath}::${relativePath}`;
  return {
    fakeFs,
    refreshIncludedSettings,
    refreshArchivedFiles,
    fsKey,
  };
});

vi.mock("@/domain/project/filesApi", () => {
  return {
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

vi.mock("@/domain/project/settingsApi", () => {
  return {
    refreshIncludedSettings: hoisted.refreshIncludedSettings,
  };
});

vi.mock("@/stores/archivedFilesStore", () => {
  return {
    refreshArchivedFiles: hoisted.refreshArchivedFiles,
  };
});

const { fakeFs, refreshIncludedSettings, refreshArchivedFiles, fsKey } = hoisted;

import { setArchived, isArchived } from "@/domain/project/archiveApi";
import { parseFile } from "@/domain/project/frontmatter";

const PROJECT_PATH = "/fake/project";
const REL_PATH = "characters/alice.md";

const ORIGINAL_BODY = "本文 1 行目\n本文 2 行目\n";
const ORIGINAL_CONTENT = `---
title: アリス
includeInContext: true
---
${ORIGINAL_BODY}`;

beforeEach(() => {
  fakeFs.clear();
  refreshIncludedSettings.mockClear();
  refreshArchivedFiles.mockClear();
  fakeFs.set(fsKey(PROJECT_PATH, REL_PATH), ORIGINAL_CONTENT);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("archiveApi.setArchived", () => {
  it("archived キーが無い content に setArchived(_, _, true) を呼ぶと frontmatter に archived: true が追加される", async () => {
    await setArchived(PROJECT_PATH, REL_PATH, true);

    const after = fakeFs.get(fsKey(PROJECT_PATH, REL_PATH));
    expect(after).toBeDefined();
    const parsed = parseFile(after as string);
    expect(parsed.frontmatter?.fields.get("archived")).toBe(true);
  });

  it("setArchived(_, _, true) → setArchived(_, _, false) で archived: false に上書きされる", async () => {
    await setArchived(PROJECT_PATH, REL_PATH, true);
    await setArchived(PROJECT_PATH, REL_PATH, false);

    const after = fakeFs.get(fsKey(PROJECT_PATH, REL_PATH));
    expect(after).toBeDefined();
    const parsed = parseFile(after as string);
    expect(parsed.frontmatter?.fields.get("archived")).toBe(false);
  });

  it("setArchived は includeInContext の値を変えない(true → アーカイブ操作後も true)", async () => {
    await setArchived(PROJECT_PATH, REL_PATH, true);
    await setArchived(PROJECT_PATH, REL_PATH, false);

    const after = fakeFs.get(fsKey(PROJECT_PATH, REL_PATH));
    const parsed = parseFile(after as string);
    expect(parsed.frontmatter?.fields.get("includeInContext")).toBe(true);
  });

  it("setArchived は本文(body)を変更しない", async () => {
    await setArchived(PROJECT_PATH, REL_PATH, true);

    const after = fakeFs.get(fsKey(PROJECT_PATH, REL_PATH));
    const parsed = parseFile(after as string);
    expect(parsed.body).toBe(ORIGINAL_BODY);
  });

  it("書き込み後に refreshIncludedSettings(projectPath) を呼ぶ", async () => {
    await setArchived(PROJECT_PATH, REL_PATH, true);

    expect(refreshIncludedSettings).toHaveBeenCalledTimes(1);
    expect(refreshIncludedSettings).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it("書き込み後に refreshArchivedFiles(projectPath) も呼ぶ(ツリーの archived 表示同期)", async () => {
    await setArchived(PROJECT_PATH, REL_PATH, true);

    expect(refreshArchivedFiles).toHaveBeenCalledTimes(1);
    expect(refreshArchivedFiles).toHaveBeenCalledWith(PROJECT_PATH);
  });
});

describe("archiveApi.isArchived", () => {
  it("archived キーが無い frontmatter は false を返す", () => {
    const parsed = parseFile(ORIGINAL_CONTENT);
    expect(isArchived(parsed.frontmatter)).toBe(false);
  });

  it("archived: true の frontmatter は true を返す", () => {
    const text = `---
archived: true
---
hello
`;
    const parsed = parseFile(text);
    expect(isArchived(parsed.frontmatter)).toBe(true);
  });

  it("archived: false の frontmatter は false を返す", () => {
    const text = `---
archived: false
---
hello
`;
    const parsed = parseFile(text);
    expect(isArchived(parsed.frontmatter)).toBe(false);
  });

  it("frontmatter が null のときは false を返す(後方互換)", () => {
    expect(isArchived(null)).toBe(false);
  });
});
