import { beforeEach, describe, expect, it } from "vitest";
import { useIllustrationStore } from "@/stores/illustrationStore";

// 情景文の生成中の状態(開始時刻)だけを持つストア。
// 開始の条件(5.5 / 5.6)とステータスバーの経過秒数(5.1)がこの値を読む。

describe("illustrationStore", () => {
  beforeEach(() => {
    useIllustrationStore.getState().finish();
  });

  it("初期状態では生成中でない(startedAt が null)", () => {
    expect(useIllustrationStore.getState().startedAt).toBeNull();
  });

  it("start で開始時刻が入る", () => {
    useIllustrationStore.getState().start(1_700_000_000_000);
    expect(useIllustrationStore.getState().startedAt).toBe(1_700_000_000_000);
  });

  it("finish で開始時刻が null に戻る", () => {
    useIllustrationStore.getState().start(1234);
    useIllustrationStore.getState().finish();
    expect(useIllustrationStore.getState().startedAt).toBeNull();
  });

  it("finish のあとにもう一度 start できる(7.6)", () => {
    useIllustrationStore.getState().start(1000);
    useIllustrationStore.getState().finish();
    useIllustrationStore.getState().start(2000);
    expect(useIllustrationStore.getState().startedAt).toBe(2000);
  });

  it("購読者に開始と終了が通知される", () => {
    const seen: Array<number | null> = [];
    const unsubscribe = useIllustrationStore.subscribe((s) => {
      seen.push(s.startedAt);
    });
    useIllustrationStore.getState().start(5000);
    useIllustrationStore.getState().finish();
    unsubscribe();
    expect(seen).toEqual([5000, null]);
  });
});
