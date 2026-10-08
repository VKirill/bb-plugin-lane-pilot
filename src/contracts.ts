import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { stageReceiptSchema } from "./stages/contract";
import { scheduleRpcContract } from "./schedule/contract";

/** A stage row as the screen lists it: no result body (`get_stage_result` loads it), only whether there is one. */
const stageSummarySchema = stageReceiptSchema.omit({ result: true }).extend({ hasResult: z.boolean() }).strict();
import { anamnesisHostMethods, anamnesisRpcMethods } from "./anamnesis/contract";

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

const ruleProposalSchema = z.object({
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

const ruleScanSchema = z.object({
  state: z.enum(["idle", "running", "done", "failed"]),
  startedAt: z.number().int().nullable(), finishedAt: z.number().int().nullable(),
  triaged: z.number().int(), groups: z.number().int(), proposals: z.number().int(), reason: z.string().nullable(),
  adopted: z.number().int().optional(), confirmed: z.number().int().optional(), revised: z.number().int().optional(), retired: z.number().int().optional(),
}).strict();

const rulesAnalyzerSchema = z.object({
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
}).strict();

export type TaskV2 = z.infer<typeof taskV2Schema>;

/**
 * Host calls that run as background jobs: a separate process the host daemon's deadline cannot cut off (B4). A kind is
 * the name of the ordinary host method whose handler the job runs; its input is that method's own input.
 */
export const HOST_JOB_KINDS = ["detect", "install", "rollback", "snapshot", "importConfig", "connectOpencode", "coexistenceOperation", "coexistenceInventory", "gitIntegrate", "gitPrepareWorktree", "runSandboxedCommand", "runBrowserQa", "gateRun", "gateBisect", "runScript"] as const;
export type HostJobKind = (typeof HOST_JOB_KINDS)[number];
const hostJobId = z.string().regex(/^job_[a-z0-9]{10,40}$/);
const hostJobRef = z.object({ requestedHostId:z.string().min(1), jobId:hostJobId }).strict();

const hostBaseFields = {
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

const inventoryGroupSchema = z.object({
  status: z.enum(["ready", "unavailable", "error"]),
  items: z.array(z.object({ name: z.string(), label: z.string() }).strict()),
  error: z.string().optional(),
}).strict();

const hostBaseInput = z.object(hostBaseFields).strict();

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

const coexistenceManager = z.enum(["agents-marker", "managed-checkout", "claude-cache", "claude-settings", "opencode-config", "opencode-plugin"]);
const coexistenceOperation = z.enum(["install", "connect", "update", "reload", "disconnect", "rollback"]);
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
const coexistenceInventory = z.object({
  schemaVersion: z.literal(1), hostId: z.string(), targetSha: z.string(), managers: z.array(coexistenceManagerState),
}).strict();
const coexistenceOperationResult = z.object({
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
const workflowSummarySchema = z.object({
  id: z.string(), name: bilingualSchema, description: bilingualSchema, status: z.enum(["draft", "tested", "published", "deprecated"]), version: z.number().int(),
  scope: z.enum(["builtin", "global", "project"]), internal: z.boolean(), tags: z.array(z.string()), nodes: z.number().int(), warnings: z.number().int(),
  stats: workflowStatsSchema,
}).strict();
const workflowRunRowSchema = z.object({
  id: z.string(), status: z.string(), reason: z.string().nullable(), mode: z.string().nullable(), createdAt: z.number().int(), updatedAt: z.number().int(),
  tokens: z.number().int(), costUsd: z.number(), parentRunId: z.string().nullable(),
}).strict();
const workflowDetailSchema = workflowSummarySchema.extend({
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
const workflowRunSnapshotSchema = z.object({
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

export const hostContract = defineRpcContract({
  nativeInstall: {
    input: z.object({ requestedHostId: z.string().min(1), action: z.enum(["install", "enable", "disable", "remove", "status"]) }).strict(),
    output: z.object({ status: z.enum(["absent", "prepared", "enabled", "disabled"]), sourceSha: z.string().nullable(), ownedFiles: z.number(), preservedFiles: z.number() }).strict(),
  },
  gitOwnershipBase: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), baseRef:z.string().min(1).max(240).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","invalid-ref","failed"]), branch:z.string().nullable(), headSha:z.string().nullable(), baseRef:z.string().nullable(), baseSha:z.string().nullable(), compareCommitted:z.boolean(), reason:z.string().nullable() }).strict(),
  },
  gitPrepareWorktree: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), linked:z.array(z.string()) }).strict(),
  },
  gitWorktreeSnapshot: {
    input: z.object({ requestedHostId:z.string().min(1), worktreePath:z.string().startsWith("/"), name:z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["clean","saved","missing","failed"]), path:z.string().nullable(), dirty:z.number().int(), ahead:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  gitRemoveWorktree: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), removed:z.boolean() }).strict(),
  },
  gitSyncWorktree: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/"), keepConflicts:z.boolean().optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["synced","up-to-date","dirty","conflict","failed"]), head:z.string().nullable(), reason:z.string().nullable(), conflicts:z.array(z.string()).optional() }).strict(),
  },
  jobStart: {
    // `key`: one logical job; a second start with the same key returns the first job (additive; an older host ignores it).
    input: z.object({ requestedHostId:z.string().min(1), kind:z.enum(HOST_JOB_KINDS), input:z.record(z.string(), z.unknown()), timeoutSec:z.number().int().min(10).max(10_800), key:z.string().min(1).max(200).optional() }).strict(),
    output: z.object({ hostId:z.string(), jobId:hostJobId }).strict(),
  },
  jobStatus: {
    input: hostJobRef,
    output: z.object({
      hostId:z.string(), jobId:hostJobId, state:z.enum(["running", "succeeded", "failed", "cancelled", "lost"]),
      progress:z.object({ startedAt:z.number(), updatedAt:z.number(), elapsedSec:z.number().int().nonnegative(), lastLine:z.string() }).strict(),
      result:z.unknown().optional(), error:z.string().nullable(),
    }).strict(),
  },
  jobCancel: {
    input: hostJobRef,
    output: z.object({ hostId:z.string(), jobId:hostJobId, cancelled:z.boolean() }).strict(),
  },
  stabilityDrill: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), checks:z.array(z.object({ name:z.string(), ok:z.boolean(), detail:z.string().nullable() }).strict()) }).strict(),
  },
  ...anamnesisHostMethods,
  diskFree: {
    input: z.object({ requestedHostId:z.string().min(1), path:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), path:z.string(), freeBytes:z.number().nonnegative(), totalBytes:z.number().nonnegative() }).strict(),
  },
  gitCreateWorktree: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), name:z.string().regex(/^[A-Za-z0-9._-]{1,120}$/) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","failed"]), path:z.string().nullable(), branch:z.string().nullable(), reason:z.string().nullable() }).strict(),
  },
  gitIntegrate: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), worktreePath:z.string().startsWith("/"), message:z.string().min(1).max(500), removeWorktree:z.boolean().optional(),
      committedOnly:z.boolean().optional(), bookkeeping:z.array(z.string().max(300)).max(100).optional(),
      // The task's owns_paths: a bookkeeping file it owns keeps the attempt's version in the merge (additive; an older host ignores it).
      ownsPaths:z.array(z.string().max(300)).max(200).optional(),
      // The task's checks, run in the attempt's worktree when it was replayed on a moved main, before the merge (additive).
      replayChecks:z.object({ workspacePath:z.string().startsWith("/"), backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),
        commands:z.array(z.object({ command:z.string().min(1).max(32_000), cwd:z.string().startsWith("/"), timeoutSec:z.number().int().min(1).max(7200).optional() }).strict()).min(1).max(20) }).strict().optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["merged","up-to-date","conflict","failed","busy"]), commit:z.string().nullable(), conflicts:z.array(z.string()), reason:z.string().nullable(), holder:z.string().nullable().optional(), rebased:z.boolean().optional(),
      checks:z.array(z.object({ command:z.string(), exitCode:z.number().int(), stdout:z.string(), stderr:z.string() }).strict()).optional(),
      rebuilt:z.array(z.object({ dir:z.string(), ok:z.boolean(), detail:z.string().nullable() }).strict()).optional() }).strict(),
  },
  gitDocsScope: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), sinceEpochMs:z.number().int().nonnegative(), base:z.string().min(1).max(200).optional(),
      docsDir:z.string().min(1).max(240).regex(/^(?!\/)(?!.*\.\.)[^\0]+$/).optional(), exclude:z.array(z.string().min(1).max(240)).max(50).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), isRepoRoot:z.boolean(), hasDocs:z.boolean(), changed:z.array(z.string()), dirty:z.array(z.string()), base:z.string().nullable(),
      workspaces:z.array(z.object({ path:z.string(), name:z.string(), codeFiles:z.number().int() })), localDate:z.string(), localHour:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  docsWorthinessFacts: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), trackedFiles:z.number().int(), codeFiles:z.number().int(), testFiles:z.number().int(),
      contentFiles:z.number().int(), languages:z.array(z.object({ ext:z.string(), files:z.number().int() })), commits30d:z.number().int(), manifests:z.array(z.string()),
      deploy:z.boolean(), docsPages:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  docsAnchors: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), title:z.string() })).max(500),
      prefix:z.string().max(240).optional(), exclude:z.array(z.string()).max(500).optional(),
      workspaces:z.array(z.object({ path:z.string(), name:z.string(), docsDir:z.string().nullable() })).max(500).optional() }).strict(),
    output: z.object({ hostId:z.string(), briefPath:z.string(), anchors:z.number().int(), jev:z.enum(["ok","partial","disabled"]), productFiles:z.array(z.string()),
      core:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })), tables:z.array(z.string()), deploy:z.boolean() }).strict(),
  },
  docsFlows: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), projectCwd:z.string().startsWith("/"), workspaces:z.array(z.object({ path:z.string(), name:z.string() })).max(500),
      keep:z.array(z.string()).max(200).optional() }).strict(),
    output: z.object({ hostId:z.string(), briefPath:z.string(), jev:z.enum(["ok","partial","disabled"]), routes:z.number().int(),
      flows:z.array(z.object({ name:z.string(), slug:z.string(), entries:z.number().int(), modules:z.array(z.string()), briefPath:z.string(), files:z.array(z.string()),
        calls:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })) })) }).strict(),
  },
  docsDepth: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500),
      core:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), findings:z.array(z.object({ path:z.string(), rule:z.string(), detail:z.string() })) }).strict(),
  },
  docsVerifyCitations: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500),
      related:z.array(z.object({ path:z.string(), content:z.string() })).max(500).optional() }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), checked:z.number().int(), findings:z.array(z.object({ path:z.string(), rule:z.string(), detail:z.string() })),
      pageStats:z.array(z.object({ path:z.string(), checked:z.number().int(), supported:z.number().int(), partial:z.number().int() })) }).strict(),
  },
  docsStaleness: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), projectCwd:z.string().startsWith("/"), base:z.string().min(1), changed:z.array(z.string()).max(5000), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500) }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), refresh:z.array(z.string()), reasons:z.array(z.object({ path:z.string(), section:z.string(), p:z.number() })) }).strict(),
  },
  docsLineCounts: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), files:z.array(z.string()).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), counts:z.record(z.string(), z.number().int().nullable()) }).strict(),
  },
  gitCommitDocs: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), paths:z.array(z.string()).max(2000), message:z.string().min(1).max(500) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["committed","nothing","failed"]), commit:z.string().nullable(), reason:z.string().nullable() }).strict(),
  },
  gitRevertPaths: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), paths:z.array(z.string().min(1)).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), reverted:z.array(z.string()), failed:z.array(z.string()) }).strict(),
  },
  gitOwnershipChanges: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), baseSha:z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), compareCommitted:z.boolean(), unfiltered:z.boolean().optional(), bookkeeping:z.array(z.string().max(300)).max(100).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), headSha:z.string().nullable(), paths:z.array(z.string()), reason:z.string().nullable() }).strict(),
  },
  readOpenCodeTelemetry: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), relativePath:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), relativePath:z.string(), size:z.number().int().nonnegative().max(262144), sha256:z.string().regex(/^[a-f0-9]{64}$/), content:z.string().max(262144) }).strict(),
  },
  readBoundedFile: {
    input: z.object({
      requestedHostId: z.string().min(1),
      projectCwd: z.string().startsWith("/"),
      relativePath: z.string().min(1).max(1024),
      offset: z.number().int().min(0).max(100000),
      maxLines: z.number().int().min(1).max(2000),
    }).strict(),
    output: z.object({
      schemaVersion: z.literal(1),
      hostId: z.string().min(1),
      path: z.string().min(1),
      content: z.string().max(262144),
      contentEncoding: z.literal("utf8"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
      totalLines: z.number().int().nonnegative(),
      offset: z.number().int().min(0),
      maxLines: z.number().int().min(1),
      lineStart: z.number().int().min(1),
      lineEnd: z.number().int().min(0),
      truncated: z.boolean(),
      returnedBytes: z.number().int().nonnegative().max(262144),
    }).strict(),
  },
  listDocsPages: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"),
      roots:z.array(z.string().min(1).max(240).regex(/^(?!\/)(?!.*\.\.)[^\0]+$/)).max(500).optional(), skipOversized:z.boolean().optional() }).strict(),
    output: z.object({hostId:z.string(), oversized:z.array(z.string()).optional(), pages:z.array(z.object({path:z.string(),modifiedAt:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),content:z.string()}).strict())}).strict(),
  },
  listWorkflowFiles: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), files:z.array(z.object({ path:z.string(), content:z.string() }).strict()) }).strict(),
  },
  applyOnboardingPages: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), confirmed:z.literal(true),
      previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(8_000)}).strict()).min(1).max(8),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
  },
  writeDocsPages: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), previewSha256:z.string().regex(/^[a-f0-9]{64}$/),
      edits:z.array(z.object({path:z.string().min(1).max(240),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),content:z.string().max(40_000)}).strict()).min(1).max(100),
    }).strict(),
    output:z.object({hostId:z.string(),previewSha256:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(["applied","conflict","blocked"]),writes:z.array(z.object({path:z.string(),beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),status:z.enum(["applied","conflict","blocked"]),reason:z.string().nullable()}).strict()),reason:z.string().nullable()}).strict(),
  },
  /** The Workflow architect publishes a chain into `<project>/.lane-pilot/workflows/<id>.json`; the write is compare-and-swap on the file's hash. */
  writeWorkflowFile: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), id:z.string().regex(/^[a-z][a-z0-9.-]{0,47}$/),
      content:z.string().min(2).max(400_000), expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict(),
    output:z.object({hostId:z.string(), status:z.enum(["applied","conflict"]), path:z.string(), beforeSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(), afterSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(), reason:z.string().nullable()}).strict(),
  },
  coexistenceInventory: {
    input: z.object({ requestedHostId: z.string().min(1), projectId: z.string().min(1), targetSha: z.string().optional() }).strict(),
    output: coexistenceInventory,
  },
  coexistenceOperation: {
    input: z.object({
      requestedHostId: z.string().min(1), projectId: z.string().min(1), operation: coexistenceOperation,
      manager: coexistenceManager, path: z.string().startsWith("/"), expectedSha256: z.string().nullable().optional(),
      snapshotId: z.string().nullable().optional(), targetSha: z.string().nullable().optional(), confirmExternalOps: z.literal(false).optional(),
    }).strict(),
    output: coexistenceOperationResult,
  },
  detect: {
    input: z.object({ ...hostBaseFields, workspacePath: z.string().startsWith("/") }).strict(),
    output: z.object({
      hostId: z.string(),
      laneStack: z.object({ present: z.boolean(), version: z.string().nullable(), sourceSha: z.string().nullable() }),
      openCode: z.object({ present: z.boolean(), version: z.string().nullable() }),
      workspace: z.object({ path: z.string(), present: z.boolean() }),
      targetSha: z.string(),
      matchesTarget: z.boolean(),
      scenario: z.enum(["S1", "S2", "S3"]),
    }).strict(),
  },
  snapshotDryRun: {
    input: z.object({ requestedHostId: z.string().min(1), paths: z.array(z.string().startsWith("/")).max(128) }).strict(),
    output: z.object({
      hostId: z.string(),
      entries: z.array(z.object({
        path: z.string(),
        kind: z.enum(["missing", "file", "directory", "symlink", "other"]),
        sha256: z.string().nullable(),
        symlinkTarget: z.string().nullable(),
        /** What a symlink points at once followed (stat); absent from an older host. */
        targetKind: z.enum(["missing", "file", "directory", "other"]).optional(),
      }).strict()),
    }).strict(),
  },
  snapshot: {
    input: hostBaseInput,
    output: installReceiptSchema,
  },
  install: {
    input: z.object({
      ...hostBaseFields,
      installSettings: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
    output: installReceiptSchema,
  },
  rollback: {
    input: z.object({ ...hostBaseFields, snapshotPath: z.string().startsWith("/") }).strict(),
    output: installReceiptSchema,
  },
  importConfig: {
    input: hostBaseInput,
    output: installReceiptSchema.extend({
      imported: z.object({
        routingProfile: z.object({ path: z.string(), text: z.string(), sha256: z.string() }).nullable(),
        nightShift: z.object({ path: z.string(), text: z.string(), sha256: z.string() }).nullable(),
      }).strict(),
    }).strict(),
  },
  connectOpencode: {
    input: hostBaseInput,
    output: installReceiptSchema,
  },
  runCli: {
    input: z.object({
      requestedHostId: z.string().min(1),
      binary: z.enum(["run-controller", "lane-ctl"]),
      argv: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      cwd: z.string().startsWith("/"),
      timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(),
      binaryPath: z.string(),
      argv: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      cwd: z.string(),
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
    }).strict(),
  },
  // The integration gate runs on the project's host (a project on another machine has no path on the hub): both are job kinds.
  gateRun: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), command:z.string().min(1).max(32_000), timeoutSec:z.number().int().min(1).max(7200) }).strict(),
    output: z.object({ hostId:z.string(), exitCode:z.number().int(), stdout:z.string(), stderr:z.string(), head:z.string().nullable() }).strict(),
  },
  gateBisect: {
    input: z.object({ requestedHostId:z.string().min(1), basePath:z.string().startsWith("/"), command:z.string().min(1).max(32_000),
      goodSha:z.string().regex(/^[a-f0-9]{7,64}$/), badSha:z.string().regex(/^[a-f0-9]{7,64}$/), timeoutSec:z.number().int().min(1).max(7200) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["found", "none", "failed"]), commit:z.string().nullable(), reason:z.string().nullable() }).strict(),
  },
  // A scheduled script (schedule board): runs as a host job so a reload of the hub loses the poll, not the script.
  runScript: {
    input: z.object({
      requestedHostId: z.string().min(1),
      command: z.string().min(1).max(32_000),
      cwd: z.string().startsWith("/"),
      timeoutSec: z.number().int().min(1).max(10_800),
      /** Env Catalog values for this run (by variable name): in its environment only, masked in the output. */
      env: z.record(secretNameSchema, z.string().max(65_536)).optional(),
      maxOutputBytes: z.number().int().min(1024).max(512 * 1024).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string(),
      truncated: z.boolean(), timedOut: z.boolean(), durationMs: z.number().int().nonnegative(),
    }).strict(),
  },
  runCommand: {
    input: z.object({
      requestedHostId: z.string().min(1),
      command: z.string().min(1),
      cwd: z.string().startsWith("/"),
      timeoutSec: z.number().int().min(1).max(7200).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(),
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
    }).strict(),
  },
  // One goal in the owner's own Chrome on the browser machine through jev-ultrafast (the computer-use runner).
  browserGoal: {
    input: z.object({
      requestedHostId: z.string().min(1),
      url: z.string().url(),
      goal: z.string().min(1).max(2000),
      timeoutSec: z.number().int().min(10).max(600).optional(),
    }).strict(),
    output: z.object({
      hostId: z.string(), exitCode: z.number().int(), status: z.string(), url: z.string().nullable(), actions: z.number().int().nullable(),
      // The visible text of the page it reached (jev keeps up to 6000 characters); null from an older launcher.
      title: z.string().nullable(), text: z.string().nullable(),
      log: z.string(),
    }).strict(),
  },
  runSandboxedCommand: {
    input:z.object({
      requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),cwd:z.string().startsWith("/"),
      backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),
      command:z.string().min(1).max(32_000),timeoutSec:z.number().int().min(1).max(7200).optional(),
      /** Secret values for this one command (Env Catalog, J2): they go into the sandbox's environment only, and the host masks them in the output. */
      env:z.record(secretNameSchema,z.string().max(65_536)).optional(),
    }).strict(),
    output:z.object({
      hostId:z.string(),backend:z.enum(["macos-seatbelt","linux-bubblewrap"]),workspacePath:z.string(),cwd:z.string(),
      exitCode:z.number().int(),policySha256:z.string().regex(/^[a-f0-9]{64}$/),stdout:z.string(),stderr:z.string(),
    }).strict(),
  },
  sandboxCommandLine: {
    input:z.object({
      requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),cwd:z.string().startsWith("/"),
      backend:z.enum(["auto","macos-seatbelt","linux-bubblewrap"]).optional(),command:z.string().min(1).max(32_000),
      passEnv:z.array(z.string().max(128)).max(500).optional(),
    }).strict(),
    output:z.object({
      hostId:z.string(),backend:z.enum(["macos-seatbelt","linux-bubblewrap"]),workspacePath:z.string(),cwd:z.string(),
      policySha256:z.string().regex(/^[a-f0-9]{64}$/),commandLine:z.string(),
      cleanup:z.object({tempPath:z.string(),created:z.array(z.string())}).strict(),
    }).strict(),
  },
  sandboxRelease: {
    input:z.object({requestedHostId:z.string().min(1),tempPath:z.string().startsWith("/"),created:z.array(z.string())}).strict(),
    output:z.object({hostId:z.string(),released:z.boolean()}).strict(),
  },
  runBrowserQa: {
    input: z.object({
      requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), url:z.string().url(),
      slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), cases:z.array(z.string().min(1).max(2000)).min(1).max(30),
      envClass:z.enum(["local","staging","preview","production","unknown"]), viewports:z.string().regex(/^\d{2,4}(,\d{2,4}){0,2}$/),
      authorized:z.boolean(), provider:z.enum(["jev","codex"]), model:z.string().max(120).optional(),
      reasoningEffort:z.enum(["low","medium","high","xhigh","max"]).optional(),
      backend:z.enum(["live-chrome","chrome-qa","headless"]), timeoutSec:z.number().int().min(30).max(1800),
    }).strict(),
    output:z.object({
      hostId:z.string(), provider:z.enum(["jev","codex"]), runner:z.string(), exitCode:z.number().int(),
      verdict:z.enum(["passed","failed","blocked"]), reportPath:z.string().nullable(), reportSha256:z.string().nullable(),
      actualModel:z.string().nullable(),actualReasoningEffort:z.string().nullable(),actualBackend:z.string().nullable(),
      reportText:z.string().nullable(), artifacts:z.array(z.object({path:z.string(),sha256:z.string(),size:z.number().int().nonnegative()}).strict()),
      stdout:z.string(), stderr:z.string(), reason:z.string().nullable(),
      processPid:z.number().int().nullable(), runnerPath:z.string().nullable(),
    }).strict(),
  },
  vpnAddress: {
    input: z.object({ requestedHostId:z.string().min(1) }).strict(),
    output: z.object({ hostId:z.string(), address:z.string().nullable(), interface:z.string().nullable() }).strict(),
  },
  probeBrowserQaTarget: {
    input: z.object({
      requestedHostId:z.string().min(1), workspacePath:z.string().startsWith("/"), url:z.string().url(),
    }).strict(),
    output:z.object({
      hostId:z.string(), workspaceRealPath:z.string(), url:z.string(), processHostId:z.string(),
    }).strict(),
  },
  classifyPlan: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), plan:z.string().min(1) }).strict(),
    output: z.object({
      hostId:z.string(), status:z.enum(["ok","disabled","timeout","error"]),
      effort:z.string().nullable(), reason:z.string().nullable(), planSha256:z.string(), sentPlanSha256:z.string().nullable(),
      sourceLength:z.number().int().nonnegative(), sentLength:z.number().int().nonnegative().nullable(),
    }).strict(),
  },
  councilJudge: {
    input: z.object({
      requestedHostId: z.string().min(1),
      jevApiKey: z.string().max(4096).optional(),
      state: z.string().min(1).max(60_000),
      questions: z.record(z.string().min(1).max(40), z.object({
        instructions: z.string().min(1).max(2000),
        criteria: z.record(z.string().min(1).max(40), z.string().min(1).max(500)),
      }).strict()).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8, "1 to 8 questions"),
    }).strict(),
    output: z.object({
      hostId: z.string(), status: z.enum(["ok", "disabled", "timeout", "error"]),
      answers: z.record(z.string(), z.string()), confidence: z.record(z.string(), z.number()).optional(),
      // Per question, the probability of each criterion; `confidence` is not the probability of the chosen answer.
      probabilities: z.record(z.string(), z.record(z.string(), z.number())).optional(), reason: z.string().nullable(),
    }).strict(),
  },
  inspectCritiqueCoverage: {
    input:z.object({requestedHostId:z.string().min(1),workspacePath:z.string().startsWith("/"),plan:z.string().max(100_000),
      tasks:z.array(z.object({id:z.string().max(128),lane:z.string().max(64),ownsPaths:z.array(z.string()).max(128),hasVerification:z.boolean(),
        verification:z.array(z.object({command:z.string().max(4096),timeoutSec:z.number().int().nonnegative().max(7200).optional()}).strict()).max(32)}).strict()).max(64)}).strict(),
    output:z.object({hostId:z.string(),status:z.enum(["complete","truncated"]),pathCount:z.number().int().nonnegative(),
      findings:z.array(z.object({code:z.enum(["plan_path_unowned","owns_gap","coverage_scan_truncated","owns_overlap","verify_missing","verify_heavy","owns_empty","plan_missing","no_tasks","caller_unowned","task_placeholder","output_unowned","output_binary","verify_filter_ignored","depends_cycle","depends_self"]),path:z.string(),
        severity:z.enum(["error","warning","info"]),finding:z.string()}).strict()).max(10)}).strict(),
  },
  writePmSettings: {
    input: z.object({
      requestedHostId: z.string().min(1),
      pmWorkspacePath: z.string().startsWith("/"),
    }).strict(),
    output: z.object({
      hostId: z.string(),
      settingsPath: z.string(),
      guardPath: z.string(),
    }).strict(),
  },
  session_inventory: {
    input: z.object({ cwd: z.string().nullable() }).strict(),
    output: z.object({
      mcpServers: z.array(z.object({ name: z.string(), sources: z.array(z.enum(["claude", "codex", "opencode"])) }).strict()),
      nativePlugins: z.array(z.object({ name: z.string(), sources: z.array(z.enum(["claude", "codex", "opencode"])) }).strict()),
    }).strict(),
  },
  discoverClaudeAgents: {
    input: z.object({ cwd: z.string().startsWith("/") }).strict(),
    output: z.object({
      agents: z.array(z.object({ id: z.string(), source: z.string() }).strict()),
      version: z.string(),
      sessionAgents: z.boolean(),
      pluginDir: z.boolean(),
      supported: z.boolean(),
    }).strict(),
  },
  /** A minimal OpenCode config home for a helper thread (see src/opencode-min-config.ts); a null result means: run with the machine's own config. */
  prepareOpencodeMinimal: {
    input: z.object({ requestedHostId: z.string().min(1), model: z.string().max(300).nullable() }).strict(),
    output: z.object({
      result: z.object({ configHome: z.string(), kept: z.array(z.string()), left: z.array(z.string()) }).strict().nullable(),
    }).strict(),
  },
  /** The directory of guard wrappers (bb, ssh, scp, sftp) for Codex, OpenCode and Cursor helpers (see src/bb-shim.ts) and the PATH that puts it first. */
  prepareBbShim: {
    input: z.object({ requestedHostId: z.string().min(1) }).strict(),
    output: z.object({ dir: z.string(), path: z.string() }).strict(),
  },
  prepareNativeClaude: {
    input: z.object({
      cwd: z.string().startsWith("/").optional(),
      agentId: z.string().min(1).max(200),
      agentsJson: z.string().max(200_000).nullable(),
    }).strict(),
    output: z.object({
      env: z.array(z.object({ name: z.string(), value: z.string(), reason: z.string() }).strict()),
      agentId: z.string(),
      claudePath: z.string(),
      sessionAgents: z.boolean(),
    }).strict(),
  },
});

