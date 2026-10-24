import { z } from "zod";
import { acceptanceTotalsSchema, acceptanceWeekSchema } from "@lane-pilot/contracts";

/** Run control, statistics, deploy, self-repair, canary and the stack installer. */
export const rpcOps = {
  /** Stops a whole run: cancels every open attempt and keeps the run out of parking and restarts until the PM sends a task again. */
  halt_run: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), canceled: z.array(z.string()), left: z.array(z.string()) }).strict(),
  },
  /** Pauses a run at a safe boundary: new tasks wait, running attempts finish their current stage and then wait; nothing is canceled. */
  pause_run: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.unknown(),
  },
  resume_run: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.unknown(),
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
  // Memory probe (SMA block 4): plants a token through the write door and asks every memory delivery path for it; `clean` removes what a kept run left, `report` reads the last run.
  memory_probe: {
    input: z.object({ projectId: z.string().min(1), paths: z.array(z.string().min(1)).max(40).optional(), keep: z.boolean().optional(), force: z.boolean().optional(),
      action: z.enum(["run", "clean", "report"]).default("run") }).strict(),
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
  /** The writer harness that learns (src/rooms/harness): trees per area and writer, trials, the nightly editor. */
  harness_status: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.unknown(),
  },
  harness_configure: {
    input: z.object({ projectId: z.string().min(1), patch: z.record(z.string(), z.unknown()) }).strict(),
    output: z.unknown(),
  },
  harness_edit: {
    input: z.object({ projectId: z.string().min(1), area: z.string().max(120).optional(), writerKey: z.string().max(200).optional(), wait: z.boolean().default(false) }).strict(),
    output: z.unknown(),
  },
  harness_tick: {
    input: z.object({ projectId: z.string().min(1), dryRun: z.boolean().default(true) }).strict(),
    output: z.unknown(),
  },
  harness_reflect: {
    input: z.object({ harnessId: z.string().min(1) }).strict(),
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
  /** The task's verification[] again on its recorded base plus the accepted change, in a fresh worktree; a receipt is kept (src/rooms/rollback). */
  task_reverify: {
    input: z.object({ ref: z.string().min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  /** Reverts an accepted task's merge commit(s) in a worktree, checked and merged through the merge queue; refused with the next step on a conflict. */
  task_revert: {
    input: z.object({ ref: z.string().min(1).max(200), dryRun: z.boolean().optional(), skipGate: z.boolean().optional() }).strict(),
    output: z.unknown(),
  },
  /** What is on record for a task or an attempt: bases, merges, changed files, receipts. */
  task_changes: {
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
    input: z.object({ runId: z.string().min(1), taskId: z.string().min(1) }).strict(),
    output: z.unknown(),
  },
  /** The stage cells and the summary line of many tasks, keyed `runId:taskId`, for the task list. */
  work_graph_strips: {
    input: z.object({ keys: z.array(z.object({ runId: z.string().min(1), taskId: z.string().min(1) }).strict()).max(300) }).strict(),
    output: z.unknown(),
  },
  /** Stages and models over a window: green, red, rounds, cost and time per stage, and per model on each stage. */
  work_graph_stats: {
    input: z.object({ projectId: z.string().min(1).optional(), days: z.number().int().min(1).max(365).optional(), excludeProjectIds: z.array(z.string().min(1)).max(100).optional() }).strict(),
    output: z.unknown(),
  },
  /** The PM's forecasts against the facts of accepted tasks, scored and calibrated per area (src/rooms/forecast). */
  forecast_report: {
    input: z.object({ projectId: z.string().min(1).optional(), days: z.number().int().min(1).max(365).optional() }).strict(),
    output: z.unknown(),
  },
  /** The conveyor switch: read it, or turn it on or off (off: no new work is issued anywhere; src/rooms/runs/server/conveyor.ts). */
  conveyor: {
    input: z.object({ set: z.enum(["on", "off"]).optional(), reason: z.string().max(300).optional() }).strict(),
    output: z.unknown(),
  },
  /** Per provider in use: the adapter version installed and each capability's state, supported, not_supported or unproven (src/rooms/capability). */
  capability_table: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  /** Money (src/rooms/money): spent month to date, the 14-day series, the cap and what is left of it. */
  money_status: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  /** The world version (src/rooms/outbound): one number that grows with every attempt change; a screen reads the board again when it moved. */
  world_version: {
    input: z.object({}).strict(),
    output: z.object({ version: z.number().int().nonnegative() }).strict(),
  },
  /** Phases on rails (src/rooms/phase): the live and recent phases of a project or a PM chat, with stage and next action. */
  phase_list: {
    input: z.object({ projectId: z.string().min(1).optional(), pmThreadId: z.string().min(1).optional(), live: z.boolean().optional() }).strict(),
    output: z.unknown(),
  },
  /** One phase: its record, gates, next action, the facts of its pieces and its book (the chain of parts). */
  phase_get: {
    input: z.object({ phaseId: z.string().min(1).max(40) }).strict(),
    output: z.unknown(),
  },
  /** Controls of a phase from the screen or the CLI: pause, resume, return to an earlier stage with a note, stop the wave, close in words. */
  /** The owner's word on a task (owner.words on): a verified task waiting to land gets yes or no (src/rooms/tasks/words.ts). */
  task_word: {
    input: z.object({ runId: z.string().min(1).max(200), taskId: z.string().min(1).max(200), decision: z.enum(["yes", "no"]), text: z.string().trim().min(1).max(600) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  phase_control: {
    input: z.object({ phaseId: z.string().min(1).max(40), action: z.enum(["pause", "resume", "return", "stop_wave", "close", "word"]), to: z.enum(["discussion", "planning", "design", "execution"]).optional(),
      note: z.string().max(2000).optional(), turn: z.enum(["planning", "design", "acceptance", "uat"]).optional(), decision: z.enum(["yes", "no"]).optional() }).strict(),
    output: z.unknown(),
  },
  /** The run-goal verdict of a run: every accepted task's checks together on the final main (src/rooms/run-goal). */
  run_goal_status: {
    input: z.object({ runId: z.string().min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  /** Runs the run-goal check of a run now and keeps the verdict. */
  run_goal_check: {
    input: z.object({ runId: z.string().min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  /** The returns on record for a task: the note, the stale and kept stages, how far each got. */
  task_returns: {
    input: z.object({ ref: z.string().min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  /** The baseline a task started from (checks already green or red on its base, what turned red after the merge) and the regression findings (src/rooms/baseline). */
  baseline_status: {
    input: z.object({ taskId: z.string().min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  /** The regression pass: the last accepted tasks' checks on current main, a bisect for the ones that went red. `plan` only picks; `dryRun` writes nothing. */
  regress_run: {
    input: z.object({ projectId: z.string().min(1).optional(), lastN: z.number().int().min(1).max(200).optional(), days: z.number().int().min(1).max(365).optional(),
      dryRun: z.boolean().optional(), plan: z.boolean().optional(), force: z.boolean().optional() }).strict(),
    output: z.unknown(),
  },
  /** The regression findings still open (or all of them), with the first bad commit, its task and the evidence. */
  regress_list: {
    input: z.object({ projectId: z.string().min(1).optional(), all: z.boolean().optional() }).strict(),
    output: z.unknown(),
  },
  /** Settles a regression finding by hand, with the reason. */
  regress_close: {
    input: z.object({ id: z.number().int().min(1), reason: z.string().min(1).max(500) }).strict(),
    output: z.unknown(),
  },
  /** LP-Bench (src/rooms/bench): the fixed task set, its series per arm and the paired comparison. Building and running go through `bb lane-pilot bench`. */
  bench_status: {
    input: z.object({ version: z.string().min(1).max(40).optional() }).strict(),
    output: z.unknown(),
  },
  bench_compare: {
    input: z.object({ version: z.string().min(1).max(40).default("v1"), armA: z.string().min(1).max(80), armB: z.string().min(1).max(80), noise: z.tuple([z.string(), z.string()]).optional() }).strict(),
    output: z.unknown(),
  },
  /** «Waiting for the owner» (src/rooms/owner-waiting): what only the owner can decide, the Telegram digest of new items, and its settings. */
  owner_waiting: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  owner_waiting_digest: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  owner_waiting_ack: {
    input: z.object({ keys: z.array(z.string().min(1).max(300)).min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  owner_waiting_config: {
    input: z.object({ patch: z.record(z.string().max(40), z.string().max(80)).optional() }).strict(),
    output: z.unknown(),
  },
  /** The «Self-improvement» screen in one read: the values and versions of its controls, the status strip, the night policy and the deferral counts (src/rooms/improvement). */
  improvement_view: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  /** The wall journal and the night loop (src/rooms/wall): classes by recurrence, the night's repairs, the wall ladder, what a night spent. */
  wall_status: {
    input: z.object({}).strict(),
    output: z.unknown(),
  },
  wall_show: {
    input: z.object({ key: z.string().min(1).max(200) }).strict(),
    output: z.unknown(),
  },
  /** Runs the night now; `dryRun` keeps nothing, calls no model and answers what it would pick and why. */
  wall_night: {
    input: z.object({ dryRun: z.boolean().optional() }).strict(),
    output: z.unknown(),
  },
  /** Reads (no fields) or changes the night loop's settings: classes and rounds per night, walks, hunters, the night's token cap. */
  wall_config: {
    input: z.object({
      enabled: z.boolean().optional(), maxClassesPerNight: z.number().int().min(1).max(3).optional(), roundsPerNight: z.number().int().min(1).max(2).optional(),
      walks: z.number().int().min(1).max(5).optional(), hunters: z.number().int().min(1).max(5).optional(), nightTokenCap: z.number().int().min(0).optional(),
      huntShare: z.number().min(0.01).max(1).optional(), assumedRepairTokens: z.number().int().min(0).optional(), hunterProviderId: z.string().min(1).max(80).optional(),
      hunterModel: z.string().min(1).max(120).optional(), hunterReasoningLevel: z.string().min(1).max(40).optional(), benchSubset: z.number().int().min(0).max(50).optional(),
      rerunSandboxOnly: z.boolean().optional(), recurrenceFloor: z.number().int().min(1).max(50).optional(),
    }).strict(),
    output: z.unknown(),
  },
};
