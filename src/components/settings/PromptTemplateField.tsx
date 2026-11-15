import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AIConfig, ProviderId } from "@/domain/providers/types";
import {
  describeTemplateSelection,
  isSameChoice,
  isThinkingDisabledFor,
  needsConfirm,
  planTemplateChange,
  shouldHintMaxTokens,
  TEMPLATE_CHOICES,
  THINKING_MAX_TOKENS_HINT,
  type TemplateChoice,
  type TemplateSelectionState,
} from "@/domain/providers/templateSelection";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface PromptTemplateFieldProps {
  providerId: ProviderId;
  /** 対象のセクション(ストアの今の値)。 */
  config: AIConfig;
  /** フォームに入力中の Max Tokens(文字列)。保存前の値でも案内を切り替えるため。 */
  maxTokensInput: string;
  /** フォームの、自動保存を待っている入力をその場で保存する。待ちが無ければ何もしない。 */
  flushPendingInput: () => Promise<void>;
  inputClass: string;
  labelClass: string;
}

const SELECT_ID = "ai-prompt-template";
const NOTE_CLASS = "mt-1 text-xs text-zinc-500 dark:text-zinc-500";
const WARN_CLASS = "mt-1 text-xs text-amber-700 dark:text-amber-400";

/** 選択欄の値。自由記述と読めない指定は、選べない選択肢で示す。 */
function selectValue(state: TemplateSelectionState): string {
  switch (state.kind) {
    case "none":
      return "none";
    case "preset":
      return state.name;
    case "custom":
      return "custom";
    case "unreadable":
      return "unreadable";
  }
}

function isTemplateChoice(value: string): value is TemplateChoice {
  return (TEMPLATE_CHOICES as readonly string[]).includes(value);
}

/**
 * AI 設定画面の「プロンプトテンプレート」の欄(`template-settings-ui` spec)。
 *
 * - 表示は、常にストアの今の値(`config`)から求める。部品の中に「選んだ値」を持たない。
 *   保存に失敗して戻したときも、確認を取りやめたときも、表示は自然に元へ戻る
 * - 選んだ時点で保存する(フォームの 1 秒後の自動保存には乗せない)。保存の前に、
 *   フォームの待ち中の入力を先に保存する(テンプレートの保存でフォームが作り直され、
 *   入力が消えるのを防ぐ)
 * - 自由記述と読めない指定から選び直すときは、置き換わることを確認する
 * - 部品が持つ状態は、確認待ちの選択肢と「タグを足した」の表示の 2 つだけ
 */
export function PromptTemplateField({
  providerId,
  config,
  maxTokensInput,
  flushPendingInput,
  inputClass,
  labelClass,
}: PromptTemplateFieldProps) {
  const { t } = useTranslation();
  const [pendingChoice, setPendingChoice] = useState<TemplateChoice | null>(
    null,
  );
  const [tagsAdded, setTagsAdded] = useState(false);
  // 保存を待っている間にプロバイダが変わったとき、前のプロバイダの結果を表示しないため
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;

  // プロバイダが変わったら、確認待ちと「タグを足した」の表示を捨てる
  useEffect(() => {
    setPendingChoice(null);
    setTagsAdded(false);
  }, [providerId]);

  const state = describeTemplateSelection(config.template);

  const save = useCallback(
    async (choice: TemplateChoice) => {
      await flushPendingInput();
      // 先の保存でセクションが置き換わっているので、ストアから読み直した今の値で求める
      const current =
        useAIConfigStore.getState().bundle?.providers[providerId] ?? null;
      if (current == null) return;
      const plan = planTemplateChange(choice, current.thinking);
      const ok = await useAIConfigStore
        .getState()
        .saveTemplateSelection(
          providerId,
          plan.thinking === null
            ? { template: plan.template }
            : { template: plan.template, thinking: plan.thinking },
        );
      if (ok && plan.tagsAdded && providerIdRef.current === providerId) {
        setTagsAdded(true);
      }
    },
    [flushPendingInput, providerId],
  );

  function handleChange(value: string) {
    if (!isTemplateChoice(value)) return;
    setTagsAdded(false);
    if (isSameChoice(state, value)) return;
    if (needsConfirm(state)) {
      setPendingChoice(value);
      return;
    }
    void save(value);
  }

  const handleCancel = useCallback(() => setPendingChoice(null), []);
  function handleConfirm() {
    const choice = pendingChoice;
    setPendingChoice(null);
    if (choice != null) void save(choice);
  }

  const parsedMaxTokens = parseInt(maxTokensInput, 10);
  const maxTokens = Number.isFinite(parsedMaxTokens)
    ? parsedMaxTokens
    : config.parameters.maxTokens;
  const showMaxTokensHint = shouldHintMaxTokens(state, maxTokens);
  const showThinkingDisabled = isThinkingDisabledFor(state, config.thinking);

  let stateNote: { text: string; warn: boolean } | null = null;
  if (state.kind === "custom") {
    stateNote = state.invalid
      ? { text: t("aiSettings.templateCustomInvalidNote"), warn: true }
      : { text: t("aiSettings.templateCustomNote"), warn: false };
  } else if (state.kind === "unreadable") {
    stateNote = { text: t("aiSettings.templateUnreadableNote"), warn: true };
  }

  return (
    <div>
      <label className={labelClass} htmlFor={SELECT_ID}>
        {t("aiSettings.template")}
      </label>
      <select
        id={SELECT_ID}
        value={selectValue(state)}
        onChange={(e) => handleChange(e.target.value)}
        className={inputClass}
      >
        {state.kind === "custom" && (
          <option value="custom" disabled>
            {t("aiSettings.templateOption.custom")}
          </option>
        )}
        {state.kind === "unreadable" && (
          <option value="unreadable" disabled>
            {t("aiSettings.templateOption.unreadable")}
          </option>
        )}
        {TEMPLATE_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {t(`aiSettings.templateOption.${choice}`)}
          </option>
        ))}
      </select>
      {stateNote != null && (
        <p className={stateNote.warn ? WARN_CLASS : NOTE_CLASS}>
          {stateNote.text}
        </p>
      )}
      {(state.kind === "none" || state.kind === "preset") && (
        <p className={NOTE_CLASS}>
          {t(
            `aiSettings.templateDesc.${state.kind === "none" ? "none" : state.name}`,
          )}
        </p>
      )}
      {tagsAdded && (
        <p role="status" className={NOTE_CLASS}>
          {t("aiSettings.templateTagsAdded")}
        </p>
      )}
      {showThinkingDisabled && (
        <p className={WARN_CLASS}>{t("aiSettings.templateThinkingDisabled")}</p>
      )}
      {showMaxTokensHint && (
        <p className={WARN_CLASS}>
          {t("aiSettings.templateMaxTokensHint", {
            min: THINKING_MAX_TOKENS_HINT,
          })}
        </p>
      )}
      <p className={NOTE_CLASS}>{t("aiSettings.templateHelp")}</p>
      <ConfirmDialog
        open={pendingChoice != null}
        title={t("aiSettings.templateConfirmTitle")}
        message={t("aiSettings.templateConfirmBody")}
        confirmLabel={t("aiSettings.templateConfirmAction")}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
