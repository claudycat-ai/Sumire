import type { EditorView } from "@codemirror/view";
import { readFileText, writeFileText } from "@/domain/project/filesApi";
import { useMemoEditorStore } from "@/stores/memoEditorStore";
import { useAppStore } from "@/stores/appStore";

const MEMO_PATH = "memo.md";

/**
 * `memo.md` の内容を取得する。
 * ファイルが存在しない(=新規プロジェクトや既存プロジェクトで未作成)場合は空文字を返す。
 *
 * 仕様 `02-architecture.md` §325-328: memo.md はフロントマター無し、プレーンな Markdown。
 */
export async function readMemo(projectPath: string): Promise<string> {
  try {
    return await readFileText(projectPath, MEMO_PATH);
  } catch {
    // ファイルが存在しない場合などは空扱い。実体は初回書き込みで生成される。
    return "";
  }
}

/** memo.md を上書き保存する。親ディレクトリ(=プロジェクトルート)は必ず存在する前提。 */
export async function writeMemo(projectPath: string, content: string): Promise<void> {
  await writeFileText(projectPath, MEMO_PATH, content);
}

/**
 * メモへの転記エントリ 1 件を文字列に整形する。
 *
 * 現在のフォーマット(M5 暫定):
 *   ***
 *   YYYY-MM-DD HH:mm
 *   <本文>
 *
 * 区切りに `***` を使うのは、`---` だと直前行を Markdown の setext 見出しとして
 * 解釈してしまい、メモ本文に下線+太字が当たって読みづらくなるため。
 *
 * フォーマットは仕様 §198-205 がフォーマット未定としているため、ここで決め打つ。
 * 将来「シンプルすぎる/過剰」と判断されたらこの関数の中身だけ差し替える(呼び出し側不変)。
 */
export function formatMemoEntry(text: string, now: Date = new Date()): string {
  const ts = formatTimestamp(now);
  return `***\n${ts}\n${text}\n`;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * memo.md の末尾に 1 件追記する(エディタが無い時のフォールバック)。
 *
 * MemoPane が常駐する想定なので通常は使わないが、メモエディタが何らかの理由でアンマウント
 * されている時のために用意する。
 */
export async function appendMemoToFile(
  projectPath: string,
  text: string,
): Promise<void> {
  const current = await readMemo(projectPath);
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const next = current + sep + formatMemoEntry(text);
  await writeMemo(projectPath, next);
}

/**
 * メモエディタ(EditorView)の末尾に 1 件追記する。
 *
 * 末尾が改行で終わってなければ改行を 1 つ挟んでからエントリを差し込む。
 * D&D・Alt+M による選択転記・提案転記の共通処理。
 */
export function appendMemoEntryToView(view: EditorView, text: string): void {
  const docLen = view.state.doc.length;
  const needsLeadingNewline =
    docLen > 0 && view.state.doc.sliceString(docLen - 1) !== "\n";
  const insert = (needsLeadingNewline ? "\n" : "") + formatMemoEntry(text);
  view.dispatch({
    changes: { from: docLen, to: docLen, insert },
    userEvent: "input.memo.append",
  });
}

/**
 * メモへの転記の共通エントリポイント。
 *
 * MemoPane の EditorView があればそこに挿入、なければ memo.md に直追記。
 * `text` は呼び出し側でトリム済みである必要はない(整形は formatMemoEntry が行う)。
 */
export async function appendToMemo(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const view = useMemoEditorStore.getState().view;
  if (view) {
    appendMemoEntryToView(view, trimmed);
    return;
  }
  const project = useAppStore.getState().currentProject;
  if (!project) return;
  await appendMemoToFile(project.path, trimmed);
}
