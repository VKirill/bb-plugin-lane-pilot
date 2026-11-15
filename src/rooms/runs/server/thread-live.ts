import { getRun, latestAttemptWorkForThread, latestStageWorkForThread, listRunsForPmThread, openRunOfPmThread, type LanePilotDatabase } from "../../storage";

import { workGraphStrips, type TokenCursorReader } from "../../work-graph/server";
import { buildTaskBoard } from "./task-board";

/** The strict `threadLiveOutput` item: board internals (waitingFor, attempt ids, pmThreadId) stay server-side. */
export type ThreadLiveItem = {
  key: string; runId: string; taskId: string | null; title: string;
  column: "queued" | "running" | "checking" | "blocked" | "done"; phase: string;
  stage: string | null; model: string | null; since: number | null;
  threadId: string | null; updatedAt: number; detail: string | null;
  projectId: string | null; kind: "task" | "workflow" | "phase" | "batch"; state: string;
};

export type ThreadLive = {
  role: "pm" | "writer" | "helper";
  pmThreadId: string | null;
  items: ThreadLiveItem[];
  strips: ReturnType<typeof workGraphStrips>;
  /** The PM chat's open run even while it has no task items yet (a native CLI run before its first dispatch). */
  session: { runId: string; state: string; kind: string } | null;
};

const WEEK_MS = 7 * 86_400_000;
const MAX_ITEMS = 40;

/**
 * What Lane Pilot does for a chat, for the thread's info panel (owner, 2026-10-23: «сижу в чате и могу посмотреть, что сейчас работает,
 * какая задача выполняется, её пошаговость»). A PM chat sees the tasks of its runs of the last week plus the workflows linked to those
 * runs; a writer or a helper thread sees the task it works on. Any other thread gets null, and the panel shows nothing.
 */
export function readThreadLive(db: LanePilotDatabase, threadId: string, cursorRow: TokenCursorReader, now = Date.now()): ThreadLive | null {
  const runs = listRunsForPmThread(db, threadId);
  let role: ThreadLive["role"] = "pm", focus: { runId: string; taskId: string } | null = null, projectId: string | null = runs[0]?.project_id ?? null, pmThreadId: string | null = threadId;
  if (!runs.length) {
    const writer = latestAttemptWorkForThread(db, threadId);
    const helper = writer ? undefined : latestStageWorkForThread(db, threadId);
    const row = writer ?? helper;
    if (!row) return null;
    role = writer ? "writer" : "helper";
    focus = { runId: row.run_id, taskId: row.task_id };
    projectId = row.project_id;
    pmThreadId = row.pm_thread_id;
  }
  const runIds = focus ? [focus.runId] : runs.map((run) => run.id);
  const board = buildTaskBoard(db, { projectId, doneSince: now - WEEK_MS, limit: 200, runIds, linkedRunIds: runIds })
    .filter((item) => (item.kind === "task" || item.kind === "workflow") && (!focus || item.taskId === focus.taskId))
    .slice(0, MAX_ITEMS);
  const items: ThreadLiveItem[] = board.map((item) => ({
    key: item.key, runId: item.runId, taskId: item.taskId, title: item.title,
    column: item.column, phase: item.phase, stage: item.stage, model: item.model, since: item.since,
    threadId: item.threadId, updatedAt: item.updatedAt, detail: item.detail,
    projectId: item.projectId ?? null, kind: item.kind, state: item.state,
  }));
  const strips = workGraphStrips(db, items.flatMap((item) => (item.taskId ? [{ runId: item.runId, taskId: item.taskId }] : [])), cursorRow);
  const open = role === "pm" ? openRunOfPmThread(db, threadId) : undefined;
  const sessionRun = open ? getRun(db, open.id) : undefined;
  const session = sessionRun && !sessionRun.closed_at ? { runId: sessionRun.id, state: sessionRun.state, kind: sessionRun.kind } : null;
  return { role, pmThreadId, items, strips, session };
}
