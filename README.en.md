# Sumire

A desktop app for writing Japanese web novels with seamless switching between local LLMs and cloud AI.

Sumire treats AI as a "skilled co-author" and offers a Copilot-style Tab adoption UX for inline continuation suggestions.

An introduction with screenshots is available on note (in Japanese): [書くのは自分。続きだけ AI に出してもらう執筆ツール「Sumire」を作りました](https://note.com/claudycat/n/n157df9665e43)

How Sumire launches and manages `llama-server`, and the measurements behind those decisions, are written up on Zenn (in Japanese): [デスクトップアプリから llama-server を起動して使うときに決めたこと](https://zenn.dev/claudycat/articles/7de3ce3fe21452)

How Sumire separates a reasoning model's thinking blocks from a streaming response is also written up on Zenn (in Japanese): [ストリーミング中の応答から、推論モデルの思考ブロックを取り分ける](https://zenn.dev/claudycat/articles/0d468dd38c8231)

> **Note for English-speaking users:** Sumire is designed and optimized for **Japanese web novel writing**. UI translations are provided, but context handling, typography, and chapter/episode structure are tuned for Japanese-language workflows. English-language fiction is a future extension and not a primary use case.

## Status

MVP complete, polish phase. Distributed binaries are unsigned (see "Installation Notes" below).

Sumire is a tool one person develops for their own writing. It comes with no guarantee that it works. While the version is 0.x, the settings file format and the controls may change without backward compatibility.

Please report bugs and requests in Issues. They will be read, but a reply or a fix is not promised. Pull requests are considered only when they fit "Sumire が守るべき軸" (the axes Sumire keeps) in [`docs/spec/vision.md`](docs/spec/vision.md). For a large change, open an issue first.

## Stance

Sumire is a supplementary tool that assumes **the writer is the primary author**.

- **Sumire only "suggests" continuations; the writer writes the actual text.** Whether to accept, rewrite, or ignore each suggestion is decided by the writer via Tab/Esc.
- The author of Sumire is not responsible for any consequences of its use (rule violations, public backlash, copyright disputes, etc.). Use at your own risk.

The intended use is for writers to operate within a scope where they can take responsibility for their own work.

### Declaring AI use on publishing platforms

If you post a novel written with Sumire to a web fiction platform, **always check that platform's rules and guidelines, and declare your AI use accurately**.

Which category applies depends on **what ends up in the manuscript**, not on how you think of the tool. If a suggestion you accepted with `Tab` remains in the text, that passage is AI-generated. Sumire is a supplementary tool with the writer as the primary author, but that is not the same thing as what the platforms call "assistive use".

The summary below is as of November 2026. Definitions and enforcement change, so read the official pages before you post.

- **Shōsetsuka ni Narō**: Since June 9, 2026, every work must have its "AI usage status" (AI利用状況) set ([guideline](https://syosetu.com/site/ai/)).
  - A continuous passage accepted with `Tab` remains in the body as-is → **Direct use** (AI直接使用). The keyword "AI直接使用" is shown on the work. Passages where you only changed a few words still count.
  - Suggestions served only as drafts or material, and you rewrote the whole in your own words → **Indirect use** (AI間接利用).
  - **Assistive use** (AI補助的利用) is the category for cases where AI takes no part in writing the body (brainstorming, research, typo checks, and so on). It does not apply if you used Sumire's suggestions in the body.
  - Works whose body is entirely AI-generated, with no additions or edits by the author, cannot be posted. Setting a status that differs from the facts is also prohibited.
- **Kakuyomu**: Works that use generative AI are asked to carry one of the recommended tags ([announcement](https://kakuyomu.jp/info/entry/geneai_tag)). Tagging is recommended for ordinary posts and mandatory for Kakuyomu Contest entries.
  - AI-generated text (including lightly edited text) makes up half or more of the body → **AI本文利用**
  - Less than half → **AI本文一部利用**
  - You wrote the body yourself from AI ideas or material, or used AI only for proofreading → **AI補助利用**
- **Novelup+**: Since October 2026, every work must have its AI usage category set ([guideline](https://novelup.plus/help/detail/AI%E7%94%9F%E6%88%90%E4%BD%9C%E5%93%81%E3%81%AE%E6%8A%95%E7%A8%BF%E3%81%AB%E9%96%A2%E3%81%99%E3%82%8B%E3%82%AC%E3%82%A4%E3%83%89%E3%83%A9%E3%82%A4%E3%83%B3)).
  - AI-generated text is used as-is in the body, even in part → **AI生成作品** (AI-generated work). Such works are excluded from the support rankings and, as a rule, cannot enter contests. The category cannot be changed to another one after publication.
  - AI text is not used as-is in the body, and AI was used for brainstorming, typo checks, and so on → **AI補助利用作品** (AI-assisted work).
  - If text accepted with `Tab` remains in the body, the work is an AI生成作品. The guideline asks you to choose AI生成作品 when in doubt.
- Contests and newcomer awards may set conditions that differ from the site-wide rules. Check the entry guidelines.

## Download

Installers for Windows (x64) are distributed in two places. The files are the same.

- [GitHub Releases](https://github.com/claudycat-ai/Sumire/releases)
- [BOOTH](https://claudycat.booth.pm/items/9158205) (a free edition, plus a "supporter edition" for those who want to support development; its contents are the same as the free edition. The page is in Japanese)

## Installation Notes

### Windows: SmartScreen Warning

This tool is not code-signed, so Windows SmartScreen will display a warning on first launch. This is a generic warning shown for all unsigned applications, not a Sumire-specific issue.

On the warning screen, click **More info**, then click **Run anyway** to launch.

The source code is open; if you have concerns, you can build it yourself (see "Building from Source" below).

## Getting Started

Sumire has no inference engine of its own. To get suggestions, you need an inference server running on your PC. This section covers the setup where Sumire starts llama.cpp's `llama-server` for you.

Labels below are those of the English UI.

### What you need

- **The `llama-server` executable**: get a build that matches your GPU from the [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases). It is not bundled with Sumire.
- **A model in gguf format**: place it directly under a single folder. The author uses Gemma 4 family models.

### Steps

1. Launch Sumire, click "New Project", choose a parent folder, and enter a title and author. A project folder named after the title is created inside the parent folder.
2. In the left pane, click "+" on the "Chapters" heading to create a chapter.
3. In "LLM Switcher" at the bottom left, click the name "llama.cpp (started by Sumire)". The bottom-right pane switches to the AI settings. Fill in the following. If the pane is too small, drag its border with the memo pane upward.
   - **llama-server executable**: the path to the `llama-server` you downloaded
   - **Models folder**: the folder that holds your gguf files
   - **Context size**: one value for each model in the list. Choose a value that fits in your GPU memory. A value that is too large does not fail to load; generation just gets slow.
4. Click `○` at the left end of the same row to make this the active provider (`●`). Expand the row with `▸` and click the model to use.
5. In the same AI settings, choose the template that matches your model under "Prompt template" (see "Choosing a prompt template" below).
6. Open the chapter, write a few lines, and press `Shift+Enter`. **The first press only loads the model**; no suggestion appears. When the "is ready" toast appears, press `Shift+Enter` again.
7. The suggestion appears in a faint color. Accept it with `Tab` or dismiss it with `Esc`.

### Choosing a prompt template

Some instruction-tuned models (Gemma, ChatML-style models, and so on) produce broken output unless a template is specified. Gemma 4 did continue a short text without one, but Sumire is meant to be used with the template that matches your model.

Choose it under "Prompt template" in the AI settings. The choice is saved as soon as you make it and takes effect from the next suggestion, without reopening the project. New projects start with "None" (no template; the content is joined as-is and sent).

| Name | For | Thinking |
| --- | --- | --- |
| `gemma4` | Gemma 4 | Off |
| `gemma4-think` | Gemma 4 | On |
| `chatml` | ChatML-format models | Left to the model |
| `chatml-nothink` | ChatML-format models | Suppressed |

When you choose `gemma4-think`, Sumire adds the tags that separate thinking from the text (`<|channel>` and `<channel|>`) to `thinking` in `sumire.json`. It does not change any other setting. Adjust these two to the length of the thinking:

- **Max Tokens**: this value includes the tokens spent on thinking. The default for new projects is 4000. When it is below 1000, a hint appears in the settings. Raise it if generation stops in the middle of the thinking.
- **Timeout**: in new projects, a request times out after 120 seconds. If generation takes longer, raise `timeoutMs` (default 120000) in the same section of `sumire.json`. Before editing `sumire.json`, close the project with "Close Project" in the header, and reopen it after editing (`sumire.json` is read only when a project is opened).

For formats not covered by the presets, write your own under `custom` in `template` under `aiConfig` → `providers` → `llama-server` in `sumire.json` (close the project before editing, as above). See "プロンプトテンプレート" in [`docs/spec/architecture.md`](docs/spec/architecture.md) (Japanese). When a custom template is written, the settings show "Custom (sumire.json)". Choosing a preset there replaces it after a confirmation.

### Key bindings

| Action | Key |
| --- | --- |
| Request a continuation | `Shift+Enter` |
| Accept the suggestion | `Tab` |
| Dismiss the suggestion / stop generation | `Esc` |
| Save the suggestion to the memo pane | `Alt+M` |
| Generate an illustration scene description from the selected scene and append it to the memo | `Alt+I` |
| Flush pending autosave now | `Ctrl+S` |
| Save a snapshot | `Ctrl+Shift+S` |

Character and worldbuilding files are sent to the model with each request only when "Include in context" is turned on for them in the settings tabs at the bottom right.

### If you already run an inference server

If you start an inference server with an OpenAI-compatible API (`/v1/completions`) yourself, such as text-generation-webui, use "OpenAI Compatible" in "LLM Switcher". In the AI settings, set Endpoint, Model, and Context Window to match your server. The defaults are `http://127.0.0.1:5000/v1` and a context window of 8192. Set the context window to match the loaded model. Choose the prompt template in the same AI settings.

The author has verified Sumire with `llama-server` and text-generation-webui.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| "Failed to load the model" appears | "Server output" in the AI settings. Whether the context size is too large for your GPU memory |
| Suggestions are broken, or contain instruction-like text | Whether "Prompt template" in the AI settings matches your model |
| Suggestions are empty, or end with thinking only | Raise "Max Tokens" |
| A timeout error appears (shown in Japanese: 「応答がタイムアウトしました」) | Raise `timeoutMs` in `sumire.json` |
| An error says the API key cannot be sent to this endpoint (OpenAI; shown in Japanese: 「この接続先には API キーを送れません」) | Set Endpoint back to `https://api.openai.com/v1`. The API key is sent only to that host |
| Suggestions ignore earlier parts of the text | The context size. Text that does not fit is cut from the beginning before it is sent |
| A connection error appears (OpenAI Compatible; this toast is shown in Japanese: 「推論サーバーに接続できません」) | Whether the inference server is running. The port number in Endpoint |

## Building from Source

### Prerequisites

- Node.js + [pnpm](https://pnpm.io/) (a pinned version is declared via `package.json`'s `packageManager` field)
- Rust toolchain (install stable via [rustup](https://rustup.rs/))
- Windows: Microsoft Edge [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (bundled with Windows 11) and Build Tools for Visual Studio (C++ build tools)
- macOS: Xcode Command Line Tools / Linux: see the official [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)

### Steps

```bash
pnpm install
pnpm tauri build
```

Output locations:

- Executable: `src-tauri/target/release/sumire.exe`
- NSIS installer: `src-tauri/target/release/bundle/nsis/Sumire_<version>_x64-setup.exe`
- MSI installer: `src-tauri/target/release/bundle/msi/Sumire_<version>_x64_en-US.msi`

### Building binaries to give to others

```bash
pnpm build:release
```

Rust embeds source file locations in the executable for error reporting. With plain `pnpm tauri build`, the home directory of the build machine (which includes the OS user name) and the location of the repository end up in the distributed binary. `pnpm build:release` replaces them with fixed strings (`/cargo`, `/rustup`, `/sumire`, and so on) and then calls `pnpm tauri build` ([`scripts/build-release.mjs`](scripts/build-release.mjs)). Output locations are the same. If the build is only for yourself, `pnpm tauri build` is fine.

### Note: do not invoke `cargo build --release` directly

Always build release binaries through `pnpm tauri build`. Running `cargo build --release` directly does **not** enable the `tauri/custom-protocol` feature, so even a release binary will try to load `tauri.conf.json`'s `devUrl` and the WebView fails with `ERR_CONNECTION_REFUSED` on launch.

This is because this repository intentionally omits the `[features]` section from `Cargo.toml`. `pnpm tauri build` passes `--features tauri/custom-protocol` to cargo internally, so the feature is only enabled when building through the Tauri CLI.

## License

Copyright 2026 Claudy Cat

[Apache License 2.0](LICENSE)

## Documentation

Most documentation is in Japanese. Key references:

- [`docs/spec/vision.md`](docs/spec/vision.md) — Product vision and differentiation (read this first)
- [`docs/spec/ux.md`](docs/spec/ux.md) — UX / interaction spec
- [`docs/spec/architecture.md`](docs/spec/architecture.md) — System architecture, module decomposition, data formats
- [`docs/spec/roadmap.md`](docs/spec/roadmap.md) — Extension roadmap
- [`docs/spec/polish-backlog.md`](docs/spec/polish-backlog.md) — Polish TODO list
- [`docs/history/`](docs/history/) — Verification records from MVP development
- [`.kiro/steering/`](.kiro/steering/) — Persistent project knowledge (steering)

## Tech Stack

- Tauri 2 + React 19 + TypeScript
- Rust (Tauri native layer, minimal)
- CodeMirror 6 (editor)
- OpenAI-compatible HTTP API as the provider abstraction

See [`docs/spec/architecture.md`](docs/spec/architecture.md) for details.

## Development Style

Spec-Driven Development (cc-sdd). Specs are written before implementation, agreed upon, then coded. See `CLAUDE.md`.

## About the Name

**Sumire** (すみれ) is a double meaning in Japanese:

- **墨入れ** (sumi-ire): "to apply ink" — a tool for writing.
- **菫** (sumire): the violet flower that blooms quietly in early spring.

The name reflects the product philosophy: a quiet companion for writers, never overshadowing the work itself.

## Credits

- Spec-driven development skills and templates (`.claude/skills/kiro-*/`, `.kiro/settings/templates/`): [cc-sdd](https://github.com/gotalab/cc-sdd) v3.0.2 (MIT License). See [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the license text and modifications.
- App icon: generated with Adobe Firefly (under Adobe's commercial use license). The master image lives at `src-tauri/icons/source/icon-source.png`; `pnpm tauri icon` expands it to all required sizes.

## Japanese README

[README.md](README.md)
