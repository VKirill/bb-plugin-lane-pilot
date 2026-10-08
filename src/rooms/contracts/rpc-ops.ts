import { z } from "zod";
import { acceptanceTotalsSchema, acceptanceWeekSchema } from "@lane-pilot/contracts";

/** Run control, statistics, deploy, self-repair, canary and the stack installer. */
export const rpcOps = {
  /** Stops a whole run: cancels every open attempt and keeps the run out of parking and restarts until the PM sends a task again. */
  halt_run: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), canceled: z.array(z.string()), left: z.array(z.string()) }).strict(),
  },
  cancel_attempt: {
    input: z.object({ attemptId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), state: z.string(), reason: z.string().nullable() }).strict(),
  },
  retry_attempt: {
    input: z.object({ attemptId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), state: z.string(), attemptId: z.string(), reason: z.string().nullable() }).strict(),
  },
  resume_runs: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      resumed: z.array(z.string()),
      skipped: z.array(z.string()),
      finished: z.array(z.string()),
    }).strict(),
  },
  writer_brief_stats: {
    input: z.object({ projectId: z.string().min(1), since: z.number().int(), until: z.number().int().optional() }).strict(),
    output: z.unknown(),
  },
  /** How much each critic is worth in a project: blocks, what became of blocked tasks, misses, first-try acceptance. */
  critic_stats: {
    input: z.object({ projectId:z.string().min(1), days:z.number().int().min(1).max(90).default(7) }).strict(),
    output: z.object({ days:z.number(), stats:z.array(z.object({
      stage:z.string(), runs:z.number(), approved:z.number(), blocked:z.number(), skipped:z.number(), blockShare:z.number().nullable(),
      afterBlock:z.object({ fixedAndAccepted:z.number(), sentAgainNotAccepted:z.number(), dropped:z.number() }),
      missed:z.object({ count:z.number(), examples:z.array(z.object({ taskId:z.string(), reason:z.string() })) }),
      firstTryAccepted:z.object({ reviewed:z.object({ tasks:z.number(), share:z.number().nullable() }), notReviewed:z.object({ tasks:z.number(), share:z.number().nullable() }) }),
    })) }),
  },
  /** Whether writers carry their context: cold writer threads per accepted task, continued turns, time to acceptance. */
  writer_reuse_stats: {
    input: z.object({ projectId:z.string().min(1), days:z.number().int().min(1).max(90).default(7) }).strict(),
    output: z.object({ days:z.number(), stats:z.object({ tasks:z.number(), accepted:z.number(), coldThreads:z.number(), continued:z.number(),
      coldPerAccepted:z.number().nullable(), areaShare:z.number().nullable(), tasksPerArea:z.number().nullable(), medianMinutesToAccept:z.number().nullable() }) }),
  },
  /** Acceptance per project and ISO week: first-try, eventual, attempts per accepted task, redispatch families, failure causes. */
  acceptance_stats: {
    input: z.object({ days:z.number().int().min(1).max(90).default(28), projectId:z.string().min(1).optional() }).strict(),
    output: z.object({
      days: z.number(),
      totals: acceptanceTotalsSchema,
      projects: z.array(z.object({ projectId:z.string(), totals:acceptanceTotalsSchema, weeks:z.array(acceptanceWeekSchema) })),
    }),
  },
  /** Before a deploy: hold new checkout-writing host calls and report the ones still running. */
  deploy_drain: {
    input: z.object({ on:z.boolean() }).strict(),
    output: z.unknown(),
  },
  deploy_status: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  self_repair_status: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  self_repair_configure: {
    input: z.object({
      enabled: z.boolean().optional(),
      projectId: z.string().min(1).optional(),
      environmentId: z.string().min(1).optional(),
      sectionId: z.string().min(1).nullable().optional(),
      providerId: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      reasoningLevel: z.string().min(1).optional(),
      maxPerDay: z.number().int().min(0).max(20).optional(),
      ignoreProjects: z.array(z.string().min(1)).max(50).optional(),
      hubSsh: z.string().trim().min(1).max(300).optional(),
      hubDb: z.string().trim().min(1).max(300).optional(),
      hubLog: z.string().trim().min(1).max(300).optional(),
    }).strict(),
    output: z.unknown(),
  },
  canary_status: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  self_repair_tick: {
    input: z.object({ dryRun: z.boolean().default(true), since: z.number().int().optional() }).strict(),
    output: z.unknown(),
  },
  stack_detect: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.unknown(),
  },
  stack_install: {
    input: z.object({ projectId: z.string().min(1), confirmExternalOps: z.boolean() }).strict(),
    output: z.unknown(),
  },
  stack_connect: {
    input: z.object({ projectId: z.string().min(1), confirmExternalOps: z.boolean() }).strict(),
    output: z.unknown(),
  },
  stack_rollback: {
    input: z.object({ projectId: z.string().min(1), snapshotPath: z.string().startsWith("/").optional() }).strict(),
    output: z.unknown(),
  },
};
