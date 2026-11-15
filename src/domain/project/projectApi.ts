import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_AI_CONFIG_BUNDLE } from "@/domain/providers/types";
import {
  CreateProjectInput,
  CreateProjectResult,
  RecentProjectEntry,
  SumireProjectMeta,
} from "./types";

const SCHEMA_VERSION = "1.0";
const RECENT_MAX = 10;

/**
 * 既存のプロジェクトを開く。
 * sumire.json を読み込み、パース結果を返す。
 */
export async function openProject(path: string): Promise<SumireProjectMeta> {
  const json = await invoke<string>("read_project_meta", { path });
  return JSON.parse(json) as SumireProjectMeta;
}

/**
 * プロジェクトの `sumire.json` を JSON シリアライズして上書き保存する。
 *
 * `cloud-providers` spec の `useAIConfigStore.setActiveProvider` /
 * `updateProviderSection` から呼ばれる永続化経路。`meta` 全体を渡し、
 * snapshots など他フィールドを失わないようにする責務はストア側が負う。
 *
 * 書き込みは Rust 側の `write_file_text` コマンドを再利用する
 * (引数 `relative_path` に `sumire.json` を渡す)。
 *
 * 例外時は呼び出し側で toast 通知する。
 */
export async function saveProjectMeta(
  projectPath: string,
  meta: SumireProjectMeta,
): Promise<void> {
  const json = JSON.stringify(meta, null, 2);
  await invoke("write_file_text", {
    projectPath,
    relativePath: "sumire.json",
    content: json,
  });
}

/**
 * 新規プロジェクトを作成する。
 *
 * - 親フォルダ (`parentPath`) 直下に `folderName` のフォルダを新規作成し、
 *   その中に `sumire.json` と最低限のディレクトリ構造を生成する
 * - 既に同名の子フォルダがある場合や、親フォルダ自身が Sumire プロジェクトの
 *   場合は Rust 側でエラー(`Conflict:` / `NestedProject:` 等)を返す
 * - 戻り値の `projectPath` は新しく作成された子フォルダ(プロジェクトルート)
 *   のフルパス
 */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const meta: SumireProjectMeta = {
    schemaVersion: SCHEMA_VERSION,
    title: input.title,
    author: input.author,
    created: new Date().toISOString(),
    // DEFAULT_AI_CONFIG_BUNDLE は読み取り専用で参照渡し可(extract/update 経路は deep copy)
    aiConfig: DEFAULT_AI_CONFIG_BUNDLE,
    snapshots: { maxKeep: 10 },
  };
  const metaJson = JSON.stringify(meta, null, 2);
  const projectPath = await invoke<string>("create_project", {
    parentPath: input.parentPath,
    folderName: input.folderName,
    metaJson,
  });
  return { meta, projectPath };
}

/**
 * 指定パスがプロジェクトルートかを判定する。
 */
export async function isProjectRoot(path: string): Promise<boolean> {
  return invoke<boolean>("is_project_root", { path });
}

/**
 * 各 OS のアプリデータディレクトリ配下の `Sumire/recent.json` を読み込む。
 * (Windows: `%LOCALAPPDATA%\Sumire\`、macOS/Linux はそれぞれの標準データディレクトリ)
 *
 * ファイルが破損している場合は空配列を返す(履歴が壊れているだけで起動を妨げない)。
 */
export async function readRecentProjects(): Promise<RecentProjectEntry[]> {
  const json = await invoke<string>("read_recent_projects");
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed as RecentProjectEntry[];
  } catch {
    return [];
  }
}

/**
 * `Sumire/recent.json` を更新する。配置先は `readRecentProjects` の説明を参照。
 *
 * - 同じ path のエントリは置換
 * - 先頭が最新、末尾が古い
 * - 上限 10 件、超えたら古いものを切り捨てる
 */
export async function pushRecentProject(entry: RecentProjectEntry): Promise<void> {
  const current = await readRecentProjects();
  const filtered = current.filter((e) => e.path !== entry.path);
  const next = [entry, ...filtered].slice(0, RECENT_MAX);
  await invoke("write_recent_projects", { json: JSON.stringify(next, null, 2) });
}

/**
 * 履歴から指定パスを除去する。
 */
export async function removeRecentProject(path: string): Promise<void> {
  const current = await readRecentProjects();
  const filtered = current.filter((e) => e.path !== path);
  await invoke("write_recent_projects", { json: JSON.stringify(filtered, null, 2) });
}
