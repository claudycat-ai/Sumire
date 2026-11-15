import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// `sumire.json` への書き込みだけを差し替える。ストアは実物を使う(保存が失敗したときに
// ストアが元に戻ることを確かめるため)。
vi.mock("@/domain/project/projectApi", () => ({
  saveProjectMeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/ui/Toast", () => ({
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

import { PromptTemplateField } from "@/components/settings/PromptTemplateField";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { useAppStore } from "@/stores/appStore";
import { saveProjectMeta } from "@/domain/project/projectApi";
import { toastError } from "@/components/ui/Toast";
import {
  DEFAULT_AI_CONFIG_BUNDLE,
  type AIConfig,
  type ProviderId,
  type ThinkingConfig,
} from "@/domain/providers/types";
import type { SumireProjectMeta } from "@/domain/project/types";

// `template-settings-ui` spec task 2.1〜2.3: プロンプトテンプレートの欄。

const mockSaveProjectMeta = saveProjectMeta as unknown as ReturnType<
  typeof vi.fn
>;
const ORIGINAL_SAVE_TEMPLATE_SELECTION =
  useAIConfigStore.getState().saveTemplateSelection;

const GEMMA4_TAGS = { open: "<|channel>", close: "<channel|>" };
const THINK_TAGS = { open: "<think>", close: "</think>" };
const PROVIDER: ProviderId = "openai-compatible";

let saveSpy: ReturnType<typeof vi.fn<typeof ORIGINAL_SAVE_TEMPLATE_SELECTION>>;
let flushSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;

/** openai-compatible のセクションに値を足して、プロジェクトを開いた状態にする。 */
function loadSection(extra: Partial<AIConfig>): void {
  const bundle = structuredClone(DEFAULT_AI_CONFIG_BUNDLE);
  const section: Record<string, unknown> = {
    ...bundle.providers[PROVIDER],
    ...extra,
  };
  for (const key of Object.keys(extra)) {
    if ((extra as Record<string, unknown>)[key] === undefined) delete section[key];
  }
  bundle.providers[PROVIDER] = section as unknown as AIConfig;
  useAIConfigStore
    .getState()
    .loadFromMeta({ aiConfig: bundle } as unknown as SumireProjectMeta);
}

function section(): AIConfig {
  const bundle = useAIConfigStore.getState().bundle;
  if (bundle == null) throw new Error("bundle is null");
  return bundle.providers[PROVIDER];
}

/** ストアの今の値で欄を描く。ストアが変わったら描き直す。 */
function Harness({
  maxTokensInput = "2000",
  providerId = PROVIDER,
}: {
  maxTokensInput?: string;
  providerId?: ProviderId;
}) {
  const config = useAIConfigStore((s) => s.bundle?.providers[providerId]);
  if (config == null) return null;
  return (
    <PromptTemplateField
      providerId={providerId}
      config={config}
      maxTokensInput={maxTokensInput}
      flushPendingInput={flushSpy}
      inputClass=""
      labelClass=""
    />
  );
}

function select(): HTMLSelectElement {
  return screen.getByLabelText("プロンプトテンプレート") as HTMLSelectElement;
}

async function choose(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(select(), { target: { value } });
  });
}

beforeEach(() => {
  mockSaveProjectMeta.mockReset();
  mockSaveProjectMeta.mockResolvedValue(undefined);
  vi.mocked(toastError).mockClear();
  useAIConfigStore.getState().clear();
  saveSpy = vi.fn(ORIGINAL_SAVE_TEMPLATE_SELECTION);
  useAIConfigStore.setState({ saveTemplateSelection: saveSpy });
  flushSpy = vi.fn(() => Promise.resolve());
  useAppStore.setState({ currentProject: { path: "/proj", title: "test" } });
});

afterEach(() => {
  cleanup();
});

describe("いまの指定の表示(2.1–2.5, 7.2)", () => {
  it("指定なしは「指定なし」を選んだ状態で、説明が出る", () => {
    loadSection({ template: undefined });
    render(<Harness />);
    expect(select().value).toBe("none");
    expect(screen.getByText(/テンプレートを使わず/)).toBeTruthy();
    expect(screen.getByText(/指示に答える形で学習されたモデル/)).toBeTruthy();
  });

  it("プリセットは、そのプリセットを選んだ状態で、その説明が出る", () => {
    loadSection({ template: { preset: "chatml-nothink" } });
    render(<Harness />);
    expect(select().value).toBe("chatml-nothink");
    expect(screen.getByText(/空の思考を先に置いて/)).toBeTruthy();
  });

  it("選択肢は「指定なし」と 4 つのプリセットで、表示名にプリセットの名前を含む", () => {
    loadSection({ template: undefined });
    render(<Harness />);
    const labels = Array.from(select().options).map((o) => o.value);
    expect(labels).toEqual([
      "none",
      "gemma4",
      "gemma4-think",
      "chatml",
      "chatml-nothink",
    ]);
    expect(
      Array.from(select().options).find((o) => o.value === "gemma4-think")
        ?.textContent,
    ).toContain("gemma4-think");
  });

  it("自由記述は、選べない「自由記述」の選択肢を選んだ状態で、注記が出る", () => {
    loadSection({ template: { custom: "{{system}}{{body}}" } });
    render(<Harness />);
    expect(select().value).toBe("custom");
    const option = Array.from(select().options).find((o) => o.value === "custom");
    expect(option?.disabled).toBe(true);
    expect(screen.getByText(/中身は sumire.json で直してください/)).toBeTruthy();
  });

  it("不備のある自由記述は、提案が生成されないことを伝える", () => {
    loadSection({ template: { custom: "{{system}}" } });
    render(<Harness />);
    expect(select().value).toBe("custom");
    expect(screen.getByText(/自由記述のテンプレートに不備があり/)).toBeTruthy();
  });

  it("読めない指定は、選べない「読めない指定」を選んだ状態で、提案が生成されないことを伝える", () => {
    loadSection({ template: { preset: "unknown-x" } });
    render(<Harness />);
    expect(select().value).toBe("unreadable");
    expect(screen.getByText(/指定を読めません/)).toBeTruthy();
  });

  it("表示しただけでは、保存しない", () => {
    loadSection({ template: { custom: "{{body}}" } });
    render(<Harness />);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(flushSpy).not.toHaveBeenCalled();
    expect(mockSaveProjectMeta).not.toHaveBeenCalled();
  });
});

describe("選択の保存(3.1, 3.2, 3.5, 3.6)", () => {
  it("プリセットを選ぶと、待ち中の入力を先に保存してから、そのプリセットを保存する", async () => {
    loadSection({ template: undefined });
    render(<Harness />);
    await choose("gemma4");

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy.mock.invocationCallOrder[0]).toBeLessThan(
      saveSpy.mock.invocationCallOrder[0],
    );
    expect(saveSpy).toHaveBeenCalledWith(PROVIDER, {
      template: { preset: "gemma4" },
    });
    expect(section().template).toEqual({ preset: "gemma4" });
    expect(select().value).toBe("gemma4");
  });

  it("「指定なし」を選ぶと、指定が無くなる", async () => {
    loadSection({ template: { preset: "chatml" } });
    render(<Harness />);
    await choose("none");

    expect(saveSpy).toHaveBeenCalledWith(PROVIDER, { template: undefined });
    expect(section().template).toBeUndefined();
    expect(select().value).toBe("none");
  });

  it("いまと同じ指定を選び直しても、保存しない", async () => {
    loadSection({ template: { preset: "chatml" } });
    render(<Harness />);
    await choose("chatml");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("書き込みが失敗すると、選択欄が保存されている指定の表示に戻る", async () => {
    loadSection({ template: { preset: "chatml" } });
    mockSaveProjectMeta.mockRejectedValueOnce(new Error("disk full"));
    render(<Harness />);
    await choose("gemma4");

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(section().template).toEqual({ preset: "chatml" });
    expect(select().value).toBe("chatml");
  });

  it("保存の値に Max Tokens を含めず、保存されている Max Tokens は変わらない(6.5)", async () => {
    loadSection({ template: undefined });
    const before = section().parameters.maxTokens;
    render(<Harness maxTokensInput="200" />);
    await choose("gemma4-think");

    const patch = saveSpy.mock.calls[0][1];
    expect(Object.keys(patch).sort()).toEqual(["template", "thinking"]);
    expect(section().parameters.maxTokens).toBe(before);
  });
});

describe("自由記述と読めない指定の確認(4.2–4.5)", () => {
  it("自由記述の状態で選ぶと確認が出て、取りやめると保存せず、表示は自由記述のまま", async () => {
    const custom = { custom: "{{system}}{{body}}" };
    loadSection({ template: custom });
    render(<Harness />);
    await choose("gemma4");

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(saveSpy).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(section().template).toEqual(custom);
    expect(select().value).toBe("custom");
  });

  it("確認で続けると、選んだ指定を保存する", async () => {
    loadSection({ template: { preset: 1 } });
    render(<Harness />);
    await choose("chatml");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置き換える" }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(section().template).toEqual({ preset: "chatml" });
  });

  it("プリセットどうし、指定なしからは確認を出さない", async () => {
    loadSection({ template: { preset: "gemma4" } });
    render(<Harness />);
    await choose("chatml");
    expect(screen.queryByRole("dialog")).toBeNull();
    await choose("none");
    expect(screen.queryByRole("dialog")).toBeNull();
    await choose("gemma4");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveSpy).toHaveBeenCalledTimes(3);
  });

  it("確認を待っている間にプロバイダが変わったら、確認待ちを捨てる", async () => {
    loadSection({ template: { custom: "{{body}}" } });
    const { rerender } = render(<Harness />);
    await choose("gemma4");
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(<Harness providerId="llama-server" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("思考を分けるタグ(5.1, 5.3–5.7)", () => {
  it("gemma4-think を選ぶと、Gemma 4 の組を足した設定が保存され、「足した」の表示が出る", async () => {
    loadSection({ template: undefined, thinking: { enabled: true, tags: [THINK_TAGS] } });
    render(<Harness />);
    await choose("gemma4-think");

    expect(section().thinking).toEqual({
      enabled: true,
      tags: [THINK_TAGS, GEMMA4_TAGS],
    });
    expect(screen.getByRole("status").textContent).toMatch(/タグ/);
  });

  it("組がすでにあれば、思考の分離の設定を変えず、「足した」の表示も出ない", async () => {
    const thinking: ThinkingConfig = { tags: [GEMMA4_TAGS, THINK_TAGS] };
    loadSection({ template: undefined, thinking });
    render(<Harness />);
    await choose("gemma4-think");

    expect(saveSpy).toHaveBeenCalledWith(PROVIDER, {
      template: { preset: "gemma4-think" },
    });
    expect(section().thinking).toEqual(thinking);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("思考の分離が無効なら、足さずに注記が出る", async () => {
    const thinking: ThinkingConfig = { enabled: false, tags: [THINK_TAGS] };
    loadSection({ template: undefined, thinking });
    render(<Harness />);
    await choose("gemma4-think");

    expect(section().thinking).toEqual(thinking);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/思考の文が提案に混ざります/)).toBeTruthy();
  });

  it("gemma4-think からほかに変えても、足した組が残り、「足した」の表示は消える", async () => {
    loadSection({ template: undefined, thinking: undefined });
    render(<Harness />);
    await choose("gemma4-think");
    expect(screen.getByRole("status")).toBeTruthy();
    const added = section().thinking;
    expect(added).toEqual({ tags: [THINK_TAGS, GEMMA4_TAGS] });

    await choose("gemma4");
    expect(screen.queryByRole("status")).toBeNull();
    expect(section().thinking).toEqual(added);
    await choose("none");
    expect(section().thinking).toEqual(added);
  });

  it("書き込みが失敗したら、「足した」の表示は出ず、思考の分離の設定も元に戻る", async () => {
    loadSection({ template: undefined, thinking: { tags: [THINK_TAGS] } });
    mockSaveProjectMeta.mockRejectedValueOnce(new Error("disk full"));
    render(<Harness />);
    await choose("gemma4-think");

    expect(section().thinking).toEqual({ tags: [THINK_TAGS] });
    expect(screen.queryByRole("status")).toBeNull();
    expect(select().value).toBe("none");
  });
});

describe("Max Tokens の案内(6.1–6.4)", () => {
  it("gemma4-think で入力中の Max Tokens が 200 なら案内が出て、1000 にすると消える", () => {
    loadSection({ template: { preset: "gemma4-think" } });
    const { rerender } = render(<Harness maxTokensInput="200" />);
    expect(screen.getByText(/思考の分も Max Tokens に含まれます/)).toBeTruthy();
    expect(screen.getByText(/1000 以上/)).toBeTruthy();

    rerender(<Harness maxTokensInput="1000" />);
    expect(screen.queryByText(/思考の分も Max Tokens に含まれます/)).toBeNull();
  });

  it("入力中の値が数として読めないときは、保存されている値で判定する", () => {
    loadSection({
      template: { preset: "gemma4-think" },
      parameters: { temperature: 0.8, topP: 0.9, maxTokens: 300 },
    });
    render(<Harness maxTokensInput="" />);
    expect(screen.getByText(/思考の分も Max Tokens に含まれます/)).toBeTruthy();
  });

  it("思考ありでないプリセットと「指定なし」では、案内が出ない", () => {
    loadSection({ template: { preset: "gemma4" } });
    const { unmount } = render(<Harness maxTokensInput="200" />);
    expect(screen.queryByText(/思考の分も Max Tokens に含まれます/)).toBeNull();
    unmount();

    loadSection({ template: undefined });
    render(<Harness maxTokensInput="200" />);
    expect(screen.queryByText(/思考の分も Max Tokens に含まれます/)).toBeNull();
  });
});
