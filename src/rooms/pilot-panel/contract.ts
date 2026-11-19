import { z } from "zod";
import { pilotDelegationChoiceSchema } from "./delegation";
import { pilotProcessStateSchema } from "./process-state";

export const PILOT_PROJECT_SKILLS = [
  "lane-pilot",
  "lp-project-setup",
  "lp-plan",
  "lp-implement",
  "lp-verify",
  "lp-writer",
  "lp-docs",
  "lane-memory",
  "project-life",
  "lp-agentic-discipline",
  "karpathy-guidelines",
] as const;

export const pilotReadinessStepSchema = z.object({
  id: z.enum(["install", "context", "architecture", "quality", "ci"]),
  label: z.string(),
  actionId: z.string(),
  state: z.enum(["done", "todo", "skipped"]),
  skippable: z.boolean(),
  anyOf: z.boolean(),
  missing: z.array(z.string()),
}).strict();

export const pilotPlanTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(["todo", "in_progress", "done", "failed"]),
}).strict();

export const pilotPlanTargetSchema = z.object({
  path: z.string(),
  title: z.string(),
  tasks: z.array(pilotPlanTaskSchema),
}).strict();

export const pilotSkillItemSchema = z.object({
  name: z.string(),
  state: z.enum(["synced", "outdated", "missing"]),
}).strict();

export const pilotRunTaskRowSchema = z.object({
  key: z.string(),
  runId: z.string(),
  taskId: z.string().nullable(),
  title: z.string(),
  column: z.enum(["queued", "running", "checking", "blocked", "done"]),
  phase: z.string(),
  stage: z.string().nullable(),
  model: z.string().nullable(),
  threadId: z.string().nullable(),
  detail: z.string().nullable(),
  kind: z.enum(["task", "workflow", "phase", "batch"]).optional(),
}).strict();

export const pilotChildThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  role: z.string().nullable(),
  providerId: z.string().nullable(),
  cleanSession: z.boolean(),
}).strict();

export const pilotPanelActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  reason: z.string(),
  group: z.enum(["next", "setup", "maintenance"]),
  available: z.boolean(),
}).strict();

export const pilotDelegationViewSchema = z.object({
  choice: pilotDelegationChoiceSchema,
  configured: z.boolean(),
  error: z.string().nullable(),
  providers: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  children: z.array(pilotChildThreadSchema),
}).strict();

export const pilotWorkflowDraftItemSchema = z.object({
  draftId: z.string(),
  workflowId: z.string(),
  title: z.string(),
  scope: z.enum(["global", "project"]),
  status: z.enum(["draft", "tested", "published"]),
  version: z.number(),
  publishedVersion: z.number().nullable(),
  testedGreen: z.boolean(),
  canPublish: z.boolean(),
  canRollback: z.boolean(),
  summary: z.string(),
  ownerItemKey: z.string().nullable(),
  updatedAt: z.number(),
}).strict();

export const pilotWorkflowEvolutionSchema = z.object({
  items: z.array(pilotWorkflowDraftItemSchema),
  autoPublishedCount: z.number(),
  pendingApprovalCount: z.number(),
}).strict();

export const pilotPanelSnapshotSchema = z.object({
  collectedAt: z.string(),
  fingerprint: z.string(),
  pluginVersion: z.string(),
  project: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    hostId: z.string().nullable(),
    rootPath: z.string().nullable(),
    environmentId: z.string().nullable(),
    gitBranch: z.string().nullable(),
    gitDirty: z.boolean().nullable(),
  }).strict(),
  session: z.object({
    threadId: z.string(),
    providerId: z.string().nullable().optional(),
    threadState: z.string(),
    pendingQuestions: z.number().nullable(),
    role: z.string().nullable(),
    cleanSubthreadsActive: z.boolean(),
    serviceTierPolicy: z.literal("standard"),
    activeRun: z.object({
      runId: z.string(),
      pmThreadId: z.string().nullable(),
      state: z.string(),
      conveyorOn: z.boolean(),
    }).strict().nullable(),
    runItems: z.array(pilotRunTaskRowSchema),
  }).strict(),
  readiness: z.array(pilotReadinessStepSchema),
  projectSkills: z.object({
    rootRelPath: z.string(),
    total: z.number(),
    synced: z.number(),
    items: z.array(pilotSkillItemSchema),
  }).strict(),
  plans: z.object({
    candidates: z.array(z.object({ path: z.string(), title: z.string(), done: z.number(), total: z.number() }).strict()),
    selected: pilotPlanTargetSchema.nullable(),
  }).strict(),
  delegation: pilotDelegationViewSchema,
  actions: z.array(pilotPanelActionSchema),
  processState: pilotProcessStateSchema.nullable().optional(),
  workflowEvolution: pilotWorkflowEvolutionSchema.optional(),
  diagnostics: z.array(z.string()),
}).strict();

export type PilotPanelSnapshot = z.infer<typeof pilotPanelSnapshotSchema>;
export type PilotPanelAction = z.infer<typeof pilotPanelActionSchema>;
export type PilotDelegationView = z.infer<typeof pilotDelegationViewSchema>;
export type PilotChildThread = z.infer<typeof pilotChildThreadSchema>;
export type PilotWorkflowDraftItem = z.infer<typeof pilotWorkflowDraftItemSchema>;
export type PilotWorkflowEvolution = z.infer<typeof pilotWorkflowEvolutionSchema>;

export const pilotPanelRpcMethods = {
  pilot_panel_status: {
    input: z.object({
      threadId: z.string().min(1),
      targetPlan: z.string().max(400).optional(),
      force: z.boolean().optional(),
    }).strict(),
    output: pilotPanelSnapshotSchema,
  },
  pilot_panel_prepare_project: {
    input: z.object({
      threadId: z.string().min(1),
    }).strict(),
    output: z.object({
      ok: z.literal(true),
      installedSkills: z.array(z.string()),
      updatedSkills: z.array(z.string()),
      createdFiles: z.array(z.string()),
      snapshot: pilotPanelSnapshotSchema,
    }).strict(),
  },
  pilot_panel_set_delegation: {
    input: z.object({
      threadId: z.string().min(1),
      choice: pilotDelegationChoiceSchema,
    }).strict(),
    output: pilotDelegationViewSchema,
  },
  pilot_panel_set_readiness_skip: {
    input: z.object({
      threadId: z.string().min(1),
      stepId: z.enum(["quality", "ci"]),
      skipped: z.boolean(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  pilot_panel_run_action: {
    input: z.object({
      threadId: z.string().min(1),
      actionId: z.string().min(1).max(100),
      targetPlan: z.string().max(400).optional(),
      fingerprint: z.string().min(1).max(200),
      requestId: z.string().min(1).max(120),
    }).strict(),
    output: z.object({
      sent: z.boolean(),
      queued: z.boolean().optional(),
      stale: z.boolean().optional(),
      threadId: z.string().optional(),
      runId: z.string().optional(),
      message: z.string(),
    }).strict(),
  },
  pilot_panel_publish_workflow_draft: {
    input: z.object({
      threadId: z.string().optional(),
      draftId: z.string().min(1),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      snapshot: pilotPanelSnapshotSchema.optional(),
    }).strict(),
  },
  pilot_panel_rollback_workflow_draft: {
    input: z.object({
      threadId: z.string().optional(),
      draftId: z.string().min(1),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      snapshot: pilotPanelSnapshotSchema.optional(),
    }).strict(),
  },
};
