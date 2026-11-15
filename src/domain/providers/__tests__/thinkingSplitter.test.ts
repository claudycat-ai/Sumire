/**
 * `thinking-output` spec の思考ブロックの分離の単体テスト。
 *
 * - task 1.1: `resolveThinkingTags`。`sumire.json` から読めた思考の分離の設定から、
 *   実行時に使うタグの組を決める規則(design.md「resolveThinkingTags」の解決規則 1〜4)
 * - task 2.1: `createThinkingSplitter`。design.md「ThinkingSplitter」の検出規則・保留規則・
 *   つなぎ規則・不変条件
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1,
 * 5.3, 5.4, 5.5, 5.6
 */
import { describe, expect, it } from "vitest";

import type { ThinkingTagPair } from "@/domain/providers/types";
import {
  DEFAULT_THINKING_TAGS,
  createThinkingSplitter,
  resolveThinkingTags,
  type ThinkingResult,
  type ThinkingSnapshot,
} from "@/domain/providers/thinkingSplitter";

const THINK = { open: "<think>", close: "</think>" };
const THINKING = { open: "<thinking>", close: "</thinking>" };

describe("resolveThinkingTags", () => {
  it("既定のタグの組は <think> / </think> の 1 組", () => {
    expect(DEFAULT_THINKING_TAGS).toEqual([THINK]);
  });

  it("設定が無ければ既定の 1 組になる(5.3)", () => {
    expect(resolveThinkingTags(undefined)).toEqual([THINK]);
  });

  it("enabled: false なら、タグの組があっても空になる(5.6)", () => {
    expect(resolveThinkingTags({ enabled: false, tags: [THINKING] })).toEqual([]);
    expect(resolveThinkingTags({ enabled: false })).toEqual([]);
  });

  it("enabled が省略されていれば有効として扱う", () => {
    expect(resolveThinkingTags({ tags: [THINKING] })).toEqual([THINKING]);
  });

  it("開始タグか終了タグが空文字の組は無視し、残りを順に使う(5.4)", () => {
    expect(
      resolveThinkingTags({
        enabled: true,
        tags: [
          { open: "", close: "</think>" },
          THINKING,
          { open: "<reason>", close: "" },
          { open: "<r>", close: "</r>" },
        ],
      }),
    ).toEqual([THINKING, { open: "<r>", close: "</r>" }]);
  });

  it("有効な組が 1 つも無ければ既定の 1 組になる(5.5)", () => {
    expect(
      resolveThinkingTags({
        enabled: true,
        tags: [
          { open: "", close: "</think>" },
          { open: "<think>", close: "" },
          { open: "", close: "" },
        ],
      }),
    ).toEqual([THINK]);
    expect(resolveThinkingTags({ enabled: true, tags: [] })).toEqual([THINK]);
    expect(resolveThinkingTags({ enabled: true })).toEqual([THINK]);
    expect(resolveThinkingTags({})).toEqual([THINK]);
  });

  it("複数の有効な組は、書かれた順のまま全部使う(5.2)", () => {
    expect(resolveThinkingTags({ enabled: true, tags: [THINK, THINKING] })).toEqual([
      THINK,
      THINKING,
    ]);
  });

  it("既定の組は毎回新しい並びで返り、変更しても既定値に影響しない", () => {
    const first = resolveThinkingTags(undefined);
    first.push(THINKING);
    first[0].open = "<changed>";

    const second = resolveThinkingTags(undefined);
    expect(second).not.toBe(first);
    expect(second).toEqual([THINK]);
    expect(DEFAULT_THINKING_TAGS).toEqual([THINK]);
  });

  it("設定の組から返した並びを変更しても、元の設定に影響しない", () => {
    const tags = [{ ...THINK }, { ...THINKING }];
    const config = { enabled: true, tags };

    const resolved = resolveThinkingTags(config);
    expect(resolved).not.toBe(tags);
    resolved.pop();
    resolved[0].close = "</changed>";

    expect(config.tags).toEqual([THINK, THINKING]);
    expect(resolveThinkingTags(config)).toEqual([THINK, THINKING]);
  });
});

// ---------------------------------------------------------------------------
// createThinkingSplitter
// ---------------------------------------------------------------------------

const R = { open: "<r>", close: "</r>" };
/** 一方の開始タグがもう一方の接頭辞になっている組(同じ位置で一致したときの規則を確かめる)。 */
const SHORT = { open: "<<", close: ">>" };
const LONG = { open: "<<<", close: ">>>" };

