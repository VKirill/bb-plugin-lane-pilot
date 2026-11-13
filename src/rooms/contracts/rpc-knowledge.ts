import { z } from "zod";
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
  // M1 one-door import: the client reads its JSONL export (`bb plugin rpc call lane-pilot memory_import --input-file x.json`), the hub
  // writes it through the agent write path and answers with the receipt; the plugin server reads and writes no file itself.
  memory_import: {
    input: z.object({ source: z.enum(["bb-memory", "claude-files"]), projectId: z.string().min(1).max(200),
      jsonl: z.string().max(8_000_000), dryRun: z.boolean().optional() }).strict(),
    output: z.unknown(),
  },
  memory_import_eval: { input: z.object({ report: z.object({ projectId: z.string().min(1), outcomes: z.array(z.unknown()) }).passthrough() }).strict(), output: z.unknown() },
  session_memory_project: {
    input: z.object({ hostId: z.string().min(1), path: z.string().startsWith("/") }).strict(),
    output: z.object({ projectId: z.string().nullable(), scopes: z.array(z.string()) }).strict(),
  },
  session_memory_write: {
    input: z.object({ projectId: z.string().min(1), kind: z.enum(["core", "note"]), content: z.string().min(1).max(8000),
      concepts: z.array(z.string().min(1).max(100)).max(24), source: z.string().max(300).optional(),
      chain: z.array(z.string()).max(16).optional() }).strict(),
    output: z.object({ stored: z.boolean(), id: z.string().nullable(), reason: z.string().nullable() }).strict(),
  },
  session_memory_search: {
    input: z.object({ projectId: z.string().min(1), query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(50).optional(),
      chain: z.array(z.string()).max(16).optional() }).strict(),
    // `nothingRelevant` and `message` are only there when nothing cleared the relevance floor; `weakMatch` and `message` when the answer gate
    // doubts the search (the records still come). A client that reads `records` alone is unchanged.
    output: z.object({ records: z.array(z.object({ id: z.string(), kind: z.enum(["core", "note"]), content: z.string(), concepts: z.array(z.string()) }).strict()),
      nothingRelevant: z.boolean().optional(), weakMatch: z.boolean().optional(), message: z.string().optional() }).strict(),
  },
  session_memory_core: {
    input: z.object({ projectId: z.string().min(1), chain: z.array(z.string()).max(16).optional() }).strict(),
    output: z.object({
      records: z.array(z.object({ id: z.string(), content: z.string() }).strict()),
      receipts: z.array(z.object({
        id: z.string(), project_id: z.string(), role: z.string(),
        returned_ids: z.array(z.string()), packed_ids: z.array(z.string()),
        tokens: z.number().int(), created_at: z.number().int(),
      }).strict()).optional(),
    }).strict(),
  },
  // The L1 showcase an ordinary BB thread gets from contributeInstructions (M2); null for a PM or plugin thread.
  memory_thread_block: {
    input: z.object({ projectId: z.string().min(1), threadId: z.string().min(1) }).strict(),
    output: z.object({ block: z.string().nullable() }).strict(),
  },
  session_lesson: {
    // audience defaults to both for older lane-memory clients that do not send it.
    input: z.object({ projectId: z.string().min(1), rule: z.string().min(8).max(600), evidence: z.string().max(1000).optional(), scope: z.array(z.string()).max(8).optional(),
      audience: z.union([z.enum(["writer", "pm", "both"]), z.string().regex(/^specialist:[\w-]{1,60}$/)]).optional(), always: z.boolean().optional() }).strict(),
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
      useCount: z.number().int(), acceptedCount: z.number().int(), originTaskId: z.string().nullable(),
      /** The file record this one came from, so a record with no task and no file can be flagged as «no trace». */
      sourceFileId: z.string().nullable(),
      /** Decided on the server by the one «no trace» definition (memoryWithoutTrace): no task, no file, no voucher, not the owner's or an import. */
      noTrace: z.boolean(),
      /** Whose authority this record carries (maintainer/session/probe…) and where it applies: the section chain it was written under. */
      origin: z.string(), scope: z.array(z.string()),
      /** Independent confirmations the record carries (one per accepted write that corroborated it). */
      sources: z.number().int(),
    }).strict()) }).strict(),
  },
  memory_record_delete: {
    input: z.object({ projectId: z.string().min(1), id: z.string().min(1) }).strict(),
    // `deleted` is true once the record is gone; `leftovers` names tables that still hold its bytes after the erase (empty when clean).
    output: z.object({ deleted: z.boolean(), reason: z.string().nullable(), leftovers: z.array(z.string()) }).strict(),
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
  /** Per attempt: stages passed or failed, seconds per stage, writer tokens and list-price cost, with `not_measured` where the provider reports no usage (never 0). */
  lp_attempt_metrics: {
    input: z.object({ projectId: z.string().min(1), days: z.number().int().min(1).max(90).default(7) }).strict(),
    output: z.object({
      projectId: z.string(), days: z.number(), since: z.number(),
      summary: z.object({
        attempts: z.number().int(), measured: z.number().int(), partial: z.number().int(), notMeasured: z.number().int(),
        measuredCostUsd: z.number().nullable(), measuredTokens: z.number().nullable(),
        notMeasuredByProvider: z.record(z.string(), z.number().int()),
        stagesPassed: z.number().int(), stagesFailed: z.number().int(),
        queueWait: z.object({ samples: z.number(), p50Ms: z.number().nullable(), p99Ms: z.number().nullable() }).strict(),
        firstByTier: z.record(z.string(), z.object({ first: z.number().int(), accepted: z.number().int() }).strict()),
        attemptsPerAcceptedTask: z.number().nullable(), heldShare: z.number().nullable(),
      }).strict(),
      attempts: z.array(z.object({
        taskId: z.string(), attemptId: z.string(), attemptNo: z.number().int(), state: z.string(), createdAt: z.number(),
        seconds: z.number().nullable(), queueWaitMs: z.number().nullable().optional(), turns: z.number().int().optional(),
        stages: z.array(z.object({ stageId: z.string(), state: z.string(), seconds: z.number().nullable(), proof: z.string() }).strict()),
        stagesPassed: z.number().int(), stagesFailed: z.number().int(),
        gates: z.object({ passed: z.number().int(), rejected: z.number().int() }).strict(),
        writer: z.object({ threadId: z.string().nullable(), providerId: z.string().nullable(), model: z.string().nullable(), tier: z.enum(["light", "standard", "strong"]).nullable() }).strict(),
        tokens: z.object({ input: z.number(), output: z.number(), cached: z.number(), total: z.number() }).strict().nullable(),
        costUsd: z.number().nullable(),
        costState: z.enum(["measured", "partial", "not_measured"]),
        costNote: z.string().nullable(),
      }).strict()),
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
