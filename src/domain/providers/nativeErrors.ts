/**
 * nativeFetch(`@/domain/http`)の開始時エラーを `ProviderError` に変換する、
 * 両アダプタ共通の関数。
 *
 * 開始時エラーは HTTP を送る前に Rust 側で判定されたもの(URL のスキーム、キーの有無、
 * ヘッダーの形式など)で、どれも書き手が設定を直せば解消するので `config` に寄せる。
 * 接続失敗(`network`)や中断(`AbortError`)は、移行前と同じ文言・種別を使うために
 * 呼び出し側の既存の分岐に任せる。
 *
 * 文言は design.md「ProviderNativeErrors」の対応表に従う。
 */
import { NativeHttpError } from "@/domain/http";
import { ProviderError } from "./types";

/**
 * 開始時エラーなら `ProviderError`(config)を返す。`network` や `AbortError` など、
 * それ以外の値は `null`(呼び出し側の既存処理に任せる)。
 *
 * @param context.secretLabel キー未設定の文言に使うプロバイダ名(例: "OpenAI")。
 */
export function toProviderErrorFromStart(
  e: unknown,
  context: { secretLabel?: string },
): ProviderError | null {
  if (!(e instanceof NativeHttpError)) return null;
  switch (e.kind) {
    case "invalidUrl":
      return new ProviderError(
        "config",
        `エンドポイントの URL が不正です(http / https のみ対応): ${e.message}`,
        e,
      );
    case "missingSecret":
      // 移行前(画面側でキーを読んでいた頃)と同じ文言にする。
      return new ProviderError(
        "config",
        `${context.secretLabel ? `${context.secretLabel} ` : ""}API キーが設定されていません`,
        e,
      );
    case "secretUnavailable":
      return new ProviderError("config", `API キーを読み出せませんでした: ${e.message}`, e);
    case "unsupportedAuth":
      return new ProviderError(
        "config",
        `この接続先の認証方式に対応していません: ${e.message}`,
        e,
      );
    case "authHostNotAllowed":
      // キーを付ける相手は Rust 側で固定している(他人のプロジェクトの設定で、
      // キーが第三者のサーバーに渡らないようにするため)。
      return new ProviderError(
        "config",
        `この接続先には API キーを送れません: ${e.message}。${context.secretLabel ?? "このプロバイダ"} のエンドポイントを既定の値に戻してください`,
        e,
      );
    case "invalidHeader":
      return new ProviderError("config", `リクエストヘッダーが不正です: ${e.message}`, e);
    case "network":
      return null;
  }
  return null;
}
