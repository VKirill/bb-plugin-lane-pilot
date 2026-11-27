import { z } from "zod";
import { CANCEL_CODES, acceptanceTotalsSchema, acceptanceWeekSchema } from "@lane-pilot/contracts";
import { attemptLogTailInput, attemptLogTailOutput, emptyRpcInput, moneyStatusOutput, ownerWaitingOutput, workGraphStripsInput, workGraphStripsOutput, workGraphTaskInput, workGraphTaskOutput, uiVersionOutput } from "./ui-query-schemas";

/** Run control, statistics, deploy, self-repair, canary and the stack installer. */
export const rpcOps = {
  /** Stops a whole run: cancels every open attempt and keeps the run out of parking and restarts until the PM sends a task again. */
  halt_run: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), canceled: z.array(z.string()), left: z.array(z.string()) }).strict(),
  },
  cancel_attempt: {
    input: z.object({ attemptId: z.string().min(1),
      /** W31 rank 6: the closed cancel-code list; a call without it (or with a value outside it) lands as `unknown`. */
      code: z.enum(CANCEL_CODES).catch("unknown").default("unknown"),
      /** The owner's reason in words (SMA m_ws_task_panel): 3–400 characters, stored on the attempt. */
      note: z.string().min(3).max(400).optional() }).strict(),
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
  /** How much each critic is worth in a project: blocks, what became of blocked tasks, misses, first-try acceptance. */
  critic_stats: {
    input: z.object({ projectId:z.string().min(1), days:z.number().int().min(1).max(90).default(7) }).strict(),
    output: z.object({ days:z.number(), stats:z.array(z.object({
      stage:z.string(), runs:z.number(), approved:z.number(), blocked:z.number(), skipped:z.number(), blockShare:z.number().nullable(),
      afterBlock:z.object({ fixedAndAccepted:z.number(), sentAgainNotAccepted:z.number(), dropped:z.number() }),
      missed:z.object({ count:z.number(), examples:z.array(z.object({ taskId:z.string(), reason:z.string() })) }),
      firstTryAccepted:z.object({ reviewed:z.object({ tasks:z.number(), share:z.number().nullable() }), notReviewed:z.object({ tasks:z.number(), share:z.number().nullable() }) }),
      calibration:z.object({
        labeled:z.number(), hits:z.number(), accuracy:z.number().nullable(), low:z.boolean(),
        byModel:z.array(z.object({ model:z.string(), labeled:z.number(), hits:z.number(), accuracy:z.number().nullable(), low:z.boolean() })),
      }),
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
  canary_status: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  // Memory probe (SMA block 4): plants a token through the write door and asks every memory delivery path for it; `clean` removes what a kept run left, `report` reads the last run.
  memory_probe: {
    input: z.object({ projectId: z.string().min(1), paths: z.array(z.string().min(1)).max(40).optional(), keep: z.boolean().optional(), force: z.boolean().optional(),
      action: z.enum(["run", "clean", "report"]).default("run") }).strict(),
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
  /** The register of deferrals (src/rooms/deferral): terms come only from a verified owner message. */
  deferral_list: {
    input: z.object({
      projectId: z.string().min(1).optional(), state: z.enum(["open", "overdue", "closed", "needs_owner_term"]).optional(),
      /** Ids cited in the repository (`// deferral:<id>` beside a skipped test): the answer names the ones the register does not hold or holds closed. */
      refs: z.array(z.string().min(1).max(80)).max(500).optional(),
    }).strict(),
    output: z.unknown(),
  },
  deferral_defer: {
    input: z.object({
      what: z.string().min(1).max(500), kind: z.string().max(40).optional(), area: z.string().max(120).optional(), projectId: z.string().min(1).optional(),
      ownerMsg: z.string().min(1).max(300), due: z.string().max(40).optional(),
    }).strict(),
    output: z.unknown(),
  },
  deferral_close: {
    input: z.object({ id: z.string().min(1).max(80), evidence: z.string().min(1).max(2000) }).strict(),
    output: z.unknown(),
  },
  /** The changes of a work as a patch: git show of its merge commit, clipped with a mark (src/rooms/rollback). */
  task_diff: {
    input: z.object({ ref: z.string().min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  /** Sends a task back to discussion, planning or the writer with a note: recorded, the stale receipts reset, the running attempt stopped, the work restarted from that stage (src/rooms/stage-return). */
  task_return_stage: {
    input: z.object({ ref: z.string().min(1).max(200), to: z.enum(["discussion", "planning", "writer"]), note: z.string().max(8000), by: z.string().min(1).max(60).optional() }).strict(),
    output: z.unknown(),
  },
  /** One task's work graph: a cell per stage, who ran each (role, round, model, turns, time, tokens, cost) (src/rooms/work-graph). */
  work_graph_task: {
    input: workGraphTaskInput,
    output: workGraphTaskOutput,
  },
  /** The stage cells and the summary line of many tasks, keyed `runId:taskId`, for the task list. */
  work_graph_strips: {
    input: workGraphStripsInput,
    output: workGraphStripsOutput,
  },
  /** A proposed task draft's card: title, promise, kind, state (SMA m_sw_chat_draft, src/rooms/tasks/server/draft.ts). */
  task_draft_card: {
    input: z.object({ draftId: z.string().min(1).max(120), projectId: z.string().min(1).optional() }).strict(),
    output: z.unknown(),
  },
  /** The owner's «Создать» on a draft card: the same enqueue path as the PM's confirmed propose call. */
  task_draft_create: {
    input: z.object({ draftId: z.string().min(1).max(120), projectId: z.string().min(1).optional() }).strict(),
    output: z.unknown(),
  },
  /** The tail of a task's latest attempt log in plain words (SMA m_ws_attempt_log, src/rooms/work-graph/log-tail.ts). */
  attempt_log_tail: {
    input: attemptLogTailInput,
    output: attemptLogTailOutput,
  },
  /** Stages and models over a window: green, red, rounds, cost and time per stage, and per model on each stage. */
  work_graph_stats: {
    input: z.object({ projectId: z.string().min(1).optional(), days: z.number().int().min(1).max(365).optional(), excludeProjectIds: z.array(z.string().min(1)).max(100).optional() }).strict(),
    output: z.unknown(),
  },
  /** The conveyor switch: read it, or turn it on or off (off: no new work is issued anywhere; src/rooms/runs/server/conveyor.ts). */
  conveyor: {
    input: z.object({ set: z.enum(["on", "off"]).optional(), reason: z.string().max(300).optional() }).strict(),
    output: z.unknown(),
  },
  /** Money (src/rooms/money): spent month to date, the 14-day series, the cap and what is left of it. */
  money_status: {
    input: emptyRpcInput,
    output: moneyStatusOutput,
  },
  /** The UI version (src/rooms/relay/server): one number that grows with every attempt change; a screen reads the board again when it moved. */
  ui_version: {
    input: emptyRpcInput,
    output: uiVersionOutput,
  },
  /** Project first-run onboarding interview (src/rooms/front). */
  first_run_get: { input: z.object({ projectId: z.string().min(1).max(200) }).strict(), output: z.unknown() },
  first_run_answer: { input: z.object({ projectId: z.string().min(1).max(200), step: z.enum(["goal", "writer", "quality", "words"]), answer: z.string().trim().min(1).max(2000) }).strict(), output: z.unknown() },
  first_run_finish: { input: z.object({ projectId: z.string().min(1).max(200) }).strict(), output: z.unknown() },
  /** The owner's word on a task (owner.words on): a verified task waiting to land gets yes or no (src/rooms/tasks/words.ts). */
  task_word: {
    input: z.object({ runId: z.string().min(1).max(200), taskId: z.string().min(1).max(200), decision: z.enum(["yes", "no"]), text: z.string().trim().min(1).max(600) }).strict(),
    output: z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), reason: z.string() }).strict()]),
  },
  /** «Waiting for the owner» (src/rooms/owner-waiting): what only the owner can decide, the Telegram digest of new items, and its settings. */
  owner_waiting: {
    input: emptyRpcInput,
    output: ownerWaitingOutput,
  },
  owner_waiting_digest: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  owner_waiting_close: { input: z.object({ key: z.string().min(1).max(300) }).strict(), output: z.object({ closed: z.boolean() }) },
  owner_waiting_ack: {
    input: z.object({ keys: z.array(z.string().min(1).max(300)).min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  owner_waiting_config: {
    input: z.object({ patch: z.record(z.string().max(40), z.union([z.string().max(80), z.number(), z.boolean()])).optional() }).strict(),
    output: z.unknown(),
  },
  /** The «Errands» page (src/rooms/errands): the kinds with the model in force and the period's counts, and the period's errand runs with outcome, source, helper thread and cost. */
  errands_overview: { input: z.object({ days: z.number().int().min(1).max(365).optional(), kind: z.string().min(1).max(40).optional(), projectId: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(500).optional() }).strict(), output: z.unknown() },
  /** The «Диагноз» block of the «Errands» page (src/rooms/errands/diagnosis): outcomes with their N, cost and time, failure classes, repeats, router near misses, unused skills and catalog litter. */
  errands_diagnosis: { input: z.object({ days: z.number().int().min(1).max(365).optional(), projectId: z.string().min(1).max(200).optional() }).strict(), output: z.unknown() },
  /** Specialist OS (src/rooms/specialist): project or hub snapshot of active intents, locks, questions, evals, PDAS artifacts and ledger spend. */
  specialist_overview: { input: z.object({ projectId: z.string().min(1).max(200).optional() }).strict(), output: z.unknown() },
};
