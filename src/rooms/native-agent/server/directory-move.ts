import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stringAt } from "@lane-pilot/kit";
import { closeRun, createRun, freezeRunBinding, hasRunAdmission, getRun, getRunWriterHost, listLiveTasksForRun, listOpenAttempts, readParkedTasks, setRunThread, type LanePilotDatabase } from "../../storage";
import { directoryMove, type DirectoryMove } from "../../storage";
import { buildRunPolicy } from "../../tasks";
import { nativeEnvKey } from "../../contracts";

export type DirectoryMoveInput = Omit<DirectoryMove, "newRunId"> & { phase: "prepare" | "commit" | "abort" };
type Dependencies = { bb: BbPluginApi; db: LanePilotDatabase; loadParked(): Promise<Array<{ runId: string; pmThreadId: string }>> };

function runsFor(db: LanePilotDatabase, threadId: string) {
  return db.prepare("SELECT id,project_id,kind,writer_environment_id,writer_workspace_path,closed_at FROM lane_pilot_run WHERE pm_thread_id=?").all(threadId) as Array<{ id: string; project_id: string; kind: string; writer_environment_id: string | null; writer_workspace_path: string | null; closed_at: number | null }>;
}

function saveMove(db: LanePilotDatabase, move: DirectoryMove): void {
  db.prepare("INSERT INTO lane_pilot_directory_move(thread_id,operation_id,record_json) VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET operation_id=excluded.operation_id,record_json=excluded.record_json")
    .run(move.threadId, move.operationId, JSON.stringify(move));
}

function assertIdle(db: LanePilotDatabase, threadId: string): void {
  if (hasRunAdmission(db, threadId)) throw new Error("Lane Pilot is preparing work for this chat; wait for admission to finish before moving");
  const runs = runsFor(db, threadId), ids = new Set(runs.map((run) => run.id));
  if (listOpenAttempts(db).some((attempt) => ids.has(attempt.run_id))) throw new Error("Lane Pilot has active or queued writer work; finish or cancel it before moving");
  if (runs.some((run) => listLiveTasksForRun(db, run.id).length)) throw new Error("Lane Pilot has unfinished task work; finish or cancel it before moving");
  if (db.prepare("SELECT 1 FROM lane_pilot_phase WHERE pm_thread_id=? AND state<>'closed' LIMIT 1").get(threadId)) throw new Error("Lane Pilot has a live or resumable phase; close it before moving");
  if (db.prepare("SELECT 1 FROM lane_pilot_wf_run w JOIN lane_pilot_run r ON r.id=w.link_run_id WHERE r.pm_thread_id=? AND w.status IN ('running','waiting','blocked','interrupted') LIMIT 1").get(threadId)) throw new Error("Lane Pilot has a live or resumable workflow; finish or cancel it before moving");
}

