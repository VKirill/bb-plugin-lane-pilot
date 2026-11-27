import { z } from "zod";
import { AUTONOMY_CLASSES, CARD_KINDS, taskOutcomeSchema } from "@lane-pilot/contracts";


const idSchema = z.string().min(1).max(200);
const weekSchema = z.string().regex(/^\d{4}-W\d{2}$/);

export const BRAKE_IDS = ["schedules", "conveyor", "graphs", "staff"] as const;
export type BrakeId = (typeof BRAKE_IDS)[number];
const brakeIdSchema = z.enum(BRAKE_IDS);

export const activeItemSchema = z.object({
  kind: z.enum(["task", "workflow", "batch", "phase"]),
  key: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  stage: z.string().nullable(),
  since: z.number(),
  costUsd: z.number().nullable(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
}).strict();

export const goalLineSchema = z.object({
  projectId: z.string(),
  domain: z.string(),
  metric: z.string(),
  current: z.number().nullable(),
  target: z.number().nullable(),
  due: z.string().nullable(),
  onTrack: z.boolean().nullable(),
}).strict();

export const consoleOverviewOutput = z.object({
  tz: z.string(),
  counts: z.object({
    active: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    closedToday: z.number().int().nonnegative(),
    spendTodayUsd: z.number().nullable(),
    goalsOnTrack: z.number().int().nonnegative(),
    goalsTotal: z.number().int().nonnegative(),
  }).strict(),
  active: z.array(activeItemSchema),
  closedByDay: z.array(z.object({
    day: z.string(),
    accepted: z.number().int().nonnegative(),
    reworked: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).strict()),
  goals: z.array(goalLineSchema),
  costCoverage: z.number().min(0).max(1),
}).strict();

export const taskHistoryRowSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  title: z.string(),
  outcome: taskOutcomeSchema,
  attempts: z.number().int().nonnegative(),
  finishedAt: z.number(),
  durationMs: z.number().nullable(),
  costUsd: z.number().nullable(),
  mergeSha: z.string().nullable(),
  failureReason: z.string().nullable(),
  lessonMemoryId: z.string().nullable(),
}).strict();

export const threadScopeOutput = z.object({
  threadId: z.string(),
  projectId: z.string().nullable(),
  sectionId: z.string().nullable(),
  hostId: z.string().nullable(),
  cwd: z.string().nullable(),
  repo: z.object({
    root: z.string(),
    remote: z.string().nullable(),
    githubRepoId: z.string().nullable(),
  }).strict().nullable(),
}).strict();

export const autonomousActionSchema = z.object({
  id: z.string(),
  at: z.number(),
  projectId: z.string().nullable(),
  actor: z.string(),
  action: z.string(),
  authority: z.enum(["bounded_auto", "repo_rule", "maintenance"]),
  result: z.enum(["done", "reverted", "failed"]),
  evidenceRef: z.string().nullable(),
  undo: z.object({
    method: z.string(),
    input: z.record(z.string(), z.unknown()),
  }).strict().nullable(),
}).strict();

export const reviewDeskItemSchema = z.object({
  id: z.string(),
  section: z.string(),
  question: z.string(),
  evidence: z.string().nullable(),
  options: z.array(z.object({
    id: z.string(),
    label: z.string(),
    isDefault: z.boolean(),
  }).strict()),
  answered: z.string().nullable(),
  defaultAt: z.number(),
}).strict();

export const reviewDeskViewOutput = z.object({
  week: z.string(),
  items: z.array(reviewDeskItemSchema),
}).strict();

