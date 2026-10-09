import { z } from "zod";
import { stageReceiptSchema } from "./stage-contract";

/** A stage row as the screen lists it: no result body (`get_stage_result` loads it), only whether there is one. */
export const stageSummarySchema = stageReceiptSchema.omit({ result: true }).extend({ hasResult: z.boolean() }).strict();

export const prototypeConfigSchema = z.object({
  projectId: z.string().min(1),
  hostId: z.string().min(1),
  pmWorkspacePath: z.string().startsWith("/"),
  writerWorkspacePath: z.string().startsWith("/"),
  pmProviderId: z.string().min(1),
  pmModel: z.string().min(1),
  writerProviderId: z.string().min(1),
  writerModel: z.string().min(1),
}).strict();

export type PrototypeConfig = z.infer<typeof prototypeConfigSchema>;

export const settingValidationSchema = z.object({
  code: z.enum([
    "invalid_choice",
    "incompatible_setting",
    "setup_required",
    "writer_binding_ambiguous",
    "writer_host_offline",
    "catalog_unavailable",
  ]),
  key: z.string(),
  params: z.array(z.string()),
}).strict();

export const ruleProposalSchema = z.object({
  id: z.string(),
  rule: z.string(),
  author: z.enum(["sweep", "pm", "owner", "model"]),
  state: z.enum(["proposed", "accepted", "rejected", "revoked"]),
  occurrences: z.number().int(),
  taskCount: z.number().int(),
  examples: z.array(z.string()),
  evidence: z.array(z.object({ runId: z.string(), taskId: z.string(), attemptId: z.string(), reason: z.string() }).strict()),
  lastSeenAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  decidedBy: z.enum(["owner", "auto"]).nullable(),
  trialState: z.enum(["trial", "confirmed"]).nullable(),
  revision: z.number().int(),
  retiredReason: z.string().nullable(),
  trial: z.object({ applied: z.number().int(), appliedAccepted: z.number().int(), recurrences: z.number().int() }).strict().nullable(),
  scope: z.array(z.string()),
  scopeLabel: z.string(),
  audience: z.enum(["writer", "pm", "both"]),
  always: z.boolean(),
}).strict();

export const ruleScanSchema = z.object({
  state: z.enum(["idle", "running", "done", "failed"]),
  startedAt: z.number().int().nullable(), finishedAt: z.number().int().nullable(),
  triaged: z.number().int(), groups: z.number().int(), proposals: z.number().int(), reason: z.string().nullable(),
  adopted: z.number().int().optional(), confirmed: z.number().int().optional(), revised: z.number().int().optional(), retired: z.number().int().optional(),
}).strict();

export const rulesAnalyzerSchema = z.object({
  providerId: z.string().min(1), model: z.string().min(1), reasoningLevel: z.string().min(1), serviceTier: z.enum(["default", "fast"]).nullable(),
}).strict();

/** An environment variable name, as the sandbox passes it; Env Catalog names follow the same rule. */
export const secretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

