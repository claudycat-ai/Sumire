import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  MAX_CONTEXT_SIZE,
  formatExtraArgsText,
  parseExtraArgsText,
  readLlamaServerLog,
  type LlamaServerPreferences,
} from "@/domain/llamaServer";
import { useLlamaServerStore } from "@/stores/llamaServerStore";

interface Props {
  inputClass: string;
  labelClass: string;
}

type ModelEntries = LlamaServerPreferences["models"];

type ParsedContextSize =
  | { kind: "empty" }
  | { kind: "valid"; value: number }
  | { kind: "invalid" };

/** コンテキスト長の欄の文字列を読む。空欄は未設定、正の整数だけが有効(Req 2.8)。 */
function parseContextSize(text: string): ParsedContextSize {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_CONTEXT_SIZE
    ? { kind: "valid", value }
    : { kind: "invalid" };
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
}

/**
 * 編集中の欄を保存済みのエントリに重ねる。変わらなければ null。
 * 誤りのある欄は飛ばす。欄に出ていないファイル名のエントリには触らない(Req 2.6)。
 */
function applyContextDrafts(
  models: ModelEntries,
  drafts: Record<string, string>,
): ModelEntries | null {
  const next = new Map(Object.entries(models));
  let changed = false;
  for (const [fileName, text] of Object.entries(drafts)) {
    const parsed = parseContextSize(text);
    if (parsed.kind === "invalid") continue;
    if (parsed.kind === "empty") {
      if (next.delete(fileName)) changed = true;
      continue;
    }
    if (next.get(fileName)?.contextSize !== parsed.value) {
      next.set(fileName, { contextSize: parsed.value });
      changed = true;
    }
  }
  return changed ? Object.fromEntries(next) : null;
}

/** 保存済みの値と同じになった編集中の欄を外す。誤りのある欄と、保存を待っている欄は残す。 */
function pruneContextDrafts(
  drafts: Record<string, string>,
  models: ModelEntries,
): Record<string, string> {
  const kept = Object.entries(drafts).filter(([fileName, text]) => {
    const parsed = parseContextSize(text);
    if (parsed.kind === "invalid") return true;
    const saved = hasOwn(models, fileName) ? models[fileName].contextSize : null;
    return parsed.kind === "empty" ? saved !== null : saved !== parsed.value;
  });
  return kept.length === Object.keys(drafts).length
    ? drafts
    : Object.fromEntries(kept);
}

/**
 * AI 設定画面で `llama-server` を選んだときに、接続先・モデル名・Context Window の欄の
 * 代わりに出す欄(`llama-server-provider` spec)。
 *
 * 保存先は `sumire.json` ではなくアプリ側の設定(`useLlamaServerStore.updatePreferences`)。
 * ここで設定を変えても、動いている `llama-server` は起動し直さない(次の起動から効く)。
 */
