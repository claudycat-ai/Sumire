/**
 * 思考ブロックの分離(`thinking-output` spec)。
 *
 * 推論モデルが応答に混ぜる思考ブロック(`<think>…</think>` など)を本文から分けるための、
 * 純粋なモジュール。DOM・CodeMirror・zustand・i18n・時刻に依存しない。
 */
import type { ThinkingConfig, ThinkingTagPair } from "./types";

/** 設定が無いとき・有効な組が 1 つも無いときに使うタグの組。 */
export const DEFAULT_THINKING_TAGS: readonly ThinkingTagPair[] = Object.freeze([
  Object.freeze({ open: "<think>", close: "</think>" }),
]);

/**
 * 読み込んだ思考の分離の設定から、実行時に使うタグの組を決める。
 * 思考の分離の設定を読む口はこの関数に限る(`config.thinking` を直接読むと既定値が効かない)。
 *
 * - 未設定 → 既定の 1 組
 * - `enabled: false` → 空配列(思考の分離が無効)。`enabled` の省略は有効として扱う
 * - 開始タグか終了タグが空文字の組は無視し、有効な組が 0 なら既定の 1 組
 *
 * 戻り値は毎回新しい配列(組も新しいオブジェクト)で、呼び出し側が変更しても
 * 既定値や元の設定に影響しない。
 */
export function resolveThinkingTags(
  config: ThinkingConfig | undefined,
): ThinkingTagPair[] {
  if (config === undefined) return copyPairs(DEFAULT_THINKING_TAGS);
  if (config.enabled === false) return [];
  const valid = (config.tags ?? []).filter(
    (pair) => pair.open !== "" && pair.close !== "",
  );
  return copyPairs(valid.length > 0 ? valid : DEFAULT_THINKING_TAGS);
}

function copyPairs(pairs: readonly ThinkingTagPair[]): ThinkingTagPair[] {
  return pairs.map((pair) => ({ open: pair.open, close: pair.close }));
}

export interface ThinkingSnapshot {
  /** 思考ブロックを除き、つなぎ規則を適用した、ここまでの本文。ゴーストにそのまま渡せる。 */
  text: string;
  /** 思考ブロックの中にいるか */
  inThinking: boolean;
}

export interface ThinkingResult {
  /** 応答全体から思考ブロックを除き、つなぎ規則を適用した本文 */
  text: string;
  /** 終了タグを受け取らないまま応答が終わったか */
  unfinishedThinking: boolean;
}

export interface ThinkingSplitter {
  push(delta: string): ThinkingSnapshot;
  finish(): ThinkingResult;
}

/**
 * ストリームで届く応答テキストを、本文と思考ブロックに分ける分離器を作る。1 回の生成ごとに作る。
 * 規則の正は design.md「ThinkingSplitter」の検出規則・保留規則・つなぎ規則。
 *
 * 空配列を渡すと(思考の分離が無効)、保留もしない完全な素通しになる。
 * 思考ブロックの中身は返さず、保持するのも終了タグの照合に要る末尾だけにする。
 */
