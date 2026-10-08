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
}).strict();
export type RunView = z.infer<typeof runViewSchema>;

export const whenViewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), cron: z.string(), timezone: z.string() }).strict(),
  z.object({ type: z.literal("once"), runAt: z.number() }).strict(),
]);

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
}).strict();
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

export const conflictSchema = z.object({
  scheduleId: z.string(), name: z.string(), machine: z.string(),
  /** How many pairs of start times in the next 7 days fall within `windowMinutes` of each other, and the first few. */
  pairs: z.number(), windowMinutes: z.number(), samples: z.array(z.object({ at: z.number(), otherAt: z.number() }).strict()),
}).strict();
export type ScheduleConflict = z.infer<typeof conflictSchema>;

export const hostOptionSchema = z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict();
