import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { ScheduleInput, ScheduleRow } from "../../models/schedule";

/**
 * Lane Pilot's own schedules on the schedule board: the plugin's periodic jobs a person should see, pause and run by hand, instead of hidden
 * `scheduleIsolated` timers. They live in the global project (`*`, «every project» on the board) and are made once: the row is found by its
 * `created_by` (`system:<key>`), and a kv mark remembers it was made, so a schedule the owner deleted is not made again at the next start
 * (he pauses it, or turns the job off by its setting). The owner may edit the time; the job itself is the graph the row names.
 */
export type SystemSchedule = {
  key: string;
  /** The `startedBy` of the graph the row runs: a starter graph refuses every start but its own system schedule's (workflow-triggers.ts `starter`). */
  starter: string;
  definition: Omit<ScheduleInput, "projectId">;
};

/** The worktree cleanup (docs/worktrees.md): the hourly sweep of Lane Pilot's root and the daily pass over every class on every machine. */
export const SYSTEM_SCHEDULES: readonly SystemSchedule[] = [
  { key: "worktree-cleanup-hourly", starter: "worktree-cleanup", definition: {
    name: "Уборка worktree: ежечасно",
    description: "Lane Pilot: ежечасный проход по ~/.lane-pilot/worktrees на каждой подключённой машине — копии без открытой попытки, чистые и влитые, уходят; с правками или невлитыми коммитами остаются. Выключатель: cleanup.worktrees. docs/worktrees.md",
    task: { kind: "workflow", workflowId: "lp.worktree-cleanup", inputs: { pass: "hourly" } },
    when: { type: "cron", cron: "14 * * * *" }, missed: "skip", overlap: "skip", timeoutSec: 900, maxFailures: 3,
  } },
  { key: "worktree-cleanup-daily", starter: "worktree-cleanup", definition: {
    name: "Уборка worktree: ежедневно",
    description: "Lane Pilot: ежедневный проход по всем классам worktree (корень Lane Pilot, .claude/worktrees, .worktrees, .git/lp-phases, BB-окружения попыток) с git worktree prune; влитое и старше cleanup.worktree_max_age_days дней или отменённой задачи удаляется вместе с веткой, невлитое и грязное остаётся и попадает в отчёт. docs/worktrees.md",
    task: { kind: "workflow", workflowId: "lp.worktree-cleanup", inputs: { pass: "daily" } },
    when: { type: "cron", cron: "40 4 * * *" }, missed: "run_once", overlap: "skip", timeoutSec: 3600, maxFailures: 3,
  } },
  { key: "owner-push", starter: "owner-push", definition: {
    name: "Напоминания владельцу в Telegram",
    description: "Каждые 30 минут отправляет новые срочные вопросы «Ждут владельца» в Telegram, с соблюдением тихих часов.",
    task: { kind: "workflow", workflowId: "lp.owner-push", inputs: {} },
    when: { type: "cron", cron: "*/30 * * * *" }, missed: "skip", overlap: "skip", timeoutSec: 120, maxFailures: 3,
  } },
  { key: "daily-report", starter: "daily-report", definition: {
    name: "Ежедневный дайджест владельцу",
    description: "Короткая утренняя сводка в Telegram (до 9 строк) о попытках, графах и расходах за сутки.",
    task: { kind: "workflow", workflowId: "lp.daily-report", inputs: {} },
    when: { type: "cron", cron: "0 * * * *" }, missed: "run_once", overlap: "skip", timeoutSec: 120, maxFailures: 3,
  } },
  { key: "review-desk", starter: "review-desk", definition: {
    name: "Еженедельный разбор владельца",
    description: "Раз в неделю по понедельникам собирает решения всех циклов с вариантами по умолчанию и отправляет сводку в Telegram.",
    task: { kind: "workflow", workflowId: "lp.review-desk", inputs: {} },
    when: { type: "cron", cron: "0 10 * * 1" }, missed: "run_once", overlap: "skip", timeoutSec: 120, maxFailures: 3,
  } },
];

export const systemScheduleBy = (key: string) => `system:${key}`;

export type ProjectSchedule = {
  key: string;
  starter: string | null;
  build: (projectId: string, options?: { leadCron?: string }) => Omit<ScheduleInput, "projectId">;
};

