# Sumire — Agentic SDLC and Spec-Driven Development

Sumire は「ローカル LLM とクラウド AI を切り替えながら日本語 Web 小説を執筆する Tauri 製デスクトップアプリ」。AI を共著者として使い、Copilot 風の Tab 採用 UX で続きを提案する。

詳細は `.kiro/steering/` と `docs/spec/` にある。どちらも自動では読み込まれないので、作業に関係する箇所を読んでから着手する。最初に読むべきは `docs/spec/README.md`(読み方ガイド)。

## Project Context

### Paths

- Steering: `.kiro/steering/`(永続的なプロジェクト知識。product / tech / structure)
- Specs: `.kiro/specs/`(個別機能の作業領域。requirements / design / tasks。作業記録なので、配布用の書き出しには含めない)
- Detailed specs: `docs/spec/`(恒久的な仕様書。読み順は `docs/spec/README.md` 参照)
- Polish backlog: `docs/spec/polish-backlog.md`(磨き込み TODO の inbox)

### Steering vs Specification

- **Steering** (`.kiro/steering/`): Guide AI with project-wide rules and context.
- **Specs** (`.kiro/specs/`): Formalize development process for individual features.
- **docs/spec/**: 詳細仕様の正。steering は要約 + 参照ポインタ。

### Active Specifications

- Check `.kiro/specs/` for active specifications
- Use `/kiro-spec-status [feature-name]` to check progress

## Development Guidelines

- Think in English, generate responses in Japanese. Write Markdown content in project files (e.g., requirements.md, design.md, tasks.md, research.md, validation reports) in the language set in spec.json.language.

## 開発スタイル(Sumire 固有)

仕様駆動の一般則は次の 3 つ。仕様 → 合意 → 実装の順で進める。撤退の判断は、理由を仕様書の側に残す。差別化軸を歪めない。以下は Sumire 固有の運用。

- **新機能や非自明な変更**は cc-sdd ワークフロー(下記 Minimal Workflow)で `.kiro/specs/<feature>/` を切る。
- **磨き込み・配色調整・小さなバグ修正**など、仕様化する価値が薄いものは spec を切らずに直接実装してよい。線引きは `docs/spec/polish-backlog.md` の方針(「仕様に書く価値があるか?」)に従う。
- **差別化軸の正**は `docs/spec/vision.md` の「Sumire が守るべき軸」と `docs/spec/roadmap.md` の「採らない方針」。新機能着手前に必ず照らす。

## Minimal Workflow

- Phase 0 (optional): `/kiro-steering`, `/kiro-steering-custom`
- Discovery: `/kiro-discovery "idea"` — determines action path, writes brief.md + roadmap.md for multi-spec projects
- Phase 1 (Specification):
  - Single spec: `/kiro-spec-quick {feature} [--auto]` or step by step:
    - `/kiro-spec-init "description"`
    - `/kiro-spec-requirements {feature}`
    - `/kiro-validate-gap {feature}` (optional: for existing codebase)
    - `/kiro-spec-design {feature} [-y]`
    - `/kiro-validate-design {feature}` (optional: design review)
    - `/kiro-spec-tasks {feature} [-y]`
  - Multi-spec: `/kiro-spec-batch` — creates all specs from roadmap.md in parallel by dependency wave
- Phase 2 (Implementation): `/kiro-impl {feature} [tasks]`
  - Without task numbers: autonomous mode (subagent per task + independent review + final validation)
  - With task numbers: manual mode (selected tasks in main context, still reviewer-gated before completion)
  - `/kiro-validate-impl {feature}` (standalone re-validation)
- Progress check: `/kiro-spec-status {feature}` (use anytime)

## Skills Structure

Skills are located in `.claude/skills/kiro-*/SKILL.md`

- Each skill is a directory with a `SKILL.md` file
- Skills run inline with access to conversation context
- Skills may delegate parallel research to subagents for efficiency
- Additional files (templates, examples) can be added to skill directories
- `kiro-review` — task-local adversarial review protocol used by reviewer subagents
- `kiro-debug` — root-cause-first debug protocol used by debugger subagents
- `kiro-verify-completion` — fresh-evidence gate before success or completion claims
- spec 作成・実装・レビュー・完了確認など、kiro-* スキルが扱う作業ではそのスキルを使う。
- `kiro-spec-quick` と `kiro-discovery` は、cc-sdd v3.0.2 のテンプレから強調表記(CRITICAL / MUST)を平叙文に直してある。cc-sdd を更新すると元に戻るので、更新後に当て直す。

## Development Rules

- 3-phase approval workflow: Requirements → Design → Tasks → Implementation
- Human review required each phase; use `-y` only for intentional fast-track
- Keep steering current and verify alignment with `/kiro-spec-status`
- 実装の細部は自律的に進め、依頼された範囲をこの実行内で完了させる。仕様判断や選択肢が出る場面では、作者に確認してから進める。

## Steering Configuration

- Load entire `.kiro/steering/` as project memory
- Default files: `product.md`, `tech.md`, `structure.md`
- Custom files are supported (managed via `/kiro-steering-custom`)
