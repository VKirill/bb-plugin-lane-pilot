import type { DirtSnapshot } from "../../cli-outcome";
import { getRun } from "../../database";
import {
  chunkPaths, classifyFolderProbe, liveBackupCommand, liveOwnedFiles, liveRestoreCommand, liveSnapshotCommand, liveTrashCommand,
  LIVE_FOLDER_PROBE_COMMAND, parseBackupFailure, parseLiveSnapshot,
} from "../../live-folder";
import { resolve } from "node:path";
import type { ServerCore } from "../core";

type Ran = { exitCode: number; stdout: string; stderr: string };

/** Folder-without-git mode on the server side: detection, snapshot, backup and rollback, all run on the folder's own host. */
export function createLiveFolder(ctx: ServerCore) {
  const { bb, db, host } = ctx;

  const run = (hostId: string, folder: string, command: string, timeoutSec: number): Promise<Ran> =>
    host.call("runCommand", { requestedHostId: hostId, command, cwd: folder, timeoutSec }, { hostId, timeoutMs: (timeoutSec + 5) * 1000 })
      .then((ran) => ({ exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }))
      .catch((cause: unknown): Ran => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));

  /**
   * Whether the folder has no git, asked on its own host. A run's answer for its folder is kept, so a `git init` in the
   * middle of a run cannot change the baseline kind under it. Another path of a run (a worktree) is git by construction.
   */
  async function isLiveFolder(runId: string | undefined, hostId: string, folder: string): Promise<boolean> {
    const bound = runId ? getRun(db, runId)?.writer_workspace_path : null;
    if (bound && resolve(bound) !== resolve(folder)) return false;
    const key = runId ? `live-folder:${runId}` : null;
    const kv = bb.storage?.kv;
    if (key && kv) {
      const saved = await kv.get(key).catch(() => null);
      if (saved === "no-git") return true;
      if (saved === "git") return false;
    }
    const ran = await host.call("runCommand", { requestedHostId: hostId, command: LIVE_FOLDER_PROBE_COMMAND, cwd: folder, timeoutSec: 15 }, { hostId, timeoutMs: 20_000 }).catch(() => null);
    const kind = classifyFolderProbe(ran);
    if (key && kv && kind !== "unknown") await kv.set(key, kind as never).catch(() => undefined);
    return kind === "no-git";
  }

  async function liveSnapshot(hostId: string, folder: string): Promise<{ ok: true; paths: string[]; snapshots: DirtSnapshot[] } | { ok: false; reason: string }> {
    const parsed = parseLiveSnapshot(await run(hostId, folder, liveSnapshotCommand(), 300));
    return parsed.ok ? { ok: true, paths: parsed.snapshots.map((row) => row.path), snapshots: parsed.snapshots } : parsed;
  }

  /** Copies the files the task owns aside before its attempt, so a rejection can put them back. */
  async function backupLiveFolder(input: { hostId: string; folder: string; backupId: string; files: string[] }): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
    const chunks = chunkPaths(input.files);
    if (!chunks.length) chunks.push([]);
    let count = 0;
    for (const [index, files] of chunks.entries()) {
      const ran = await run(input.hostId, input.folder, liveBackupCommand({ id: input.backupId, files, begin: index === 0, finish: index === chunks.length - 1 }), 300);
      if (ran.exitCode !== 0) return { ok: false, reason: parseBackupFailure(ran) };
      try {
        const answer = JSON.parse(ran.stdout) as { copied?: number; reused?: boolean };
        if (answer.reused) return { ok: true, count: input.files.length };
        count += answer.copied ?? 0;
      } catch {
        return { ok: false, reason: "cannot back up the owned files (no git): invalid answer" };
      }
    }
    return { ok: true, count };
  }

  /**
   * Puts the task's owned files back as they were before the attempt and takes out what the writer created inside
   * owns_paths. Only owned paths are touched: the owner's other files in the folder are never rolled back.
   */
  async function restoreLiveFolder(input: { hostId: string; folder: string; backupId: string; task: { owns_paths: string[]; never_touch: string[] } }):
    Promise<{ ok: true; restored: string[]; removed: string[]; failed: string[] } | { ok: false; reason: string }> {
    const restoredRan = await run(input.hostId, input.folder, liveRestoreCommand(input.backupId), 300);
    if (restoredRan.exitCode !== 0) return { ok: false, reason: `cannot restore the owned files (no git): ${restoredRan.stderr.trim() || `exit ${restoredRan.exitCode}`}` };
    let restored: { files: string[]; restored: string[]; failed: string[] };
    try { restored = JSON.parse(restoredRan.stdout); } catch { return { ok: false, reason: "cannot restore the owned files (no git): invalid answer" }; }
    const now = await liveSnapshot(input.hostId, input.folder);
    if (!now.ok) return { ok: false, reason: `files restored, created files not removed: ${now.reason}` };
    const backedUp = new Set(restored.files);
    // Lane Pilot's own files (a failed check's log the retry reads) are not the writer's creation, even inside owns_paths.
    const created = liveOwnedFiles(now.paths, input.task).filter((path) => !backedUp.has(path) && !path.startsWith(".agents/") && !path.startsWith(".bb/"));
    const removed: string[] = [];
    for (const chunk of chunkPaths(created)) {
      const ran = await run(input.hostId, input.folder, liveTrashCommand(input.backupId, chunk), 300);
      if (ran.exitCode !== 0) return { ok: false, reason: `files restored, created files not removed: ${ran.stderr.trim() || `exit ${ran.exitCode}`}` };
      try { removed.push(...(JSON.parse(ran.stdout) as { removed: string[] }).removed); } catch { /* the folder is already restored */ }
    }
    return { ok: true, restored: restored.restored, removed, failed: restored.failed };
  }

  return { isLiveFolder, liveSnapshot, backupLiveFolder, restoreLiveFolder };
}
