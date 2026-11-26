import { inflateSync } from "node:zlib";
import type { DirtSnapshot } from "../../models/cli-outcome";
import { LIVE_FOLDER_FILE_CAP } from "../../../platform/server";
import {
  CHUNK_JSON_BYTES, COMPRESSED_PREFIX, LIVE_BACKUP_BYTES_CAP, LIVE_BACKUP_KEEP_DAYS,
  LIVE_BACKUP_SCRIPT, LIVE_DELETED_SHA, LIVE_FOLDER_BIG_BYTES, LIVE_OWNED_LIST_SCRIPT,
  LIVE_RESTORE_SCRIPT, LIVE_SNAPSHOT_OUTPUT_BYTES, LIVE_SNAPSHOT_SCRIPT,
  LIVE_SNAPSHOT_SKIP_DIRS, LIVE_SNAPSHOT_SKIP_PATHS, LIVE_TRASH_SCRIPT, liveOwnedRoots,
} from "../../models/live-folder";

export { LIVE_FOLDER_FILE_CAP };

export function pythonCommand(script: string, payload: unknown = {}): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `python3 - <<'PY'\nimport base64, json\nPAYLOAD = json.loads(base64.b64decode("${encoded}").decode("utf-8"))\n${script}PY`;
}

/** A tracked file `git status` reports deleted inside a nested repository: it is listed so its removal reads as a change. */

export const liveSnapshotCommand = (cap = LIVE_FOLDER_FILE_CAP): string => pythonCommand(LIVE_SNAPSHOT_SCRIPT, {
  skip_dirs: LIVE_SNAPSHOT_SKIP_DIRS, skip_paths: LIVE_SNAPSHOT_SKIP_PATHS, cap, big: LIVE_FOLDER_BIG_BYTES,
  max_output: LIVE_SNAPSHOT_OUTPUT_BYTES, deleted: LIVE_DELETED_SHA,
});

/** The snapshot command's answer as dirt snapshots, or the reason the owner reads. */
export function parseLiveSnapshot(ran: { exitCode: number; stdout: string; stderr: string }): { ok: true; snapshots: DirtSnapshot[] } | { ok: false; reason: string } {
  if (ran.exitCode === 3) {
    const count = /too_large:(\d+)/.exec(ran.stderr)?.[1];
    if (count) return { ok: false, reason: `folder too large for no-git mode: ${count} files; put it under git` };
    const output = /too_large_output:(\d+):(\d+)/.exec(ran.stderr);
    if (output) return { ok: false, reason: `folder too large for no-git mode: ${output[1]} files make a ${(Number(output[2]) / 1024 / 1024).toFixed(1)} MB snapshot; put it under git` };
  }
  if (ran.exitCode !== 0) return { ok: false, reason: `cannot snapshot the folder (no git): ${ran.stderr.trim() || `exit ${ran.exitCode}`}` };
  try {
    const text = ran.stdout.trim();
    const json = text.startsWith(COMPRESSED_PREFIX) ? inflateSync(Buffer.from(text.slice(COMPRESSED_PREFIX.length), "base64")).toString("utf8") : text;
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== "object"
      || typeof (row as DirtSnapshot).path !== "string" || typeof (row as DirtSnapshot).sha256 !== "string")) {
      return { ok: false, reason: "cannot snapshot the folder (no git): unexpected answer" };
    }
    return { ok: true, snapshots: (parsed as DirtSnapshot[]).map((row) => ({ path: row.path, sha256: row.sha256 })) };
  } catch {
    return { ok: false, reason: "cannot snapshot the folder (no git): invalid answer" };
  }
}

/** The files of a snapshot a task may change: matching owns_paths and not never_touch. */

export const liveOwnedListCommand = (ownsPaths: readonly string[], cap = LIVE_FOLDER_FILE_CAP): string => pythonCommand(LIVE_OWNED_LIST_SCRIPT, {
  roots: liveOwnedRoots(ownsPaths), skip_dirs: LIVE_SNAPSHOT_SKIP_DIRS, skip_paths: LIVE_SNAPSHOT_SKIP_PATHS, cap,
});

/** The owned-files listing as paths, or the reason the owner reads. */
export function parseLiveOwnedList(ran: { exitCode: number; stdout: string; stderr: string }): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const count = ran.exitCode === 3 ? /too_large:(\d+)/.exec(ran.stderr)?.[1] : undefined;
  if (count) return { ok: false, reason: `owned files too many for no-git mode: ${count} files; narrow owns_paths` };
  if (ran.exitCode !== 0) return { ok: false, reason: `cannot list the owned files (no git): ${ran.stderr.trim() || `exit ${ran.exitCode}`}` };
  try {
    const text = ran.stdout.trim();
    const parsed = JSON.parse(text.startsWith(COMPRESSED_PREFIX) ? inflateSync(Buffer.from(text.slice(COMPRESSED_PREFIX.length), "base64")).toString("utf8") : text) as unknown;
    if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string")) return { ok: false, reason: "cannot list the owned files (no git): unexpected answer" };
    return { ok: true, paths: parsed as string[] };
  } catch {
    return { ok: false, reason: "cannot list the owned files (no git): invalid answer" };
  }
}

/** Splits a path list so each part fits one command line. */
export function chunkPaths(paths: readonly string[], maxJsonBytes = CHUNK_JSON_BYTES): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 2;
  for (const path of paths) {
    const bytes = Buffer.byteLength(JSON.stringify(path), "utf8") + 1;
    if (current.length && size + bytes > maxJsonBytes) { chunks.push(current); current = []; size = 2; }
    current.push(path);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}


export const liveBackupCommand = (input: { id: string; files: string[]; begin: boolean; finish: boolean }): string =>
  pythonCommand(LIVE_BACKUP_SCRIPT, { ...input, keep_days: LIVE_BACKUP_KEEP_DAYS, cap_bytes: LIVE_BACKUP_BYTES_CAP });
export const liveRestoreCommand = (id: string): string => pythonCommand(LIVE_RESTORE_SCRIPT, { id });
export const liveTrashCommand = (id: string, created: string[]): string => pythonCommand(LIVE_TRASH_SCRIPT, { id, created });

/** The reason a failed backup command is rejected with; the size cap gets its own text. */