/** 思考の中身。本文に一度も現れない文字列にしてあり、漏れたら分かる。 */
const THOUGHT =
  "\nOkay, the user wants me to continue the scene. She just sighed, so show what she sees next.\n";
/** 実測の形(research.md「思考モデルの出力の形(実測)」)。 */
const REAL_SHAPE = `ため息をついた。\n\n<think>${THOUGHT}</think>\n\n改札の向こうに、見慣れた背中が佇んでいた。`;
const REAL_EXPECTED = "ため息をついた。\n\n改札の向こうに、見慣れた背中が佇んでいた。";

interface SplitRun {
  snapshots: ThinkingSnapshot[];
  result: ThinkingResult;
}

function run(chunks: readonly string[], tags: readonly ThinkingTagPair[] = [THINK]): SplitRun {
  const splitter = createThinkingSplitter(tags);
  const snapshots = chunks.map((chunk) => splitter.push(chunk));
  return { snapshots, result: splitter.finish() };
}

/** 1 文字(UTF-16 のコード単位)ずつに切る。 */
function chars(input: string): string[] {
  return input.split("");
}

/** 指定した位置(昇順)で切る。 */
function splitAt(input: string, ...positions: number[]): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (const position of positions) {
    chunks.push(input.slice(start, position));
    start = position;
  }
  chunks.push(input.slice(start));
  return chunks;
}

/** 1 文字ずつ・一括の 2 通りで流し、どちらも同じ結果になることを確かめてから返す。 */
function finishBoth(input: string, tags: readonly ThinkingTagPair[] = [THINK]): ThinkingResult {
  const whole = run([input], tags).result;
  expect(run(chars(input), tags).result).toEqual(whole);
  return whole;
}

describe("createThinkingSplitter: 実測の形", () => {
  const openAt = REAL_SHAPE.indexOf("<think>");
  const closeAt = REAL_SHAPE.indexOf("</think>");
  const afterClose = closeAt + "</think>".length;

  it.each([
    ["1 文字ずつ", chars(REAL_SHAPE)],
    [
      "タグの途中で切って",
      splitAt(REAL_SHAPE, openAt + 1, openAt + 4, closeAt + 1, closeAt + 5, afterClose + 1),
    ],
    ["一括で", [REAL_SHAPE]],
  ])(
    "%s流すと、思考を除き前後の改行を多い側にそろえた本文になり、タグの切れ端も思考も出ない(1.1, 1.2, 1.4, 1.9, 3.1)",
    (_label, chunks) => {
      const { snapshots, result } = run(chunks);

      expect(result).toEqual({ text: REAL_EXPECTED, unfinishedThinking: false });
      for (const snapshot of snapshots) {
        expect(snapshot.text).not.toContain("<");
        expect(snapshot.text).not.toContain("Okay");
        expect(REAL_EXPECTED.startsWith(snapshot.text)).toBe(true);
      }
    },
  );

  it("1 文字ずつ流すと、思考中は思考前の本文を返したまま inThinking が真になる(2.4)", () => {
    const { snapshots } = run(chars(REAL_SHAPE));

    // 開始タグの最後の文字を受けてから、終了タグの最後の文字を受ける直前まで
    const thinking = snapshots.slice(openAt + "<think>".length - 1, afterClose - 1);
    expect(thinking.length).toBeGreaterThan(0);
    for (const snapshot of thinking) {
      expect(snapshot).toEqual({ text: "ため息をついた。\n\n", inThinking: true });
    }
    expect(snapshots[afterClose - 1]).toEqual({ text: "ため息をついた。\n\n", inThinking: false });
  });

  it("タグの途中で切れても、切れ端を保留し、終了タグを受けた時点で思考中を抜ける(1.4, 2.4)", () => {
    const splitter = createThinkingSplitter([THINK]);

    expect(splitter.push("ため息をついた。\n\n<")).toEqual({
      text: "ため息をついた。\n\n",
      inThinking: false,
    });
    expect(splitter.push("thi")).toEqual({ text: "ため息をついた。\n\n", inThinking: false });
    expect(splitter.push("nk>\nOkay, let me plan.</thi")).toEqual({
      text: "ため息をついた。\n\n",
      inThinking: true,
    });
    // 思考ブロック直後の改行は、改行以外の文字が来るまで表示しない
    expect(splitter.push("nk>\n")).toEqual({ text: "ため息をついた。\n\n", inThinking: false });
    expect(splitter.push("\n")).toEqual({ text: "ため息をついた。\n\n", inThinking: false });
    expect(splitter.push("改札の")).toEqual({ text: "ため息をついた。\n\n改札の", inThinking: false });
    expect(splitter.finish()).toEqual({
      text: "ため息をついた。\n\n改札の",
      unfinishedThinking: false,
    });
  });
});