export const taskV2Schema = z.object({
  schema_version: z.literal(2),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  title: z.string().min(1),
  risk: z.enum(["low", "medium", "high", "critical"]),
  lane: z.string().min(1),
  project_cwd: z.string().startsWith("/"),
  read_first: z.array(z.string().min(1)),
  interfaces: z.array(z.string().min(1)),
  invariants: z.array(z.string().min(1)),
  out_of_scope: z.array(z.string().min(1)),
  expected_outputs: z.array(z.string().min(1)).min(1),
  owns_paths: z.array(z.string().min(1)).min(1),
  never_touch: z.array(z.string().min(1)),
  depends_on: z.array(z.string().min(1)),
  objective: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  verify: z.enum(["none", "smoke", "tests"]),
  verification: z.array(z.object({
    command: z.string().min(1),
    cwd: z.string().startsWith("/"),
    timeout_sec: z.number().int().min(1).max(7200).optional(),
    /** Env Catalog names this check needs (kind secret or login): the server passes their values to the check as environment variables, by name; the writer never sees them. */
    secrets: z.array(secretNameSchema).max(16).optional(),
  }).strict()),
  /** The page or feature the task belongs to («page:/tools/cards»): one writer at a time per area, and the area's writer continues its next task. */
  area: z.string().trim().min(1).max(120).optional(),
  /** Which review stages this task goes through (quick, standard, full); the project setting `quality_mode` when absent, and standard when that is absent too. */
  quality_mode: z.enum(["quick", "standard", "full"]).optional(),
  /** Browser checks for a task of a project in full mode: the PM runs them with lane_pilot_helpers (action browser_qa), and the task is not done until they pass. */
  qa_cases: z.array(z.string().min(1).max(2000)).max(30).optional(),
  /**
   * Maestro `convergence`: the checks that decide the task is done, each one a command, a grep or a file read that names the exact
   * string, value or exit code («src/a.ts contains 'RATE_LIMIT = 10'», «the command exits 0»). Next to `acceptance`, not instead of it;
   * the contract lint refuses a criterion that rests on subjective words.
   */
  convergence: z.object({ criteria: z.array(z.string().min(1).max(600)).min(1).max(20) }).strict().optional(),
  /** Maestro `files[]`: the concrete change per file, as a hint for the writer. `owns_paths` stays the rule; the lint refuses a file the task does not own. */
  files: z.array(z.object({
    path: z.string().min(1).max(300),
    action: z.enum(["create", "modify", "delete"]),
    /** The function, class or section the change is in. */
    target: z.string().min(1).max(200).optional(),
    change: z.string().min(1).max(1000),
  }).strict()).max(40).optional(),
}).strict();

export type TaskV2 = z.infer<typeof taskV2Schema>;

/**
 * Host calls that run as background jobs: a separate process the host daemon's deadline cannot cut off (B4). A kind is
 * the name of the ordinary host method whose handler the job runs; its input is that method's own input.
 */
export const HOST_JOB_KINDS = ["detect", "install", "rollback", "snapshot", "importConfig", "connectOpencode", "coexistenceOperation", "coexistenceInventory", "gitIntegrate", "gitPrepareWorktree", "runSandboxedCommand", "runBrowserQa", "gateRun", "gateBisect", "gateAttribute", "runScript"] as const;
export type HostJobKind = (typeof HOST_JOB_KINDS)[number];
export const hostJobId = z.string().regex(/^job_[a-z0-9]{10,40}$/);
export const hostJobRef = z.object({ requestedHostId:z.string().min(1), jobId:hostJobId }).strict();

export const hostBaseFields = {
  requestedHostId: z.string().min(1),
  workspacePath: z.string().startsWith("/").optional(),
  threadStoragePath: z.string().startsWith("/").optional(),
  receiptDir: z.string().startsWith("/").optional(),
  confirmExternalOps: z.boolean().optional(),
  localFallbackPath: z.string().startsWith("/").optional(),
  guardSourcePath: z.string().startsWith("/").optional(),
  pmWorkspacePath: z.string().startsWith("/").optional(),
  projectId: z.string().min(1).optional(),
  snapshotPath: z.string().startsWith("/").optional(),
};

export const inventoryGroupSchema = z.object({
  status: z.enum(["ready", "unavailable", "error"]),
  items: z.array(z.object({ name: z.string(), label: z.string() }).strict()),
  error: z.string().optional(),
}).strict();

export const hostBaseInput = z.object(hostBaseFields).strict();

const fileChangeSchema = z.object({
  path: z.string(),
  sha256Before: z.string().nullable(),
  sha256After: z.string().nullable(),
}).strict();

export const installReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.string(),
  scenario: z.string().nullable(),
  status: z.enum(["ok", "failed", "rolled_back"]).optional(),
  filesChanged: z.array(fileChangeSchema),
  externalOpsBefore: z.record(z.string(), z.string().nullable()),
  externalOpsAfter: z.record(z.string(), z.string().nullable()),
  skippedExternalOps: z.array(z.string()),
  warning: z.string().nullable(),
  exitCode: z.number().int(),
  receiptPath: z.string().nullable(),
  snapshotPath: z.string().nullable(),
  sourceSha: z.string().nullable(),
  notes: z.array(z.string()),
}).strict();