const acceptanceTotalsSchema = z.object({
  dispatched:z.number(), firstTryAccepted:z.number(), eventuallyAccepted:z.number(),
  attempts:z.number(), attemptsPerAccepted:z.number().nullable(),
  redispatched:z.number(), families:z.number(), causes:z.record(z.string(), z.number()),
});
const acceptanceWeekSchema = acceptanceTotalsSchema.extend({ week:z.string() });

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

const runViewSchema = z.object({
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

export const rpcContract = defineRpcContract({
  ...scheduleRpcContract,
  get_preferences: {
    input: z.object({ suggestedLocale: z.enum(["en", "ru"]) }).strict(),
    output: z.object({ locale: z.enum(["en", "ru"]), preference: z.enum(["auto", "en", "ru"]), lastProjectId: z.string().nullable() }).strict(),
  },
  set_locale: {
    input: z.object({ locale: z.enum(["auto", "en", "ru"]), suggestedLocale: z.enum(["en", "ru"]) }).strict(),
    output: z.object({ locale: z.enum(["en", "ru"]), preference: z.enum(["auto", "en", "ru"]) }).strict(),
  },
  remember_project: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  list_sections: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      sections: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), name: z.string(), path: z.string(), kind: z.enum(["folder", "group"]) }).strict()),
    }).strict(),
  },
  list_projects: {
    input: z.object({}).strict(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(["personal", "standard"]).optional() }).strict()),
      lastProjectId: z.string().nullable(),
    }).strict(),
  },
  get_globals: {
    input: z.object({}).strict(),
    output: z.object({
      defaults: z.object({
        writerProviderId: z.string().optional(),
        writerModel: z.string().optional(),
        writerReasoningEffort: z.string().optional(),
        helperPlacement: z.enum(["plugin", "project_tree"]).optional(),
        qaHostId: z.string().optional(),
      }).strict(),
      revision: z.number().int().nonnegative(),
      agents: z.array(z.object({
        id: z.string(),
        description: z.string(),
        prompt: z.string(),
        sourceHash: z.string(),
        sourceVersion: z.string(),
        edited: z.boolean(),
        tools: z.array(z.string()).optional(),
        disallowedTools: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
        mcpServers: z.array(z.string()).optional(),
      }).strict()),
      hosts: z.array(z.object({
        id: z.string(), name: z.string(), status: z.string(), connected: z.boolean(),
      }).strict()).optional(),
      requiredSessionPolicy: z.enum(["required", "none"]).optional(),
    }).strict(),
  },
  get_agent_inventory: {
    input: z.object({
      projectId: z.string().nullable(),
      hostId: z.string().nullable(),
    }).strict(),
    output: z.object({
      skills: inventoryGroupSchema,
      mcpServers: inventoryGroupSchema,
      tools: inventoryGroupSchema,
      disallowedTools: inventoryGroupSchema,
    }).strict(),
  },
  save_globals: {
    input: z.object({
      defaults: z.object({
        writerProviderId: z.string().optional(),
        writerModel: z.string().optional(),
        writerReasoningEffort: z.string().optional(),
        helperPlacement: z.enum(["plugin", "project_tree"]).optional(),
        qaHostId: z.string().optional(),
      }).strict(),
      expectedRevision: z.number().int().nonnegative(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      revision: z.number().int().nonnegative(),
      defaults: z.record(z.string(), z.unknown()),
    }).strict(),
  },
  save_agent_profile: {
    input: z.object({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      prompt: z.string().min(1).max(32_000),
      description: z.string().min(1).max(400).optional(),
      expectedSourceHash: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
      tools: z.array(z.string().min(1)).max(64).optional(),
      disallowedTools: z.array(z.string().min(1)).max(64).optional(),
      skills: z.array(z.string().min(1)).max(64).optional(),
      mcpServers: z.array(z.string().min(1)).max(64).optional(),
      resourceModes: z.object({
        tools: z.enum(["inherit", "none", "selected"]).optional(),
        disallowedTools: z.enum(["inherit", "none", "selected"]).optional(),
        skills: z.enum(["inherit", "none", "selected"]).optional(),
        mcpServers: z.enum(["inherit", "none", "selected"]).optional(),
      }).strict().optional(),
    }).strict(),
    output: z.object({ ok: z.boolean(), id: z.string(), sourceHash: z.string() }).strict(),
  },
  finish_run: {
    input: z.object({ projectId: z.string().min(1), runId: z.string().min(1) }).strict(),
    output: z.object({ projectId: z.string(), finishedRunIds: z.array(z.string()), closed: z.boolean() }).strict(),
  },
  activate_pm: {
    input: z.object({
      projectId: z.string().min(1),
      sourceThreadId: z.string().nullable(),
      agentId: z.string().nullable().optional(),
      snapshot: z.object({
        status: z.literal("ready"),
        scope: z.object({ kind: z.literal("new-thread"), projectId: z.string().nullable() }).strict(),
        projectId: z.string().min(1),
        providerId: z.string().min(1),
        model: z.string().min(1),
        reasoningLevel: z.string().min(1),
        serviceTier: z.string().optional(),
        environment: z.union([
          z.object({
            kind: z.literal("existing"),
            type: z.literal("reuse"),
            environmentId: z.string().min(1),
            hostId: z.string().min(1).optional(),
            path: z.string().min(1).optional(),
          }).strict(),
          z.object({
            kind: z.literal("existing"),
            type: z.literal("host"),
            workspaceType: z.enum(["personal", "unmanaged", "managed-worktree"]),
            hostId: z.string().min(1).optional(),
            path: z.string().min(1).optional(),
          }).strict(),
          z.object({ kind: z.literal("existing"), type: z.literal("project-default") }).strict(),
          z.object({
            kind: z.literal("provisioning"),
            type: z.literal("provider"),
            environmentProviderId: z.string().min(1),
            machine: z.union([
              z.object({ type: z.literal("existing"), hostId: z.string().min(1) }).strict(),
              z.object({ type: z.literal("new"), machineProviderId: z.string().min(1) }).strict(),
            ]).optional(),
          }).strict(),
        ]),
        environmentRequest: z.union([
          z.object({ type: z.literal("reuse"), environmentId: z.string().min(1) }).strict(),
          z.object({
            type: z.literal("host"),
            hostId: z.string().min(1).optional(),
            workspace: z.union([
              z.object({ type: z.literal("personal") }).passthrough(),
              z.object({ type: z.literal("unmanaged"), path: z.string().nullable().optional() }).passthrough(),
              z.object({ type: z.literal("managed-worktree") }).passthrough(),
            ]),
          }).passthrough(),
          z.object({ type: z.literal("project-default") }).strict(),
          z.object({
            type: z.literal("provider"),
            environmentProviderId: z.string().min(1),
            machine: z.union([
              z.object({ type: z.literal("existing"), hostId: z.string().min(1) }).passthrough(),
              z.object({ type: z.literal("new"), machineProviderId: z.string().min(1) }).passthrough(),
            ]).optional(),
            inputs: z.unknown().optional(),
          }).passthrough(),
        ]),
        environmentProvenance: z.object({
          projectId: z.string().min(1),
          sectionId: z.null(),
          projectSourceId: z.string().min(1).optional(),
          hostId: z.string().min(1).optional(),
          path: z.string().min(1).optional(),
        }).strict(),
      }).strict().optional(),
    }).strict(),
    /** bookkeepingExcluded: the lines activation just added to the project's .git/info/exclude; absent when none were missing. */
    output: z.object({ threadId: z.string().min(1), runId: z.string().min(1), bookkeepingExcluded: z.array(z.string()).optional() }).strict(),
  },
  activation_context: {
    input: z.object({
      projectId: z.string().nullable(),
      threadId: z.string().nullable(),
    }).strict(),
    output: z.object({
      projectId: z.string().nullable(),
      projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
      bindingStatus: z.enum(["resolved", "ambiguous", "setup_required", "offline", "catalog_unavailable"]).nullable(),
      compiledMainAgent: z.enum(["supported", "none"]),
      mainAgents: z.array(z.object({ id: z.string(), description: z.string() }).strict()),
      writer: z.object({
        providerId: z.string().nullable(),
        model: z.string().nullable(),
        reasoningEffort: z.string().nullable(),
      }).strict(),
      liveRun: z.object({ threadId: z.string(), runId: z.string() }).strict().nullable(),
      pluginRole: z.string().nullable(),
      threadStatus: z.string().nullable(),
      /** The project's main agent, when one is chosen and still listed; new chats enable Lane Pilot with it. */
      mainAgent: z.string().nullable().optional(),
      requiredSessionPolicy: z.enum(["required", "none"]),
    }).strict(),
  },
  native_install_start: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ started: z.boolean() }).strict(),
  },
  native_install_status: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ status: z.string(), error: z.string().nullable() }).strict(),
  },
  prepare_native_session: {
    input: z.object({
      projectId: z.string().min(1),
      agentId: z.string().min(1).max(200),
    }).strict(),
    output: z.object({
      token: z.string().uuid(),
      label: z.string().min(1),
      agentId: z.string().min(1),
      profileMode: z.enum(["installed", "session-override"]),
      cliAgentsCollision: z.enum(["pending", "thread", "mention"]).nullable(),
    }).strict(),
  },
  list_helper_threads: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threads: z.array(z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        role: z.string(),
        detail: z.string().nullable(),
        phase: z.string().nullable().optional(),
      }).strict()),
      queued: z.array(z.string()).default([]),
    }).strict(),
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
      }).strict()),
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
      mainAgents: z.array(z.object({ id: z.string(), description: z.string() }).strict()).optional(),
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
  save_setting: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      key: z.string().min(1),
      value: z.unknown(),
      expectedVersion: z.number().int().min(0),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      version: z.number().int(),
      value: z.unknown(),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  reset_project_settings: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      keys: z.array(z.string().min(1)).min(1).max(64).refine((keys) => new Set(keys).size === keys.length),
      expectedVersions: z.record(z.string(), z.number().int().nonnegative()),
    }).strict(),
    output: z.object({
      ok: z.boolean(), conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()), versions: z.record(z.string(), z.number()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  save_settings: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      changes: z.array(z.object({
        key: z.string().min(1),
        value: z.unknown(),
        expectedVersion: z.number().int().min(0),
      }).strict()).min(1).superRefine((changes, context) => {
        const seen = new Set<string>();
        for (const change of changes) {
          if (seen.has(change.key)) {
            context.addIssue({ code: "custom", message: `duplicate setting key: ${change.key}` });
          }
          seen.add(change.key);
        }
      }),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  save_writer_binding: {
    input: z.object({
      projectId: z.string().min(1),
      hostId: z.string().min(1),
      path: z.string().min(1),
    }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  save_writer_selection: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      threadId: z.string().min(1).nullable().optional(),
      selectedBinding: z.object({ hostId: z.string().min(1), path: z.string().min(1) }).strict().optional(),
      providerId: z.string().min(1),
      model: z.string().min(1),
      reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
      serviceTier: z.enum(["default", "fast"]).nullable(),
      expectedVersions: z.object({
        "writer.provider": z.number().int().min(0),
        "writer.model": z.number().int().min(0),
        "writer.reasoning_effort": z.number().int().min(0),
        "writer.service_tier": z.number().int().min(0),
      }).strict(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  save_memory_selection: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      providerId: z.string().min(1),
      model: z.string().min(1),
      reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
      serviceTier: z.enum(["default", "fast"]).nullable(),
      expectedVersions: z.object({
        "memory.provider": z.number().int().min(0),
        "memory.model": z.number().int().min(0),
        "memory.reasoning_effort": z.number().int().min(0),
        "memory.service_tier": z.number().int().min(0),
      }).strict(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  save_night_review_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"night_review.provider":z.number().int().min(0),"night_review.model":z.number().int().min(0),"night_review.reasoning_effort":z.number().int().min(0),"night_review.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_docs_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"docs.provider":z.number().int().min(0),"docs.model":z.number().int().min(0),"docs.reasoning_effort":z.number().int().min(0),"docs.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_project_life_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"project_life.provider":z.number().int().min(0),"project_life.model":z.number().int().min(0),"project_life.reasoning_effort":z.number().int().min(0),"project_life.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_pm_read_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"pm_read.provider":z.number().int().min(0),"pm_read.model":z.number().int().min(0),"pm_read.reasoning_effort":z.number().int().min(0),"pm_read.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_onboarding_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"onboarding.provider":z.number().int().min(0),"onboarding.model":z.number().int().min(0),"onboarding.reasoning_effort":z.number().int().min(0),"onboarding.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_plan_critique_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"plan_critique.provider":z.number().int().min(0),"plan_critique.model":z.number().int().min(0),"plan_critique.reasoning_effort":z.number().int().min(0),"plan_critique.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_specialist_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"specialist.provider":z.number().int().min(0),"specialist.model":z.number().int().min(0),"specialist.reasoning_effort":z.number().int().min(0),"specialist.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  // A writer fallback model (slot 1 or 2); off: true stores an empty slot, so the default does not come back.
  save_writer_fallback_selection: {
    input:z.object({
      projectId:z.string().min(1),slot:z.union([z.literal(1),z.literal(2)]),sectionId:z.string().min(1).optional(),
      off:z.boolean().optional(),providerId:z.string().min(1).optional(),model:z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]).optional(),
      expectedVersions:z.record(z.string(),z.number().int().min(0)),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_council_seat_selection: {
    input:z.object({
      projectId:z.string().min(1),seat:z.enum(["product","demand","audience","skeptic","growth","ux","chair"]),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      expectedVersions:z.record(z.string(),z.number().int().min(0)),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_code_critique_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"code_critique.provider":z.number().int().min(0),"code_critique.model":z.number().int().min(0),"code_critique.reasoning_effort":z.number().int().min(0),"code_critique.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
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
  list_councils: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ councils: z.array(z.object({ id: z.string(), runId: z.string(), question: z.string(), state: z.string(), round: z.number().int(), maxRounds: z.number().int(), decisionPath: z.string().nullable(), updatedAt: z.number().int() })) }).strict(),
  },
  get_council_defaults: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ seats: z.array(z.object({ id: z.string(), title: z.string(), providerId: z.string().nullable(), model: z.string().nullable(), configured: z.boolean() })) }).strict(),
  },
  council_say: {
    input: z.object({ councilId: z.string().min(1), text: z.string().trim().min(1).max(4000).optional(), decide: z.boolean().optional() }).strict(),
    output: z.object({ seq: z.number().int().nullable(), decideRequested: z.boolean() }).strict(),
  },
  council_stop: {
    input: z.object({ councilId: z.string().min(1) }).strict(),
    output: z.object({ stopRequested: z.boolean() }).strict(),
  },
  get_council: {
    input: z.object({ councilId: z.string().min(1) }).strict(),
    output: z.object({
      id: z.string(), question: z.string(), state: z.string(), round: z.number().int(), maxRounds: z.number().int(), agenda: z.array(z.string()), criteria: z.array(z.string()),
      decisionPath: z.string().nullable(), reason: z.string().nullable(), recommendation: z.string().nullable(),
      speaking: z.string().nullable(), speakingSince: z.number().int().nullable(),
      seats: z.array(z.object({ id: z.string(), title: z.string(), providerId: z.string().nullable(), model: z.string().nullable() })),
      messages: z.array(z.object({ seq: z.number().int(), seatId: z.string(), round: z.number().int(), kind: z.string(), text: z.string(), at: z.number().int() })),
    }).strict(),
  },
  get_routing_hint: {
    input: z.object({ projectId: z.string().min(1), days: z.number().int().min(1).max(365).optional() }).strict(),
    output: z.object({
      current: z.object({ providerId: z.string(), model: z.string() }).nullable(),
      hints: z.array(z.object({ risk: z.string(), hint: z.string() })),
      stats: z.array(z.object({ providerId: z.string(), model: z.string(), risk: z.string(), tasks: z.number().int(), acceptedFirstTry: z.number().int(), accepted: z.number().int(), failed: z.number().int() })),
    }).strict(),
  },
  list_rule_proposals: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      proposals: z.array(ruleProposalSchema),
      memory: z.object({ enabled: z.boolean(), inject: z.boolean() }).strict(),
      triage: z.object({ total: z.number().int(), byOrigin: z.record(z.string(), z.number().int()), errors: z.number().int(), lastTriagedAt: z.number().nullable(), pendingGroups: z.number().int() }).strict(),
      scan: ruleScanSchema,
      analyzer: rulesAnalyzerSchema.nullable(),
      events: z.array(z.object({ ruleId: z.string(), action: z.string(), detail: z.string().nullable(), at: z.number().int() }).strict()),
    }).strict(),
  },
  ...anamnesisRpcMethods,
  session_memory_project: {
    input: z.object({ hostId: z.string().min(1), path: z.string().startsWith("/") }).strict(),
    output: z.object({ projectId: z.string().nullable(), scopes: z.array(z.string()) }).strict(),
  },
  session_memory_write: {
    input: z.object({ projectId: z.string().min(1), kind: z.enum(["core", "note"]), content: z.string().min(1).max(8000),
      concepts: z.array(z.string().min(1).max(100)).max(24), source: z.string().max(300).optional() }).strict(),
    output: z.object({ stored: z.boolean(), id: z.string().nullable(), reason: z.string().nullable() }).strict(),
  },
  session_memory_search: {
    input: z.object({ projectId: z.string().min(1), query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(50).optional() }).strict(),
    output: z.object({ records: z.array(z.object({ id: z.string(), kind: z.enum(["core", "note"]), content: z.string(), concepts: z.array(z.string()) }).strict()) }).strict(),
  },
  session_memory_core: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ records: z.array(z.object({ id: z.string(), content: z.string() }).strict()) }).strict(),
  },
  session_lesson: {
    // audience defaults to both for older lane-memory clients that do not send it.
    input: z.object({ projectId: z.string().min(1), rule: z.string().min(8).max(600), evidence: z.string().max(1000).optional(), scope: z.array(z.string()).max(8).optional(),
      audience: z.enum(["writer", "pm", "both"]).optional(), always: z.boolean().optional() }).strict(),
    output: z.object({ proposalId: z.string(), repeatOf: z.string().nullable(), state: z.string(), adopted: z.boolean() }).strict(),
  },
  rule_set_audience: {
    input: z.object({ projectId: z.string().min(1), ruleId: z.string().min(1), audience: z.enum(["writer", "pm", "both"]), always: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  memory_records_list: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ records: z.array(z.object({
      id: z.string(), kind: z.enum(["core", "note"]), audience: z.string(), content: z.string(), concepts: z.array(z.string()),
      createdAt: z.number().int(), rule: z.boolean(),
      /** Times the note went into a brief, and how many of those attempts were accepted. */
      useCount: z.number().int(), acceptedCount: z.number().int(),
    }).strict()) }).strict(),
  },
  memory_record_delete: {
    input: z.object({ projectId: z.string().min(1), id: z.string().min(1) }).strict(),
    output: z.object({ deleted: z.boolean(), reason: z.string().nullable() }).strict(),
  },
  docs_overview: {
    input: z.object({ projectId: z.string().min(1), recheck: z.boolean().optional() }).strict(),
    output: z.object({
      places: z.array(z.object({
        hostId: z.string(), path: z.string(), name: z.string(), scopes: z.array(z.string()),
        mode: z.enum(["auto", "on", "off"]),
        verdict: z.object({ need: z.boolean(), reason: z.string(), confidence: z.number().nullable(), at: z.number().int(),
          facts: z.object({ codeFiles: z.number().int(), contentFiles: z.number().int(), commits30d: z.number().int(), manifests: z.array(z.string()), docsPages: z.number().int() }).strict() }).strict().nullable(),
        cadence: z.enum(["nightly", "weekly", "paused"]),
        lastReadAt: z.number().int().nullable(),
      }).strict()),
    }).strict(),
  },
  start_rule_scan: {
    input: z.object({ projectId: z.string().min(1), locale: z.enum(["ru", "en"]) }).strict(),
    output: z.object({ started: z.boolean(), scan: ruleScanSchema }).strict(),
  },
  save_rules_analyzer: {
    input: z.object({ projectId: z.string().min(1), analyzer: rulesAnalyzerSchema }).strict(),
    output: z.object({ analyzer: rulesAnalyzerSchema }).strict(),
  },
  decide_rule_proposal: {
    input: z.object({
      projectId: z.string().min(1),
      id: z.string().min(1),
      action: z.enum(["accept", "reject", "revoke"]),
      rule: z.string().min(8).max(600).optional(),
    }).strict(),
    output: z.object({ proposal: ruleProposalSchema }).strict(),
  },
  token_usage: {
    input: z.object({
      range: z.enum(["7d", "14d", "30d", "month"]),
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      projectId: z.string().min(1).optional(),
    }).strict(),
    output: z.object({
      byModel: z.array(z.object({
        providerId: z.string(), model: z.string(), input: z.number(), output: z.number(), cached: z.number(), total: z.number(),
        costUsd: z.number().nullable(),
      }).strict()),
      series: z.array(z.object({
        day: z.string(),
        models: z.array(z.object({ providerId: z.string(), model: z.string(), total: z.number() }).strict()),
      }).strict()),
      months: z.array(z.string()),
      lastSyncAt: z.number().int().nullable(),
      noDataProviders: z.array(z.string()),
      diagnostics: z.object({
        threadsSeen: z.number().int(),
        threadsWithUsage: z.number().int(),
        threadsFailed: z.number().int(),
        lastError: z.string().nullable(),
      }).strict(),
      byProject: z.array(z.object({
        projectId: z.string(), projectName: z.string(), total: z.number(), share: z.number(), topModel: z.string(), costUsd: z.number().nullable(),
      }).strict()),
      costUsd: z.number().nullable(),
    }).strict(),
  },
  token_usage_sync: {
    input: z.object({}).strict(),
    output: z.object({ started: z.boolean() }).strict(),
  },
  // The journal of Env Catalog names handed to checks, browser checks and errands (never a value), newest first.
  secret_issuance: {
    input: z.object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(500).optional() }).strict(),
    output: z.object({
      entries: z.array(z.object({
        id: z.number().int(), at: z.number(), runId: z.string().nullable(), taskId: z.string().nullable(), consumer: z.string(), threadId: z.string().nullable(),
        checkCommand: z.string().nullable(), secretName: z.string(), hostId: z.string().nullable(), network: z.string().nullable(),
      }).strict()),
    }).strict(),
  },
  // Lane Pilot's worktree provider is switched off on a machine after 3 errors in a row; it is probed again after an hour, or lifted here.
  workspace_provider_status: {
    input: z.object({}).strict(),
    output: z.object({ hosts: z.array(z.object({ hostId: z.string(), failures: z.number().int(), disabled: z.boolean(), disabledAt: z.number().nullable(), probeAt: z.number().nullable(), lastReason: z.string().nullable() }).strict()) }).strict(),
  },
  workspace_provider_reset: {
    input: z.object({ hostId: z.string().min(1).optional() }).strict(),
    output: z.object({ cleared: z.array(z.string()) }).strict(),
  },
  workflow_list: {
    input: z.object({ projectId: z.string().min(1).optional() }).strict(),
    output: z.object({
      workflows: z.array(workflowSummarySchema),
      /** Files that did not load: where, and why. */
      problems: z.array(z.object({ origin: z.enum(["builtin", "global", "project"]), source: z.string(), messages: z.array(z.string()) }).strict()),
      /** `unavailable`: the project's machine could not be read, so only built-in and global workflows are listed. */
      project: z.enum(["not_requested", "ok", "no_machine", "unavailable"]),
    }).strict(),
  },
  workflow_get: {
    input: z.object({ id: z.string().min(1), projectId: z.string().min(1).optional() }).strict(),
    output: z.object({ workflow: workflowDetailSchema.nullable() }).strict(),
  },
  workflow_run_snapshot: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({ snapshot: workflowRunSnapshotSchema.nullable() }).strict(),
  },
  /** The run history of one workflow, newest first, a page at a time (`before` is the `createdAt` of the last row of the page before). */
  workflow_runs: {
    input: z.object({ id: z.string().min(1), projectId: z.string().min(1).optional(), limit: z.number().int().min(1).max(50).default(20), before: z.number().int().optional() }).strict(),
    output: z.object({ runs: z.array(workflowRunRowSchema.extend({ stepsUsed: z.number().int() }).strict()), hasMore: z.boolean() }).strict(),
  },
  /** Re-runs one node of a finished run: its steps and everything after it start again. `reason` says why not (run_active, child_run, node_not_run, ...). */
  workflow_rerun_node: {
    input: z.object({ runId: z.string().min(1), nodeId: z.string().min(1).max(80) }).strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().optional(), stepKey: z.string().optional(), removed: z.number().int().optional() }).strict(),
  },
  /**
   * Starts a workflow now, from the tab (`manual`) or from another plugin (`telegram`: the workflow must list a telegram trigger). The project's PM chat runs it.
   * `liveTrial` is the owner's word for the first real run of a `tested` workflow. `reason` says why not (unknown_workflow, not_runnable, missing_inputs,
   * no_pm_chat, requirements_missing, no_trigger, cannot_start).
   */
  workflow_run: {
    input: z.object({ id: z.string().min(1), projectId: z.string().min(1), inputs: z.record(z.string(), z.unknown()).default({}), source: z.enum(["manual", "telegram"]).default("manual"), liveTrial: z.boolean().optional() }).strict(),
    output: z.object({ ok: z.boolean(), runId: z.string().optional(), created: z.boolean().optional(), status: z.string().optional(), notChecked: z.array(z.string()).optional(),
      reason: z.string().optional(), message: z.string().optional(), missing: z.array(z.string()).optional(),
      issues: z.array(z.object({ kind: z.string(), name: z.string(), level: z.enum(["missing", "unverified"]), message: z.string() }).strict()).optional(),
      envRequests: z.array(z.object({ name: z.string(), kind: z.literal("secret"), purpose: z.string() }).strict()).optional() }).strict(),
  },
  /** Whether what the workflow `requires` exists where it would run (skills, plugins, MCP servers, secrets by name, commands, logins). */
  workflow_preflight: {
    input: z.object({ id: z.string().min(1), projectId: z.string().min(1).optional() }).strict(),
    output: z.object({ found: z.boolean(), ok: z.boolean(),
      issues: z.array(z.object({ kind: z.string(), name: z.string(), level: z.enum(["missing", "unverified"]), message: z.string() }).strict()),
      envRequests: z.array(z.object({ name: z.string(), kind: z.literal("secret"), purpose: z.string() }).strict()),
      checked: z.array(z.object({ kind: z.string(), name: z.string() }).strict()) }).strict(),
  },
  /** A trial run of a workflow with every external action stubbed (agents, code tasks, sends): nothing leaves the machine. */
  workflow_dry_run: {
    input: z.object({ id: z.string().min(1), projectId: z.string().min(1).optional(), input: z.record(z.string(), z.unknown()).default({}) }).strict(),
    output: z.object({ found: z.boolean(), result: workflowTrialCaseSchema.nullable(), stubbed: z.array(z.string()) }).strict(),
  },
  /** Runs every test case of a workflow on stubs and keeps the receipt: a file of the owner counts as tested or published only with a green one. */
  workflow_run_tests: {
    input: z.object({ id: z.string().min(1), projectId: z.string().min(1).optional() }).strict(),
    output: z.object({ found: z.boolean(), green: z.boolean(), cases: z.array(workflowTrialCaseSchema), status: z.string().nullable() }).strict(),
  },
  // The Workflow architect's drafts: the same value as a workflow file, with the validator's verdict and the last test.
  workflow_draft_list: {
    input: z.object({ projectId: z.string().min(1), threadId: z.string().min(1).optional() }).strict(),
    output: z.object({ drafts: z.array(workflowDraftSummarySchema) }).strict(),
  },
  workflow_draft_get: {
    input: z.object({ draftId: z.string().min(1), history: z.boolean().default(false) }).strict(),
    output: z.object({ draft: workflowDraftSummarySchema.nullable(), definition: z.record(z.string(), z.unknown()).nullable(), check: workflowDraftCheckSchema.nullable(),
      tests: z.unknown().nullable(), history: z.array(z.object({ version: z.number().int(), summary: z.string(), at: z.number() }).strict()).default([]) }).strict(),
  },
  // The editor in the Workflows tab: the same operations the architect's tools run (draftOpSchema is checked on the server).
  workflow_draft_patch: {
    input: z.object({ draftId: z.string().min(1), ops: z.array(z.record(z.string(), z.unknown())).min(1).max(40), expectedVersion: z.number().int().min(1).optional() }).strict(),
    output: workflowDraftPatchResultSchema,
  },
  /** Takes the draft back to the content of an earlier version, as a new version: undo and redo. */
  workflow_draft_restore: {
    input: z.object({ draftId: z.string().min(1), version: z.number().int().min(1), expectedVersion: z.number().int().min(1).optional() }).strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().optional(), currentVersion: z.number().int().optional(), version: z.number().int().optional(), definition: z.record(z.string(), z.unknown()).optional() }).strict(),
  },
  workflow_draft_test: {
    input: z.object({ draftId: z.string().min(1), testCaseId: z.string().min(1).max(120).optional() }).strict(),
    output: workflowDraftTestResultSchema,
  },
  workflow_draft_publish: {
    input: z.object({ draftId: z.string().min(1) }).strict(),
    output: workflowDraftPublishResultSchema,
  },
  /** Starts a draft from a workflow of the library: `edit` the owner's own file (same id, replaced on publish), or `duplicate` a built-in one under a new id. */
  workflow_draft_create: {
    input: z.object({ projectId: z.string().min(1), workflowId: z.string().min(1), mode: z.enum(["edit", "duplicate"]), scope: z.enum(["global", "project"]).optional() }).strict(),
    output: z.object({ draftId: z.string().nullable(), workflowId: z.string().nullable(), reused: z.boolean(), reason: z.string().optional() }).strict(),
  },
  /**
   * «Build with the architect»: a chat thread with the Workflow architect already active (Claude Code, Opus 5.5, high, standard speed).
   * The project is `projectId`, else the draft's, else the Lane Pilot project of the hub; `sectionId` files the chat in that Project Folders section.
   * An architect chat of the same project (and draft) that is still alive is returned instead of a second one (`reused`).
   */
  workflow_architect_start: {
    input: z.object({ projectId: z.string().min(1).optional(), sectionId: z.string().min(1).optional(), draftId: z.string().min(1).optional() }).strict(),
    output: z.object({ threadId: z.string(), projectId: z.string(), reused: z.boolean() }).strict(),
  },
  /** Who works on every step of a workflow or draft: agent, provider, model, effort and where each value comes from (node, Settings, role default, writer chain). */
  workflow_step_executors: {
    input: z.object({ workflowId: z.string().min(1).optional(), draftId: z.string().min(1).optional(), projectId: z.string().min(1).optional() }).strict(),
    output: z.object({ found: z.boolean(), executors: z.array(stepExecutorSchema), pm: z.object({ providerId: z.string(), model: z.string() }).strict().nullable() }).strict(),
  },
  /**
   * Sets (`choice`) or drops (`null`) the owner's model override of one step, for all projects (`scope: "global"`) or for `projectId` only.
   * Built-in workflows stay untouched: the override is a settings row `workflow.model_override.<workflowId>/<nodeId>`.
   */
  workflow_model_override: {
    input: z.object({
      projectId: z.string().min(1), scope: z.enum(["project", "global"]), workflowId: z.string().min(1), nodeId: z.string().min(1),
      choice: z.object({ providerId: z.string().min(1), model: z.string().min(1), effort: z.string().nullable().optional(), serviceTier: z.string().nullable().optional() }).strict().nullable(),
    }).strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().optional() }).strict(),
  },
  /** Every provider and model the hub's machines offer, with the machines each is available on; the pickers of the Workflows tab list this. */
  workflow_model_catalog: {
    input: z.object({ refresh: z.boolean().optional(), projectId: z.string().min(1).optional() }).strict(),
    output: modelCatalogSchema,
  },
  /** What a node may use: skills, plugins, MCP servers, Env Catalog names (never values), machines, specialist roles. */
  workflow_capabilities: {
    input: z.object({ projectId: z.string().min(1), draftId: z.string().min(1).optional() }).strict(),
    output: z.object({ capabilities: z.record(z.string(), z.unknown()) }).strict(),
  },
});
