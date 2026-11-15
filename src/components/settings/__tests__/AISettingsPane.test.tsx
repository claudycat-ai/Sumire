import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// `saveProjectMeta` は I/O なので no-op に固定する(autosave の副作用が
// テスト環境のファイルシステムに到達しないように)。
vi.mock("@/domain/project/projectApi", () => ({
  saveProjectMeta: vi.fn().mockResolvedValue(undefined),
}));

// モデル一覧取得(provider-http-rust 3.3)の検証用。通信は listOpenAIModels のモックで遮断し、
// トーストと dev イベントは呼び出しを記録するだけにする。
vi.mock("@/domain/providers/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/providers/openai")>();
  return { ...actual, listOpenAIModels: vi.fn() };
});
vi.mock("@/components/ui/Toast", () => ({
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/lib/devLog", () => ({ emitDevEvent: vi.fn() }));
// llama-server の画面(llama-server-provider 4.4)の検証用。Rust の command は呼ばない。
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/domain/llamaServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/llamaServer")>();
  return {
    ...actual,
    listGgufModels: vi.fn().mockResolvedValue([]),
    readLlamaServerLog: vi.fn().mockResolvedValue([]),
    writeAppPreferences: vi.fn().mockResolvedValue(undefined),
  };
});

import { AISettingsPane } from "@/components/settings/AISettingsPane";
import { listOpenAIModels } from "@/domain/providers/openai";
import { ProviderError } from "@/domain/providers/types";
import { toastError, toastInfo } from "@/components/ui/Toast";
import { emitDevEvent } from "@/lib/devLog";
import { useAppStore } from "@/stores/appStore";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import {
  DEFAULT_AI_CONFIG_BUNDLE,
  type AIConfig,
  type ProviderId,
} from "@/domain/providers/types";
import type { SumireProjectMeta } from "@/domain/project/types";
import { SecretStore } from "@/domain/secrets";
import { saveProjectMeta } from "@/domain/project/projectApi";
import { writeAppPreferences } from "@/domain/llamaServer";
import { useLlamaServerStore } from "@/stores/llamaServerStore";

// テスト間の汚染を防ぐため、初回の `updateProviderSection` 実装を
// モジュールロード時にキャプチャしておく。各テストの beforeEach で
// この original を base に新しい spy を作って差し替えることで、
// 「前テストの spy 実装がチェーンに残って今テストの spy にカウントされる」
// 事故を防ぐ(zustand は setState で action を上書きできるが、
// 単純に getState().updateProviderSection を使い回すと前テストの spy を
// 持ってきてしまう)。
const ORIGINAL_UPDATE_PROVIDER_SECTION =
  useAIConfigStore.getState().updateProviderSection;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // 念のため pending な microtask を消化(advanceTimersByTimeAsync 後に
  // fire-and-forget された Promise が次テストへ漏れないように)
  return Promise.resolve();
});

beforeEach(() => {
  // 実 store をクリーン状態に戻し、action を **必ず初回キャプチャした
  // original 実装** に巻き戻す。これにより前テストの spy chain が消える。
  useAIConfigStore.getState().clear();
  useAIConfigStore.setState({
    updateProviderSection: ORIGINAL_UPDATE_PROVIDER_SECTION,
  });
  useAppStore.setState({
    currentProject: { path: "/proj", title: "test" },
    selectedAIProvider: "openai-compatible",
  });
  // bundle をデフォルトでロード
  const meta: SumireProjectMeta = {
    aiConfig: DEFAULT_AI_CONFIG_BUNDLE,
  } as SumireProjectMeta;
  useAIConfigStore.getState().loadFromMeta(meta);
});