export const coexistenceManager = z.enum(["agents-marker", "managed-checkout", "claude-cache", "claude-settings", "opencode-config", "opencode-plugin"]);
export const coexistenceOperation = z.enum(["install", "connect", "update", "reload", "disconnect", "rollback"]);
const coexistenceEvidence = z.object({
  kind: z.string(), path: z.string().nullable(), sha256: z.string().nullable(), detail: z.string(),
}).strict();
const coexistenceManagerState = z.object({
  manager: coexistenceManager, path: z.string(), installed: z.boolean(), configured: z.boolean(),
  loaded: z.boolean().nullable(), compatible: z.boolean().nullable(), modified: z.boolean().nullable(),
  version: z.string().nullable(), sourceSha: z.string().nullable(), sha256: z.string().nullable(),
  owner: z.enum(["lane-pilot", "user", "upstream", "unknown"]),
  decision: z.enum(["reuse", "install", "upgrade", "conflict", "skip", "disconnect-owned"]),
  capabilities: z.array(z.string()), missingCapabilities: z.array(z.string()), evidence: z.array(coexistenceEvidence),
}).strict();
export const coexistenceInventory = z.object({
  schemaVersion: z.literal(1), hostId: z.string(), targetSha: z.string(), managers: z.array(coexistenceManagerState),
}).strict();
export const coexistenceOperationResult = z.object({
  schemaVersion: z.literal(1), hostId: z.string(), operation: coexistenceOperation, manager: coexistenceManager,
  path: z.string(), status: z.enum(["ok", "conflict", "blocked", "failed", "skipped", "rolled_back"]),
  beforeSha256: z.string().nullable(), afterSha256: z.string().nullable(), snapshotId: z.string().nullable(),
  owner: z.enum(["lane-pilot", "user", "upstream", "unknown"]), evidence: z.array(coexistenceEvidence), reason: z.string().nullable(),
}).strict();