export function createThinkingSplitter(
  tags: readonly ThinkingTagPair[],
): ThinkingSplitter {
  // 空文字のタグは照合が進まず止まらなくなるので、resolveThinkingTags を通さずに渡されても除く
  const pairs = copyPairs(tags.filter((pair) => pair.open !== "" && pair.close !== ""));
  if (pairs.length === 0) return createPassthrough();
  const opens = pairs.map((pair) => pair.open);

  /** 表示してよいと確定した本文 */
  let text = "";
  /** 次の差分と合わせて照合する末尾。外では開始タグの、中では終了タグの真の接頭辞 */
  let carry = "";
  /** 思考ブロックの中にいる間だけ、その組の終了タグ */
  let closeTag: string | null = null;
  /** 改行以外の本文がもう出たか */
  let seenBody = false;
  /** 思考ブロックを抜けてから、改行以外の文字をまだ受け取っていないか(継ぎ目の途中) */
  let afterBlock = false;
  /** 表示を保留している改行の数(応答の先頭の改行か、思考ブロック直後の改行) */
  let heldNewlines = 0;
  /** 継ぎ目の直前の本文の末尾に連続する改行の数(a) */
  let seamBefore = 0;
  /** 継ぎ目に接する改行の連続のうち、いちばん長いもの */
  let seamMax = 0;

  function emitBody(body: string): void {
    for (const ch of body) {
      if (ch === "\n") {
        if (seenBody && !afterBlock) text += "\n";
        else heldNewlines += 1;
        continue;
      }
      if (afterBlock) {
        // 継ぎ目の前に本文が無ければ(応答の先頭)保留した改行は捨てる
        if (seenBody) text += "\n".repeat(Math.max(seamMax, heldNewlines) - seamBefore);
        afterBlock = false;
      } else if (!seenBody) {
        // 思考ブロックが来ないまま本文が始まったので、先頭の改行を戻す
        text += "\n".repeat(heldNewlines);
      }
      heldNewlines = 0;
      seenBody = true;
      text += ch;
    }
  }

  function startBlock(pair: ThinkingTagPair): void {
    if (afterBlock) {
      // 改行だけを挟んで続く思考ブロックは、前のブロックと 1 つの継ぎ目にする
      seamMax = Math.max(seamMax, heldNewlines);
    } else if (seenBody) {
      seamBefore = countTrailingNewlines(text);
      seamMax = seamBefore;
    }
    // 本文より前に保留していた改行(応答の先頭)は、ここで捨てる(3.2)
    heldNewlines = 0;
    closeTag = pair.close;
  }

  /** `final` は応答が終わったことを表す。続きが来ないので、接頭辞を保留しない。 */
  function consume(delta: string, final: boolean): void {
    let rest = carry + delta;
    carry = "";
    for (;;) {
      if (closeTag !== null) {
        const end = rest.indexOf(closeTag);
        if (end === -1) {
          const partial = final ? -1 : partialTagStart(rest, [closeTag]);
          carry = partial === -1 ? "" : rest.slice(partial);
          return;
        }
        rest = rest.slice(end + closeTag.length);
        closeTag = null;
        afterBlock = true;
        heldNewlines = 0;
        continue;
      }
      const open = findOpenTag(rest, pairs);
      const partial = final ? -1 : partialTagStart(rest, opens);
      // 続きしだいで、より早い位置か同じ位置のより長い開始タグになりうる間は決めない
      if (open !== null && (partial === -1 || partial > open.index)) {
        emitBody(rest.slice(0, open.index));
        startBlock(open.pair);
        rest = rest.slice(open.index + open.pair.open.length);
        continue;
      }
      if (partial === -1) {
        emitBody(rest);
        return;
      }
      emitBody(rest.slice(0, partial));
      carry = rest.slice(partial);
      return;
    }
  }

  return {
    push(delta) {
      consume(delta, false);
      return { text, inThinking: closeTag !== null };
    },
    finish() {
      consume("", true);
      const unfinishedThinking = closeTag !== null;
      if (unfinishedThinking || afterBlock) {
        // 応答の末尾の思考ブロックに接する改行は取り除く(3.3)
        return { text: text.slice(0, text.length - countTrailingNewlines(text)), unfinishedThinking };
      }
      // 改行だけの応答なら、保留した先頭の改行を戻す
      return { text: text + "\n".repeat(heldNewlines), unfinishedThinking: false };
    },
  };
}

function createPassthrough(): ThinkingSplitter {
  let text = "";
  return {
    push(delta) {
      text += delta;
      return { text, inThinking: false };
    },
    finish() {
      return { text, unfinishedThinking: false };
    },
  };
}

/** 最も早く現れる開始タグ。同じ位置で複数一致したら長いほう。 */
function findOpenTag(
  text: string,
  pairs: readonly ThinkingTagPair[],
): { index: number; pair: ThinkingTagPair } | null {
  let found: { index: number; pair: ThinkingTagPair } | null = null;
  for (const pair of pairs) {
    const index = text.indexOf(pair.open);
    if (index === -1) continue;
    if (
      found === null ||
      index < found.index ||
      (index === found.index && pair.open.length > found.pair.open.length)
    ) {
      found = { index, pair };
    }
  }
  return found;
}

/** 末尾のうち、いずれかのタグの真の接頭辞になっている最長部分の開始位置。無ければ -1。 */
function partialTagStart(text: string, tags: readonly string[]): number {
  const longest = Math.max(...tags.map((tag) => tag.length));
  for (let start = Math.max(0, text.length - longest + 1); start < text.length; start++) {
    const tail = text.slice(start);
    if (tags.some((tag) => tag.length > tail.length && tag.startsWith(tail))) return start;
  }
  return -1;
}

function countTrailingNewlines(text: string): number {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === "\n") count += 1;
  return count;
}
