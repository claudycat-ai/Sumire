import { invoke } from "@tauri-apps/api/core";

/** Rust 側 list_snapshots の戻り値。 */
export interface SnapshotEntry {
  /** `history/` 内のファイル名(例: "2026-04-28T15-30-00.json") */
  name: string;
  /** JSON 内の "timestamp"。タイムゾーン付き ISO 文字列。 */
  timestamp: string;
  /** 含まれるファイル数。 */
  fileCount: number;
}

interface RawSnapshotEntry {
  name: string;
  timestamp: string;
  file_count: number;
}

/** 仕様 §334-345 に対応する JSON 構造。 */
export interface SnapshotPayload {
  snapshotVersion: string;
  timestamp: string;
  files: Record<string, string>;
}

/**
 * プロジェクト全体のスナップショットを保存する。
 *
 * - timestamp: ローカルタイム由来の `YYYY-MM-DDTHH-mm-ss`(ファイル名 stem)
 * - isoTimestamp: ISO8601 タイムスタンプ(JSON に埋める "timestamp" フィールド)
 * - maxKeep: 保持件数(0 以下なら削除なし)
 *
 * 戻り値は生成された `history/` 内のファイル名。
 */
export async function saveSnapshot(
  projectPath: string,
  timestamp: string,
  isoTimestamp: string,
  maxKeep: number,
): Promise<string> {
  return invoke<string>("save_snapshot", {
    projectPath,
    timestamp,
    isoTimestamp,
    maxKeep,
  });
}

/** スナップショット一覧(新しい順)。 */
export async function listSnapshots(
  projectPath: string,
): Promise<SnapshotEntry[]> {
  const raw = await invoke<RawSnapshotEntry[]>("list_snapshots", { projectPath });
  return raw.map((e) => ({
    name: e.name,
    timestamp: e.timestamp,
    fileCount: e.file_count,
  }));
}

/** 1 つのスナップショット JSON を読み込んでパース済みの構造で返す。 */
export async function readSnapshot(
  projectPath: string,
  name: string,
): Promise<SnapshotPayload> {
  const text = await invoke<string>("read_snapshot", { projectPath, name });
  const parsed = JSON.parse(text) as SnapshotPayload;
  return parsed;
}

/**
 * 現在時刻からスナップショット用のローカルタイム文字列ペアを作る。
 *
 * - filenameStem: `2026-04-28T22-35-00`(ファイル名用、`:` を `-` に)
 * - iso: `2026-04-28T22:35:00+09:00`(JSON 埋め込み用、タイムゾーンオフセット付き)
 */
export function buildSnapshotTimestamp(now: Date = new Date()): {
  filenameStem: string;
  iso: string;
} {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const M = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const m = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const filenameStem = `${y}-${M}-${d}T${h}-${m}-${s}`;
  const iso = `${y}-${M}-${d}T${h}:${m}:${s}${formatTimezoneOffset(now)}`;
  return { filenameStem, iso };
}

function formatTimezoneOffset(d: Date): string {
  const offMin = -d.getTimezoneOffset(); // 例: JST → 540
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