const bilingualSchema = z.object({ en: z.string(), ru: z.string() }).strict();
const viewFieldSchema = z.object({ name: z.string(), type: z.string(), required: z.boolean(), values: z.array(z.string()).optional(), note: z.string().optional(), default: z.unknown().optional() }).strict();
export const WORKFLOW_NODE_TONES = ["plan", "build", "qa", "review", "agent", "action", "decision", "human", "flow", "sub", "note", "terminal"] as const;
export const workflowViewNodeSchema = z.object({
  id: z.string(), kind: z.enum(["agent", "lp-task", "action", "decision", "human", "parallel", "join", "subworkflow", "note", "start", "end"]),
  tone: z.enum(WORKFLOW_NODE_TONES), title: bilingualSchema.nullable(), label: z.string().nullable(),
  role: z.string().nullable(), excerpt: z.string().nullable(), uses: z.string().nullable(),
  out: z.array(z.string()), maxVisits: z.number().int().nullable(), stages: z.array(z.string()),
  /** A subworkflow node: the workflow it calls. */
  calls: z.object({ id: z.string(), version: z.number().int().nullable() }).strict().nullable(),
  modes: z.array(z.string()).nullable(),
}).strict();
export const workflowViewEdgeSchema = z.object({
  index: z.number().int(), from: z.string(), to: z.string(), when: z.string().nullable(), label: z.string().nullable(),
  pass: z.enum(["artifact", "same-session", "read-prior-session", "fork"]), carries: z.array(z.string()),
}).strict();
/** `positions`: where the owner put the nodes (the file's `ui.positions`, by node id); absent when the graph is laid out automatically. */
export const workflowViewSchema = z.object({ nodes: z.array(workflowViewNodeSchema), edges: z.array(workflowViewEdgeSchema), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).optional() }).strict();
/** Who works on a step and with which model, as the Models view and the graph cards show it (see server/workflow-step-executors.ts). */
const executorPairSchema = z.object({ providerId: z.string().nullable(), model: z.string().nullable(), reasoningEffort: z.string().nullable(), serviceTier: z.string().nullable() }).strict();
export const stepExecutorSchema = z.object({
  /** The id of the node on the graph (`<id>:child` for the body of a parallel). */
  nodeId: z.string(), kind: z.string(), uses: z.string().nullable(),
  /** `model`: one model call; `chain`: a writer and its fallback chain; `helper`: a fixed helper thread; `none`: no model works here. */
  mode: z.enum(["model", "chain", "helper", "none"]),
  agent: z.object({ role: z.string().nullable(), helper: z.string().nullable(), label: z.string() }).strict(),
  providerId: z.string().nullable(), model: z.string().nullable(), reasoningEffort: z.string().nullable(), serviceTier: z.string().nullable(),
  source: z.enum(["override", "node", "preset", "stage", "agent", "pm", "role-default", "writer", "helper", "session", "none"]),
  /** The setting key, the preset name or the helper the value comes from; for `session` the step whose session this one goes on in. */
  sourceKey: z.string().nullable(),
  inherited: z.boolean(),
  /** The writer chain after the writer's own model: fallback 1, fallback 2, then the PM's model (`pm`). */
  fallbacks: z.array(z.object({ providerId: z.string().nullable(), model: z.string().nullable(), reasoningEffort: z.string().nullable(), pm: z.boolean() }).strict()),
  /** Further models of the same step: the code critic of a code task. */
  parts: z.array(executorPairSchema.extend({ stage: z.string(), source: z.string(), sourceKey: z.string().nullable() }).strict()),
  /** Whether a patch of the node changes it; otherwise the Settings of `settingsKey` do. */
  overridable: z.boolean(), settingsKey: z.string().nullable(),
  /** Whether the owner can move the step to another model without editing the workflow (a per-step override in settings), and the level of the override in force. */
  canOverride: z.boolean(), overrideScope: z.enum(["project", "global"]).nullable(),
  costTier: z.enum(["none", "low", "medium", "high", "unknown"]),
  /** Problems found: `unknown_preset`, `provider_without_model`, `provider_unavailable`, `model_unavailable` ... */
  issues: z.array(z.string()),
  /**
   * Set for a step of a called workflow: `workflowId` is the workflow the step is in (`nodeId` above is its id there) and `nodeId` the
   * call on the graph being shown. The override of such a step is keyed `<workflowId>/<nodeId>`, which is what the executor reads.
   */
  fragment: z.object({ nodeId: z.string(), workflowId: z.string() }).strict().optional(),
}).strict();
export const modelCatalogSchema = z.object({
  /** With a `projectId`: the machine the project's workflow helpers run on (its PM chat's environment); a model must be offered there. */
  runHostId: z.string().nullable().optional(),
  hosts: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict()),
  providers: z.array(z.object({
    id: z.string(), displayName: z.string(), logoUrl: z.string().nullable(), family: z.string().nullable(), supportsServiceTier: z.boolean(), serviceTiers: z.array(z.string()), hostIds: z.array(z.string()),
    models: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), efforts: z.array(z.string()), defaultEffort: z.string().nullable(), isDefault: z.boolean(), hostIds: z.array(z.string()) }).strict()),
  }).strict()),
}).strict();
export const workflowStatsSchema = z.object({
  runs: z.number().int(), succeeded: z.number().int(), failed: z.number().int(), active: z.number().int(),
  /** Succeeded over finished runs; null before any run has finished. */
  successRate: z.number().nullable(), lastRunAt: z.number().int().nullable(), lastStatus: z.string().nullable(), lastRunId: z.string().nullable(),
}).strict();
export const workflowSummarySchema = z.object({
  id: z.string(), name: bilingualSchema, description: bilingualSchema, status: z.enum(["draft", "tested", "published", "deprecated"]), version: z.number().int(),
  scope: z.enum(["builtin", "global", "project"]), internal: z.boolean(), tags: z.array(z.string()), nodes: z.number().int(), warnings: z.number().int(),
  stats: workflowStatsSchema,
}).strict();
export const workflowRunRowSchema = z.object({
  id: z.string(), status: z.string(), reason: z.string().nullable(), mode: z.string().nullable(), createdAt: z.number().int(), updatedAt: z.number().int(),
  tokens: z.number().int(), costUsd: z.number(), parentRunId: z.string().nullable(),
}).strict();
export const workflowDetailSchema = workflowSummarySchema.extend({
  examples: z.object({ en: z.array(z.string()), ru: z.array(z.string()) }).strict(),
  inputs: z.array(viewFieldSchema), outputs: z.array(viewFieldSchema),
  triggers: z.array(z.string()), requires: z.array(z.string()),
  budget: z.object({ maxSteps: z.number().nullable(), maxTokens: z.number().nullable(), maxCostUsd: z.number().nullable(), maxWallSeconds: z.number().nullable() }).strict(),
  qualityMode: z.string().nullable(), source: z.string(), sha256: z.string(),
  /** The live run that proved this version (a `tested` workflow whose run succeeded counts as published); null until one did. */
  proven: z.object({ runId: z.string(), at: z.number().int() }).strict().nullable(),
  /** The BB automations that run this workflow's schedule triggers (own, published workflows only). */
  schedules: z.array(z.object({ projectId: z.string(), slot: z.number().int(), automationId: z.string() }).strict()),
  warningMessages: z.array(z.string()),
  graph: workflowViewSchema,
  runs: z.array(workflowRunRowSchema),
}).strict();
const workflowStepSchema = z.object({
  key: z.string(), nodeId: z.string(), state: z.string(), visit: z.number().int(), scope: z.string(), attempt: z.number().int(),
  parentKey: z.string().nullable(), edgeIndex: z.number().int().nullable(),
  startedAt: z.number().int().nullable(), endedAt: z.number().int().nullable(), error: z.string().nullable(),
  threadId: z.string().nullable(), handoff: z.string().nullable(), awaiting: z.string().nullable(),
  /** What the step was given (its inputs, the item of a branch, how the data came); a large value is replaced by `{ truncated: true, preview }`. */
  input: z.unknown(),
  /** The step's output; a large one is replaced by `{ truncated: true, preview }`. */
  output: z.unknown(),
}).strict();
export const workflowRunSnapshotSchema = z.object({
  run: workflowRunRowSchema.extend({ workflowId: z.string(), version: z.number().int(), projectId: z.string().nullable(), parentStepKey: z.string().nullable(), stepsUsed: z.number().int(), inputs: z.unknown(), output: z.unknown() }).strict(),
  graph: workflowViewSchema,
  steps: z.array(workflowStepSchema),
  children: z.array(z.object({ runId: z.string(), stepKey: z.string(), workflowId: z.string(), status: z.string() }).strict()),
  /** K7: what the run is for, the last audit against it, and how the goals changed (oldest first, the first entry is the start). */
  goals: z.array(z.object({ id: z.string(), done_when: z.string(), evidence: z.string(), guess: z.boolean().optional() }).strict()),
  goalAudit: z.object({ verdict: z.enum(["pass", "gaps", "unavailable"]), met: z.array(z.string()), unmet: z.array(z.object({ id: z.string(), why: z.string() }).strict()), notes: z.string().optional(), error: z.string().optional(), at: z.number().int() }).strict().nullable(),
  goalChanges: z.array(z.object({ at: z.number().int(), by: z.string(), reason: z.string(), goals: z.number().int() }).strict()),
  events: z.array(z.object({ seq: z.number().int(), stepKey: z.string().nullable(), kind: z.string(), from: z.string().nullable(), to: z.string().nullable(), detail: z.string().nullable(), at: z.number().int() }).strict()),
}).strict();