/** Per-project calendar rows on the schedule board: backlog scan and the lead's tick, replacing hidden timers. */
export const PROJECT_SCHEDULES: readonly ProjectSchedule[] = [
  {
    key: "backlog-scan",
    starter: "backlog-scan",
    build: (projectId) => ({
      name: "Скан бэклога",
      description: "Lane Pilot: проверяет .agents/todos/items/*.yaml и автоматически выдаёт готовую задачу в PM-чат (до 1 в день на проект, 3 по хабу).",
      task: { kind: "workflow", workflowId: "lp.backlog-scan", inputs: { projectId } },
      when: { type: "cron", cron: "3 * * * *" },
      missed: "skip",
      overlap: "skip",
      timeoutSec: 1200,
      maxFailures: 3,
    }),
  },
  {
    key: "lead-tick",
    starter: null,
    build: (projectId, options) => ({
      name: "Тик Штурмана",
      description: "Lane Pilot: анализ проекта и запись предложений и гипотез в дерево дороги и журнал эволюции.",
      task: { kind: "workflow", workflowId: "lead-tick", inputs: { projectId, trigger: "cron" } },
      when: { type: "cron", cron: options?.leadCron?.trim() || "30 6,10,14,18 * * *" },
      missed: "skip",
      overlap: "skip",
      timeoutSec: 2700,
      maxFailures: 3,
    }),
  },
];

/**
 * The starter a schedule row may start a starter graph with: the one of the system schedule whose `created_by` the row carries, else none.
 * `created_by` is written by the server once at insert (owner, cli, agent:<thread>, system:<key>) and an update keeps it, so no chat claims it.
 */
export function systemStarterOf(createdBy: string, schedules: readonly SystemSchedule[] = SYSTEM_SCHEDULES): string | null {
  return schedules.find((item) => systemScheduleBy(item.key) === createdBy)?.starter
    ?? PROJECT_SCHEDULES.find((item) => systemScheduleBy(item.key) === createdBy)?.starter
    ?? null;
}

export function isSystemScheduleCreator(createdBy: string): boolean {
  return SYSTEM_SCHEDULES.some((item) => systemScheduleBy(item.key) === createdBy)
    || PROJECT_SCHEDULES.some((item) => systemScheduleBy(item.key) === createdBy);
}

const markKey = (key: string) => `lp.system-schedule.${key}`;
const projectMarkKey = (key: string, projectId: string) => `lp.project-schedule.${key}.${projectId}`;

type Deps = {
  list: () => readonly Pick<ScheduleRow, "id" | "created_by" | "project_id">[] | readonly Pick<ScheduleRow, "id" | "created_by">[];
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

/** Ensures per-project calendar rows (`backlog-scan`, `lead-tick`) once per project; deleted rows stay deleted via KV marks. */
export async function ensureProjectSchedules(
  deps: Deps,
  projectIds: readonly string[],
  options: { leadCron?: string } = {},
  schedules: readonly ProjectSchedule[] = PROJECT_SCHEDULES,
): Promise<Array<{ projectId: string; key: string }>> {
  const made: Array<{ projectId: string; key: string }> = [];
  const rows = deps.list() as readonly Pick<ScheduleRow, "id" | "created_by" | "project_id">[];
  const uniqueProjects = [...new Set(projectIds)].filter((id) => Boolean(id) && id !== GLOBAL_SETTINGS_PROJECT_ID);
  for (const projectId of uniqueProjects) {
    for (const item of schedules) {
      const by = systemScheduleBy(item.key);
      const mark = projectMarkKey(item.key, projectId);
      const existing = rows.find((row) => row.project_id === projectId && row.created_by === by);
      if (existing) {
        if (!(await deps.kv.get(mark).catch(() => null))) await deps.kv.set(mark, existing.id).catch(() => undefined);
        continue;
      }
      if (await deps.kv.get(mark).catch(() => null)) continue;
      const saved = await deps.save({ ...item.build(projectId, options), projectId }, by)
        .catch((cause: unknown) => ({ ok: false as const, problems: [cause instanceof Error ? cause.message : String(cause)] }));
      if (!saved.ok) { deps.log(`Lane Pilot project schedule ${item.key} (${projectId}) not made: ${saved.problems.join("; ")}`); continue; }
      await deps.kv.set(mark, saved.schedule.id).catch(() => undefined);
      made.push({ projectId, key: item.key });
    }
  }
  return made;
}
