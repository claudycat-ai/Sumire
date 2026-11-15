/**
 * OS のセキュアストレージ(Windows Credential Manager / macOS Keychain /
 * Linux Secret Service)に対する API キー保管の薄ラッパー。
 *
 * Rust 側コマンドは `src-tauri/src/commands/secrets.rs` に定義されている
 * (task 1.2 で実装、2026-05-10 に silent-failure 対策で大幅修正)。
 * target_name は Rust 側で `Sumire.{provider}_api_key` に組み立てる
 * (`Entry::new_with_target` で固定指定)。
 *
 * 設計原則:
 * - **画面側はキーの値を取得できない**(provider-http-rust Req 7.1 / 7.5)。
 *   提供するのは保存・削除・存在確認だけで、値の読み出しは Rust 側の HTTP 中継の
 *   内部に閉じている。認証が要る通信は `nativeFetch` に `authProvider` を渡して
 *   Rust 側でキーを付与させる。開発用コンソールもこのオブジェクトをそのまま
 *   公開するので、コンソールからも値は取れない。
 * - `hasSecret` は設定済みかどうかの真偽値だけを受け取る(Req 7.3)。空文字の
 *   キーは未設定として扱われる(HTTP 中継のキー未設定判定と同じ)。
 * - 各操作の例外は OS keychain の本物の失敗(アクセス権拒否など)であり、
 *   握り潰さずにそのまま伝える。UI 側で toast 通知する責務がある(Req 2.6)。
 *
 * 引数 `provider: ProviderId` を Rust 側に素のまま渡す。Rust 側で英数字 + ハイフン
 * のみを受け付ける防御的検証を行う(`:` などの文字を含むと Windows Credential
 * Manager で silent failure になる罠を回避するため)。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "@/domain/providers/types";

export const SecretStore = {
  /**
   * `provider` に紐付く API キーを OS keychain に書き込む。既存値は上書きされる。
   * Req 2.1 「キー入力時に OS のセキュアストレージへ保存」に対応。
   */
  async setSecret(provider: ProviderId, value: string): Promise<void> {
    await invoke<void>("set_secret", { provider, value });
  },

  /**
   * `provider` に紐付く API キーを OS keychain から削除する。冪等。
   * Req 2.4 「キー削除」に対応。
   */
  async deleteSecret(provider: ProviderId): Promise<void> {
    await invoke<void>("delete_secret", { provider });
  },

  /**
   * `provider` の API キーが設定済みかどうかだけを返す。キーの値は受け取らない。
   * UI のバッジ表示(Req 5.7)や AI タブの設定状態表示(provider-http-rust Req 7.3)で使う。
   * 失敗時は例外をそのまま伝える。
   */
  async hasSecret(provider: ProviderId): Promise<boolean> {
    return await invoke<boolean>("has_secret", { provider });
  },
} as const;