export const acceptanceTotalsSchema = z.object({
  dispatched:z.number(), firstTryAccepted:z.number(), eventuallyAccepted:z.number(),
  attempts:z.number(), attemptsPerAccepted:z.number().nullable(),
  redispatched:z.number(), families:z.number(), causes:z.record(z.string(), z.number()),
});
export const acceptanceWeekSchema = acceptanceTotalsSchema.extend({ week:z.string() });

const workflowDraftProblemSchema = z.object({ level: z.enum(["error", "warning"]), code: z.string(), message: z.string(), node: z.string().optional(), edge: z.number().int().optional() }).strict();
export const workflowDraftCheckSchema = z.object({ valid: z.boolean(), errors: z.number().int(), warnings: z.number().int(), nodes: z.number().int(), edges: z.number().int(),
  problems: z.array(workflowDraftProblemSchema) }).strict();
/** One draft in a list: enough to draw a card and to know whether the open graph is behind (`version`). */
export const workflowDraftSummarySchema = z.object({
  id: z.string(), projectId: z.string(), threadId: z.string().nullable(), workflowId: z.string(), scope: z.enum(["global", "project"]),
  name: z.object({ en: z.string(), ru: z.string() }).strict(), status: z.enum(["draft", "tested", "published"]), version: z.number().int(),
  nodes: z.number().int(), edges: z.number().int(), errors: z.number().int(), tested: z.enum(["none", "red", "green"]), publishedPath: z.string().nullable(), updatedAt: z.number(),
}).strict();

