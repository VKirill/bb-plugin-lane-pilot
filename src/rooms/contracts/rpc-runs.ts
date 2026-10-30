import { z } from "zod";
import { pickableAgentSchema } from "./rpc-shell";
import { runViewSchema, stageSummarySchema } from "@lane-pilot/contracts";

/** Run cards, stages, helper access and the screen snapshot. */
const cardThreadSchema: z.ZodType<{ id: string; role: string; title: string | null; status: string | null; children: unknown[] }> = z.lazy(() =>
  z.object({ id: z.string(), role: z.string(), title: z.string().nullable(), status: z.string().nullable(), children: z.array(cardThreadSchema) }).strict());

/** The acceptance card of one task (src/rooms/acceptance): the contract, what each stage proved and how, the plan against the fact, what did not run, cost. */
export const acceptanceCardSchema = z.object({
  contract: z.object({ objective: z.string().nullable(), acceptance: z.array(z.string()), ownsPaths: z.array(z.string()) }).strict(),
  risk: z.string().nullable(),
  base: z.object({ ref: z.string().nullable(), sha: z.string().nullable(), branch: z.string(), compareCommitted: z.boolean() }).strict().nullable(),
  receipts: z.array(z.object({ stageId: z.string(), state: z.string(), proof: z.enum(["code", "advisory"]), proofKind: z.string(), reason: z.string().nullable(), model: z.string().nullable(), updatedAt: z.number() }).strict()),
  gates: z.array(z.object({ gate: z.string(), status: z.string(), attempt: z.number().int(), at: z.number() }).strict()),
  planFact: z.object({
    state: z.string(), table: z.enum(["ok", "missing", "invalid"]), reason: z.string().nullable(), mode: z.enum(["record", "gate"]),
    items: z.array(z.object({
      item: z.number().int(), acceptance: z.string(), claimed: z.enum(["done", "not_done", "none"]),
      verdict: z.enum(["proven", "unproven", "declared_not_done", "no_row"]), severity: z.enum(["ok", "info", "warning", "blocking"]),
      evidence: z.array(z.object({ evidence: z.string(), kind: z.string(), ok: z.boolean(), code: z.string(), note: z.string() }).strict()), why: z.string().nullable(),
    }).strict()),
    extraRows: z.array(z.number().int()), notChecked: z.array(z.string()),
    /** The declared wires (contract `wires`), the file each hop met in, the first hop that met nowhere (src/rooms/wires). */
    wires: z.array(z.object({ chain: z.array(z.string()), broken: z.object({ from: z.string(), to: z.string() }).strict().nullable() }).strict()).optional(),
  }).strict().nullable(),
  /** The task's checks on its base before any writer (src/rooms/baseline): which were already green or red, and which turned red after the merge. */
  baseline: z.object({
    state: z.enum(["ran", "skipped", "error"]), verdict: z.enum(["already_built", "partial", "red", "unknown"]), action: z.enum(["proceed", "notified", "stopped"]),
    mode: z.string(), summary: z.string(), baseSha: z.string().nullable(), at: z.number(),
    checks: z.array(z.object({ command: z.string(), status: z.enum(["green", "red", "skipped", "unknown"]), note: z.string(), cached: z.boolean() }).strict()),
    /** Null until the merge's checks on main ran; then the checks green on the base and red after the change. */
    turnedRed: z.array(z.string()).nullable(),
  }).strict().nullable().optional(),
  /** Stages with no receipt or a skipped one: «not run» is not «no findings». */
  notRun: z.array(z.object({ stageId: z.string(), why: z.string() }).strict()),
  cost: z.object({ state: z.enum(["measured", "partial", "not_measured"]), usd: z.number().nullable(), tokens: z.number().nullable(), note: z.string().nullable(), attempts: z.number().int(), measured: z.number().int() }).strict(),
}).strict();
export type AcceptanceCard = z.infer<typeof acceptanceCardSchema>;

