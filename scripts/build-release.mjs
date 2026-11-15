// 配布用のリリースビルドを作る。`pnpm tauri build` を、ビルドした PC のパスが
// 実行ファイルに残らない設定で呼ぶ。
//
// Rust は、エラー表示のためにソースファイルの場所を実行ファイルに埋め込む。そのまま
// ビルドすると、Cargo のレジストリや Rust のツールチェーンの場所(ホームディレクトリの
// 下にあるので、OS のユーザー名を含む)と、このリポジトリの場所が、配布物に入る。
// `--remap-path-prefix` で、埋め込まれるパスの先頭を固定の文字列に置き換える。
//
// 使い方: `pnpm build:release`(後ろに付けた引数は `tauri build` にそのまま渡す)
//
// - 置き換える対象はこの PC の場所から求めるので、設定ファイルにパスを書かない。
// - フラグは `CARGO_ENCODED_RUSTFLAGS` で渡す(区切りが 0x1f なので、パスに空白が
//   あっても崩れない)。すでに値があれば、その後ろに足す。
// - フラグが変わると Cargo は全体をビルドし直すので、`pnpm tauri build` のあとの
//   初回は時間がかかる。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const cargoHome = process.env.CARGO_HOME ?? join(home, ".cargo");
const rustupHome = process.env.RUSTUP_HOME ?? join(home, ".rustup");

// 同じパスに複数の指定が当たるときは、後ろの指定が勝つ。広い指定(ホーム)を先に、
// 狭い指定(Cargo、rustup、リポジトリ)を後ろに並べる。
const remaps = [
  [home, "/home"],
  [cargoHome, "/cargo"],
  [rustupHome, "/rustup"],
  [repoRoot, "/sumire"],
];

const SEPARATOR = "\x1f";
const flags = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
const existing = process.env.CARGO_ENCODED_RUSTFLAGS;
const encoded = [...(existing ? existing.split(SEPARATOR) : []), ...flags].join(
  SEPARATOR,
);

const result = spawnSync("pnpm", ["tauri", "build", ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: encoded },
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
