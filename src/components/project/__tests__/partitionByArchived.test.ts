import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/domain/project/filesApi";
import { partitionByArchived } from "@/components/project/partitionByArchived";

const e = (relativePath: string, name: string): FileEntry => ({
  relativePath,
  name,
});

describe("partitionByArchived", () => {
  it("archived Set に含まれるパスは archived 配列、それ以外は active 配列に振り分ける", () => {
    const entries: FileEntry[] = [
      e("characters/a.md", "a.md"),
      e("characters/b.md", "b.md"),
      e("characters/c.md", "c.md"),
    ];
    const archivedSet = new Set<string>(["characters/b.md"]);

    const result = partitionByArchived(entries, archivedSet);

    expect(result.active.map((x) => x.relativePath)).toEqual([
      "characters/a.md",
      "characters/c.md",
    ]);
    expect(result.archived.map((x) => x.relativePath)).toEqual([
      "characters/b.md",
    ]);
  });

  it("元の配列順序を保持する", () => {
    const entries: FileEntry[] = [
      e("p/1.md", "1"),
      e("p/2.md", "2"),
      e("p/3.md", "3"),
      e("p/4.md", "4"),
    ];
    const archivedSet = new Set<string>(["p/1.md", "p/3.md"]);

    const result = partitionByArchived(entries, archivedSet);

    expect(result.active.map((x) => x.relativePath)).toEqual(["p/2.md", "p/4.md"]);
    expect(result.archived.map((x) => x.relativePath)).toEqual([
      "p/1.md",
      "p/3.md",
    ]);
  });

  it("archived Set が空のときは全件 active", () => {
    const entries: FileEntry[] = [e("p/1.md", "1"), e("p/2.md", "2")];
    const result = partitionByArchived(entries, new Set());
    expect(result.active.length).toBe(2);
    expect(result.archived.length).toBe(0);
  });

  it("entries が空のときは両配列とも空", () => {
    const result = partitionByArchived([], new Set(["p/1.md"]));
    expect(result.active).toEqual([]);
    expect(result.archived).toEqual([]);
  });
});