export function LlamaServerSettings({ inputClass, labelClass }: Props) {
  const { t } = useTranslation();
  const preferences = useLlamaServerStore((s) => s.preferences);
  const models = useLlamaServerStore((s) => s.models);
  const modelsError = useLlamaServerStore((s) => s.modelsError);
  const status = useLlamaServerStore((s) => s.status);

  const [executablePath, setExecutablePath] = useState(preferences.executablePath);
  const [modelsDir, setModelsDir] = useState(preferences.modelsDir);
  const [extraArgsText, setExtraArgsText] = useState(() =>
    formatExtraArgsText(preferences.extraArgs),
  );
  // 書き手が触った欄だけを持つ(キーはファイル名)。触っていない欄は、保存済みの値を出す。
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({});
  const [log, setLog] = useState<
    { ok: true; text: string } | { ok: false; message: string }
  >({ ok: true, text: "" });
  const contextErrorIdPrefix = useId();

  // ストアの値が変わったら欄に写す。自分の保存による変化では、欄の値と同じなので何も起きない。
  useEffect(() => {
    setExecutablePath(preferences.executablePath);
  }, [preferences.executablePath]);
  useEffect(() => {
    setModelsDir(preferences.modelsDir);
  }, [preferences.modelsDir]);
  useEffect(() => {
    // 配列として同じなら書き換えない(入力中の末尾の改行や空行を消さないため)。
    setExtraArgsText((prev) =>
      sameArgs(parseExtraArgsText(prev), preferences.extraArgs)
        ? prev
        : formatExtraArgsText(preferences.extraArgs),
    );
  }, [preferences.extraArgs]);
  useEffect(() => {
    setContextDrafts((prev) => pruneContextDrafts(prev, preferences.models));
  }, [preferences.models]);

  // 入力から 1 秒後の自動保存。ストアの今の値と違う欄だけを送る。
  useEffect(() => {
    const handle = setTimeout(() => {
      const store = useLlamaServerStore.getState();
      const current = store.preferences;
      const patch: Partial<LlamaServerPreferences> = {};
      if (executablePath !== current.executablePath) {
        patch.executablePath = executablePath;
      }
      if (modelsDir !== current.modelsDir) patch.modelsDir = modelsDir;
      const extraArgs = parseExtraArgsText(extraArgsText);
      if (!sameArgs(extraArgs, current.extraArgs)) patch.extraArgs = extraArgs;
      const nextModels = applyContextDrafts(current.models, contextDrafts);
      if (nextModels !== null) patch.models = nextModels;
      if (Object.keys(patch).length === 0) return;
      void store.updatePreferences(patch);
    }, 1000);
    return () => clearTimeout(handle);
  }, [executablePath, modelsDir, extraArgsText, contextDrafts]);

  // 読み直しが重なったときに、古い結果で新しい結果を上書きしないための通し番号。
  const logRequestRef = useRef(0);
  const reloadLog = useCallback(async () => {
    const request = ++logRequestRef.current;
    let next: typeof log;
    try {
      next = { ok: true, text: (await readLlamaServerLog()).join("\n") };
    } catch (e) {
      next = { ok: false, message: String(e) };
    }
    if (logRequestRef.current === request) setLog(next);
  }, []);

  // マウント時と、状態が失敗になったとき(起動ごと)に読み直す(Req 5.7)。
  const failedRunId = status.state === "failed" ? status.runId : null;
  useEffect(() => {
    void reloadLog();
  }, [failedRunId, reloadLog]);

  async function handleBrowseExecutable() {
    const selected = await open({
      multiple: false,
      title: t("llamaServer.executablePath"),
    });
    if (typeof selected !== "string") return;
    setExecutablePath(selected);
    void useLlamaServerStore
      .getState()
      .updatePreferences({ executablePath: selected });
  }

  async function handleBrowseModelsDir() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("llamaServer.modelsDir"),
    });
    if (typeof selected !== "string") return;
    setModelsDir(selected);
    void useLlamaServerStore.getState().updatePreferences({ modelsDir: selected });
  }

  function handleRefreshModels() {
    const store = useLlamaServerStore.getState();
    // 入力した直後のフォルダがまだ保存されていなければ、先に保存する
    // (フォルダの保存が一覧の読み直しを兼ねる)。
    if (modelsDir !== store.preferences.modelsDir) {
      void store.updatePreferences({ modelsDir });
    } else {
      void store.refreshModels();
    }
  }

  const secondaryButtonClass =
    "shrink-0 whitespace-nowrap rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
  const fieldsetClass =
    "space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800";
  const legendClass =
    "px-1 text-xs font-medium text-zinc-700 dark:text-zinc-300";
  const noteClass = "text-xs text-zinc-500 dark:text-zinc-500";
  const errorClass = "text-xs text-red-700 dark:text-red-300";

  return (
    <div className="space-y-4">
      <div>
        <label className={labelClass} htmlFor="llama-server-executable-path">
          {t("llamaServer.executablePath")}
        </label>
        <div className="flex gap-2">
          <input
            id="llama-server-executable-path"
            type="text"
            spellCheck={false}
            value={executablePath}
            onChange={(e) => setExecutablePath(e.target.value)}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => void handleBrowseExecutable()}
            className={secondaryButtonClass}
          >
            {t("llamaServer.browse")}
          </button>
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="llama-server-models-dir">
          {t("llamaServer.modelsDir")}
        </label>
        <div className="flex gap-2">
          <input
            id="llama-server-models-dir"
            type="text"
            spellCheck={false}
            value={modelsDir}
            onChange={(e) => setModelsDir(e.target.value)}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => void handleBrowseModelsDir()}
            className={secondaryButtonClass}
          >
            {t("llamaServer.browse")}
          </button>
        </div>
      </div>

      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>{t("llamaServer.contextSize")}</legend>

        <button
          type="button"
          onClick={handleRefreshModels}
          className={secondaryButtonClass}
        >
          {t("llamaServer.refreshModels")}
        </button>

        {modelsError !== null ? (
          <p className={errorClass + " break-all"}>
            {t("llamaServer.modelsDirUnreadable", { message: modelsError })}
          </p>
        ) : models.length === 0 ? (
          // 一覧が映しているのは保存済みのフォルダなので、入力中の値では分けない。
          <p className={noteClass}>
            {t(
              preferences.modelsDir === ""
                ? "llamaServer.modelsDirUnset"
                : "llamaServer.modelsDirNoGguf",
            )}
          </p>
        ) : (
          <ul className="space-y-2">
            {models.map(({ fileName }, index) => {
              const errorId = `${contextErrorIdPrefix}-context-error-${index}`;
              const value = hasOwn(contextDrafts, fileName)
                ? contextDrafts[fileName]
                : hasOwn(preferences.models, fileName)
                  ? String(preferences.models[fileName].contextSize)
                  : "";
              const invalid = parseContextSize(value).kind === "invalid";
              return (
                <li key={fileName}>
                  <div className="flex items-center gap-2">
                    <span
                      title={fileName}
                      className="min-w-0 flex-1 truncate text-xs text-zinc-700 dark:text-zinc-300"
                    >
                      {fileName}
                    </span>
                    {/* type="number" にすると、数字でない入力が空欄として届き、未設定と区別できない */}
                    <div className="w-28 shrink-0">
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={`${t("llamaServer.contextSize")}: ${fileName}`}
                        aria-invalid={invalid}
                        aria-describedby={invalid ? errorId : undefined}
                        value={value}
                        onChange={(e) =>
                          setContextDrafts((prev) => ({
                            ...prev,
                            [fileName]: e.target.value,
                          }))
                        }
                        className={inputClass}
                      />
                    </div>
                  </div>
                  {invalid && (
                    <p id={errorId} className={errorClass + " mt-1 text-right"}>
                      {t("llamaServer.contextSizeInvalid")}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div>
        <label className={labelClass} htmlFor="llama-server-extra-args">
          {t("llamaServer.extraArgs")}
        </label>
        <textarea
          id="llama-server-extra-args"
          value={extraArgsText}
          onChange={(e) => setExtraArgsText(e.target.value)}
          rows={4}
          spellCheck={false}
          className={inputClass + " resize-y font-mono"}
        />
        <p className={"mt-1 " + noteClass}>{t("llamaServer.extraArgsHelp")}</p>
      </div>

      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>{t("llamaServer.serverLog")}</legend>
        {status.state === "failed" && (
          <p className={errorClass + " break-all"}>
            {status.reason === "spawn"
              ? t("llamaServer.failureSpawn", { message: status.message })
              : t("llamaServer.failureExited", {
                  code: status.exitCode ?? t("llamaServer.exitCodeUnknown"),
                })}
          </p>
        )}
        <button
          type="button"
          onClick={() => void reloadLog()}
          className={secondaryButtonClass}
        >
          {t("llamaServer.serverLogRefresh")}
        </button>
        <pre
          aria-label={t("llamaServer.serverLog")}
          tabIndex={0}
          className="max-h-64 min-h-16 overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
        >
          {log.ok
            ? log.text
            : t("llamaServer.serverLogUnreadable", { message: log.message })}
        </pre>
      </fieldset>
    </div>
  );
}