describe("AISettingsPane autosave", () => {
  it("1 入力 + 30s タイマ進行で updateProviderSection はちょうど 1 回だけ呼ばれる(無限ループ回帰防止)", async () => {
    // 元の action を保持してラップした spy で差し替える。
    // - debounce save が走る → 元実装が bundle を新参照に更新 → mount effect 発火
    //   → 再 sync → debounce 再スケジュール、というループが起きないことを確認するのが本テストの目的。
    const updateSpy = vi.fn(ORIGINAL_UPDATE_PROVIDER_SECTION);
    useAIConfigStore.setState({ updateProviderSection: updateSpy });

    vi.useFakeTimers();

    render(<AISettingsPane projectPath="/proj" />);

    // model 入力欄を 1 回だけ変更
    const modelInput = screen.getByLabelText(/モデル/);
    await act(async () => {
      fireEvent.change(modelInput, { target: { value: "gpt-4o-mini-x" } });
    });

    // 30 秒進める。1 秒 debounce なので「ちゃんと 1 回」呼ばれた後、
    // 残り 29 秒で再発火が起きていないことを確認する。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(
      "openai-compatible",
      expect.objectContaining({ model: "gpt-4o-mini-x" }),
    );
  });

  it("マウント直後に何も操作しなければ updateProviderSection は呼ばれない(初期 sync の冗長 save 抑止)", async () => {
    const updateSpy = vi.fn(ORIGINAL_UPDATE_PROVIDER_SECTION);
    useAIConfigStore.setState({ updateProviderSection: updateSpy });

    vi.useFakeTimers();

    render(<AISettingsPane projectPath="/proj" />);

    // 30s 経過しても何も呼ばれない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(updateSpy).toHaveBeenCalledTimes(0);
  });
});

describe("AISettingsPane API キーセクション", () => {
  let setSecretSpy: MockInstance<typeof SecretStore.setSecret>;
  let deleteSecretSpy: MockInstance<typeof SecretStore.deleteSecret>;
  // hasSecret は store.refreshSecretAvailability から呼ばれる。
  // 既定で false (キー未設定) を返し、保存テストでは true に切替える。
  let hasSecretSpy: MockInstance<typeof SecretStore.hasSecret>;

  beforeEach(() => {
    // openai セクションを表示するため selectedAIProvider を切替える。
    useAppStore.setState({ selectedAIProvider: "openai" });
    setSecretSpy = vi
      .spyOn(SecretStore, "setSecret")
      .mockResolvedValue(undefined);
    deleteSecretSpy = vi
      .spyOn(SecretStore, "deleteSecret")
      .mockResolvedValue(undefined);
    hasSecretSpy = vi.spyOn(SecretStore, "hasSecret").mockResolvedValue(false);
  });

  afterEach(() => {
    setSecretSpy.mockRestore();
    deleteSecretSpy.mockRestore();
    hasSecretSpy.mockRestore();
  });

  it("API キーを入力して保存ボタンを押すと SecretStore.setSecret が呼ばれ、refreshSecretAvailability で hasSecret が再評価される", async () => {
    // 保存後の hasSecret は true を返すように切替えてバッジ更新を確認する。
    hasSecretSpy.mockResolvedValueOnce(false); // mount 時の refresh
    hasSecretSpy.mockResolvedValueOnce(true); // 保存後の refresh

    render(<AISettingsPane projectPath="/proj" />);

    const apiKeyInput = screen.getByLabelText("API キー", {
      selector: "input",
    });
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: "sk-test-12345" } });
    });

    const saveButton = screen.getByRole("button", { name: "保存" });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(setSecretSpy).toHaveBeenCalledWith("openai", "sk-test-12345");
    });

    // refreshSecretAvailability("openai") が走ったかを hasSecret 呼び出し回数で確認。
    // - mount 時に 1 回 (ApiKeySection.useEffect)
    // - 保存後に 1 回 (handleSave -> refreshSecretAvailability)
    // 合計 2 回以上呼ばれていれば再評価が発火している証拠。
    await waitFor(() => {
      expect(hasSecretSpy).toHaveBeenCalledWith("openai");
      expect(hasSecretSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // 保存完了後に入力欄がクリアされる(平文をメモリ滞在させない設計)。
    expect((apiKeyInput as HTMLInputElement).value).toBe("");
  });

  it("空入力で保存しても SecretStore.setSecret は呼ばれない", async () => {
    render(<AISettingsPane projectPath="/proj" />);

    const saveButton = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    // 空入力の場合 button は disabled なので、disabled 確認 + 念のためクリック
    expect(saveButton.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(setSecretSpy).not.toHaveBeenCalled();
  });

  it("openai-compatible 選択時は API キーセクションが表示されない", async () => {
    useAppStore.setState({ selectedAIProvider: "openai-compatible" });

    render(<AISettingsPane projectPath="/proj" />);

    expect(
      screen.queryByLabelText("API キー", { selector: "input" }),
    ).toBeNull();
  });
});