const brakeStateSchema = z.object({
  id: brakeIdSchema,
  paused: z.boolean(),
  since: z.number().nullable(),
  reason: z.string().nullable(),
  impact: z.object({
    label: z.string(),
    count: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const brakesOutput = z.object({
  brakes: z.array(brakeStateSchema),
}).strict();

const specialistShiftSchema = z.object({
  at: z.number(),
  depth: z.string(),
  outcome: z.string(),
  workflowId: z.string().nullable(),
  runId: z.string().nullable(),
}).strict();

const specialistAutonomyRowSchema = z.object({
  actionClass: z.string(),
  level: z.enum(AUTONOMY_CLASSES),
  sample: z.number().int().nonnegative(),
  confidence: z.number().nullable(),
  frozen: z.boolean(),
}).strict();

export const loadoutRoleSchema = z.object({
  role: z.string(),
  kind: z.enum(["pipeline", "specialist", "pm", "custom"]),
  model: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    from: z.enum(["step", "section", "project", "system", "legacy", "builtin"]),
  }).strict(),
  items: z.array(z.object({
    type: z.enum(["skill", "plugin", "mcp", "instructions", "tool"]),
    name: z.string(),
    from: z.enum(["profile", "owner", "required", "domain_pack", "employee", "catalog"]),
    missing: z.boolean(),
  }).strict()),
  contextMode: z.enum(["roles", "inherit", "selected", "none"]),
  machine: z.string().nullable(),
  note: z.string().nullable(),
}).strict();

/** Console methods with registered handlers. */
export const rpcConsole = {
  console_overview: {
    input: z.object({
      projectId: idSchema.optional(),
      sectionId: idSchema.optional(),
      days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
    }).strict(),
    output: consoleOverviewOutput,
  },
  task_history: {
    input: z.object({
      projectId: idSchema.optional(),
      sectionId: idSchema.optional(),
      outcome: taskOutcomeSchema.optional(),
      cursor: idSchema.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }).strict(),
    output: z.object({
      rows: z.array(taskHistoryRowSchema),
      nextCursor: z.string().nullable(),
    }).strict(),
  },
  thread_scope: {
    input: z.object({ threadId: idSchema }).strict(),
    output: threadScopeOutput,
  },
  actions_log: {
    input: z.object({
      projectId: idSchema.optional(),
      since: z.number().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).strict(),
    output: z.object({
      rows: z.array(autonomousActionSchema),
    }).strict(),
  },
  desk_get: {
    input: z.object({
      week: weekSchema.optional(),
    }).strict(),
    output: reviewDeskViewOutput,
  },
  desk_answer: {
    input: z.object({
      itemId: idSchema,
      option: z.string().min(1).max(200),
    }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), item: reviewDeskItemSchema }).strict(),
      z.object({ ok: z.literal(false), reason: z.string() }).strict(),
    ]),
  },
  desk_accept_defaults: {
    input: z.object({
      week: weekSchema,
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      accepted: z.number().int().nonnegative(),
    }).strict(),
  },
  brakes_get: {
    input: z.object({}).strict(),
    output: brakesOutput,
  },
  brakes_set: {
    input: z.object({
      id: brakeIdSchema,
      paused: z.boolean(),
      reason: z.string().max(300).optional(),
    }).strict(),
    output: brakesOutput,
  },
  stop_all: {
    input: z.object({
      reason: z.string().min(3).max(300),
    }).strict(),
    output: z.object({
      brakes: z.array(brakeStateSchema),
      halted: z.array(z.object({
        runId: z.string(),
        ok: z.boolean(),
      }).strict()),
    }).strict(),
  },
  specialist_detail: {
    input: z.object({
      projectId: idSchema,
      domain: idSchema,
    }).strict(),
    output: z.object({
      charter: z.object({
        version: z.number().int(),
        approvedBy: z.string().nullable(),
        approvedAt: z.number().nullable(),
        body: z.record(z.string(), z.unknown()),
        pendingDraft: z.object({
          draftId: z.string(),
          body: z.record(z.string(), z.unknown()),
        }).strict().nullable(),
      }).strict().nullable(),
      shifts: z.object({
        last: specialistShiftSchema.nullable(),
        next: z.object({ at: z.number(), depth: z.string() }).strict().nullable(),
        recent: z.array(specialistShiftSchema).max(10),
      }).strict(),
      northStar: z.object({
        metric: z.string(),
        series: z.array(z.object({ at: z.number(), value: z.number() }).strict()),
        freshAt: z.number().nullable(),
      }).strict().nullable(),
      caps: z.array(z.object({
        period: z.enum(["day", "month", "test"]),
        capUsd: z.number().nullable(),
        usedUsd: z.number(),
      }).strict()),
      autonomy: z.array(specialistAutonomyRowSchema),
      loopHealth: z.object({
        status: z.string(),
        note: z.string().nullable(),
      }).strict().nullable(),
    }).strict(),
  },
  agent_loadout: {
    input: z.object({
      projectId: idSchema.optional(),
      sectionId: idSchema.optional(),
      role: z.string().min(1).max(200).optional(),
    }).strict(),
    output: z.object({
      roles: z.array(loadoutRoleSchema),
    }).strict(),
  },
  memory_cards_list: {
    input: z.object({
      projectId: idSchema,
      kind: z.enum(CARD_KINDS).optional(),
    }).strict(),
    output: z.object({
      cards: z.array(z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        concepts: z.array(z.string()),
        verifiedAt: z.number().nullable(),
        ttlDays: z.number().nullable(),
        stale: z.boolean(),
        ref: z.string().nullable(),
        version: z.number().int(),
      }).strict()),
    }).strict(),
  },
  specialist_autonomy_set: {
    input: z.object({
      projectId: idSchema,
      domain: idSchema,
      actionClass: idSchema,
      level: z.enum(AUTONOMY_CLASSES),
      reason: z.string().max(300).optional(),
    }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), autonomy: z.array(specialistAutonomyRowSchema) }).strict(),
      z.object({ ok: z.literal(false), reason: z.string() }).strict(),
    ]),
  },
  charter_propose: {
    input: z.object({
      projectId: idSchema,
      domain: idSchema,
      charter: z.record(z.string(), z.unknown()),
    }).strict(),
    output: z.object({ draftId: z.string() }).strict(),
  },
  charter_approve: {
    input: z.object({
      projectId: idSchema,
      domain: idSchema,
      draftId: idSchema,
    }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), version: z.number().int() }).strict(),
      z.object({ ok: z.literal(false), reason: z.string() }).strict(),
    ]),
  },
  repo_trust: {
    input: z.object({
      projectId: idSchema,
      sectionId: idSchema.optional(),
    }).strict(),
    output: z.object({
      repo: z.object({
        root: z.string().nullable(),
        remote: z.string().nullable(),
      }).strict(),
      gate: z.object({
        state: z.enum(["passed", "failed", "running", "not_run", "none"]),
        at: z.number().nullable(),
        fresh: z.boolean(),
        reason: z.string().nullable(),
      }).strict(),
      tests: z.object({
        lastCount: z.number().int().nullable(),
      }).strict(),
      rollbacks30d: z.number().int().nonnegative(),
      acceptedFirstTry30d: z.number().nullable(),
      level: z.enum(["high", "medium", "low", "unknown"]),
      rules: z.array(z.object({
        actionClass: z.string(),
        mode: z.enum(["auto", "ask", "owner_only"]),
      }).strict()),
    }).strict(),
  },
  outages_list: {
    input: z.object({
      days: z.number().int().min(1).max(365).default(7),
    }).strict(),
    output: z.object({
      outages: z.array(z.object({
        id: z.number().int(),
        fromAt: z.number(),
        toAt: z.number(),
        minutes: z.number(),
        cause: z.string().nullable(),
        noticedAt: z.number(),
      }).strict()),
    }).strict(),
  },
  drills_list: {
    input: z.object({
      limit: z.number().int().min(1).max(50).default(10),
    }).strict(),
    output: z.object({
      drills: z.array(z.object({
        file: z.string(),
        date: z.string().nullable(),
        stamp: z.string().nullable(),
        finishedAt: z.number().nullable(),
        durationSec: z.number().nullable(),
        mode: z.string().nullable(),
        result: z.string(),
        passedCount: z.number().int().nonnegative(),
        totalCount: z.number().int().nonnegative(),
        problems: z.array(z.string()),
      }).strict()),
    }).strict(),
  },
};

