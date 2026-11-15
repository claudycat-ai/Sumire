/**
 * sumire.json の最低限の型定義。
 * 実際の sumire.json には ai 設定や snapshots など多数のフィールドがあるが、
 * M1 段階では UI に必要な基本情報のみ扱う。
 */
export interface SumireProjectMeta {
  schemaVersion: string;
  title: string;
  author: string;
  created: string;
  /** 旧スキーマの AI 設定。新スキーマ移行後は `aiConfig` を使う(`cloud-providers` spec)。 */
  ai?: unknown;
  /**
   * 新スキーマの AI 設定バンドル(`AIConfigBundle`)。
   * パースは `extractAIConfigBundle` で行う(`unknown` のまま受けて runtime で型ガード)。
   */
  aiConfig?: unknown;
  snapshots?: unknown;
  chapterGroups?: unknown;
}

/**
 * `~/.sumire/recent.json` のエントリ型。
 */
export interface RecentProjectEntry {
  path: string;
  title: string;
  lastOpenedAt: string;
}

/**
 * 新規プロジェクト作成時の入力。
 *
 * - `parentPath`: 複数プロジェクトを格納する親フォルダのフルパス
 * - `folderName`: 親フォルダ直下に新規作成する子フォルダ名(サニタイズ済み)
 * - `title` / `author`: `sumire.json` に書き込むメタデータ
 */
export interface CreateProjectInput {
  parentPath: string;
  folderName: string;
  title: string;
  author: string;
}

/**
 * 新規プロジェクト作成の結果。
 *
 * - `meta`: フロントで組み立てた `SumireProjectMeta`(`sumire.json` の内容)
 * - `projectPath`: Rust が返したプロジェクトルートのフルパス
 *   (= `<parentPath>/<folderName>` の絶対パス)
 */
export interface CreateProjectResult {
  meta: SumireProjectMeta;
  projectPath: string;
}