const draftProblems = z.array(workflowDraftProblemSchema);
export const workflowDraftPatchResultSchema = z.object({
  ok: z.boolean(), applied: z.boolean(), reason: z.string().optional(), currentVersion: z.number().int().optional(),
  /** Operations the draft could not take (nothing was changed). */
  refused: z.array(z.object({ index: z.number().int(), op: z.string(), reason: z.string() }).strict()).optional(),
  version: z.number().int().optional(), status: z.string().optional(), changes: z.array(z.string()).optional(),
  valid: z.boolean().optional(), errors: z.number().int().optional(), warnings: z.number().int().optional(), nodes: z.number().int().optional(), edges: z.number().int().optional(),
  problems: draftProblems.optional(), definition: z.record(z.string(), z.unknown()).optional(),
});
export const workflowDraftTestResultSchema = z.object({
  draftId: z.string(), version: z.number().int(), ran: z.boolean(), green: z.boolean(), reason: z.string().optional(), allCasesRun: z.boolean().optional(),
  cases: z.array(z.object({
    caseId: z.string(), green: z.boolean(), status: z.string(), path: z.array(z.string()), output: z.unknown(), failures: z.array(z.string()),
    runId: z.string().nullable(), failedNode: z.string().nullable(), stubbedCalls: z.array(z.string()), notChecked: z.array(z.string()).optional(),
  })).optional(),
  problems: draftProblems.optional(), note: z.string().optional(),
});
export const workflowDraftPublishResultSchema = z.object({
  draftId: z.string(), published: z.boolean(), reason: z.string().optional(), next: z.string().optional(), problems: draftProblems.optional(), path: z.string().optional(),
  failing: z.array(z.object({ caseId: z.string(), failures: z.array(z.string()) })).optional(),
  workflowId: z.string().optional(), workflowVersion: z.number().int().optional(), scope: z.string().optional(),
  liveReady: z.boolean().optional(), unregisteredExecutors: z.array(z.string()).optional(), warning: z.string().optional(), capabilityWarnings: z.array(z.string()).optional(),
});

/** One case of a trial run on stubs (a dry run, or the tests of a workflow file). */
export const workflowTrialCaseSchema = z.object({
  caseId: z.string(), green: z.boolean(), status: z.string(), reason: z.string().nullable(), error: z.string().nullable(), failedNode: z.string().nullable(),
  path: z.array(z.string()), output: z.unknown(), runId: z.string().nullable(), failures: z.array(z.string()), stubbedCalls: z.array(z.string()), notChecked: z.array(z.string()),
}).strict();

export const runViewSchema = z.object({
  id: z.string(),
  state: z.string(),
  kind: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  cliReceiptJson: z.string().nullable(),
  /** The PM chat of an open run: what the owner sees instead of a bare run id. */
  pmThread: z.object({ id: z.string(), title: z.string().nullable(), status: z.string().nullable() }).strict().nullable().optional(),
  /** How many stage rows the run has; `list_run_stages` returns them when the owner opens the list. */
  stageCount: z.number().int().nonnegative().optional(),
  attempts: z.array(z.object({
    id: z.string(),
    state: z.string(),
    attempt_no: z.number(),
    thread_id: z.string().nullable(),
    reason: z.string().nullable(),
    task_id: z.string(),
    cliReceiptJson: z.string().nullable(),
  }).strict()),
}).strict();