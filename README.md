# Sumire

[English README](README.en.md)

ローカル LLM とクラウド AI を切り替えながら、日本語 Web 小説を執筆できるデスクトップアプリ。

AI を「優秀な共著者」として使い、Copilot 風の Tab 採用 UX で続きを提案する。

どんな道具かを画面写真つきで紹介した記事が、note にあります: [書くのは自分。続きだけ AI に出してもらう執筆ツール「Sumire」を作りました](https://note.com/claudycat/n/n157df9665e43)

Sumire から `llama-server` を起動して使う仕組みと、そのときに実測して決めたことは、Zenn の記事にまとめました: [デスクトップアプリから llama-server を起動して使うときに決めたこと](https://zenn.dev/claudycat/articles/7de3ce3fe21452)

推論モデルの思考ブロックを、ストリーミング中の応答から取り分ける仕組みも、Zenn の記事にまとめました: [ストリーミング中の応答から、推論モデルの思考ブロックを取り分ける](https://zenn.dev/claudycat/articles/0d468dd38c8231)

Gemma 4 に Completion で続きを書かせるためのプロンプトテンプレートの形も、Zenn の記事にまとめました: [Gemma 4 に /v1/completions で文章の続きを書かせるプロンプトの形](https://zenn.dev/claudycat/articles/4016ffb2735fc3)

API キーを Windows の資格情報マネージャーに保存するときに踏んだ罠も、Zenn の記事にまとめました: [Rust の keyring 3 は、feature を付けないと黙って何も保存しない](https://zenn.dev/claudycat/articles/f5d4df964548e8)

## ステータス

MVP 完成、磨き込みフェーズ。配布バイナリは無署名で提供する(下記「インストール時の注意」参照)。

個人が、自分の執筆のために開発している道具です。動作は保証しません。バージョン 0.x の間は、設定ファイルの形式や操作が、互換性を保たずに変わることがあります。

不具合の報告や要望は Issues に書いてください。目は通しますが、返信や対応は約束できません。Pull Request は、[`docs/spec/vision.md`](docs/spec/vision.md) の「Sumire が守るべき軸」に沿うものだけを検討します。大きな変更は、先に Issue で相談してください。

## このツールについての立場

Sumire は **書き手が主体で執筆する**ことを前提とした補助ツールです。

- **Sumire は続きを「提案」するだけで、本文を書くのは書き手自身です**。AI が出した提案を採用するか、書き直すか、無視するかは、すべて書き手が Tab/Esc で判断します。
- Sumire の利用によって生じた結果(規約違反、炎上、著作権上のトラブル等)について、開発者は責任を負いません。利用は自己責任でお願いします。

書き手が自分の作品の責任を持てる範囲で使う、というのが本ツールの想定です。

### 投稿サイトでの AI 利用の申告

Sumire で書いた小説を Web 小説の投稿サイトに出すときは、**各サイトの規約・ガイドラインを必ず確認し、AI の利用を正しく申告してください**。

申告の区分は、道具の使い方の心構えではなく、**原稿に何が残ったか**で決まります。`Tab` で採用した提案の文が本文に残っていれば、そこは AI が生成した文章です。Sumire は「書き手が主体の補助ツール」ですが、これは投稿サイトの言う「補助的な利用」と同じ意味ではありません。

以下は 2026 年 11 月時点の整理です。区分の定義や運用は変わるので、投稿の前に公式の案内を読んでください。

- **小説家になろう**: 2026 年 6 月 9 日から、作品ごとに「AI利用状況」の設定が必須です([ガイドライン](https://syosetu.com/site/ai/))。
  - `Tab` で採用したひと続きの文章が、そのまま本文に残っている箇所がある → **AI直接使用**(キーワードに「AI直接使用」が表示されます)。語句を直した程度なら、これに当たります。
  - 提案は下書きや素材にとどめ、全体を自分の表現に書き直した → **AI間接利用**
  - **AI補助的利用**は、AI が本文の執筆に関与しない場合(アイデア出し、資料調査、誤字のチェックなど)の区分です。Sumire の続き提案を本文に使ったなら、当てはまりません。
  - 作者の加筆・修正が一切なく、本文の全てが AI の生成である作品は投稿できません。実際と異なる設定も禁止されています。
- **カクヨム**: 生成 AI を使った作品には、推奨タグを付けるよう案内されています([お知らせ](https://kakuyomu.jp/info/entry/geneai_tag))。通常の投稿では推奨、カクヨムコンテストの応募作では必須です。
  - AI が生成した文(軽く直したものを含む)が本文の半分以上 → **AI本文利用**
  - 半分未満 → **AI本文一部利用**
  - AI の案や資料をもとに自分で本文を書いた、校正だけに使った → **AI補助利用**
- **ノベルアップ+**: 2026 年 10 月から、作品ごとに AI の利用区分の設定が必須です([ガイドライン](https://novelup.plus/help/detail/AI%E7%94%9F%E6%88%90%E4%BD%9C%E5%93%81%E3%81%AE%E6%8A%95%E7%A8%BF%E3%81%AB%E9%96%A2%E3%81%99%E3%82%8B%E3%82%AC%E3%82%A4%E3%83%89%E3%83%A9%E3%82%A4%E3%83%B3))。
  - AI が生成した文を、一部でもそのまま本文に使った → **AI生成作品**。応援ランキングの対象外で、コンテストには原則参加できません。公開後に、ほかの区分へは変更できません。
  - AI の文を本文にそのまま使わず、アイデア出しや誤字の確認などに使った → **AI補助利用作品**
  - `Tab` で採用した文が本文に残るなら、AI生成作品に当たります。迷う場合は AI生成作品に設定するよう案内されています。
- コンテストや新人賞は、サイト全体とは別の条件を定めていることがあります。応募要項を確認してください。

## ダウンロード

Windows(x64)向けのインストーラを、次の 2 か所で配布しています。中身は同じです。

- [GitHub の Releases](https://github.com/claudycat-ai/Sumire/releases)
- [BOOTH](https://claudycat.booth.pm/items/9158205)(無料版のほかに、開発を応援してくださる方向けの「応援版」があります。中身は無料版と同じです)

## インストール時の注意

### Windows: SmartScreen 警告について

本ツールはコード署名を行っていないため、初回起動時に Windows SmartScreen の警告画面が表示されます。これは無署名アプリ全般に出る警告で、Sumire 固有の問題ではありません。

警告画面で「**詳細情報**」をクリックすると、「**実行**」ボタンが表示されるので、それを押せば起動します。

ソースコードは公開しているので、不安な場合はビルドしてご利用ください(下記「ソースからビルドする」参照)。

## はじめかた

Sumire は推論エンジンを持ちません。続きを提案させるには、手元の PC で動く推論サーバーが要ります。ここでは、Sumire が llama.cpp の `llama-server` を起動する使い方を説明します。

### 用意するもの

- **`llama-server` の実行ファイル**: [llama.cpp のリリース](https://github.com/ggml-org/llama.cpp/releases)から、自分の GPU に合ったビルドを入手します。Sumire には入っていません。
- **gguf 形式のモデル**: 1 つのフォルダの直下に置きます。作者は Gemma 4 系のモデルで使っています。

### 手順

1. Sumire を起動し、「新規作成」で親フォルダを選び、タイトルと著者を入れます。親フォルダの中に、タイトルの名前でプロジェクトのフォルダが作られます。
2. 左ペインの「章」の見出しにある「+」を押して、章を 1 つ作ります。
3. 左下の「LLM 切替」で、「llama.cpp(Sumire が起動)」の名前をクリックします。右下が AI 設定画面に切り替わるので、次を入れます。枠が狭いときは、上のメモとの境界を上へ引くと広がります。
   - **llama-server の実行ファイル**: 入手した `llama-server` のパス
   - **モデルのフォルダ**: gguf を置いたフォルダ
   - **コンテキスト長**: 一覧に並んだモデルごとに入れます。GPU メモリに収まる値にしてください。大きすぎても読み込みは失敗せず、生成が遅くなります。
4. 同じ行の左端の `○` をクリックして、このプロバイダを使う状態(`●`)にします。`▸` で行を開き、使うモデルをクリックします。
5. 同じ AI 設定画面の「プロンプトテンプレート」で、モデルに合ったテンプレートを選びます(下の「プロンプトテンプレートを選ぶ」)。
6. 章を開いて本文を数行書き、`Shift+Enter` を押します。**最初の 1 回はモデルの読み込みだけ**で、提案は出ません。「準備ができました」と出たら、もう一度 `Shift+Enter` を押します。
7. 薄い色で出た提案を、`Tab` で採用するか、`Esc` で却下します。

### プロンプトテンプレートを選ぶ

指示に答える形で学習されたモデル(Gemma、ChatML 系など)は、モデルによっては、テンプレートを指定しないと出力が崩れます。Gemma 4 では、短い本文なら指定なしでも続きが出ましたが、モデルに合ったテンプレートを指定して使う想定です。

AI 設定画面の「プロンプトテンプレート」で選びます。選んだ時点で保存され、プロジェクトを開き直さなくても、次の提案から効きます。新規プロジェクトは「指定なし」(テンプレートを使わず、内容をそのまま連結して送る)で始まります。

| 名前 | 対象 | 思考 |
| --- | --- | --- |
| `gemma4` | Gemma 4 | なし |
| `gemma4-think` | Gemma 4 | あり |
| `chatml` | ChatML 形式のモデル | モデルに任せる |
| `chatml-nothink` | ChatML 形式のモデル | 止める |

`gemma4-think` を選ぶと、思考を本文と分けるためのタグ(`<|channel>` と `<channel|>`)を、Sumire が `sumire.json` の `thinking` に足します。ほかの設定は書き換えません。次の 2 つは、思考の長さに合わせて調整してください。

- **Max Tokens**: 思考の分も含まれます。新規プロジェクトの既定は 4000 です。1000 未満のときは、画面に案内が出ます。思考の途中で切れるときは上げてください。
- **タイムアウト**: 新規プロジェクトでは、生成が 120 秒を超えるとタイムアウトします。時間がかかるときは、`sumire.json` の同じ欄にある `timeoutMs`(既定は 120000)を上げます。`sumire.json` を書き換えるときは、先にヘッダーの「プロジェクトを閉じる」で閉じ、書き換えたあとに開き直します(`sumire.json` は、プロジェクトを開いたときにだけ読まれます)。

プリセットに無い書式は、`sumire.json` の `aiConfig` → `providers` → `llama-server` の `template` に、`custom` として自分で書けます(上と同じく、プロジェクトを閉じてから書き換えます)。書き方は [`docs/spec/architecture.md`](docs/spec/architecture.md) の「プロンプトテンプレート」を参照してください。自由記述が書かれていると、画面には「自由記述(sumire.json)」と出ます。画面でプリセットを選び直すと、確認のうえで置き換わります。

### キー操作

| 操作 | キー |
| --- | --- |
| 続きの提案を要求する | `Shift+Enter` |
| 提案を採用する | `Tab` |
| 提案を却下する / 生成を止める | `Esc` |
| 提案をメモに退避する | `Alt+M` |
| 選んだ場面から挿し絵の情景文を作り、メモに追記する | `Alt+I` |
| 保留中の保存をすぐ書き出す | `Ctrl+S` |
| スナップショットを保存する | `Ctrl+Shift+S` |

キャラクターや世界観のファイルは、右下の設定タブで「コンテキストに含める」を ON にしたものだけが、提案のたびにモデルへ渡ります。

### すでに推論サーバーを動かしている場合

text-generation-webui など、OpenAI 互換の API(`/v1/completions`)を持つ推論サーバーを自分で起動しているなら、「LLM 切替」の「OpenAI 互換」を使います。AI 設定画面で、エンドポイント、モデル、Context Window を、動かしているサーバーに合わせてください。既定値は `http://127.0.0.1:5000/v1` とコンテキスト長 8192 です。コンテキスト長は、読み込んだモデルに合わせて変えてください。プロンプトテンプレートも、同じ AI 設定画面で選びます。

作者が動作を確かめているのは、`llama-server` と text-generation-webui です。

### うまくいかないとき

| 症状 | 確かめること |
| --- | --- |
| 「読み込みに失敗しました」と出る | AI 設定画面の「サーバーの出力」。コンテキスト長が GPU メモリに対して大きすぎないか |
| 提案が崩れている、指示文のようなものが混じる | AI 設定画面の「プロンプトテンプレート」が、モデルに合っているか |
| 提案が空、または思考だけで終わる | 「Max Tokens」を上げる |
| 「応答がタイムアウトしました」と出る | `sumire.json` の `timeoutMs` を上げる |
| 「この接続先には API キーを送れません」と出る(OpenAI) | エンドポイントを `https://api.openai.com/v1` に戻す。API キーは、この接続先にだけ送られます |
| 前のほうの本文を踏まえていない | コンテキスト長。収まらない本文は、先頭から削って送られます |
| 「推論サーバーに接続できません」と出る(OpenAI 互換) | 推論サーバーが起動しているか。エンドポイントのポート番号 |

## ソースからビルドする

### 必要なツール

- Node.js + [pnpm](https://pnpm.io/)(`package.json` の `packageManager` に固定バージョンあり)
- Rust toolchain([rustup](https://rustup.rs/) で stable を入れる)
- Windows: Microsoft Edge [WebView2 ランタイム](https://developer.microsoft.com/microsoft-edge/webview2/)(Win11 は同梱)、Build Tools for Visual Studio(C++ ビルドツール)
- macOS: Xcode Command Line Tools / Linux: 公式 [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) 参照

### 手順

```bash
pnpm install
pnpm tauri build
```

成果物の出力先:

- 実行ファイル: `src-tauri/target/release/sumire.exe`
- NSIS インストーラ: `src-tauri/target/release/bundle/nsis/Sumire_<version>_x64-setup.exe`
- MSI インストーラ: `src-tauri/target/release/bundle/msi/Sumire_<version>_x64_en-US.msi`

### ほかの人に配るビルドを作るとき

```bash
pnpm build:release
```

Rust は、エラー表示のためにソースファイルの場所を実行ファイルに埋め込みます。`pnpm tauri build` のままだと、ビルドした PC のホームディレクトリ(OS のユーザー名を含む)やリポジトリの場所が、配布物に入ります。`pnpm build:release` は、それらを固定の文字列(`/cargo`、`/rustup`、`/sumire` など)に置き換えてから `pnpm tauri build` を呼びます([`scripts/build-release.mjs`](scripts/build-release.mjs))。成果物の出力先は同じです。自分で使うだけなら、`pnpm tauri build` で構いません。

### 注意: `cargo build --release` は直接叩かない

リリース用バイナリは必ず `pnpm tauri build` 経由でビルドすること。`cargo build --release` を直接叩くと `tauri/custom-protocol` フィーチャが立たず、release ビルドでも `tauri.conf.json` の `devUrl` を読みに行ってしまい、起動時に `ERR_CONNECTION_REFUSED` で WebView が真っ暗になる。

これは本リポジトリが `Cargo.toml` に `[features]` セクションを置かない構成を取っているため。`pnpm tauri build` は内部で `--features tauri/custom-protocol` を cargo に渡してくれる。

## ライセンス

Copyright 2026 Claudy Cat

[Apache License 2.0](LICENSE)

## ドキュメント

- [`docs/spec/vision.md`](docs/spec/vision.md) — プロダクトビジョン・差別化軸(まずここを読む)
- [`docs/spec/ux.md`](docs/spec/ux.md) — UX / インタラクション仕様
- [`docs/spec/architecture.md`](docs/spec/architecture.md) — システム構成・モジュール分割・データ形式
- [`docs/spec/roadmap.md`](docs/spec/roadmap.md) — 拡張ロードマップ
- [`docs/spec/polish-backlog.md`](docs/spec/polish-backlog.md) — 磨き込み TODO
- [`docs/history/`](docs/history/) — MVP 着手時の検証記録など歴史資料
- [`.kiro/steering/`](.kiro/steering/) — 永続的なプロジェクト知識(steering)

## 技術スタック

- Tauri 2 + React 19 + TypeScript
- Rust(Tauri ネイティブ層、最小限)
- CodeMirror 6(エディタ)
- OpenAI 互換 HTTP API をプロバイダ抽象として採用

詳細は [`docs/spec/architecture.md`](docs/spec/architecture.md) 参照。

## 開発スタイル

仕様駆動開発(cc-sdd 採用)。実装の前に仕様を書き、合意してから手を動かす。詳細は `CLAUDE.md` 参照。

## 名称について

**Sumire**(すみれ)。「墨入れ」と「菫」のダブルミーニング。

執筆の伴侶として、書き手のそばに静かに咲くプロダクトを目指す。

## クレジット

- 仕様駆動開発のスキルとテンプレート(`.claude/skills/kiro-*/`、`.kiro/settings/templates/`): [cc-sdd](https://github.com/gotalab/cc-sdd) v3.0.2(MIT License)。ライセンス文と変更点は [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)。
- アプリアイコン: Adobe Firefly で生成(Adobe の商用利用許諾下)。マスター画像は `src-tauri/icons/source/icon-source.png`、`pnpm tauri icon` で各サイズへ展開している。