describe("AISettingsPane 推論モデルの temperature / top_p 注記", () => {
  const NOTE = "推論モデルには temperature と top_p を送信しません";

  /** openai セクションのモデルを差し替えた bundle を読み込み直す。 */
  function loadOpenAIModel(model: string) {
    const meta = {
      aiConfig: {
        ...DEFAULT_AI_CONFIG_BUNDLE,
        providers: {
          ...DEFAULT_AI_CONFIG_BUNDLE.providers,
          openai: { ...DEFAULT_AI_CONFIG_BUNDLE.providers.openai, model },
        },
      },
    } as SumireProjectMeta;
    useAIConfigStore.getState().loadFromMeta(meta);
  }

  let hasSecretSpy: MockInstance<typeof SecretStore.hasSecret>;

  beforeEach(() => {
    hasSecretSpy = vi.spyOn(SecretStore, "hasSecret").mockResolvedValue(false);
  });

  afterEach(() => {
    hasSecretSpy.mockRestore();
  });

  it("OpenAI で推論モデル(gpt-5.5)を選んでいると、注記を出して入力欄と結び付ける", () => {
    useAppStore.setState({ selectedAIProvider: "openai" });
    loadOpenAIModel("gpt-5.5");

    render(<AISettingsPane projectPath="/proj" />);

    const note = screen.getByText(NOTE);
    expect(note.id).not.toBe("");
    // 値は編集できるまま(無効化しない)。注記は両方の入力欄から読み上げられる。
    for (const label of ["Temperature", "Top P"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.disabled).toBe(false);
      expect(input.getAttribute("aria-describedby")).toBe(note.id);
    }
  });

  it("OpenAI で非推論モデル(gpt-4o)なら注記を出さない", () => {
    useAppStore.setState({ selectedAIProvider: "openai" });
    loadOpenAIModel("gpt-4o");

    render(<AISettingsPane projectPath="/proj" />);

    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.getByLabelText("Temperature").getAttribute("aria-describedby")).toBeNull();
  });

  it("OpenAI 互換サーバーでは、モデル名が gpt-5 系でも注記を出さない", async () => {
    useAppStore.setState({ selectedAIProvider: "openai-compatible" });

    render(<AISettingsPane projectPath="/proj" />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/モデル/), { target: { value: "gpt-5.5" } });
    });

    expect(screen.queryByText(NOTE)).toBeNull();
  });
});

