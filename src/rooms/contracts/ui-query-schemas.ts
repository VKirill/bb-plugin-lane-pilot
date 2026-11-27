import { z } from "zod";
import { TASK_KINDS } from "@lane-pilot/contracts";
import { consoleOverviewOutput, rpcConsole } from "./rpc-console";

/**
 * Browser-safe schemas of the RPC methods the UI watches (ui-query-contract.ts). They live apart from
 * rpc-native.ts / rpc-runs.ts because those files sit behind the full server contract, which pulls Node
 * builtins into the UI bundle; these are zod-only and are the single home both sides import — the server
 * contract references them, so input/output can never drift between what the UI validates and what the
 * server accepts.
 */
export const listHelperThreadsInput = z.object({ threadId: z.string().min(1) }).strict();
export const listHelperThreadsOutput = z.object({
  threads: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    role: z.string(),
    detail: z.string().nullable(),
    phase: z.string().nullable().optional(),
  }).strict()),
  queued: z.array(z.string()).default([]),
  /** The open run's unfinished tasks and what each waits for (src/rooms/runs/server/task-graph.ts). */
  graph: z.object({
    nodes: z.array(z.object({ id: z.string(), title: z.string(), state: z.enum(["running", "waiting", "queued", "blocked"]), threadId: z.string().nullable(), area: z.string().nullable().optional(), attemptId: z.string().nullable().optional(), reason: z.string().nullable().optional() }).strict()),
    edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(["depends", "files", "folder", "question"]) }).strict()),
    objective: z.string().nullable().optional(),
  }).strict().optional(),
}).strict();

export const helperThreadLabelsInput = z.object({ threadIds: z.array(z.string().min(1)).min(1).max(200) }).strict();
export const helperThreadLabelsOutput = z.object({ labels: z.record(z.string(), z.string()) }).strict();

/** Inputs of the remaining watched reads; rpc-ops.ts / rpc-runs.ts import these so server and UI cannot drift. */
export const emptyRpcInput = z.object({}).strict();
export const threadLiveInput = z.object({ threadId: z.string().min(1) }).strict();
export const attemptLogTailInput = z.object({ runId: z.string().min(1), taskId: z.string().min(1), projectId: z.string().min(1).optional() }).strict();
export const workGraphTaskInput = z.object({ runId: z.string().min(1), taskId: z.string().min(1) }).strict();
export const workGraphStripsInput = z.object({ keys: z.array(z.object({ runId: z.string().min(1), taskId: z.string().min(1) }).strict()).max(300) }).strict();
export const uiVersionOutput = z.object({ version: z.number().int().nonnegative() }).strict();

/** Stable envelopes of the remaining watched reads, mirrored from the server types (work-graph/logic.ts,
 *  owner-waiting/items.ts, runs/ui/thread-live.tsx, money/server.ts). Truly open payloads stay records/JSON,
 *  never invented fields. */
export const stageCellSchema = z.object({ stageId: z.string(), state: z.enum(["passed", "failed", "running", "pending", "skipped", "canceled"]), rounds: z.number().int(), failures: z.number().int(), reason: z.string().nullable() }).strict();
export const executorRowSchema = z.object({
  stageId: z.string(), role: z.enum(["writer", "agent", "reviewer", "code"]), round: z.number().int(),
  threadId: z.string().nullable(), providerId: z.string().nullable(), model: z.string().nullable(),
  seconds: z.number().nullable(), tokens: z.object({ fresh: z.number(), cacheRead: z.number(), cacheWrite: z.number(), output: z.number() }).strict().nullable(),
  costUsd: z.number().nullable(), costState: z.enum(["measured", "partial", "not_measured"]).nullable(), turns: z.number().nullable(),
}).strict();
export const taskSummarySchema = z.object({ returns: z.number().int(), seconds: z.number().nullable(), costUsd: z.number().nullable(), costState: z.enum(["measured", "partial", "not_measured"]).nullable(), models: z.array(z.string()) }).strict();
const stripSchema = z.object({ cells: z.array(stageCellSchema), summary: taskSummarySchema }).strict();
export const workGraphTaskOutput = z.object({ cells: z.array(stageCellSchema), stages: z.array(z.object({ cell: stageCellSchema, rows: z.array(executorRowSchema) }).strict()), summary: taskSummarySchema, turnCeiling: z.number().optional() }).strict();
/** Keyed `runId:taskId` → strip; the key space is the caller's, so the record itself is the contract. */
export const workGraphStripsOutput = z.record(z.string(), stripSchema);
export const attemptLogTailOutput = z.object({ threadId: z.string().nullable(), lines: z.array(z.string()) }).strict();
export const threadLiveOutput = z.object({
  role: z.enum(["pm", "writer", "helper"]), pmThreadId: z.string().nullable(),
  items: z.array(z.object({
    key: z.string(), runId: z.string(), taskId: z.string().nullable(), title: z.string(),
    column: z.enum(["queued", "running", "checking", "blocked", "done"]), phase: z.string(),
    stage: z.string().nullable(), model: z.string().nullable(), since: z.number().nullable(),
    threadId: z.string().nullable(), updatedAt: z.number(), detail: z.string().nullable(), projectId: z.string().nullable().optional(),
    kind: z.enum(["task", "workflow", "phase", "batch"]).optional(), state: z.string(),
  }).strict()),
  strips: z.record(z.string(), stripSchema),
  session: z.object({ runId: z.string(), state: z.string(), kind: z.string() }).strict().nullable(),
}).strict().nullable();
export const ownerWaitingOutput = z.object({
  generatedAt: z.number(),
  items: z.array(z.object({
    key: z.string(), source: z.string(), kind: z.string(), projectId: z.string().nullable(),
    what: z.string(), why: z.string(), since: z.number(), wake: z.boolean(), tier: z.enum(["now", "later"]),
    desk: z.literal(true).optional(),
    evidence: z.array(z.object({ kind: z.enum(["attempt", "task", "run", "file", "note", "message", "command", "text"]), ref: z.string(), label: z.string().optional() }).strict()),
    actions: z.array(z.looseObject({ id: z.string(), label: z.string(), cli: z.string() })),
  }).strict()),
  counts: z.record(z.string(), z.number()),
  overnight: z.object({ windowMs: z.number(), red: z.array(z.object({ state: z.string(), count: z.number().int(), attempts: z.array(z.string()) }).strict()), accepted: z.number().int(), rulesAdopted: z.number().int(), rulesConfirmed: z.number().int() }).strict(),
  now: z.number().int(),
  answered: z.object({ owner: z.number().int(), agent: z.number().int(), lead: z.number().int(), janitor: z.number().int() }).strict(),
  attention: z.object({
    cap: z.number().int().nonnegative(),
    shown: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    day: z.string(),
  }).strict().optional(),
}).strict();
/** Money envelope: the scalars the window reads are typed; per-provider/day payloads and the specialist
 *  ledger are open records — the server adds fields without a contract bump. */
