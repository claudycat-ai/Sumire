import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { AIProvider } from "@/domain/providers";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import type { FileCategory } from "@/domain/project/filesApi";
import {
  clearContextBuilderCache,
  measureSectionCached,
  packSettingSections,
  trimBodyHead,
  trimBodyTail,
} from "../contextBuilder";

// 挿し絵の文脈と共有する部品(illustration-prompt 1.2)。
// トークン数は「文字数 = トークン数」に固定した偽のプロバイダで測る。
const countTokens = vi.fn<(text: string) => Promise<number>>();

function charCount(text: string): number {
  return Array.from(text).length;
}

const provider: AIProvider = {
  generateStream: () => {
    throw new Error("generateStream は使わない");
  },
  generate: () => Promise.reject(new Error("generate は使わない")),
  countTokens,
};

/** 100 文字の本文(位置ごとに違う文字にして、どこが削られたかを見分ける)。 */
const BODY = Array.from({ length: 100 }, (_, i) =>
  String.fromCharCode(0x3042 + (i % 80)),
).join("");

function head(n: number): string {
  return Array.from(BODY).slice(0, Math.max(0, n)).join("");
}

function tail(n: number): string {
  const chars = Array.from(BODY);
  return n <= 0 ? "" : chars.slice(chars.length - n).join("");
}

function label(category: FileCategory, title: string): string {
  return `${i18n.t(`category.${category}`)}: ${title}`;
}

function addSetting(
  relativePath: string,
  category: FileCategory,
  title: string,
  length: number,
): void {
  useSettingsContextStore.getState().upsertFile({
    relativePath,
    category,
    title,
    // 長さだけが意味を持つ本文。ファイルごとに違う文字にしてキャッシュを分ける。
    body: title.slice(0, 1).repeat(length),
  });
}

beforeEach(() => {
  clearContextBuilderCache();
  countTokens.mockReset();
  countTokens.mockImplementation(async (text) => charCount(text));
  useSettingsContextStore.getState().clear();
});

describe("trimBodyTail", () => {
  it("末尾から削り、予算に収まる最長の先頭を返す", async () => {
    expect(await trimBodyTail(provider, BODY, 37)).toBe(head(37));
    expect(await trimBodyTail(provider, BODY, 1)).toBe(head(1));
    expect(await trimBodyTail(provider, BODY, 99)).toBe(head(99));
  });

  it("全体が入るならそのまま返し、計測は 1 回で済む", async () => {
    expect(await trimBodyTail(provider, BODY, 100)).toBe(BODY);
    expect(await trimBodyTail(provider, BODY, 500)).toBe(BODY);
    countTokens.mockClear();
    await trimBodyTail(provider, BODY, 100);
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  it("予算が 0 以下なら空になる", async () => {
    expect(await trimBodyTail(provider, BODY, 0)).toBe("");
    expect(await trimBodyTail(provider, BODY, -5)).toBe("");
  });

  it("サロゲートペアを途中で割らない", async () => {
    const body = "𠮷野家".repeat(4); // 12 文字(コードポイント単位)
    expect(await trimBodyTail(provider, body, 4)).toBe("𠮷野家𠮷");
  });

  it("trimBodyHead と対称になる(先頭から削ると末尾が残る)", async () => {
    expect(await trimBodyHead(provider, BODY, 37)).toBe(tail(37));
    expect(await trimBodyHead(provider, BODY, 0)).toBe("");
  });
});

describe("measureSectionCached", () => {
  it("同じ文字列はキャッシュを使い、計測は 1 回だけ", async () => {
    expect(await measureSectionCached(provider, "情景")).toBe(2);
    expect(await measureSectionCached(provider, "情景")).toBe(2);
    expect(countTokens).toHaveBeenCalledTimes(1);
  });
});

describe("packSettingSections", () => {
  it("予算まで挿入順に詰め、入らないファイルを飛ばして後ろの小さいファイルは入れる。外した表示名は挿入順(飛び飛び)", async () => {
    addSetting("characters/a.md", "characters", "アリス", 4);
    addSetting("characters/b.md", "characters", "ボブ", 8);
    addSetting("characters/c.md", "characters", "カイ", 3);
    addSetting("characters/d.md", "characters", "ダン", 5);
    addSetting("characters/e.md", "characters", "エマ", 2);

    const packed = await packSettingSections(provider, 10);

    expect(packed.accepted.map((s) => s.label)).toEqual([
      label("characters", "アリス"),
      label("characters", "カイ"),
      label("characters", "エマ"),
    ]);
    expect(packed.dropped).toEqual([
      label("characters", "ボブ"),
      label("characters", "ダン"),
    ]);
    expect(packed.tokens).toBe(9);
  });

  it("挿入順はカテゴリの表示順 → 同じカテゴリ内の追加順で、外した名前もその順になる", async () => {
    addSetting("plot/p.md", "plot", "粗筋", 6);
    addSetting("worldbuilding/w.md", "worldbuilding", "王都", 6);
    addSetting("characters/a.md", "characters", "アリス", 6);
    addSetting("glossary/g.md", "glossary", "魔石", 2);

    const packed = await packSettingSections(provider, 8);

    expect(packed.accepted.map((s) => s.label)).toEqual([
      label("characters", "アリス"),
      label("glossary", "魔石"),
    ]);
    expect(packed.dropped).toEqual([
      label("worldbuilding", "王都"),
      label("plot", "粗筋"),
    ]);
    expect(packed.tokens).toBe(8);
  });

  it("表示名は「カテゴリのラベル: タイトル」の形", async () => {
    addSetting("characters/a.md", "characters", "アリス", 50);

    const packed = await packSettingSections(provider, 10);

    expect(packed.dropped).toEqual([`${i18n.t("category.characters")}: アリス`]);
    expect(packed.accepted).toEqual([]);
    expect(packed.tokens).toBe(0);
  });

  it("設定ファイルが無ければ空で、計測もしない", async () => {
    const packed = await packSettingSections(provider, 10);

    expect(packed).toEqual({ accepted: [], dropped: [], tokens: 0 });
    expect(countTokens).not.toHaveBeenCalled();
  });

  it("採用したセクションは本文とカテゴリを持つ", async () => {
    addSetting("worldbuilding/w.md", "worldbuilding", "王都", 3);

    const packed = await packSettingSections(provider, 10);

    expect(packed.accepted).toEqual([
      {
        label: label("worldbuilding", "王都"),
        content: "王王王",
        category: "worldbuilding",
      },
    ]);
  });
});