describe("AISettingsPane モデル一覧の更新(provider-http-rust 3.3)", () => {
  const mockList = vi.mocked(listOpenAIModels);
  const mockToastError = vi.mocked(toastError);
  const mockToastInfo = vi.mocked(toastInfo);
  const mockEmitDevEvent = vi.mocked(emitDevEvent);
  let hasSecretSpy: MockInstance<typeof SecretStore.hasSecret>;

  beforeEach(() => {
    useAppStore.setState({ selectedAIProvider: "openai" });
    mockList.mockReset();
    mockToastError.mockReset();
    mockToastInfo.mockReset();
    mockEmitDevEvent.mockReset();
    hasSecretSpy = vi.spyOn(SecretStore, "hasSecret").mockResolvedValue(true);
  });

  afterEach(() => {
    hasSecretSpy.mockRestore();
  });

  async function clickFetch() {
    render(<AISettingsPane projectPath="/proj" />);
    const button = screen.getByRole("button", { name: "モデル一覧を更新" });
    await act(async () => {
      fireEvent.click(button);
    });
  }

  it("キーの値は読まず、存在確認でキー未設定ならトーストを出して取得しない(7.3)", async () => {
    hasSecretSpy.mockResolvedValue(false);

    await clickFetch();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "API キーを設定してから実行してください",
      );
    });
    expect(hasSecretSpy).toHaveBeenCalledWith("openai");
    expect(mockEmitDevEvent).toHaveBeenCalledWith("models.fetch.skip", {
      reason: "noKey",
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("キー設定済みなら、キーを渡さずに入力中のエンドポイントで取得し、件数を表示する(6.2)", async () => {
    mockList.mockResolvedValue([{ id: "gpt-4o" }, { id: "gpt-x-preview" }]);

    await clickFetch();

    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalledWith("2 件のモデルを取得しました");
    });
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList.mock.calls[0]).toEqual(["https://api.openai.com/v1"]);
    expect(hasSecretSpy).toHaveBeenCalledWith("openai");
    expect(mockEmitDevEvent).toHaveBeenCalledWith("models.fetch.success", {
      count: 2,
    });
    // 取得に成功したら、選択肢は取得結果だけになる(API が返さないプリセットは消える)
    expect(screen.getByRole("option", { name: "gpt-x-preview" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "gpt-4o" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "gpt-4-0613" })).toBeNull();
  });

  it("取得前はプリセットを選択肢に出す", () => {
    render(<AISettingsPane projectPath="/proj" />);

    expect(screen.getByRole("option", { name: "gpt-4-0613" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "gpt-3.5-turbo-instruct" })).toBeTruthy();
  });

  it("取得に失敗したら、選択肢はプリセットのまま残す", async () => {
    mockList.mockRejectedValue(new ProviderError("network", "接続できません"));

    await clickFetch();

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(screen.getByRole("option", { name: "gpt-4-0613" })).toBeTruthy();
  });

  it("取得に失敗したら、移行前と同じ形でエラーを表示する(6.2)", async () => {
    mockList.mockRejectedValue(
      new ProviderError("config", "OpenAI API キーが設定されていません"),
    );

    await clickFetch();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "モデル一覧の取得に失敗しました: OpenAI API キーが設定されていません",
      );
    });
    expect(mockEmitDevEvent).toHaveBeenCalledWith("models.fetch.error", {
      kind: "config",
      message: "OpenAI API キーが設定されていません",
    });
  });
});

