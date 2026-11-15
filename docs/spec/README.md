# Sumire 仕様書 — 読み方ガイド

`docs/spec/` には Sumire の恒久的な仕様書を置く。本ファイルは各文書の役割と読み順の見取り図。

## 文書の関係

```
              vision.md (哲学・差別化軸)
                    │
        ┌───────────┼───────────┐
        ↓           ↓           ↓
      ux.md  architecture.md  roadmap.md
     (UX/UI) (内部仕様・構造) (拡張テーマ)
        └───────────┼───────────┘
                    ↓
             polish-backlog.md
              (磨き込み TODO)
```

- 上位ほど抽象的・恒久的。下位ほど具体的・流動的。
- 機能追加判断は `vision.md` の差別化軸 → `roadmap.md` の方針 → 必要なら `.kiro/specs/<feature>/` で個別 spec を切る、という流れで進める。

## 読む順序

### 初めて読む人(将来の自分含む)

1. **`vision.md`** — Sumire は何のために作っているか、何を守るか
2. **`ux.md`** — 書き手が触るものはどう動くか
3. **`architecture.md`** — それを支える構造・データ形式・プロトコル

ここまでで Sumire のプロダクト像と実装の輪郭が分かる。

### 機能追加・変更を考えるとき

1. **`vision.md` の差別化軸** — その変更は軸に沿うか
2. **`roadmap.md`** — 既に検討済みのテーマか、採らない方針に該当するか
3. **`polish-backlog.md`** — 既に磨き込み TODO として登録されているか

新規 spec を切るなら `/kiro-spec-init <feature>` で `.kiro/specs/<feature>/` に進む(運用は `CLAUDE.md` 参照)。

### バグ修正・小さな磨き込み

`polish-backlog.md` を見て該当があれば直接実装に進む(spec を切る必要なし)。

## 各文書の役割

| 文書 | 役割 | 寿命 |
|---|---|---|
| `vision.md` | プロダクトの哲学・差別化軸・対象ユーザー | 恒久 |
| `ux.md` | UX(ユーザー体験)と UI 仕様 | 恒久(機能追加で更新) |
| `architecture.md` | 内部仕様・データ形式・プロトコル・ファイル管理 | 恒久(技術判断で更新) |
| `roadmap.md` | 将来取り組む可能性のある拡張テーマと、採らない方針 | 流動 |
| `polish-backlog.md` | 磨き込み TODO の inbox | 流動(着手で消える) |

## 関連ディレクトリ

- `.kiro/steering/` — 永続的なプロジェクト知識(steering)。Claude が project memory として常時参照する要約版。詳細仕様は本ディレクトリ(`docs/spec/`)が正。
- `.kiro/specs/<feature>/` — 個別機能の作業領域(requirements / design / tasks)。完了したら凍結 or 削除。作業記録なので、公開しているリポジトリには含めていない。
- `docs/history/` — MVP 着手時の検証記録など歴史資料。現在の運用には影響しないが、過去の判断根拠を辿るために保管。

## 番号接頭辞について

旧版では `00-vision.md` `01-ux.md` `02-architecture.md` `99-polish-backlog.md` の番号付きで読み順を示していた。文書追加のたびに番号が悩ましくなるため番号は撤廃し、読み順は本ファイルで示す方針に切り替えた(2026-05-08)。
