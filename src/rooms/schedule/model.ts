import { z } from "zod";
import { localTimezone } from "../../workflow/cron";
import { parseDelay, scheduleTimeProblem } from "./time";

/**
 * A scheduled task (schedule board): what to do, when, and how the scheduler treats a run that cannot go on time. The task is one
 * of three kinds: a Lane Pilot workflow, an agent errand, or a script on a chosen machine.
 */
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

export const workflowTaskSchema = z.object({
  kind: z.literal("workflow"),
  workflowId: z.string().min(1).max(120),
  inputs: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const errandTaskSchema = z.object({
  kind: z.literal("errand"),
  task: z.string().min(10).max(20_000),
  title: z.string().min(1).max(120).optional(),
  /** The errand may change things inside the owner's accounts (the PM's `authorized`); false reads and reports only. */
  authorized: z.boolean().default(false),
  /** Env Catalog names the helper reads itself (the owner must have allowed each for the project). */
  accounts: z.array(envName).max(8).default([]),
  /** Who runs it (src/schedule/errand-model.ts): the task's own provider + model (`model` alone means claude-code), or a model preset name; absent, the Automation default and the errand role default decide. */
  providerId: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(120).optional(),
  reasoning: z.enum(["low", "medium", "high", "xhigh", "ultracode", "max"]).optional(),
  serviceTier: z.enum(["default", "fast"]).optional(),
  preset: z.string().min(1).max(120).optional(),
}).strict();

export const scriptTaskSchema = z.object({
  kind: z.literal("script"),
  /** The machine the script runs on (a host id of BB). */
  hostId: z.string().min(1).max(200),
  command: z.string().min(1).max(32_000),
  cwd: z.string().startsWith("/").max(1000),
  /** Env Catalog names handed to the script as environment variables (a login becomes NAME_USERNAME / NAME_PASSWORD / NAME_URL). */
  env: z.array(envName).max(16).default([]),
  maxOutputBytes: z.number().int().min(1024).max(512 * 1024).optional(),
}).strict();

export const scheduleTaskSchema = z.discriminatedUnion("kind", [workflowTaskSchema, errandTaskSchema, scriptTaskSchema]);
export type ScheduleTask = z.infer<typeof scheduleTaskSchema>;
export type ScheduleKind = ScheduleTask["kind"];

export const whenSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), cron: z.string().min(9).max(120), timezone: z.string().min(1).max(80).optional() }).strict(),
  /** One run at a moment (ms since epoch) or after a delay («2h», «через 2 ч») counted from the save. */
  z.object({ type: z.literal("once"), runAt: z.number().int().positive().optional(), delay: z.string().max(40).optional() }).strict(),
]);
export type ScheduleWhen = z.infer<typeof whenSchema>;

export const MISSED_POLICIES = ["run_once", "skip", "run_all"] as const;
export const OVERLAP_POLICIES = ["skip", "queue", "parallel"] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

export const scheduleInputSchema = z.object({
  /** An existing schedule to change; absent creates one. */
  id: z.string().min(1).max(80).optional(),
  projectId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  task: scheduleTaskSchema,
  when: whenSchema,
  /** A tick missed while the hub was off or reloading: run one catching-up run, skip it, or run each (up to missedLimit). */
  missed: z.enum(MISSED_POLICIES).default("run_once"),
  missedLimit: z.number().int().min(1).max(20).default(5),
  /** A tick that comes while the last run still runs: skip it, queue it behind, or run beside. */
  overlap: z.enum(OVERLAP_POLICIES).default("skip"),
  /** Seconds a run may take; a workflow waiting for the owner is not counted (it has its own limit). */
  timeoutSec: z.number().int().min(10).max(86_400).optional(),
  /** Consecutive failures that pause the schedule; 0 never pauses it. */
  maxFailures: z.number().int().min(0).max(50).default(3),
}).strict();
export type ScheduleInput = z.input<typeof scheduleInputSchema>;
export type ScheduleDefinition = z.output<typeof scheduleInputSchema>;

/** A run of a workflow or an errand may take long; a script is expected to be short. */
export const DEFAULT_TIMEOUT_SEC: Record<ScheduleKind, number> = { workflow: 3600, errand: 3600, script: 600 };
/** A workflow run waiting for the owner's answer is given up after this. */
export const WAITING_LIMIT_MS = 72 * 3_600_000;
export const MAX_RUN_OUTPUT = 64 * 1024;
export const MAX_SCRIPT_TIMEOUT_SEC = 10_700;

export type NormalizedWhen = { type: "cron"; cron: string; timezone: string } | { type: "once"; runAt: number };

/** The definition with its defaults filled in and `when` made concrete, or the problems that stop it. Pure apart from the clock. */
export function normalizeSchedule(raw: unknown, now: number): { ok: true; value: ScheduleDefinition & { when: NormalizedWhen; timeoutSec: number } } | { ok: false; problems: string[] } {
  const parsed = scheduleInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`) };
  const value = parsed.data;
  let when: NormalizedWhen;
  if (value.when.type === "cron") {
    const timezone = value.when.timezone ?? localTimezone();
    const problem = scheduleTimeProblem(value.when.cron, timezone);
    if (problem) return { ok: false, problems: [`when: ${problem}`] };
    when = { type: "cron", cron: value.when.cron.trim().replace(/\s+/gu, " "), timezone };
  } else {
    const delay = value.when.delay ? parseDelay(value.when.delay) : null;
    if (value.when.delay && delay === null) return { ok: false, problems: [`when.delay: "${value.when.delay}" is not a delay (use 30m, 2h, 1d)`] };
    const runAt = value.when.runAt ?? (delay !== null ? now + delay : undefined);
    if (runAt === undefined) return { ok: false, problems: ["when: a one-time task needs runAt or delay"] };
    if (runAt < now - 60_000) return { ok: false, problems: ["when.runAt: that moment is in the past"] };
    when = { type: "once", runAt };
  }
  const timeoutSec = value.timeoutSec ?? DEFAULT_TIMEOUT_SEC[value.task.kind];
  // A script is a host job, and a host job is bounded by the protocol (src/contracts.ts, jobStart).
  if (value.task.kind === "script" && timeoutSec > MAX_SCRIPT_TIMEOUT_SEC) return { ok: false, problems: [`timeoutSec: a script may run at most ${MAX_SCRIPT_TIMEOUT_SEC} s`] };
  return { ok: true, value: { ...value, when, timeoutSec } };
}

export const RUN_STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "timed_out", "skipped", "canceled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_TRIGGERS = ["tick", "catchup", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const SCHEDULE_STATES = ["active", "paused", "done"] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];
