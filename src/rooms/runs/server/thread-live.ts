import { latestAttemptWorkForThread, latestStageWorkForThread, listRunsForPmThread, type LanePilotDatabase } from "../../storage";

import { workGraphStrips, type TokenCursorReader } from "../../work-graph/server";
import { buildTaskBoard, type BoardItem } from "./task-board";

/**
 * What Lane Pilot does for a chat, for the thread's info panel (owner, 2026-10-23: «сижу в чате и могу посмотреть, что сейчас работает,
 * какая задача выполняется, её пошаговость»). A PM chat sees the tasks of its runs of the last week; a writer or a helper thread sees the
 * task it works on. Any other thread gets null, and the panel shows nothing.
 */
export type ThreadLive = {
  role: "pm" | "writer" | "helper";
  pmThreadId: string | null;
  items: BoardItem[];
  strips: ReturnType<typeof workGraphStrips>;
};

const WEEK_MS = 7 * 86_400_000;
const MAX_ITEMS = 40;

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
  const items = buildTaskBoard(db, { projectId, doneSince: now - WEEK_MS, limit: 200, runIds })
    .filter((item) => item.kind === "task" && (!focus || item.taskId === focus.taskId))
    .slice(0, MAX_ITEMS);
  const strips = workGraphStrips(db, items.flatMap((item) => (item.taskId ? [{ runId: item.runId, taskId: item.taskId }] : [])), cursorRow);
  return { role, pmThreadId, items, strips };
}