/** Core calls prepare BEFORE attaching. A failed commit retains the fence and is retried on the next native dispatch. */
export async function handleDirectoryMove(deps: Dependencies, input: DirectoryMoveInput): Promise<{ ok: true }> {
  const { bb, db } = deps;
  if (!directoryMove(db, input.threadId)) {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: input.threadId });
    const runId = stringAt(metadata, "lanePilotRunId");
    if (!runId) {
      if (runsFor(db, input.threadId).some((run) => run.closed_at === null)) throw new Error("Lane Pilot chat metadata is missing its open run; recover its binding before moving");
      return { ok: true };
    }
    const run = getRun(db, runId);
    if (stringAt(metadata, "role") !== "pm" || run?.pm_thread_id !== input.threadId || run.kind !== "cli") throw new Error("Lane Pilot helper, specialist or managed PM threads cannot move their run's directory");
  }
  const thread = await bb.sdk.threads.get({ threadId: input.threadId });
  if (stringAt(thread, "projectId") !== input.projectId || input.source.hostId !== input.target.hostId) throw new Error("Lane Pilot directory move must stay in the same project and host");
  const attached = stringAt(thread, "environmentId");
  const held = directoryMove(db, input.threadId);
  if (held && held.operationId !== input.operationId) throw new Error("Lane Pilot has a pending directory move; recover it before moving again");
  if (input.phase === "abort") {
    if (attached !== input.source.environmentId) throw new Error("Lane Pilot cannot abort after environment attachment; recover the move");
    db.prepare("DELETE FROM lane_pilot_directory_move WHERE thread_id=? AND operation_id=?").run(input.threadId, input.operationId);
    return { ok: true };
  }
  if (input.phase === "prepare") {
    if (attached !== input.source.environmentId) throw new Error("Lane Pilot source environment changed before the move");
    db.transaction(() => {
      const current = directoryMove(db, input.threadId);
      if (current && current.operationId !== input.operationId) throw new Error("Lane Pilot directory move already pending");
      assertIdle(db, input.threadId);
      for (const run of runsFor(db, input.threadId).filter((row) => row.closed_at === null)) {
        if (run.kind !== "cli" || run.project_id !== input.projectId || run.writer_environment_id !== input.source.environmentId || run.writer_workspace_path !== input.source.path || getRunWriterHost(db, run.id) !== input.source.hostId) throw new Error("Lane Pilot run binding does not match the source environment");
      }
      saveMove(db, held ?? input);
    }).immediate();
    try {
      if ((await deps.loadParked()).some((row) => row.pmThreadId === input.threadId || runsFor(db, input.threadId).some((run) => run.id === row.runId))) throw new Error("Lane Pilot has parked work that can resume; cancel it before moving");
    } catch (cause) {
      db.prepare("DELETE FROM lane_pilot_directory_move WHERE thread_id=? AND operation_id=?").run(input.threadId, input.operationId);
      throw cause;
    }
    return { ok: true };
  }
  if (!held) {
    // A repeated commit after a successful response is harmless, but cannot authorize an unprepared relocation.
    const run = runsFor(db, input.threadId).find((row) => row.closed_at === null && row.writer_environment_id === input.target.environmentId);
    if (attached === input.target.environmentId && run) return { ok: true };
    throw new Error("Lane Pilot directory move has no preparation fence");
  }
  if (JSON.stringify(held.source) !== JSON.stringify(input.source) || JSON.stringify(held.target) !== JSON.stringify(input.target)) throw new Error("Lane Pilot directory move target does not match its preparation");
  if (attached !== held.target.environmentId) throw new Error("Lane Pilot target environment is not attached; keep the move fenced");
  if ((await deps.loadParked()).some((row) => row.pmThreadId === input.threadId || runsFor(db, input.threadId).some((run) => run.id === row.runId))) throw new Error("Lane Pilot parked work appeared during the move; keep the move fenced");
  const environment = await bb.sdk.environments.get({ environmentId: held.target.environmentId });
  if (stringAt(environment, "hostId") !== held.target.hostId || stringAt(environment, "path") !== held.target.path || stringAt(environment, "projectId") !== held.projectId) throw new Error("Lane Pilot target environment no longer matches the prepared binding");
  const runId = db.transaction(() => {
    const current = directoryMove(db, input.threadId)!;
    if (current.newRunId) return current.newRunId;
    assertIdle(db, input.threadId);
    for (const run of runsFor(db, input.threadId).filter((row) => row.closed_at === null)) if (!closeRun(db, run.id, "rpc")) throw new Error("Lane Pilot work appeared during directory move");
    const id = `lprun_${randomUUID().replaceAll("-", "")}`;
    createRun(db, id, input.projectId, "cli", null, "none", buildRunPolicy({}), null);
    if (!freezeRunBinding(db, id, { hostId: held.target.hostId, environmentId: held.target.environmentId, workspacePath: held.target.path })) throw new Error("Lane Pilot new directory binding failed");
    setRunThread(db, id, input.threadId);
    saveMove(db, { ...current, newRunId: id });
    return id;
  }).immediate();
  await bb.sdk.threads.updatePluginMetadata({ threadId: input.threadId, set: { role: "pm", lanePilotRunId: runId } });
  await bb.storage.kv.delete(nativeEnvKey(input.threadId));
  db.prepare("DELETE FROM lane_pilot_directory_move WHERE thread_id=? AND operation_id=?").run(input.threadId, input.operationId);
  return { ok: true };
}

/** A crash between Core attachment and its commit notification remains fenced until the current placement proves the outcome. */
export async function recoverDirectoryMove(bb: BbPluginApi, db: LanePilotDatabase, threadId: string): Promise<void> {
  const move = directoryMove(db, threadId);
  if (!move) return;
  const thread = await bb.sdk.threads.get({ threadId });
  if (stringAt(thread, "environmentId") !== move.target.environmentId) throw new Error("Lane Pilot directory move is pending before attachment; retry the move to recover it");
  await handleDirectoryMove({ bb, db, loadParked: () => readParkedTasks(bb.storage.kv) }, { ...move, phase: "commit" });
}