describe("AISettingsPane llama-server の画面(llama-server-provider 4.4)", () => {
  const MODEL = "gemma-4-31B-it-Q3_K_M.gguf";

  beforeEach(() => {
    useAppStore.setState({ selectedAIProvider: "llama-server" });
    useLlamaServerStore.setState({
      ...useLlamaServerStore.getInitialState(),
      models: [{ fileName: MODEL, sizeBytes: 1 }],
    });
    vi.mocked(saveProjectMeta).mockClear();
    vi.mocked(writeAppPreferences).mockClear();
  });

  afterEach(() => {
    useLlamaServerStore.setState(useLlamaServerStore.getInitialState(), true);
  });

  async function renderPane() {
    render(<AISettingsPane projectPath="/proj" />);
    await act(async () => {});
  }

  it("接続先・モデル名・Context Window の欄を出さず、専用の欄を出す", async () => {
    await renderPane();

    expect(screen.queryByLabelText("エンドポイント")).toBeNull();
    expect(screen.queryByLabelText("モデル")).toBeNull();
    expect(screen.queryByLabelText("Context Window")).toBeNull();

    expect(screen.getByLabelText("llama-server の実行ファイル")).toBeTruthy();
    expect(screen.getByLabelText("モデルのフォルダ")).toBeTruthy();
    expect(screen.getByRole("button", { name: "一覧を読み直す" })).toBeTruthy();
    expect(screen.getByLabelText(`コンテキスト長: ${MODEL}`)).toBeTruthy();
    expect(screen.getByLabelText("追加の起動引数")).toBeTruthy();
    expect(screen.getByLabelText("サーバーの出力")).toBeTruthy();
  });

  it("生成パラメータ・設定のトークン予算・システムプロンプトの欄は、ほかのプロバイダと同じものを出す", async () => {
    await renderPane();

    expect(screen.getByLabelText("Temperature")).toBeTruthy();
    expect(screen.getByLabelText("Top P")).toBeTruthy();
    expect(screen.getByLabelText("Max Tokens")).toBeTruthy();
    expect(screen.getByLabelText("設定情報トークン上限")).toBeTruthy();
    expect(screen.getByLabelText("System Prompt")).toBeTruthy();
  });

  it("パスとフォルダの入力は、アプリ側の設定に保存し、sumire.json には保存しない", async () => {
    const updateSpy = vi.fn(ORIGINAL_UPDATE_PROVIDER_SECTION);
    useAIConfigStore.setState({ updateProviderSection: updateSpy });
    vi.useFakeTimers();
    await renderPane();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("llama-server の実行ファイル"), {
        target: { value: "D:\\llama\\llama-server.exe" },
      });
      fireEvent.change(screen.getByLabelText("モデルのフォルダ"), {
        target: { value: "D:\\models" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(writeAppPreferences).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(vi.mocked(writeAppPreferences).mock.calls[0][0]);
    expect(saved.llamaServer).toMatchObject({
      executablePath: "D:\\llama\\llama-server.exe",
      modelsDir: "D:\\models",
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(saveProjectMeta).not.toHaveBeenCalled();
  });

  it("生成パラメータは sumire.json に保存し、接続先・モデル名・Context Window には触らない", async () => {
    const updateSpy = vi.fn(ORIGINAL_UPDATE_PROVIDER_SECTION);
    useAIConfigStore.setState({ updateProviderSection: updateSpy });
    vi.useFakeTimers();
    await renderPane();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Temperature"), {
        target: { value: "0.5" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [id, patch] = updateSpy.mock.calls[0];
    expect(id).toBe("llama-server");
    expect(patch.parameters?.temperature).toBe(0.5);
    expect(Object.keys(patch)).not.toContain("endpoint");
    expect(Object.keys(patch)).not.toContain("model");
    expect(Object.keys(patch)).not.toContain("contextWindow");
    expect(writeAppPreferences).not.toHaveBeenCalled();
  });
});

// `template-settings-ui` spec task 3.1: プロンプトテンプレートの欄の出し分けと、
// フォームの自動保存との関係。Requirements: 1.1, 1.2, 2.6, 4.1, 6.4。
describe("AISettingsPane プロンプトテンプレートの欄(template-settings-ui)", () => {
  const TEMPLATE_LABEL = "プロンプトテンプレート";
  const MAX_TOKENS_HINT = /思考の分も Max Tokens に含まれます/;

  function loadSections(
    sections: Partial<Record<ProviderId, Record<string, unknown>>>,
  ): void {
    const bundle = structuredClone(DEFAULT_AI_CONFIG_BUNDLE);
    for (const [id, extra] of Object.entries(sections)) {
      Object.assign(bundle.providers[id as ProviderId], extra);
    }
    useAIConfigStore
      .getState()
      .loadFromMeta({ aiConfig: bundle } as unknown as SumireProjectMeta);
  }

  function storedSection(id: ProviderId): AIConfig {
    const bundle = useAIConfigStore.getState().bundle;
    if (bundle == null) throw new Error("bundle is null");
    return bundle.providers[id];
  }

  function templateSelect(): HTMLSelectElement {
    return screen.getByLabelText(TEMPLATE_LABEL) as HTMLSelectElement;
  }

  async function renderPane() {
    render(<AISettingsPane projectPath="/proj" />);
    await act(async () => {});
  }

  beforeEach(() => {
    vi.mocked(saveProjectMeta).mockReset();
    vi.mocked(saveProjectMeta).mockResolvedValue(undefined);
    useLlamaServerStore.setState(useLlamaServerStore.getInitialState(), true);
  });

  it("OpenAI 互換では、モデルの欄の後、生成パラメータの前に欄が出る", async () => {
    await renderPane();
    const field = templateSelect();
    const model = screen.getByLabelText("モデル");
    const temperature = screen.getByLabelText("Temperature");
    expect(
      model.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      field.compareDocumentPosition(temperature) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("llama.cpp では、llama-server の欄の後に欄が出る", async () => {
    useAppStore.setState({ selectedAIProvider: "llama-server" });
    await renderPane();
    const field = templateSelect();
    const serverLog = screen.getByLabelText("サーバーの出力");
    expect(
      serverLog.compareDocumentPosition(field) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("OpenAI(クラウド)では、欄を出さない", async () => {
    useAppStore.setState({ selectedAIProvider: "openai" });
    const hasSecretSpy = vi
      .spyOn(SecretStore, "hasSecret")
      .mockResolvedValue(false);
    await renderPane();
    expect(screen.queryByLabelText(TEMPLATE_LABEL)).toBeNull();
    hasSecretSpy.mockRestore();
  });

  it("プロバイダを切り替えると、それぞれの指定が出る", async () => {
    loadSections({
      "openai-compatible": { template: { preset: "chatml" } },
      "llama-server": { template: { preset: "gemma4-think" } },
    });
    await renderPane();
    expect(templateSelect().value).toBe("chatml");

    await act(async () => {
      useAppStore.setState({ selectedAIProvider: "llama-server" });
    });
    expect(templateSelect().value).toBe("gemma4-think");

    await act(async () => {
      useAppStore.setState({ selectedAIProvider: "openai-compatible" });
    });
    expect(templateSelect().value).toBe("chatml");
  });

  it("自由記述の指定があるとき、Max Tokens を変えて自動保存しても、指定が残る(4.1)", async () => {
    const custom = { custom: ["<s>{{system}}", "{{body}}"] };
    loadSections({ "openai-compatible": { template: custom } });
    vi.useFakeTimers();
    await renderPane();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Max Tokens"), {
        target: { value: "1500" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(saveProjectMeta).toHaveBeenCalledTimes(1);
    expect(storedSection("openai-compatible").parameters.maxTokens).toBe(1500);
    expect(storedSection("openai-compatible").template).toEqual(custom);
    expect(templateSelect().value).toBe("custom");
  });

  it("Max Tokens の欄を書き換えると、案内の表示が切り替わる(6.4)", async () => {
    loadSections({
      "openai-compatible": {
        template: { preset: "gemma4-think" },
        parameters: { temperature: 0.8, topP: 0.9, maxTokens: 200 },
      },
    });
    await renderPane();
    expect(screen.getByText(MAX_TOKENS_HINT)).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Max Tokens"), {
        target: { value: "2000" },
      });
    });
    expect(screen.queryByText(MAX_TOKENS_HINT)).toBeNull();
  });

  it("Max Tokens を書き換えた直後(自動保存の前)にテンプレートを選んでも、書き換えた値が残り、保存もされる", async () => {
    await renderPane();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Max Tokens"), {
        target: { value: "2000" },
      });
    });
    await act(async () => {
      fireEvent.change(templateSelect(), { target: { value: "gemma4-think" } });
    });

    const maxTokens = screen.getByLabelText("Max Tokens") as HTMLInputElement;
    expect(maxTokens.value).toBe("2000");
    expect(storedSection("openai-compatible").parameters.maxTokens).toBe(2000);
    expect(storedSection("openai-compatible").template).toEqual({
      preset: "gemma4-think",
    });
    // 先にフォームの入力、次にテンプレートの順で書き込む
    expect(saveProjectMeta).toHaveBeenCalledTimes(2);
    const [, lastMeta] = vi.mocked(saveProjectMeta).mock.calls[1];
    const lastSection = (
      lastMeta.aiConfig as unknown as { providers: Record<ProviderId, AIConfig> }
    ).providers["openai-compatible"];
    expect(lastSection.parameters.maxTokens).toBe(2000);
    expect(lastSection.template).toEqual({ preset: "gemma4-think" });
  });

  it("書き込みが失敗してテンプレートを戻したときも、書き換えた Max Tokens は残る", async () => {
    vi.mocked(saveProjectMeta).mockRejectedValue(new Error("disk full"));
    await renderPane();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Max Tokens"), {
        target: { value: "2000" },
      });
    });
    await act(async () => {
      fireEvent.change(templateSelect(), { target: { value: "gemma4" } });
    });

    expect(templateSelect().value).toBe("none");
    expect(storedSection("openai-compatible").template).toBeUndefined();
    const maxTokens = screen.getByLabelText("Max Tokens") as HTMLInputElement;
    expect(maxTokens.value).toBe("2000");
  });
});
