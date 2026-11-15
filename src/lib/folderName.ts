/**
 * タイトル文字列を Windows 互換のフォルダ名へ変換する純関数。
 *
 * 処理内容:
 * - Windows 予約文字 `< > : " / \ | ? *` を除去
 * - ASCII 制御文字 U+0000〜U+001F および U+007F (DEL) を除去
 * - 末尾の半角スペース・ピリオドを除去 (Windows 制約)
 * - 文字列全体の前後の半角スペース (U+0020) を除去
 * - 全角スペース・全角記号・日本語文字は変更しない
 *
 * 結果が空文字なら `empty`、240 文字超なら `tooLong` のエラーを返す。
 * 副作用なし、I/O なし、参照透明。
 *
 * 参考: design.md welcome-create-flow / Lib Layer / sanitizeFolderName
 */

/** サニタイズ失敗の理由。 */
export type SanitizeErrorKind =
  | { kind: "empty" }
  | { kind: "tooLong"; length: number };

/**
 * `sanitizeFolderName` の結果。
 *
 * - `ok=true` のとき `folderName` はそのままフォルダ作成に使える文字列。
 * - `ok=false` のとき `folderName` はサニタイズ後の文字列(プレビュー用)で、
 *   `error` がユーザー向けフィードバックの理由を持つ。
 */
export type SanitizeResult =
  | { ok: true; folderName: string }
  | { ok: false; folderName: string; error: SanitizeErrorKind };

/**
 * Windows 予約文字 `< > : " / \ | ? *` および ASCII 制御文字
 * U+0000〜U+001F、U+007F (DEL) にマッチする正規表現。
 *
 * 注意: `new RegExp("[<>:\"/\\\\|?*...]", "g")` のように文字列で構築すると、
 * JS 文字列リテラルの escape と RegExp constructor の escape の二重 escape を
 * 通すために backslash の扱いを誤ると character class に backslash が入らない。
 * その事故を避けるため、ここでは正規表現リテラル `/.../` を使う
 * (リテラル中の `\\` は escape された 1 文字の backslash を示す)。
 * 制御文字は Unicode escape (`\u0000` 等) で書く。
 */
const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/** 末尾の半角スペース (U+0020) およびピリオドにマッチする正規表現。 */
const TRAILING_SPACES_AND_DOTS_RE = /[ .]+$/;

/**
 * 文字列の前後の半角スペース (U+0020) のみにマッチする正規表現。
 *
 * `String.prototype.trim()` は U+3000 (全角スペース) を含む全 Unicode whitespace を
 * 除去してしまうため、Req 2.3 の「全角スペースは保持する」要件に違反する。
 * そのため明示的に半角スペースだけを対象とする正規表現を使う。
 */
const LEADING_TRAILING_HALFWIDTH_SPACES_RE = /^[ ]+|[ ]+$/g;

/** Windows MAX_PATH 260 から親パス + 区切り + サブディレクトリ余裕分を引いた経験値。 */
const MAX_FOLDER_NAME_LENGTH = 240;

/**
 * タイトル文字列をフォルダ名へサニタイズする。
 *
 * 処理順序:
 * 1. Windows 予約文字を除去
 * 2. ASCII 制御文字 (U+0000〜U+001F, U+007F) を除去
 * 3. 末尾の半角スペース・ピリオドを除去
 * 4. 文字列全体の前後の半角スペース (U+0020 のみ。U+3000 は保持) を除去
 * 5. 結果が空文字なら `empty` エラー
 * 6. 結果が 240 文字超なら `tooLong` エラー (`folderName` は原文を保持してプレビュー可能にする)
 * 7. それ以外は `ok: true` で返却
 *
 * `length` は JS string 長 (UTF-16 code unit 数) を使用する。
 *
 * @param title 任意の文字列(空文字を含む)
 * @returns 判別共用体 `SanitizeResult`
 */
export function sanitizeFolderName(title: string): SanitizeResult {
  // 1+2. Windows 予約文字 + ASCII 制御文字を空文字へ置換
  // 3. 末尾の半角スペース・ピリオドを除去
  // 4. 文字列全体の前後の半角スペース (U+0020 のみ) を除去
  //    全角スペース U+3000 は Req 2.3 によりサニタイズ対象外なので保持する
  const folderName = title
    .replace(FORBIDDEN_CHARS_RE, "")
    .replace(TRAILING_SPACES_AND_DOTS_RE, "")
    .replace(LEADING_TRAILING_HALFWIDTH_SPACES_RE, "");

  // 5. 出力長が 0 → empty エラー
  if (folderName.length === 0) {
    return { ok: false, folderName: "", error: { kind: "empty" } };
  }

  // 6. 出力長が 240 文字超 → tooLong エラー (原文を保持してプレビュー可能にする)
  if (folderName.length > MAX_FOLDER_NAME_LENGTH) {
    return {
      ok: false,
      folderName,
      error: { kind: "tooLong", length: folderName.length },
    };
  }

  // 7. それ以外 → ok
  return { ok: true, folderName };
}
