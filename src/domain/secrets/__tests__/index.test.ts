/**
 * SecretStore 単体テスト。
 *
 * 対象は `src/domain/secrets/index.ts` の薄ラッパー API。
 * Rust 側 (`src-tauri/src/commands/secrets.rs`) に渡る Tauri command の引数形状と、
 * 「画面側からキーの値を取得する手段がない」ことを不変条件として固定する。
 *
 * 経緯:
 * - `cloud-providers` spec task 11.3 でレグレッションスイートとして作成
 *   (Req 2.3 / 2.4 のキー保存・削除)。
 * - 2026-05-10: silent-failure バグ対策で IPC 引数を `{provider, value}` に変更。
 *   Rust 側で target_name を `Sumire.{provider}_api_key` に組み立てる。
 * - provider-http-rust 3.4: キーの値を読み出す操作と command を廃止
 *   (provider-http-rust Req 7.1 / 7.5)。存在確認は `has_secret` command で行う(Req 7.3)。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vitest は vi.mock 呼び出しをファイル先頭に hoist するため、下記の
// `import { invoke }` および `import { SecretStore }` よりも先に評価される。
// SecretStore 内部の `import { invoke } from "@tauri-apps/api/core"` も
// このモック版を見ることになる。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { SecretStore } from "@/domain/secrets";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/** SecretStore が呼んでよい Tauri command の全集合(値を返す command は含まない)。 */
const ALLOWED_COMMANDS = ["delete_secret", "has_secret", "set_secret"];

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("SecretStore の公開操作 (provider-http-rust Req 7.1 / 7.5)", () => {
  it("公開操作は保存・削除・存在確認の 3 つだけで、キーの値を取得する操作を持たない", () => {
    // 開発用コンソールは `secrets: typeof SecretStore` をそのまま公開するので、
    // ここで操作の集合を固定すれば、コンソールからの取得手段もないことになる(Req 7.5)。
    expect(Object.keys(SecretStore).sort()).toEqual([
      "deleteSecret",
      "hasSecret",
      "setSecret",
    ]);
  });

  it("全操作を通しても、許可された command 以外を呼ばない", async () => {
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === "has_secret" ? true : undefined,
    );

    await SecretStore.setSecret("openai", "sk-test");
    await SecretStore.hasSecret("openai");
    await SecretStore.deleteSecret("openai");

    const called = mockInvoke.mock.calls.map((c) => c[0] as string);
    expect(called).toEqual(["set_secret", "has_secret", "delete_secret"]);
    for (const cmd of called) {
      expect(ALLOWED_COMMANDS).toContain(cmd);
    }
  });
});

describe("SecretStore.setSecret (Req 2.3)", () => {
  it("`set_secret` command を {provider, value} 形状で呼ぶ", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await SecretStore.setSecret("openai", "sk-test");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("set_secret", {
      provider: "openai",
      value: "sk-test",
    });
  });

  it("openai-compatible でも同じ command 形状で呼べる", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await SecretStore.setSecret("openai-compatible", "sk-compat");

    expect(mockInvoke).toHaveBeenCalledWith("set_secret", {
      provider: "openai-compatible",
      value: "sk-compat",
    });
  });
});

describe("SecretStore.deleteSecret (Req 2.4)", () => {
  it("`delete_secret` command を {provider} 形状で呼ぶ", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await SecretStore.deleteSecret("openai");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("delete_secret", {
      provider: "openai",
    });
  });
});

describe("SecretStore.hasSecret (provider-http-rust Req 7.3)", () => {
  it("`has_secret` command を {provider} 形状で 1 回だけ呼ぶ", async () => {
    mockInvoke.mockResolvedValueOnce(true);

    await SecretStore.hasSecret("openai");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("has_secret", {
      provider: "openai",
    });
  });

  it("command が true を返したら true を返す", async () => {
    mockInvoke.mockResolvedValueOnce(true);

    expect(await SecretStore.hasSecret("openai")).toBe(true);
  });

  it("command が false を返したら false を返す", async () => {
    mockInvoke.mockResolvedValueOnce(false);

    expect(await SecretStore.hasSecret("openai-compatible")).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("has_secret", {
      provider: "openai-compatible",
    });
  });
});

describe("SecretStore round-trip (Req 2.3 + 2.4 の通し動作)", () => {
  /**
   * Rust 側 keychain の状態を 1 つの変数で擬似シミュレートする。
   * `has_secret` は Rust 側と同じく、空文字のキーを未設定として扱う。
   */
  function simulateKeychain() {
    let stored: string | null = null;
    mockInvoke.mockImplementation(
      async (cmd: string, args: { provider: string; value?: string }) => {
        if (cmd === "set_secret") {
          stored = args.value ?? null;
          return undefined;
        }
        if (cmd === "has_secret") {
          return stored !== null && stored !== "";
        }
        if (cmd === "delete_secret") {
          stored = null;
          return undefined;
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
    );
  }

  it("setSecret 後は hasSecret が true、deleteSecret 後は false に追従する", async () => {
    simulateKeychain();

    expect(await SecretStore.hasSecret("openai")).toBe(false);

    await SecretStore.setSecret("openai", "sk-test");
    expect(await SecretStore.hasSecret("openai")).toBe(true);

    await SecretStore.deleteSecret("openai");
    expect(await SecretStore.hasSecret("openai")).toBe(false);
  });

  it("同 provider への上書き後も hasSecret は true のまま(setSecret は冪等に上書き)", async () => {
    simulateKeychain();

    await SecretStore.setSecret("openai", "sk-old");
    await SecretStore.setSecret("openai", "sk-new");

    expect(await SecretStore.hasSecret("openai")).toBe(true);
    expect(mockInvoke).toHaveBeenLastCalledWith("has_secret", {
      provider: "openai",
    });
  });
});

describe("SecretStore のエラー伝播 (Req 2.6 の前提条件)", () => {
  it("setSecret: invoke が reject したら例外をそのまま伝播する", async () => {
    // Req 2.6: OS keychain 側の本物の失敗(アクセス権拒否など)は
    // UI 側で toast 通知する責務がある。SecretStore は握り潰さない。
    mockInvoke.mockRejectedValueOnce(new Error("OS keychain locked"));

    await expect(
      SecretStore.setSecret("openai", "sk"),
    ).rejects.toThrow("OS keychain locked");
  });

  it("hasSecret: invoke が reject したら例外をそのまま伝播する(false 化しない)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("OS keychain locked"));

    await expect(SecretStore.hasSecret("openai")).rejects.toThrow(
      "OS keychain locked",
    );
  });

  it("deleteSecret: invoke が reject したら例外をそのまま伝播する", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("permission denied"));

    await expect(SecretStore.deleteSecret("openai")).rejects.toThrow(
      "permission denied",
    );
  });
});
