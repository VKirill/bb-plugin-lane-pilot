import type { DirtSnapshot } from "../../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { getAttempt, getReasoningTrace, getRun, saveReasoningTrace, setAttemptDirtBefore, setAttemptWorkspace, transitionAttempt } from "../../database";
import { failureClass } from "../../failure-class";
import { stringAt } from "../values";
import { resolve } from "node:path";
import type { ServerCore } from "../core";
import type { Services } from "../services";

/**
 * Sticky writers: an area's writer thread takes the area's next task, and a task-side failure is redone in the thread
 * that made it. Copilot continues a PR's session on review comments, Cursor keeps one chat per feature, Claude Code
 * resumes a subagent with its history; a fresh thread re-reads the project and forgets why it wrote what it wrote.
 */

/** How long after acceptance an area's writer is still worth continuing: its worktree and context are current. */
export const STICKY_WINDOW_MS = 3 * 3600_000;
/** Tasks one writer thread takes; past that its context is more noise than help and a fresh writer starts. */
export const STICKY_MAX_TURNS = 6;
/** Share of the context window above which the thread is compacted before the next turn. */
export const STICKY_COMPACT_SHARE = 0.6;
/** Area records keep this many accepted tasks and files for the next writer of the area. */
const AREA_TASKS = 12;
const AREA_FILES = 40;

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown>; delete?(key: string): Promise<unknown> };

const followUpKey = (attemptId: string) => `writer-followup:${attemptId}`;
const areaKey = (projectId: string, area: string) => `area:${projectId}:${area.trim().toLowerCase()}`;

/** When a continued turn was sent: completion waits for a turn requested after it, not the thread's previous one. */
export async function saveFollowUp(kv: Kv, attemptId: string, since: number): Promise<void> {
  await kv.set(followUpKey(attemptId), since as never);
}

