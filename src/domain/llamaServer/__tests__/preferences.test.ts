import { describe, it, expect } from "vitest";
import {
  DEFAULT_LLAMA_SERVER_PREFERENCES,
  MAX_CONTEXT_SIZE,
  formatExtraArgsText,
  parseExtraArgsText,
  parsePreferences,
  serializePreferences,
} from "@/domain/llamaServer/preferences";
import type { LlamaServerPreferences } from "@/domain/llamaServer/types";

const DEFAULTS: LlamaServerPreferences = {
  executablePath: "",
  modelsDir: "",
  extraArgs: [],
  selectedModel: null,
  models: {},
};

const FULL: LlamaServerPreferences = {
  executablePath: "C:\\bin\\llama-server.exe",
  modelsDir: "C:\\models",
  extraArgs: ["--flash-attn", "on"],
  selectedModel: "a.Q3_K_M.gguf",
  models: {
    "a.Q3_K_M.gguf": { contextSize: 131072 },
    "a.Q5_K_M.gguf": { contextSize: 81920 },
  },
};

describe("parsePreferences: 全体が読めないとき", () => {
  it("既定値の定数が design.md の既定と一致する", () => {
    expect(DEFAULT_LLAMA_SERVER_PREFERENCES).toEqual(DEFAULTS);
  });

  it.each([
    ["null(ファイルが無い)", null],
    ["空文字", ""],
    ["壊れた JSON", '{ "llamaServer": '],
    ["配列", "[1, 2]"],
    ["数値", "42"],
    ["文字列", '"abc"'],
    ["JSON の null", "null"],
  ])("%s は、全体を空として扱う", (_label, json) => {
    expect(parsePreferences(json)).toEqual({ raw: {}, llamaServer: DEFAULTS });
  });

  it("呼ぶたびに別の既定値を返す(書き換えが次の呼び出しに漏れない)", () => {
    const first = parsePreferences(null);
    first.llamaServer.extraArgs.push("--x");
    first.llamaServer.models["a.gguf"] = { contextSize: 1 };

    expect(parsePreferences(null).llamaServer).toEqual(DEFAULTS);
    expect(DEFAULT_LLAMA_SERVER_PREFERENCES).toEqual(DEFAULTS);
  });
});

describe("parsePreferences: llamaServer の正規化", () => {
  it("design.md の形をそのまま読む", () => {
    const { llamaServer } = parsePreferences(
      JSON.stringify({ llamaServer: FULL }),
    );
    expect(llamaServer).toEqual(FULL);
  });

  it.each([
    ["無い", {}],
    ["null", { llamaServer: null }],
    ["配列", { llamaServer: ["a"] }],
    ["文字列", { llamaServer: "x" }],
  ])("llamaServer が%sなら、すべて既定値", (_label, root) => {
    expect(parsePreferences(JSON.stringify(root)).llamaServer).toEqual(DEFAULTS);
  });

  it("型の合わない部分だけ既定値にし、合う部分は残す", () => {
    const { llamaServer } = parsePreferences(
      JSON.stringify({
        llamaServer: {
          executablePath: 123,
          modelsDir: "C:\\models",
          extraArgs: "--flash-attn on",
          selectedModel: { name: "a.gguf" },
          models: ["a.gguf"],
        },
      }),
    );
    expect(llamaServer).toEqual({ ...DEFAULTS, modelsDir: "C:\\models" });
  });

  it("一部のキーが無ければ、そのキーだけ既定値", () => {
    const { llamaServer } = parsePreferences(
      JSON.stringify({
        llamaServer: { executablePath: "C:\\bin\\llama-server.exe" },
      }),
    );
    expect(llamaServer).toEqual({
      ...DEFAULTS,
      executablePath: "C:\\bin\\llama-server.exe",
    });
  });

  it("extraArgs は文字列の要素だけを、順番のまま採る", () => {
    const { llamaServer } = parsePreferences(
      JSON.stringify({
        llamaServer: { extraArgs: ["--flash-attn", 1, null, "on", ["x"], {}] },
      }),
    );
    expect(llamaServer.extraArgs).toEqual(["--flash-attn", "on"]);
  });

  it("selectedModel は文字列だけを採る。空文字は未選択", () => {
    const parse = (selectedModel: unknown) =>
      parsePreferences(JSON.stringify({ llamaServer: { selectedModel } }))
        .llamaServer.selectedModel;

    expect(parse("a.gguf")).toBe("a.gguf");
    expect(parse("")).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse(3)).toBeNull();
  });

  it("models は contextSize が正の整数のエントリだけを採る", () => {
    const { llamaServer } = parsePreferences(
      JSON.stringify({
        llamaServer: {
          models: {
            "ok.gguf": { contextSize: 8192 },
            "one.gguf": { contextSize: 1 },
            "float.gguf": { contextSize: 8192.5 },
            "zero.gguf": { contextSize: 0 },
            "negative.gguf": { contextSize: -4096 },
            "string.gguf": { contextSize: "8192" },
            "null.gguf": { contextSize: null },
            "missing.gguf": {},
            "notObject.gguf": 8192,
            "array.gguf": [8192],
            "nullEntry.gguf": null,
          },
        },
      }),
    );
    expect(llamaServer.models).toEqual({
      "ok.gguf": { contextSize: 8192 },
      "one.gguf": { contextSize: 1 },
    });
  });

  it("models は contextSize が上限(4294967295)を超えるエントリを捨てる。上限ちょうどは採る", () => {
    expect(MAX_CONTEXT_SIZE).toBe(4294967295);
    const { llamaServer } = parsePreferences(
      JSON.stringify({
        llamaServer: {
          models: {
            "max.gguf": { contextSize: 4294967295 },
            "over.gguf": { contextSize: 4294967296 },
            "huge.gguf": { contextSize: 1e21 },
          },
        },
      }),
    );
    expect(llamaServer.models).toEqual({
      "max.gguf": { contextSize: 4294967295 },
    });
  });

  it("models のエントリは contextSize だけを持つ形にそろえる", () => {
    const { llamaServer } = parsePreferences(
      JSON.stringify({
        llamaServer: { models: { "a.gguf": { contextSize: 4096, note: "x" } } },
      }),
    );
    expect(llamaServer.models).toEqual({ "a.gguf": { contextSize: 4096 } });
  });

  it("raw に、読んだ JSON の全体を返す", () => {
    const root = { theme: "dark", llamaServer: FULL, window: { width: 800 } };
    expect(parsePreferences(JSON.stringify(root)).raw).toEqual(root);
  });
});