describe("createThinkingSplitter: つなぎ規則", () => {
  it.each([
    ["A\n<think>x</think>\n\n\nB", "A\n\n\nB"],
    ["A\n\n\n<think>x</think>\nB", "A\n\n\nB"],
    ["A\n\n<think>x</think>\n\nB", "A\n\nB"],
    ["A<think>x</think>B", "AB"],
    ["A<think>x</think>\n\nB", "A\n\nB"],
    ["A\n\n<think>x</think>B", "A\n\nB"],
  ])("前後の改行を多い側の数にそろえる(3.1): %j", (input, expected) => {
    expect(finishBoth(input)).toEqual({ text: expected, unfinishedThinking: false });
  });

  it("思考ブロックの後の改行が多ければ、改行以外の文字が来た時点で足りない分だけ足す(3.1)", () => {
    const splitter = createThinkingSplitter([THINK]);

    expect(splitter.push("A\n<think>x</think>\n\n\n").text).toBe("A\n");
    expect(splitter.push("B").text).toBe("A\n\n\nB");
  });

  it.each([
    "<think>x</think>\n\n息を吐いた。",
    "\n\n<think>x</think>\n\n息を吐いた。",
    "\n<think>x</think>息を吐いた。",
    "<think>x</think>\n\n<think>y</think>\n\n息を吐いた。",
  ])("応答の先頭の思考ブロックに接する改行を取り除き、本文から始める(3.2): %j", (input) => {
    expect(finishBoth(input)).toEqual({ text: "息を吐いた。", unfinishedThinking: false });
    for (const snapshot of run(chars(input)).snapshots) {
      expect(snapshot.text.startsWith("\n")).toBe(false);
    }
  });

  it("応答の先頭の改行は、本文が出るまで表示しない(3.2)", () => {
    const splitter = createThinkingSplitter([THINK]);

    expect(splitter.push("\n\n")).toEqual({ text: "", inThinking: false });
    expect(splitter.push("<think>x")).toEqual({ text: "", inThinking: true });
    expect(splitter.push("</think>\n\n")).toEqual({ text: "", inThinking: false });
    expect(splitter.push("息を")).toEqual({ text: "息を", inThinking: false });
  });

  it.each([
    "ため息をついた。\n\n<think>x</think>",
    "ため息をついた。\n\n<think>x</think>\n\n",
    "ため息をついた。<think>x</think>\n",
    "ため息をついた。\n<think>x</think>\n\n<think>y</think>\n",
  ])("応答の末尾の思考ブロックに接する改行を取り除く(3.3): %j", (input) => {
    expect(finishBoth(input)).toEqual({ text: "ため息をついた。", unfinishedThinking: false });
  });

  it("末尾の思考ブロックの直前の改行は、末尾と分かる finish までは表示したままにする(2.4, 3.3)", () => {
    const splitter = createThinkingSplitter([THINK]);

    expect(splitter.push("ため息をついた。\n\n<think>x")).toEqual({
      text: "ため息をついた。\n\n",
      inThinking: true,
    });
    expect(splitter.push("</think>\n\n")).toEqual({
      text: "ため息をついた。\n\n",
      inThinking: false,
    });
    expect(splitter.finish()).toEqual({ text: "ため息をついた。", unfinishedThinking: false });
  });

  it.each([
    ["ため息をついた。\n\n<think>x</think>\n\n　改札の", "ため息をついた。\n\n　改札の"],
    ["<think>x</think>\n\n　改札の", "　改札の"],
    ["　A\n\n<think>x</think>", "　A"],
    ["A\n<think>x</think> B", "A\n B"],
    ["A \n<think>x</think>\n B", "A \n B"],
  ])("改行以外の文字(全角・半角スペース)は取り除かない(3.4): %j", (input, expected) => {
    expect(finishBoth(input)).toEqual({ text: expected, unfinishedThinking: false });
  });

  it("複数の思考ブロックを、それぞれ同じ規則で取り分ける(1.6)", () => {
    expect(finishBoth("A\n<think>x</think>\nB\n\n<think>y</think>\nC")).toEqual({
      text: "A\nB\n\nC",
      unfinishedThinking: false,
    });
  });

  it.each([
    ["A\n<think>x</think>\n\n\n<think>y</think>\nB", "A\n\n\nB"],
    ["A<think>x</think>\n<think>y</think>B", "A\nB"],
    ["A<think>x</think><think>y</think>B", "AB"],
    ["A\n<think>x</think>\n\n<think>y</think>\n", "A"],
  ])(
    "改行だけを挟んで続く思考ブロックは 1 つの継ぎ目にし、挟まれた改行も数に含める(1.6, 3.1): %j",
    (input, expected) => {
      expect(finishBoth(input)).toEqual({ text: expected, unfinishedThinking: false });
    },
  );
});

