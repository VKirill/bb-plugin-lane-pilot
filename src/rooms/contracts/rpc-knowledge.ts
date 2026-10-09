import { z } from "zod";
import { anamnesisRpcMethods } from "../anamnesis";
import { ruleProposalSchema, ruleScanSchema, rulesAnalyzerSchema } from "@lane-pilot/contracts";

/** Councils, rules, memory, docs, token usage, secrets and the workspace provider. */
export const rpcKnowledge = {
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
  // Backs up the daily and cursor tables (`*_bak_<YYYYMMDD>`), resets the cursors and re-syncs every thread with the current delta rule.
  // Refused (`started: false`, nothing touched) while a sync runs. `token_usage.lastSyncAt` past `startedAt` means it finished.
  token_usage_rebuild: {
    input: z.object({}).strict(),
    output: z.union([
      z.object({
        started: z.literal(true), startedAt: z.number(), backups: z.array(z.string()), backupsKept: z.array(z.string()),
        cursorsCleared: z.number().int(), dailyRowsCleared: z.number().int(),
      }).strict(),
      z.object({ started: z.literal(false) }).strict(),
    ]),
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
};
