# 初期検証(MVP 着手時の前提)

本書は MVP 着手時に **検証用に選んだ前提条件と、その選択理由**を保管する歴史資料。現在は別のモデル/環境で利用していても、当時「なぜそのモデルで MVP の妥当性を判断したか」を後から辿れるように残す。

実装上の現在値(現在使っているモデル・サーバー設定等)は本書ではなく `architecture.md` および各プロジェクトの `sumire.json` を参照。

## 初期検証モデル

**`japanese-stablelm-instruct-alpha-7b-v2`**

- コンテキスト長: 2048 トークン
- パラメータ数: 7B
- 種別: 日本語 Instruct チューニング済み

### このモデルを選んだ理由

- 日本語生成の品質が確認されている
- 軽量(7B)でローカル単機検証に向く
- 古いモデルだが MVP 検証用としては十分(Sumire の MVP 評価は「2048 のような厳しいコンテキスト制約下でも執筆 UX が成立するか」だったため、むしろ短いコンテキストの方が ContextBuilder の妥当性を評価できる)

### 実装は特定モデルに縛らない

このモデルは **検証時の前提**であって **実装の前提ではない**。Sumire の AI プロバイダ抽象は OpenAI 互換 API 全般を想定しており、当時より新しい・大きい・賢いモデルでも同じインターフェースで動作する。コンテキスト長や挙動の差は ContextBuilder と GenerationParameters で吸収する。

将来「japanese-stablelm-instruct-alpha-7b-v2 がもう使えない」状況になっても、本書は当時の検証根拠として読めれば十分。

## 初期検証時の推論サーバー

**text-generation-webui** の API モード(OpenAI 互換 HTTP API)。

- 例: `http://127.0.0.1:5000/v1/...`
- 起動・停止は手動。Sumire は管理しない(`architecture.md` 参照)。

text-generation-webui を選んだ理由は、ローカルで OpenAI 互換 API を立てる選択肢の中で(MVP 着手時点では)もっとも検証実績があったため。Ollama / LM Studio 等への横展開は同じアダプタ(`OpenAICompatibleAdapter`)で動く設計にしてある。

## 関連文書

- プロダクト哲学: `../spec/vision.md`
- アーキテクチャ詳細: `../spec/architecture.md`
- 拡張ロードマップ: `../spec/roadmap.md`
