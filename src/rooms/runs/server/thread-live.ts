import type { LanePilotDatabase } from "../../storage";
import { workGraphStrips } from "../../work-graph/server";
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

export function readThreadLive(db: LanePilotDatabase, threadId: string, now = Date.now()): ThreadLive | null {
  const runs = db.prepare("SELECT id, project_id FROM lane_pilot_run WHERE pm_thread_id=? ORDER BY updated_at DESC LIMIT 30").all(threadId) as Array<{ id: string; project_id: string }>;
  let role: ThreadLive["role"] = "pm", focus: { runId: string; taskId: string } | null = null, projectId: string | null = runs[0]?.project_id ?? null, pmThreadId: string | null = threadId;
  if (!runs.length) {
    const writer = db.prepare("SELECT a.run_id, a.task_id, r.project_id, r.pm_thread_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.thread_id=? ORDER BY a.updated_at DESC LIMIT 1").get(threadId) as
      { run_id: string; task_id: string; project_id: string; pm_thread_id: string | null } | undefined;
    const helper = writer ? undefined : db.prepare("SELECT s.run_id, s.task_id, r.project_id, r.pm_thread_id FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id WHERE s.thread_id=? ORDER BY s.updated_at DESC LIMIT 1").get(threadId) as
      { run_id: string; task_id: string; project_id: string; pm_thread_id: string | null } | undefined;
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
  const strips = workGraphStrips(db, items.flatMap((item) => (item.taskId ? [{ runId: item.runId, taskId: item.taskId }] : [])));
  return { role, pmThreadId, items, strips };
}
