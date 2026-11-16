import type { DirtSnapshot } from "../cli-outcome";
import { getRun } from "../../storage";
import {
  chunkPaths, classifyFolderProbe, liveBackupCommand, liveOwnedFiles, liveOwnedListCommand, liveRestoreCommand, liveSnapshotCommand, liveTrashCommand,
  LIVE_FOLDER_PROBE_COMMAND, parseBackupFailure, parseLiveOwnedList, parseLiveSnapshot,
} from "../live-folder";
import { resolve } from "node:path";
import type { ServerCore } from "../../contracts/server";
import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort, parseJsonOr } from "@lane-pilot/kit";

type Ran = { exitCode: number; stdout: string; stderr: string };

/** Folder-without-git mode on the server side: detection, snapshot, backup and rollback, all run on the folder's own host. */
export function createLiveFolder(ctx: ServerCore) {
  const { bb, db, host } = ctx;

  const run = (hostId: string, folder: string, command: string, timeoutSec: number): Promise<Ran> =>
    runOnHost(host, { hostId, cwd: folder, command, timeoutSec, timeoutMs: (timeoutSec + 5) * 1000 })
      .then((ran) => ({ exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }))
      .catch((cause: unknown): Ran => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));

  /**
   * Whether the folder has no git, asked on its own host. A run's answer for its folder is kept, so a `git init` in the
   * middle of a run cannot change the baseline kind under it. Another path of a run (a worktree) is git by construction.
   */
  // Concurrent askers (the dispatch test-hint, the spawn probe) share one probe; a second rev-parse would break the
  // "one git command on a plain folder" contract of live-folder.
  const probing = new Map<string, Promise<"git" | "no-git" | "unknown">>();
  const probeGeneration = new Map<string, number>();
  const cacheWrites = new Map<string, Promise<void>>();

  const generationFor = (generationKey:string):number => {
    if (!probeGeneration.has(generationKey)) probeGeneration.set(generationKey, 0);
    return probeGeneration.get(generationKey)!;
  };

  /** Invalidate every folder identity observed for a run, draining old cache writes before deleting its KV answer. */
  async function invalidateLiveFolder(runId:string):Promise<void> {
    const key=`live-folder:${runId}`;
    probeGeneration.set(key, generationFor(key)+1);
    await cacheWrites.get(key)?.catch(() => undefined);
    const deleteCache=bb.storage?.kv?.delete;
    if (deleteCache) await deleteCache.call(bb.storage.kv,key);
  }

  async function probeFolder(runId: string | undefined, hostId: string, folder: string, options?: { fresh?: boolean }): Promise<"git"|"no-git"|"unknown"> {
    const bound = runId ? getRun(db, runId)?.writer_workspace_path : null;
    if (bound && resolve(bound) !== resolve(folder)) return "unknown";
    const key = runId ? `live-folder:${runId}` : null;
    const kv = bb.storage?.kv;
    // A persisted answer is per run, not per path string: the epoch must invalidate every caller of that cache key.
    const generationKey = key ?? `${hostId}:${folder}`;
    if (options?.fresh && runId) await invalidateLiveFolder(runId);
    else if (options?.fresh) probeGeneration.set(generationKey, generationFor(generationKey)+1);
    const generation = generationFor(generationKey);
    if (!options?.fresh && key && kv) {
      const readGeneration=generation;
      const saved = await kv.get(key);
      // A fresh invalidation may have happened while KV was in flight. Never return the old answer in that epoch.
      if (probeGeneration.get(generationKey) === readGeneration) {
        if (saved === "no-git") return "no-git";
        if (saved === "git") return "git";
      }
    }
    const probeKey = `${hostId}:${folder}:${key ?? ""}:probe:${generation}`;
    let pending = probing.get(probeKey);
    if (!pending) {
      pending = runOnHost(host, { hostId, cwd: folder, command: LIVE_FOLDER_PROBE_COMMAND, timeoutSec: 15 })
        .then(classifyFolderProbe)
        .catch((cause: unknown) => { ctx.log(`writer live folder probe: ${cause instanceof Error ? cause.message : String(cause)}`); return "unknown" as const; })
        .finally(() => { probing.delete(probeKey); });
      probing.set(probeKey, pending);
    }
    const kind = await pending;
    if (!options?.fresh && key && kv && kind !== "unknown") {
      const previous=cacheWrites.get(key) ?? Promise.resolve();
      const write=previous.catch(() => undefined).then(async () => {
        if (probeGeneration.get(generationKey) !== generation) return;
        await bestEffort(ctx.log, "writer live folder record", kv.set(key, kind as never), undefined);
      });
      cacheWrites.set(key,write);
      await write;
      if (cacheWrites.get(key)===write) cacheWrites.delete(key);
    }
    return kind;
  }

  async function isLiveFolder(runId: string | undefined, hostId: string, folder: string, options?: { fresh?: boolean }): Promise<boolean> {
    return (await probeFolder(runId,hostId,folder,options)) === "no-git";
  }

  async function probeLiveFolder(runId: string | undefined, hostId: string, folder: string): Promise<"git"|"no-git"|"unknown"> {
    return probeFolder(runId,hostId,folder,{ fresh:true });
  }

  async function liveSnapshot(hostId: string, folder: string): Promise<{ ok: true; paths: string[]; snapshots: DirtSnapshot[] } | { ok: false; reason: string }> {
    const parsed = parseLiveSnapshot(await run(hostId, folder, liveSnapshotCommand(), 300));
    return parsed.ok ? { ok: true, paths: parsed.snapshots.map((row) => row.path), snapshots: parsed.snapshots } : parsed;
  }

  /** The files the task may change as they are now, clean files of a nested repository included (the snapshot leaves those out). */
  async function liveOwnedList(hostId: string, folder: string, task: { owns_paths: string[]; never_touch: string[] }): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
    const parsed = parseLiveOwnedList(await run(hostId, folder, liveOwnedListCommand(task.owns_paths), 300));
    return parsed.ok ? { ok: true, paths: liveOwnedFiles(parsed.paths, task) } : parsed;
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
    const now = await liveOwnedList(input.hostId, input.folder, input.task);
    if (!now.ok) return { ok: false, reason: `files restored, created files not removed: ${now.reason}` };
    const backedUp = new Set(restored.files);
    // Lane Pilot's own files (a failed check's log the retry reads) are not the writer's creation, even inside owns_paths.
    const created = now.paths.filter((path) => !backedUp.has(path) && !path.startsWith(".agents/") && !path.startsWith(".bb/"));
    const removed: string[] = [];
    for (const chunk of chunkPaths(created)) {
      const ran = await run(input.hostId, input.folder, liveTrashCommand(input.backupId, chunk), 300);
      if (ran.exitCode !== 0) return { ok: false, reason: `files restored, created files not removed: ${ran.stderr.trim() || `exit ${ran.exitCode}`}` };
      removed.push(...(parseJsonOr(ran.stdout, { removed: [] }) as { removed: string[] }).removed);
    }
    return { ok: true, restored: restored.restored, removed, failed: restored.failed };
  }

  return { isLiveFolder, probeLiveFolder, invalidateLiveFolder, liveSnapshot, liveOwnedList, backupLiveFolder, restoreLiveFolder };
}