describe("serializePreferences", () => {
  it("llamaServer 以外のトップレベルのキーを残して、llamaServer だけ差し替える", () => {
    const { raw, llamaServer } = parsePreferences(
      JSON.stringify({
        theme: "dark",
        llamaServer: { executablePath: "old.exe", unknownKey: 1 },
        window: { width: 800, tabs: [1, 2] },
      }),
    );

    const json = serializePreferences(raw, {
      ...llamaServer,
      executablePath: "new.exe",
      selectedModel: "a.gguf",
      models: { "a.gguf": { contextSize: 4096 } },
    });

    expect(JSON.parse(json)).toEqual({
      theme: "dark",
      llamaServer: {
        executablePath: "new.exe",
        modelsDir: "",
        extraArgs: [],
        selectedModel: "a.gguf",
        models: { "a.gguf": { contextSize: 4096 } },
      },
      window: { width: 800, tabs: [1, 2] },
    });
  });

  it("2 スペースのインデントで書く", () => {
    expect(serializePreferences({}, DEFAULTS)).toBe(
      [
        "{",
        '  "llamaServer": {',
        '    "executablePath": "",',
        '    "modelsDir": "",',
        '    "extraArgs": [],',
        '    "selectedModel": null,',
        '    "models": {}',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("渡した raw を書き換えない", () => {
    const raw = { theme: "dark", llamaServer: { executablePath: "old.exe" } };
    const before = structuredClone(raw);

    serializePreferences(raw, FULL);

    expect(raw).toEqual(before);
  });

  it("書いたものを読み直すと、同じ設定になる", () => {
    const json = serializePreferences({ theme: "dark" }, FULL);
    const reread = parsePreferences(json);

    expect(reread.llamaServer).toEqual(FULL);
    expect(reread.raw.theme).toBe("dark");
  });

  it("壊れた JSON から読んだあとでも、llamaServer だけの JSON を書ける", () => {
    const { raw } = parsePreferences("{ broken");
    expect(JSON.parse(serializePreferences(raw, FULL))).toEqual({
      llamaServer: FULL,
    });
  });
});

describe("追加の起動引数の欄", () => {
  it("1 行を 1 引数にする", () => {
    expect(parseExtraArgsText("--flash-attn\non")).toEqual([
      "--flash-attn",
      "on",
    ]);
  });

  it("空行と空白だけの行を捨て、前後の空白を除く", () => {
    expect(
      parseExtraArgsText("  --flash-attn  \n\n   \n\ton\n--threads\n8\n"),
    ).toEqual(["--flash-attn", "on", "--threads", "8"]);
  });

  it("CRLF の改行でも、行末に \\r を残さない", () => {
    expect(parseExtraArgsText("--flash-attn\r\non\r\n")).toEqual([
      "--flash-attn",
      "on",
    ]);
  });

  it("行の中の空白では分けない(1 行が 1 引数)", () => {
    expect(parseExtraArgsText("--flash-attn on")).toEqual(["--flash-attn on"]);
  });

  it("空の入力は、空の配列", () => {
    expect(parseExtraArgsText("")).toEqual([]);
    expect(parseExtraArgsText(" \n \n")).toEqual([]);
  });

  it("配列を、1 行に 1 引数の文字列にする", () => {
    expect(formatExtraArgsText(["--flash-attn", "on"])).toBe(
      "--flash-attn\non",
    );
    expect(formatExtraArgsText([])).toBe("");
  });

  it("文字列にしてから解析すると、元の配列に戻る", () => {
    const args = ["--flash-attn", "on", "--threads", "8"];
    expect(parseExtraArgsText(formatExtraArgsText(args))).toEqual(args);
  });
});
