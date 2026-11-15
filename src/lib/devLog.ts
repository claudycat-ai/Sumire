/**
 * dev / dogfood 専用の操作ログ。
 *
 * フロント側の重要なライフサイクルイベント(secret 操作、provider 切替、
 * generate start/end/error など)を構造化 JSON Lines 形式で
 * `dev-events.jsonl`(プロジェクトルート、`.gitignore` 済み)に append する。
 *
 * 設計の要点:
 * - **release ビルドでは何もしない**(`import.meta.env.DEV` のときだけ invoke)。
 * - **環境変数 `SUMIRE_DEV_LOG=1` が無いと Rust 側で no-op**。
 *   フロント側は dev ビルド中は無条件で invoke、ON/OFF は Rust 側 / 起動コマンドで制御する。
 *   この二重防御で「うっかり release で外部にイベントを書く」事故を防ぐ。
 * - スクショなしで実機 dogfood を観察するための補助機構。秘密情報(API キーや
 *   本文 raw)はフロント側で **絶対に payload に入れない**(呼び出し側の規律)。
 * - `dev_append_event` command 失敗は呼び出し元に伝えない(ログのために本番動線を
 *   止めない、`.catch(() => {})` で握り潰す)。
 */

import { invoke } from "@tauri-apps/api/core";

interface DevEvent {
  ts: string;
  event: string;
  payload?: Record<string, unknown>;
}

/**
 * dev/dogfood ログイベントを 1 行追記する。秘密情報は payload に含めないこと。
 *
 * @param event 例: "secret.set" / "provider.switch" / "generate.start" / "generate.error"
 * @param payload 任意の構造化メタデータ(prov / model / kind 等)
 */
export function emitDevEvent(
  event: string,
  payload?: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  const entry: DevEvent = {
    ts: new Date().toISOString(),
    event,
    ...(payload ? { payload } : {}),
  };
  void invoke("dev_append_event", { line: JSON.stringify(entry) }).catch(() => {
    // ログ書き込み失敗は本番動線を止めない。dev session で気付ければ十分。
  });
}