export const moneyStatusOutput = z.looseObject({
  monthUsd: z.number(), estimatedUsd: z.number().optional(), estimated: z.number().optional(),
  estimatedAttempts: z.number().optional(), silentAttempts: z.number().optional(), silentUnknown: z.number().optional(),
  cap: z.number().nullable(), capSet: z.boolean().optional(), unlimited: z.boolean().optional(), left: z.number().nullable(),
  byProvider: z.record(z.string(), z.number()).optional(),
  table: z.array(z.looseObject({ day: z.string(), usd: z.number() })).optional(),
});

export const taskBoardInput = z.object({ projectId: z.string().min(1).optional(), doneHours: z.number().int().min(1).max(24 * 30).default(24) }).strict();
export const taskBoardOutput = z.object({ items: z.array(z.object({
  kind: z.enum(["task", "workflow", "phase", "batch"]), key: z.string(), runId: z.string(), taskId: z.string().nullable(), title: z.string(), techTitle: z.string().nullable(),
  taskKind: z.enum(TASK_KINDS).nullable(), area: z.string().nullable(), objective: z.string().nullable(),
  projectId: z.string().nullable(), pmThreadId: z.string().nullable(), pmThreadTitle: z.string().nullable(),
  column: z.enum(["queued", "running", "checking", "blocked", "done"]), state: z.string(),
  phase: z.enum(["queued", "planning", "waiting", "writing", "checking", "retrying", "blocked", "stuck", "closed", "accepted", "canceled", "chain"]),
  stage: z.string().nullable(), model: z.string().nullable(), since: z.number().nullable(), waitingFor: z.array(z.string()), detail: z.string().nullable(),
  attemptNo: z.number().int(), threadId: z.string().nullable(), attemptId: z.string().nullable(), updatedAt: z.number(),
  held: z.boolean(), gates: z.array(z.object({ name: z.enum(["discussion", "plan", "design"]), ok: z.boolean(), why: z.array(z.string()) }).strict()).nullable(),
  wave: z.object({ n: z.number().int(), m: z.number().int() }).strict().nullable(),
}).strict()) }).strict();

export const consoleOverviewInput = rpcConsole.console_overview.input;
export { consoleOverviewOutput };
export type { ActiveItem, ConsoleOverviewOutput, GoalLine } from "./rpc-console";

export const brakesGetInput = rpcConsole.brakes_get.input;
export const brakesGetOutput = rpcConsole.brakes_get.output;
export type { BrakeId, BrakeState, BrakesOutput, StopAllOutput } from "./rpc-console";

export const manualModeGetInput = rpcConsole.manual_mode_get.input;
export const manualModeGetOutput = rpcConsole.manual_mode_get.output;
export type ManualModeOutput = z.infer<typeof manualModeGetOutput>;

export const docsProjectsInput = rpcConsole.docs_projects.input;
export const docsProjectsOutput = rpcConsole.docs_projects.output;
export type DocsProjectsOutput = z.infer<typeof docsProjectsOutput>;
export type DocsProject = DocsProjectsOutput["projects"][number];

export const deskGetInput = rpcConsole.desk_get.input;
export const deskGetOutput = rpcConsole.desk_get.output;
export type { ReviewDeskItem, ReviewDeskView } from "./rpc-console";
export type { TaskHistoryOutput, TaskHistoryRow } from "./rpc-console";

export type { MemoryCardsListOutput } from "./rpc-console";

export const actionsLogInput = rpcConsole.actions_log.input;
export const actionsLogOutput = rpcConsole.actions_log.output;
export type { ActionsLogOutput, AutonomousAction } from "./rpc-console";
export type { SpecialistAutonomyRow, SpecialistDetailOutput } from "./rpc-console";

export type { AgentLoadoutOutput, LoadoutRole } from "./rpc-console";

export type { RepoTrustOutput } from "./rpc-console";
export type { DrillSummaryRow, DrillsListOutput, OutageRow, OutagesListOutput } from "./rpc-console";