describe("createThinkingSplitter: タグの検出と保留", () => {
  it.each(["a<b", "<thinx>だった", "本文<", "本文<thi", "本文</thi", "<thinking>"])(
    "タグに見えてタグでない文字列は欠けずに残る(1.5): %j",
    (input) => {
      expect(finishBoth(input)).toEqual({ text: input, unfinishedThinking: false });
    },
  );

  it("タグの接頭辞に当たる末尾は保留し、タグでないと分かった時点で本文に戻す(1.4, 1.5)", () => {
    const splitter = createThinkingSplitter([THINK]);

    expect(splitter.push("a<")).toEqual({ text: "a", inThinking: false });
    expect(splitter.push("b")).toEqual({ text: "a<b", inThinking: false });
    expect(splitter.push("<thin")).toEqual({ text: "a<b", inThinking: false });
    expect(splitter.push("x>")).toEqual({ text: "a<b<thinx>", inThinking: false });
    expect(splitter.push("<")).toEqual({ text: "a<b<thinx>", inThinking: false });
    expect(splitter.finish()).toEqual({ text: "a<b<thinx><", unfinishedThinking: false });
  });

  it("開始タグの直前の、タグでない < は本文に残す(1.5)", () => {
    expect(finishBoth("a<<think>x</think>b")).toEqual({ text: "a<b", unfinishedThinking: false });
  });

  it("複数の組を設定すると、どの組の思考ブロックも取り分ける(1.1, 1.6)", () => {
    expect(finishBoth("A<thinking>x</thinking>B<think>y</think>C", [THINK, THINKING])).toEqual({
      text: "ABC",
      unfinishedThinking: false,
    });
  });

  it("最も早く現れた開始タグを採り、中では別の組の開始タグを思考として扱う(1.1, 1.7)", () => {
    expect(finishBoth("A<r>x<think>y</r>B", [THINK, R])).toEqual({
      text: "AB",
      unfinishedThinking: false,
    });
  });

  it("思考ブロックの中では、同じ組の終了タグだけで抜ける(1.7)", () => {
    expect(finishBoth("A<think>x<r>y</r>z</think>B", [THINK, R])).toEqual({
      text: "AB",
      unfinishedThinking: false,
    });
    expect(finishBoth("A<think>x</thinking>y</think>B", [THINK, THINKING])).toEqual({
      text: "AB",
      unfinishedThinking: false,
    });
  });

  it.each([
    ["短い組が先", [SHORT, LONG]],
    ["長い組が先", [LONG, SHORT]],
  ])(
    "同じ位置で複数の開始タグが一致したら長いほうを採る(%s)",
    (_label, tags) => {
      const input = "A<<<x>>B>>>C";
      const expected = { text: "AC", unfinishedThinking: false };

      expect(finishBoth(input, tags)).toEqual(expected);
      // 短いほうだけが届いた時点では決めずに待つ
      expect(run(splitAt(input, 3), tags).result).toEqual(expected);
      expect(run(splitAt(input, 3), tags).snapshots[0]).toEqual({ text: "A", inThinking: false });
      expect(finishBoth("A<<x>>B", tags)).toEqual({ text: "AB", unfinishedThinking: false });
    },
  );

  it("タグは大文字小文字を区別する完全一致で照合する(1.1)", () => {
    expect(finishBoth("A<THINK>x</THINK>B")).toEqual({
      text: "A<THINK>x</THINK>B",
      unfinishedThinking: false,
    });
  });
});

