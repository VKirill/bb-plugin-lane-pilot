import { z } from "zod";
import { runViewSchema, stageSummarySchema } from "@lane-pilot/contracts";

/** Run cards, stages, helper access and the screen snapshot. */
export const rpcRuns = {
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
};
