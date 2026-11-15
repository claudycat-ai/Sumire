import { describe, expect, it } from "vitest";

// Vitest 導入の smoke test。後続タスクで実装する具体的なテストに置き換えて構わない。
describe("vitest smoke", () => {
  it("runs basic assertions", () => {
    expect(1 + 1).toBe(2);
  });
});
