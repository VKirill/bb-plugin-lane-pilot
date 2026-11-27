import type { MemoryDatabase } from "./store";

/** Returns the newest active memory record ID originated from `taskId`, or null if none exists. */
export function lessonForTask(db: MemoryDatabase, taskId: string): string | null {
  const row = db
    .prepare("SELECT id FROM lane_pilot_memory WHERE origin_task_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  return row?.id ?? null;
}