describe("createThinkingSplitter: 終わり方と素通し", () => {
  it.each([
    ["ため息をついた。\n\n<think>\nOkay", "ため息をついた。"],
    ["<think>\nOkay", ""],
    ["A<think>x</think>B<think>y</thi", "AB"],
  ])("終了タグを受け取らないまま終わると unfinishedThinking が真になる(4.1): %j", (input, text) => {
    const { snapshots, result } = run(chars(input));

    expect(result).toEqual({ text, unfinishedThinking: true });
    expect(snapshots[snapshots.length - 1].inThinking).toBe(true);
    expect(run([input]).result).toEqual(result);
  });

  it("タグの組が空なら、保留もせずに届いた差分をそのまま連結する(5.6)", () => {
    const input = "\n\n<think>x</think>\n\nA<thi";
    const splitter = createThinkingSplitter([]);

    let concatenated = "";
    for (const chunk of chars(input)) {
      concatenated += chunk;
      expect(splitter.push(chunk)).toEqual({ text: concatenated, inThinking: false });
    }
    expect(splitter.finish()).toEqual({ text: input, unfinishedThinking: false });
  });

  it.each([
    "ため息をついた。\n\n改札の向こうに",
    "\n\n冒頭の改行",
    "\n\n",
    "",
    "末尾の<",
    "a<b<thi",
    "a</think>b",
    "　字下げ\n\n",
  ])("どの開始タグも現れなければ、finish の本文は届いた差分の連結に一致する(1.8): %j", (input) => {
    for (const chunks of [chars(input), [input], splitAt(input, Math.floor(input.length / 2))]) {
      expect(run(chunks).result).toEqual({ text: input, unfinishedThinking: false });
    }
  });

  it("思考ブロックの無い先頭の改行は、改行以外の文字が来た時点で表示に戻す(1.8)", () => {
    const splitter = createThinkingSplitter([THINK]);

    expect(splitter.push("\n\n")).toEqual({ text: "", inThinking: false });
    expect(splitter.push("冒頭")).toEqual({ text: "\n\n冒頭", inThinking: false });
  });
});

describe("createThinkingSplitter: 区切り方によらない", () => {
  const cases: { input: string; tags: ThinkingTagPair[]; expected: ThinkingResult }[] = [
    {
      input: "ため息。\n\n<think>\nPLAN</think>\n\n改札の",
      tags: [THINK],
      expected: { text: "ため息。\n\n改札の", unfinishedThinking: false },
    },
    {
      input: "\n\n<think>a<b</think>\n\n　息を<thi\n<think>c</think>\n\n\n<think>d</think>\nを",
      tags: [THINK],
      expected: { text: "　息を<thi\n\n\nを", unfinishedThinking: false },
    },
    {
      input: "a<<think>x</thi</think><x\n\n<think>y",
      tags: [THINK],
      expected: { text: "a<<x", unfinishedThinking: true },
    },
    {
      input: "A<thinking>p</think>q</thinking>B\n<think>r<thinking>s</think>\n\nC",
      tags: [THINK, THINKING],
      expected: { text: "AB\n\nC", unfinishedThinking: false },
    },
    {
      input: "A<<<x>>B>>>C<<y>>\n<<",
      tags: [SHORT, LONG],
      expected: { text: "AC", unfinishedThinking: true },
    },
  ];

  it.each(cases)(
    "どの 2 か所で切っても finish の結果が同じで、途中の本文にタグが出ない: $input",
    ({ input, tags, expected }) => {
      const tagStrings = tags.flatMap((pair) => [pair.open, pair.close]);
      expect(run([input], tags).result).toEqual(expected);

      for (let i = 0; i <= input.length; i++) {
        for (let j = i; j <= input.length; j++) {
          const { snapshots, result } = run(splitAt(input, i, j), tags);
          expect(result).toEqual(expected);
          for (const { text } of snapshots) {
            for (const tag of tagStrings) expect(text).not.toContain(tag);
            // ストリーミング中の本文は確定した本文の前方一致。例外は末尾の思考ブロックの直前の改行だけ
            const isPrefix = expected.text.startsWith(text);
            const onlyTrailingNewlines =
              text.startsWith(expected.text) && /^\n+$/.test(text.slice(expected.text.length));
            expect(isPrefix || onlyTrailingNewlines).toBe(true);
          }
        }
      }
    },
  );
});
