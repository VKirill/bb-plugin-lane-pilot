import { z } from "zod";
import { modelCatalogSchema, stepExecutorSchema, workflowDetailSchema, workflowDraftCheckSchema, workflowDraftPatchResultSchema, workflowDraftPublishResultSchema, workflowDraftSummarySchema, workflowDraftTestResultSchema, workflowRunRowSchema, workflowRunSnapshotSchema, workflowSummarySchema, workflowTrialCaseSchema } from "./schemas";

/** Workflows: library, runs, drafts, the editor and the architect. */
export const rpcWorkflow = {
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
};