export async function loadFollowUp(kv: Kv, attemptId: string): Promise<number | null> {
  const value = await kv.get(followUpKey(attemptId)).catch(() => null);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type AreaRecord = {
  area: string;
  runId: string;
  threadId: string;
  attemptId: string;
  acceptedAt: number;
  tasks: Array<{ taskId: string; title: string; objective: string; acceptedAt: number }>;
  files: string[];
};

export async function loadArea(kv: Kv, projectId: string, area: string): Promise<AreaRecord | null> {
  const value = await kv.get(areaKey(projectId, area)).catch(() => null);
  return value && typeof value === "object" && Array.isArray((value as AreaRecord).tasks) ? value as AreaRecord : null;
}

/** The area's record after one more accepted task: newest first, bounded. */
export function nextAreaRecord(previous: AreaRecord | null, accepted: { area: string; runId: string; threadId: string; attemptId: string; task: TaskV2; produced: string[]; now: number }): AreaRecord {
  const entry = { taskId:accepted.task.id, title:accepted.task.title.slice(0, 200), objective:accepted.task.objective.slice(0, 600), acceptedAt:accepted.now };
  return {
    area:accepted.area, runId:accepted.runId, threadId:accepted.threadId, attemptId:accepted.attemptId, acceptedAt:accepted.now,
    tasks:[entry, ...(previous?.tasks ?? []).filter((row) => row.taskId !== entry.taskId)].slice(0, AREA_TASKS),
    files:[...new Set([...accepted.produced, ...(previous?.files ?? [])])].slice(0, AREA_FILES),
  };
}

/** What a fresh writer of the area is told about the area's earlier tasks; empty when it has none. */
export function areaHistoryText(record: AreaRecord | null): string {
  if (!record?.tasks.length) return "";
  return [
    `Area «${record.area}»: earlier accepted tasks, newest first. Their decisions are in main; keep them unless this task changes them.`,
    ...record.tasks.map((row) => `- ${new Date(row.acceptedAt).toISOString().slice(0, 16)} ${row.taskId}: ${row.title}. ${row.objective}`),
    record.files.length ? `Files of this area: ${record.files.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/** A failure the same writer can fix in place: its own work, not git, Lane Pilot, the machine or a question. */
export function retryInSameThread(state: string, reason: string | null | undefined): boolean {
  if (state !== "validation_failed" && state !== "empty_output") return false;
  return ["task", "contract", "provider"].includes(failureClass(state, reason));
}

export type HotWriter = { threadId: string; attemptId: string; workspacePath: string; environmentId: string | null; decision: unknown; turns: number };

export function createWriterSticky(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;

  function threadTurns(threadId: string): number {
    const row = db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE thread_id=?").get(threadId) as { count: number };
    return row.count;
  }

  /** The thread and its workspace are still there, idle, and not used up. */
  async function threadUsable(attempt: { thread_id: string | null; workspace_path: string | null; environment_id: string | null }, runId: string, merged: boolean): Promise<boolean> {
    if (!attempt.thread_id || !attempt.workspace_path) return false;
    if (threadTurns(attempt.thread_id) >= STICKY_MAX_TURNS) return false;
    const base = getRun(db, runId)?.writer_workspace_path;
    // Lane Pilot removes its own worktree once the work is merged; only a BB environment or the project folder stays.
    if (merged && attempt.environment_id === null && base && resolve(attempt.workspace_path) !== resolve(base)) return false;
    const thread = await bb.sdk.threads.get({ threadId:attempt.thread_id }).catch(() => null);
    if (stringAt(thread, "status") !== "idle" || (thread as { archivedAt?: unknown } | null)?.archivedAt) return false;
    if (attempt.environment_id) {
      const environment = await bb.sdk.environments.get({ environmentId:attempt.environment_id }).catch(() => null);
      if (!environment || (environment as { archivedAt?: unknown }).archivedAt) return false;
    }
    return true;
  }

  /** The area's writer of this run, when its last task was accepted recently and the thread can take another. */
  async function hotWriter(projectId: string, runId: string, area: string | undefined): Promise<HotWriter | null> {
    if (!area) return null;
    const record = await loadArea(bb.storage.kv, projectId, area);
    if (!record || record.runId !== runId || Date.now() - record.acceptedAt > STICKY_WINDOW_MS) return null;
    const previous = getAttempt(db, record.attemptId);
    if (!previous || previous.state !== "accepted" || previous.thread_id !== record.threadId) return null;
    if (!await threadUsable(previous, runId, true)) return null;
    return { threadId:record.threadId, attemptId:previous.id, workspacePath:previous.workspace_path!, environmentId:previous.environment_id,
      decision:previous.workspace_decision, turns:threadTurns(record.threadId) };
  }

  /** The failed attempt's thread, when the same writer can redo the task in place. */
  async function retryWriter(failedAttemptId: string, runId: string): Promise<HotWriter | null> {
    const failed = getAttempt(db, failedAttemptId);
    if (!failed?.thread_id || !retryInSameThread(failed.state, failed.reason)) return null;
    // One redo per thread: a writer that failed twice in a row gets a fresh context (Claude Code best practices).
    const inThread = db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE thread_id=? AND task_id=?").get(failed.thread_id, failed.task_id) as { count: number };
    if (inThread.count >= 2) return null;
    if (!await threadUsable(failed, runId, false)) return null;
    return { threadId:failed.thread_id, attemptId:failed.id, workspacePath:failed.workspace_path!, environmentId:failed.environment_id,
      decision:failed.workspace_decision, turns:threadTurns(failed.thread_id) };
  }

  /** Compacts a thread whose context is mostly used, then waits for the compaction to finish. */
  async function compactIfFull(threadId: string): Promise<void> {
    const context = await bb.sdk.threads.context({ threadId }).catch(() => null) as { usage?: { usedTokens?: number; modelContextWindow?: number } | null } | null;
    const used = context?.usage?.usedTokens ?? 0;
    const window = context?.usage?.modelContextWindow ?? 0;
    if (!window || used / window < STICKY_COMPACT_SHARE) return;
    ctx.log(`sticky writer ${threadId}: context ${Math.round(100 * used / window)}% full, compacting before the next turn`);
    await bb.sdk.threads.compact({ threadId }).catch(() => undefined);
    for (const deadline = Date.now() + 5 * 60_000; Date.now() < deadline && !ctx.isDisposed();) {
      await new Promise((wake) => setTimeout(wake, 2_000));
      if (stringAt(await bb.sdk.threads.get({ threadId }).catch(() => null), "status") === "idle") return;
    }
  }

  /**
   * Starts an attempt in an existing writer thread: brings its worktree up to main for a next task, binds the
   * attempt to the same workspace, and sends the turn. Fails before binding whenever it can, so the caller simply
   * spawns a fresh writer for the same attempt.
   */
  async function continueInThread(input: {
    runId: string; taskId: string; attemptId: string; config: PrototypeConfig; writer: HotWriter;
    prompt: string; kind: "next-task" | "retry"; dirtBefore?: DirtSnapshot[];
  }): Promise<{ ok: true; workspacePath: string; dirtBefore: DirtSnapshot[] } | { ok: false; reason: string; bound: boolean }> {
    const { writer } = input;
    const base = getRun(db, input.runId)?.writer_workspace_path;
    if (!base) return { ok:false, reason:"run has no workspace", bound:false };
    try {
      transitionAttempt(db, input.attemptId, "spawn_requested");
      if (input.kind === "next-task" && resolve(writer.workspacePath) !== resolve(base)) {
        const synced = await host.call("gitSyncWorktree", { requestedHostId:input.config.hostId, basePath:base, worktreePath:writer.workspacePath },
          { hostId:input.config.hostId, timeoutMs:120_000 });
        if (synced.status !== "synced" && synced.status !== "up-to-date") return { ok:false, reason:`worktree_sync_${synced.status}:${synced.reason ?? ""}`, bound:false };
        await host.call("gitPrepareWorktree", { requestedHostId:input.config.hostId, basePath:base, worktreePath:writer.workspacePath },
          { hostId:input.config.hostId, timeoutMs:600_000 }).catch(() => undefined);
      }
      let dirtBefore = input.dirtBefore;
      if (!dirtBefore) {
        const dirt = await services.workspaceDirt(input.config, writer.workspacePath);
        if (!dirt.ok) return { ok:false, reason:`workspace_snapshot:${dirt.reason}`, bound:false };
        dirtBefore = dirt.snapshots;
      }
      await compactIfFull(writer.threadId);
      if (!setAttemptWorkspace(db, input.attemptId, { path:writer.workspacePath, environmentId:writer.environmentId, decision:writer.decision })) {
        return { ok:false, reason:"attempt_workspace_cas_conflict", bound:false };
      }
      setAttemptDirtBefore(db, input.attemptId, dirtBefore);
      const trace = getReasoningTrace(db, writer.attemptId);
      if (trace) saveReasoningTrace(db, { ...trace, attemptId:input.attemptId, runId:input.runId, threadId:writer.threadId });
      await bb.sdk.threads.updatePluginMetadata({ threadId:writer.threadId, pluginId:"lane-pilot",
        set:{ lanePilotRunId:input.runId, lanePilotTaskId:input.taskId, attemptId:input.attemptId } } as never).catch(() => undefined);
      const since = Date.now();
      await saveFollowUp(bb.storage.kv, input.attemptId, since);
      try {
        await bb.sdk.threads.send({ threadId:writer.threadId, mode:"queue-if-active", input:[{ type:"text", text:input.prompt, mentions:[] }] } as never);
      } catch (cause) {
        return { ok:false, reason:`sticky_send_failed:${cause instanceof Error ? cause.message : String(cause)}`, bound:true };
      }
      transitionAttempt(db, input.attemptId, "running", { threadId:writer.threadId });
      ctx.log(`writer ${input.taskId} continues in thread ${writer.threadId} (${input.kind}, turn ${writer.turns + 1})`);
      return { ok:true, workspacePath:writer.workspacePath, dirtBefore };
    } catch (cause) {
      return { ok:false, reason:`sticky_failed:${cause instanceof Error ? cause.message : String(cause)}`, bound:getAttempt(db, input.attemptId)?.workspace_path != null };
    }
  }

  /** Remembers the accepted task under its area, for the area's next writer. */
  async function noteAccepted(projectId: string, runId: string, task: TaskV2, attemptId: string, produced: string[]): Promise<void> {
    if (!task.area) return;
    const attempt = getAttempt(db, attemptId);
    if (!attempt?.thread_id) return;
    const previous = await loadArea(bb.storage.kv, projectId, task.area);
    await bb.storage.kv.set(areaKey(projectId, task.area), nextAreaRecord(previous, {
      area:task.area, runId, threadId:attempt.thread_id, attemptId, task, produced, now:Date.now(),
    }) as never);
  }

  return { hotWriter, retryWriter, continueInThread, noteAccepted };
}
