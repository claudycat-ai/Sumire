// Vitest のテスト前共通セットアップ。
// i18n を必ず初期化し、テスト時の言語を ja に固定する
// (既存テストは UI ラベルを日本語ハードコードで判定するため)。
import i18n from "@/i18n";

void i18n.changeLanguage("ja");