export const rpcRuns = {
  /** The «Tasks» board: tasks and workflow runs of one project or of all, by column (src/rooms/runs/server/task-board.ts). */
  task_board: {
    input: z.object({ projectId: z.string().min(1).optional(), doneHours: z.number().int().min(1).max(24 * 30).default(24) }).strict(),
    output: z.object({ items: z.array(z.object({
      kind: z.enum(["task", "workflow"]), key: z.string(), runId: z.string(), taskId: z.string().nullable(), title: z.string(), techTitle: z.string().nullable(),
      taskKind: z.enum(["feature", "fix", "check", "docs", "refactor", "research", "chore"]).nullable(), area: z.string().nullable(), objective: z.string().nullable(),
      projectId: z.string().nullable(), pmThreadId: z.string().nullable(), pmThreadTitle: z.string().nullable(),
      column: z.enum(["queued", "running", "checking", "blocked", "done"]), state: z.string(),
      phase: z.enum(["queued", "planning", "waiting", "writing", "checking", "retrying", "blocked", "stuck", "closed", "accepted", "canceled", "chain"]),
      stage: z.string().nullable(), model: z.string().nullable(), since: z.number().nullable(), waitingFor: z.array(z.string()), detail: z.string().nullable(),
      attemptNo: z.number().int(), threadId: z.string().nullable(), attemptId: z.string().nullable(), updatedAt: z.number(),
    }).strict()) }).strict(),
  },
  /** One board card opened: contract, plan, stages, attempts and the tree of threads that worked on it. */
  /** What Lane Pilot does for a chat (its PM runs' tasks, or the task a writer or helper works on), for the thread's info panel; null for other threads. */
  thread_live: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.unknown(),
  },
  task_card: {
    input: z.object({ runId: z.string().min(1), taskId: z.string().min(1).nullable() }).strict(),
    output: z.object({
      kind: z.enum(["task", "workflow"]), title: z.string(), techTitle: z.string().nullable(),
      taskKind: z.enum(["feature", "fix", "check", "docs", "refactor", "research", "chore"]).nullable(), area: z.string().nullable(), objective: z.string().nullable(),
      pmThreadId: z.string().nullable(), id: z.string(), projectId: z.string().nullable(), state: z.string(), reason: z.string().nullable(),
      contract: z.object({ objective: z.string().nullable(), acceptance: z.array(z.string()), ownsPaths: z.array(z.string()), expectedOutputs: z.array(z.string()),
        dependsOn: z.array(z.string()), checks: z.array(z.string()) }).strict().nullable(),
      plan: z.string().nullable(),
      stages: z.array(z.object({ id: z.string(), state: z.string(), reason: z.string().nullable(), threadId: z.string().nullable(), model: z.string().nullable(), updatedAt: z.number() }).strict()),
      attempts: z.array(z.object({ id: z.string(), no: z.number().int(), state: z.string(), reason: z.string().nullable(), threadId: z.string().nullable(), createdAt: z.number(), updatedAt: z.number() }).strict()),
      threads: cardThreadSchema.nullable(),
    }).strict().nullable(),
  },
  /** The acceptance card of a task: one screen for «why was this accepted, on what proof, and what was not looked at». */
  task_acceptance_card: {
    input: z.object({ runId: z.string().min(1), taskId: z.string().min(1) }).strict(),
    output: acceptanceCardSchema.nullable(),
  },
  // The run card a PM message shows for its `::lane-run{id="…"}` directive: the run's tasks with their latest state.
  get_run_card: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({
      runId: z.string(),
      state: z.string(),
      closed: z.boolean(),
      tasks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        state: z.string().nullable(),
        threadId: z.string().nullable(),
        /** The failed check's log on the writer's machine, when the task left one. */
        checkLog: z.object({ hostId: z.string(), path: z.string() }).strict().nullable(),
        /** The after-acceptance stages (memory, project log, docs) whose current receipt is failed or blocked: the code is in, these are not. */
        background: z.array(z.string()).optional(),
      }).strict()),
      /** W31 rank 11: how long this run's attempts sat in the queue (settled waits only). */
      queueWait: z.object({ samples: z.number(), p50Ms: z.number().nullable(), p99Ms: z.number().nullable() }).strict().optional(),
    }).strict().nullable(),
  },
  native_thread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      token: z.string(),
      agentId: z.string(),
      agentType: z.string(),
      projectId: z.string(),
      description: z.string().min(1),
    }).strict().nullable(),
  },
  list_runs: {
    input: z.object({ projectId: z.string().min(1), sectionId: z.string().min(1).optional(), offset: z.number().int().min(0), limit: z.number().int().min(1).max(200), pinOpen: z.boolean().optional() }).strict(),
    output: z.object({ runs: z.array(runViewSchema), total: z.number().int().nonnegative() }).strict(),
  },
  list_run_stages: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({ stages: z.array(stageSummarySchema) }).strict(),
  },
  get_stage_result: {
    input: z.object({ runId: z.string().min(1), taskId: z.string().min(1), stageId: z.string().min(1) }).strict(),
    output: z.object({ found: z.boolean(), result: z.unknown().nullable() }).strict(),
  },
  helper_access_view: {
    input: z.object({ projectId: z.string().min(1), sectionId: z.string().min(1).optional() }).strict(),
    output: z.object({
      mode: z.string(),
      modeOrigin: z.enum(["global", "project", "section"]).nullable(),
      roles: z.array(z.object({
        role: z.string(), key: z.string(), version: z.number().int(), value: z.unknown(), inherited: z.boolean(),
        /** Which scope the role's change comes from; null = the role profile in code. */
        origin: z.enum(["global", "project", "section"]).nullable(),
        /** The same one level up: what the role shows once this level's change is removed. */
        originBelow: z.enum(["global", "project", "section"]).nullable(),
        groups: z.object({ bbPlugins: z.object({ names: z.array(z.string()).nullable(), source: z.enum(["role","owner"]) }).strict(), skills: z.object({ names: z.array(z.string()).nullable(), source: z.enum(["role","owner"]) }).strict(), mcpServers: z.object({ names: z.array(z.string()).nullable(), source: z.enum(["role","owner"]) }).strict(), nativePlugins: z.object({ names: z.array(z.string()).nullable(), source: z.enum(["role","owner"]) }).strict() }).strict(),
        switches: z.object({ userInstructions: z.object({ include: z.boolean(), source: z.enum(["role","owner"]) }).strict(), projectInstructions: z.object({ include: z.boolean(), source: z.enum(["role","owner"]) }).strict() }).strict(),
      }).strict()),
      catalog: z.object({
        bbPlugins: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
        skills: z.array(z.object({ name: z.string(), description: z.string() }).strict()),
      }).strict(),
      mandatory: z.object({ bbPlugins: z.array(z.string()), mcpServers: z.array(z.string()) }).strict(),
      providers: z.record(z.string(), z.array(z.string())),
    }).strict(),
  },
  get_screen: {
    input: z.object({ projectId: z.string().min(1), sectionId: z.string().min(1).optional(), runsLimit: z.number().int().min(1).max(200).optional() }).strict(),
    output: z.object({
      projectId: z.string(),
      sectionId: z.string().nullable().optional(),
      hostId: z.string().nullable(),
      workspacePath: z.string().nullable(),
      /** The project has the CLI-mode Lane Stack setup the Maintenance install actions need. */
      legacyStack: z.boolean().optional(),
      inheritedKeys: z.array(z.string()).optional(),
      explicitKeys: z.array(z.string()).optional(),
      writerBinding: z.object({
        status: z.enum(["resolved", "ambiguous", "setup_required", "offline", "catalog_unavailable"]),
        hostId: z.string().nullable(),
        path: z.string().nullable(),
        source: z.enum(["session", "unique_source", "explicit_override"]).nullable(),
        bindings: z.array(z.object({
          id: z.string().optional(), hostId: z.string(), path: z.string(), isDefault: z.boolean().optional(),
        }).strict()),
      }).strict().optional(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number()),
      importSource: z.object({
        completed: z.boolean(),
        at: z.number().nullable(),
        routingPath: z.string().nullable(),
        nightPath: z.string().nullable(),
      }).strict(),
      runs: z.array(runViewSchema),
      /** All runs of the project; `runs` carries the newest few and every open one, `list_runs` the rest. */
      runsTotal: z.number().int().nonnegative().optional(),
      runsLimit: z.number().int().positive().optional(),
      unapplied: z.array(z.object({ key: z.string(), reason: z.string() }).strict()),
      cliPreview: z.object({
        argv: z.array(z.string()),
        env: z.record(z.string(), z.string()),
        applied: z.array(z.string()),
        unapplied: z.array(z.object({ key:z.string(), reason:z.string() }).strict()),
      }).strict(),
      lastSnapshotPath: z.string().nullable(),
      lastReceiptJson: z.string().nullable(),
      writerResultJson: z.string().nullable(),
      writerResultPatch: z.string().nullable(),
      cliReceiptJson: z.string().nullable(),
      qaHosts: z.array(z.object({
        id: z.string(), name: z.string(), status: z.string(), connected: z.boolean(),
      }).strict()),
      compiledMainAgent: z.enum(["supported", "none"]).optional(),
      mainAgents: z.array(pickableAgentSchema).optional(),
      lastWriterTrace: z.object({
        providerId: z.string(),
        model: z.string(),
        requestedReasoningLevel: z.string(),
        effectiveReasoningLevel: z.string(),
        serviceTier: z.enum(["default", "fast"]).nullable(),
        fallbackReason: z.string().nullable(),
        jevStatus: z.enum(["ok", "disabled", "timeout", "error"]),
        effortMode: z.enum(["automatic", "manual"]).optional(),
        selectionSource: z.object({
          providerId: z.string(),
          model: z.string(),
          reasoningLevel: z.string(),
          serviceTier: z.enum(["default", "fast"]).nullable(),
          reasoningLevelSource: z.enum(["explicit", "client-preference"]),
        }).strict().optional(),
      }).nullable(),
    }).strict(),
  },
};
