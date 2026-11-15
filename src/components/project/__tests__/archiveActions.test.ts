import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileTarget } from "@/components/project/FileContextMenu";

// archiveActions は archiveApi.setArchived を呼ぶ。
// テストでは vi.mock で setArchived を差し替えて、
// MenuAction が正しく構築されているか + onSelect が正しい引数で呼ばれるかを検証する。
const hoisted = vi.hoisted(() => {
  const setArchived = vi.fn(
    async (_projectPath: string, _relativePath: string, _archived: boolean) => {
      // round-trip 動作は archiveApi 側で検証済み。ここでは呼び出し引数のみ確認する。
    },
  );
  return { setArchived };
});

vi.mock("@/domain/project/archiveApi", () => {
  return {
    setArchived: hoisted.setArchived,
  };
});

afterEach(() => {
  hoisted.setArchived.mockClear();
});

const activeTarget: FileTarget = {
  category: "characters",
  relativePath: "characters/alice.md",
  name: "alice.md",
  archived: false,
};

const archivedTarget: FileTarget = {
  category: "characters",
  relativePath: "characters/bob.md",
  name: "bob.md",
  archived: true,
};

describe("buildArchiveActions", () => {
  it("MenuAction 配列を 2 個返す (archive, unarchive)", async () => {
    const { buildArchiveActions } = await import(
      "@/components/project/archiveActions"
    );

    const actions = buildArchiveActions("/proj");

    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe("archive");
    expect(actions[1].id).toBe("unarchive");
  });

  it("アクティブ target には archive のみ visible", async () => {
    const { buildArchiveActions } = await import(
      "@/components/project/archiveActions"
    );
    const [archive, unarchive] = buildArchiveActions("/proj");

    expect(archive.visible(activeTarget)).toBe(true);
    expect(unarchive.visible(activeTarget)).toBe(false);
  });

  it("アーカイブ済み target には unarchive のみ visible", async () => {
    const { buildArchiveActions } = await import(
      "@/components/project/archiveActions"
    );
    const [archive, unarchive] = buildArchiveActions("/proj");

    expect(archive.visible(archivedTarget)).toBe(false);
    expect(unarchive.visible(archivedTarget)).toBe(true);
  });

  it("archive.onSelect は setArchived(projectPath, relativePath, true) を呼ぶ", async () => {
    const { buildArchiveActions } = await import(
      "@/components/project/archiveActions"
    );
    const [archive] = buildArchiveActions("/proj");

    await archive.onSelect(activeTarget);

    expect(hoisted.setArchived).toHaveBeenCalledTimes(1);
    expect(hoisted.setArchived).toHaveBeenCalledWith(
      "/proj",
      "characters/alice.md",
      true,
    );
  });

  it("unarchive.onSelect は setArchived(projectPath, relativePath, false) を呼ぶ", async () => {
    const { buildArchiveActions } = await import(
      "@/components/project/archiveActions"
    );
    const [, unarchive] = buildArchiveActions("/proj");

    await unarchive.onSelect(archivedTarget);

    expect(hoisted.setArchived).toHaveBeenCalledTimes(1);
    expect(hoisted.setArchived).toHaveBeenCalledWith(
      "/proj",
      "characters/bob.md",
      false,
    );
  });

  it("setArchived が throw しても onSelect 自体は throw しない (try/catch で握る)", async () => {
    const { buildArchiveActions } = await import(
      "@/components/project/archiveActions"
    );
    hoisted.setArchived.mockRejectedValueOnce(new Error("boom"));

    const [archive] = buildArchiveActions("/proj");

    await expect(archive.onSelect(activeTarget)).resolves.toBeUndefined();
  });
});
