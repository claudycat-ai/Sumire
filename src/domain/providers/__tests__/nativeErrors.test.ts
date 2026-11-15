/**
 * `provider-http-rust` spec task 3.1: `toProviderErrorFromStart` の単体テスト。
 *
 * nativeFetch の開始時エラー(HTTP を送る前に判定されたもの)を、design.md
 * 「ProviderNativeErrors」の対応表どおりの `ProviderError`(すべて config)に
 * 変換すること、network・中断・それ以外の値は null を返して呼び出し側の既存処理に
 * 任せることを確かめる。
 *
 * Requirements: 2.3, 5.2, 7.4
 */
import { describe, expect, it } from "vitest";

import { NativeHttpError } from "@/domain/http";
import { toProviderErrorFromStart } from "@/domain/providers/nativeErrors";
import { ProviderError } from "@/domain/providers/types";

describe("toProviderErrorFromStart", () => {
  it("invalidUrl は config になり、Rust 側の message を文言に含める(2.3)", () => {
    const cause = new NativeHttpError("invalidUrl", "unsupported scheme: ftp");
    const err = toProviderErrorFromStart(cause, {});

    expect(err).toBeInstanceOf(ProviderError);
    expect(err?.kind).toBe("config");
    expect(err?.message).toBe(
      "エンドポイントの URL が不正です(http / https のみ対応): unsupported scheme: ftp",
    );
    expect(err?.cause).toBe(cause);
  });

  it("missingSecret は config になり、secretLabel 付きの移行前と同じ文言になる(7.4)", () => {
    const err = toProviderErrorFromStart(new NativeHttpError("missingSecret", "openai"), {
      secretLabel: "OpenAI",
    });

    expect(err?.kind).toBe("config");
    expect(err?.message).toBe("OpenAI API キーが設定されていません");
  });

  it("missingSecret で secretLabel が無いときは、ラベル抜きの文言になる", () => {
    const err = toProviderErrorFromStart(new NativeHttpError("missingSecret", "x"), {});

    expect(err?.kind).toBe("config");
    expect(err?.message).toBe("API キーが設定されていません");
  });

  it("secretUnavailable は config になる", () => {
    const err = toProviderErrorFromStart(
      new NativeHttpError("secretUnavailable", "keychain locked"),
      { secretLabel: "OpenAI" },
    );

    expect(err?.kind).toBe("config");
    expect(err?.message).toBe("API キーを読み出せませんでした: keychain locked");
  });

  it("unsupportedAuth は config になる", () => {
    const err = toProviderErrorFromStart(new NativeHttpError("unsupportedAuth", "foo"), {});

    expect(err?.kind).toBe("config");
    expect(err?.message).toBe("この接続先の認証方式に対応していません: foo");
  });

  it("authHostNotAllowed は config になり、接続先とプロバイダ名を伝える", () => {
    const err = toProviderErrorFromStart(
      new NativeHttpError("authHostNotAllowed", "evil.example.com"),
      { secretLabel: "OpenAI" },
    );

    expect(err?.kind).toBe("config");
    expect(err?.message).toBe(
      "この接続先には API キーを送れません: evil.example.com。OpenAI のエンドポイントを既定の値に戻してください",
    );
  });

  it("invalidHeader は config になる", () => {
    const err = toProviderErrorFromStart(new NativeHttpError("invalidHeader", "X-Bad"), {});

    expect(err?.kind).toBe("config");
    expect(err?.message).toBe("リクエストヘッダーが不正です: X-Bad");
  });

  it("network は null を返し、呼び出し側の既存の network 変換に任せる(5.2)", () => {
    expect(
      toProviderErrorFromStart(new NativeHttpError("network", "connection refused"), {}),
    ).toBeNull();
  });

  it("AbortError・開始時エラーの形でない IPC の reject・その他の値は null を返す", () => {
    expect(
      toProviderErrorFromStart(new DOMException("aborted", "AbortError"), {}),
    ).toBeNull();
    // NativeHttpError に包まれていない、開始時エラーと同じ形のオブジェクトも変換しない
    // (nativeFetch が包んだものだけを開始時エラーとみなす)。
    expect(
      toProviderErrorFromStart({ kind: "invalidUrl", message: "x" }, {}),
    ).toBeNull();
    expect(toProviderErrorFromStart("command http_request not found", {})).toBeNull();
    expect(toProviderErrorFromStart(new TypeError("Failed to fetch"), {})).toBeNull();
    expect(toProviderErrorFromStart(undefined, {})).toBeNull();
  });
});
