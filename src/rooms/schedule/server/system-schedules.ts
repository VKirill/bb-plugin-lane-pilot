import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { ScheduleInput } from "../model";
import type { ScheduleRow } from "../store";

/**
 * Lane Pilot's own schedules on the schedule board: the plugin's periodic jobs a person should see, pause and run by hand, instead of hidden
 * `scheduleIsolated` timers. They live in the global project (`*`, «every project» on the board) and are made once: the row is found by its
 * `created_by` (`system:<key>`), and a kv mark remembers it was made, so a schedule the owner deleted is not made again at the next start
 * (he pauses it, or turns the job off by its setting). The owner may edit the time; the job itself is the graph the row names.
 */
export type SystemSchedule = { key: string; definition: Omit<ScheduleInput, "projectId"> };

/** The worktree cleanup (docs/worktrees.md): the hourly sweep of Lane Pilot's root and the daily pass over every class on every machine. */
export const SYSTEM_SCHEDULES: readonly SystemSchedule[] = [
  { key: "worktree-cleanup-hourly", definition: {
    name: "Уборка worktree: ежечасно",
    description: "Lane Pilot: ежечасный проход по ~/.lane-pilot/worktrees на каждой подключённой машине — копии без открытой попытки, чистые и влитые, уходят; с правками или невлитыми коммитами остаются. Выключатель: cleanup.worktrees. docs/worktrees.md",
    task: { kind: "workflow", workflowId: "lp.worktree-cleanup", inputs: { pass: "hourly" } },
    when: { type: "cron", cron: "14 * * * *" }, missed: "skip", overlap: "skip", timeoutSec: 900, maxFailures: 3,
  } },
  { key: "worktree-cleanup-daily", definition: {
    name: "Уборка worktree: ежедневно",
    description: "Lane Pilot: ежедневный проход по всем классам worktree (корень Lane Pilot, .claude/worktrees, .worktrees, .git/lp-phases, BB-окружения попыток) с git worktree prune; влитое и старше cleanup.worktree_max_age_days дней или отменённой задачи удаляется вместе с веткой, невлитое и грязное остаётся и попадает в отчёт. docs/worktrees.md",
    task: { kind: "workflow", workflowId: "lp.worktree-cleanup", inputs: { pass: "daily" } },
    when: { type: "cron", cron: "40 4 * * *" }, missed: "run_once", overlap: "skip", timeoutSec: 3600, maxFailures: 3,
  } },
];

export const systemScheduleBy = (key: string) => `system:${key}`;
const markKey = (key: string) => `lp.system-schedule.${key}`;

type Deps = {
  list: () => readonly Pick<ScheduleRow, "id" | "created_by">[];
  save: (raw: unknown, by: string) => Promise<{ ok: true; schedule: { id: string } } | { ok: false; problems: string[] }>;
  kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
  log: (message: string) => void;
};

/** Makes the system schedules that were never made; returns the keys it made now. A failed save is logged and tried again at the next start. */
export async function ensureSystemSchedules(deps: Deps, schedules: readonly SystemSchedule[] = SYSTEM_SCHEDULES): Promise<string[]> {
  const made: string[] = [];
  const rows = deps.list();
  for (const item of schedules) {
    const by = systemScheduleBy(item.key);
    const existing = rows.find((row) => row.created_by === by);
    if (existing) { if (!(await deps.kv.get(markKey(item.key)).catch(() => null))) await deps.kv.set(markKey(item.key), existing.id).catch(() => undefined); continue; }
    if (await deps.kv.get(markKey(item.key)).catch(() => null)) continue;
    const saved = await deps.save({ ...item.definition, projectId: GLOBAL_SETTINGS_PROJECT_ID }, by).catch((cause: unknown) => ({ ok: false as const, problems: [cause instanceof Error ? cause.message : String(cause)] }));
    if (!saved.ok) { deps.log(`Lane Pilot system schedule ${item.key} not made: ${saved.problems.join("; ")}`); continue; }
    await deps.kv.set(markKey(item.key), saved.schedule.id).catch(() => undefined);
    made.push(item.key);
  }
  return made;
}