export type ConsoleOverviewOutput = z.infer<typeof consoleOverviewOutput>;
export type ActiveItem = z.infer<typeof activeItemSchema>;
export type GoalLine = z.infer<typeof goalLineSchema>;
export type TaskHistoryRow = z.infer<typeof taskHistoryRowSchema>;
export type TaskHistoryOutput = z.infer<typeof rpcConsole.task_history.output>;
export type ThreadScope = z.infer<typeof threadScopeOutput>;
export type AutonomousAction = z.infer<typeof autonomousActionSchema>;
export type ActionsLogOutput = z.infer<typeof rpcConsole.actions_log.output>;
export type ReviewDeskItem = z.infer<typeof reviewDeskItemSchema>;
export type ReviewDeskView = z.infer<typeof reviewDeskViewOutput>;

export type BrakeState = z.infer<typeof brakeStateSchema>;
export type BrakesOutput = z.infer<typeof brakesOutput>;
export type StopAllOutput = z.infer<typeof rpcConsole.stop_all.output>;
export type SpecialistDetailOutput = z.infer<typeof rpcConsole.specialist_detail.output>;
export type SpecialistAutonomyRow = z.infer<typeof specialistAutonomyRowSchema>;
export type LoadoutRole = z.infer<typeof loadoutRoleSchema>;
export type AgentLoadoutOutput = z.infer<typeof rpcConsole.agent_loadout.output>;
export type MemoryCardsListOutput = z.infer<typeof rpcConsole.memory_cards_list.output>;
export type RepoTrustOutput = z.infer<typeof rpcConsole.repo_trust.output>;
export type OutageRow = z.infer<typeof rpcConsole.outages_list.output>["outages"][number];
export type OutagesListOutput = z.infer<typeof rpcConsole.outages_list.output>;
export type DrillSummaryRow = z.infer<typeof rpcConsole.drills_list.output>["drills"][number];
export type DrillsListOutput = z.infer<typeof rpcConsole.drills_list.output>;
