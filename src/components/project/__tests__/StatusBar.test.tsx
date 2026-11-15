import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { StatusBar } from "@/components/project/StatusBar";
import { useIllustrationStore } from "@/stores/illustrationStore";
import { useSuggestionStore } from "@/stores/suggestionStore";

// StatusBar の情景文の生成中の表示(illustration-prompt 要件 5.1)。
// illustrationStore の startedAt が null でない間だけ「情景文を生成中… N 秒」を出し、
// N は Math.floor((now - startedAt) / 1000) を 1 秒ごとに更新する。

const BASE_TIME = new Date("2026-01-01T00:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  useIllustrationStore.setState({ startedAt: null });
  useSuggestionStore.setState({ generating: false });
});

afterEach(() => {
  cleanup();
  useIllustrationStore.setState({ startedAt: null });
  vi.useRealTimers();
});

const LABEL = /情景文を生成中…/;

describe("StatusBar の情景文の生成中の表示", () => {
  it("生成中でなければ表示しない", () => {
    render(<StatusBar />);
    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it("生成中になると 0 秒から表示し、1 秒ごとに秒数が進む", () => {
    render(<StatusBar />);

    act(() => {
      useIllustrationStore.getState().start(Date.now());
    });
    expect(screen.getByText("情景文を生成中… 0 秒")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText("情景文を生成中… 0 秒")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("情景文を生成中… 1 秒")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(41_000);
    });
    expect(screen.getByText("情景文を生成中… 42 秒")).toBeTruthy();
  });

  it("マウント前から生成中なら、開始時刻からの経過秒数を出す", () => {
    useIllustrationStore.setState({ startedAt: BASE_TIME - 12_500 });
    render(<StatusBar />);
    expect(screen.getByText("情景文を生成中… 12 秒")).toBeTruthy();
  });

  it("続き生成の「生成中…」と同じ見た目・同じ並びに出す", () => {
    useSuggestionStore.setState({ generating: true });
    useIllustrationStore.setState({ startedAt: BASE_TIME });
    render(<StatusBar />);

    const generating = screen.getByText("生成中…");
    const illustrating = screen.getByText("情景文を生成中… 0 秒");
    expect(illustrating.className).toBe(generating.className);
    expect(illustrating.getAttribute("aria-live")).toBe("polite");
    expect(illustrating.parentElement).toBe(generating.parentElement);
  });

  it("生成が終わったら表示が消え、タイマーも解かれる", () => {
    render(<StatusBar />);
    const baseline = vi.getTimerCount();

    act(() => {
      useIllustrationStore.getState().start(Date.now());
    });
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(baseline + 1);

    act(() => {
      useIllustrationStore.getState().finish();
    });
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("次の生成では 0 秒から数え直す", () => {
    render(<StatusBar />);
    act(() => {
      useIllustrationStore.getState().start(Date.now());
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("情景文を生成中… 5 秒")).toBeTruthy();

    act(() => {
      useIllustrationStore.getState().finish();
    });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    act(() => {
      useIllustrationStore.getState().start(Date.now());
    });
    expect(screen.getByText("情景文を生成中… 0 秒")).toBeTruthy();
  });

  it("アンマウントでタイマーが残らない", () => {
    useIllustrationStore.setState({ startedAt: BASE_TIME });
    const { unmount } = render(<StatusBar />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
