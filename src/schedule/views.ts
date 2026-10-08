import { z } from "zod";
import { RUN_STATUSES, RUN_TRIGGERS, SCHEDULE_STATES, MISSED_POLICIES, OVERLAP_POLICIES, scheduleTaskSchema } from "./model";

/**
 * What the board and the calendar read: schedules and runs as plain data, in the shape of the RPCs `schedule_*` (src/contracts.ts).
 * Times are ms since epoch. A task never carries a secret value: `env` and `accounts` are Env Catalog names.
 */
export const BOARD_COLUMNS = ["scheduled", "running", "waiting", "done", "failed", "paused"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const runViewSchema = z.object({
  id: z.string(), scheduleId: z.string(), scheduledAt: z.number(), trigger: z.enum(RUN_TRIGGERS), status: z.enum(RUN_STATUSES), reason: z.string().nullable(),
  queuedAt: z.number(), startedAt: z.number().nullable(), finishedAt: z.number().nullable(), durationMs: z.number().nullable(),
  /** thread: the errand's thread (link `@thread:<refId>`); workflow_run: the workflow run id; host_job: the job on `hostId`. */
  refKind: z.string().nullable(), refId: z.string().nullable(), hostId: z.string().nullable(),
  exitCode: z.number().nullable(), output: z.string().nullable(), error: z.string().nullable(), truncated: z.boolean(),
  /**
   * What the run used, read from the run thread's token usage (schedule_runs / schedule_get fill it; elsewhere it is empty).
   * `usageKnown` false: no usage was reported (an ACP provider, or the sync has not seen the thread yet): print «unknown», not 0.
   */
  providerId: z.string().nullable(), model: z.string().nullable(), tokens: z.number().nullable(), costUsd: z.number().nullable(), usageKnown: z.boolean(),
  /** The machine the work actually ran on (name; the id when BB does not list it): a script's host, the errand thread's own machine. `hostId` stays the machine used for conflict detection. */
  hostName: z.string().nullable(),
}).strict();
export type RunView = z.infer<typeof runViewSchema>;

export const whenViewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), cron: z.string(), timezone: z.string() }).strict(),
  z.object({ type: z.literal("once"), runAt: z.number() }).strict(),
]);

/** Who runs an errand (src/schedule/errand-model.ts) and where that comes from. Null for a script (no model) and a chain (its steps have their own). */
export const modelViewSchema = z.object({
  providerId: z.string(), model: z.string(), reasoningEffort: z.string(), serviceTier: z.enum(["default", "fast"]).nullable(),
  source: z.enum(["task", "preset", "schedule-default", "errand-role", "pm"]), sourceKey: z.string().nullable(), issues: z.array(z.string()),
}).strict();
export type ModelView = z.infer<typeof modelViewSchema>;

/** Approximate cost of a run: the average of the runs with known usage, and the price of the resolved model per 1M tokens (null when it has none). */
export const costViewSchema = z.object({
  perRunUsd: z.number().nullable(), samples: z.number(), priceInPer1M: z.number().nullable(), priceOutPer1M: z.number().nullable(),
}).strict();
export type CostView = z.infer<typeof costViewSchema>;

/** Where the task runs: the project, the Project Folders section its PM chat is filed in, the machine and the working folder. */
export const whereViewSchema = z.object({
  projectName: z.string().nullable(), sectionId: z.string().nullable(), sectionName: z.string().nullable(), sectionPath: z.string().nullable(),
  hostId: z.string().nullable(), hostName: z.string().nullable(), cwd: z.string().nullable(),
}).strict();
export type WhereView = z.infer<typeof whereViewSchema>;

export const scheduleViewSchema = z.object({
  id: z.string(), projectId: z.string(), name: z.string(), description: z.string(),
  task: scheduleTaskSchema, when: whenViewSchema,
  missed: z.enum(MISSED_POLICIES), missedLimit: z.number(), overlap: z.enum(OVERLAP_POLICIES), timeoutSec: z.number(), maxFailures: z.number(),
  state: z.enum(SCHEDULE_STATES), pauseReason: z.string().nullable(), consecutiveFailures: z.number(),
  createdBy: z.string(), createdAt: z.number(), updatedAt: z.number(),
  /** The next fire times (as many as asked for), oldest first; none when paused or finished. */
  nextFires: z.array(z.number()),
  /** The machine the work uses, when it has one (a script's host, an errand's browser machine). */
  machine: z.string().nullable(),
  /** The newest run that was not skipped. */
  lastRun: runViewSchema.nullable(),
  /** Runs started and not finished (running or waiting for the owner). */
  active: z.array(runViewSchema),
  /** The board column this card belongs in. */
  column: z.enum(BOARD_COLUMNS),
  /** Who runs an errand, resolved now; null for a script and a chain. */
  model: modelViewSchema.nullable(),
  /** Cost per run of an errand; null for the other kinds. */
  cost: costViewSchema.nullable(),
  where: whereViewSchema,
}).strict();
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

export const conflictSchema = z.object({
  scheduleId: z.string(), name: z.string(), machine: z.string(),
  /** How many pairs of start times in the next 7 days fall within `windowMinutes` of each other, and the first few. */
  pairs: z.number(), windowMinutes: z.number(), samples: z.array(z.object({ at: z.number(), otherAt: z.number() }).strict()),
}).strict();
export type ScheduleConflict = z.infer<typeof conflictSchema>;

/** The Automation default model (`schedule.errand_default`): the value in force, the two levels it can come from, and the versions `save_setting` / `reset_project_settings` need. */
const errandDefaultValue = z.union([
  z.object({ provider: z.string(), model: z.string(), reasoning_effort: z.string().optional(), service_tier: z.enum(["default", "fast"]).optional() }).strict(),
  z.object({ preset: z.string() }).strict(),
]);
export const errandDefaultSchema = z.object({
  effective: errandDefaultValue.nullable(), source: z.enum(["project", "global"]).nullable(),
  project: errandDefaultValue.nullable(), global: errandDefaultValue.nullable(), projectVersion: z.number(), globalVersion: z.number(),
}).strict();
export type ErrandDefaultView = z.infer<typeof errandDefaultSchema>;

export const hostOptionSchema =z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict();
