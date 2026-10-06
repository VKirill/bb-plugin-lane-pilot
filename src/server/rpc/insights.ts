import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { getRuleProposal, listRuleEvents, listRuleProposals, ruleTrialStats, routingHint, setRuleAudience, writerAcceptanceStats, type RuleProposal } from "@lane-pilot/run-insights";
import { acceptanceStats } from "../../acceptance-stats";
import { rpcContract } from "../../contracts";
import { loadProjectSettings } from "../../database";
import { parseDocsSettings } from "../../stages/docs";
import { configuredSetting } from "../context";
import { acceptRuleProposal, deleteMemoryRecord, memorySettingsFor, rejectRuleProposal, revokeRule } from "../insights";
import type { ServerCore } from "../core";
import type { Services } from "../services";

const RISKS = ["low", "medium", "high", "critical"] as const;

const ruleView = ({ id, rule, author, state, occurrences, taskCount, examples, evidence, lastSeenAt, decidedAt, decidedBy, trialState, revision, retiredReason, scope, audience, always }: RuleProposal,
  trial: { applied: number; appliedAccepted: number; recurrences: number } | null = null, scopeLabel = "") =>
  ({ id, rule, author, state, occurrences, taskCount, examples, evidence, lastSeenAt, decidedAt, decidedBy, trialState, revision, retiredReason, trial, scope, scopeLabel, audience, always });

/** What the settings screen shows next to the writer picker: first-try acceptance per risk against the configured pair. */
export function insightsRpc(ctx: ServerCore, services: Services) {
  const { db } = ctx;
  return {
    get_routing_hint: async ({ projectId, days }) => {
      const stats = writerAcceptanceStats(db, { projectId, since: Date.now() - (days ?? 90) * 86_400_000 });
      const settings = loadProjectSettings(db, projectId);
      const provider = configuredSetting(settings, "writer.provider");
      const model = configuredSetting(settings, "writer.model");
      const current = typeof provider === "string" && typeof model === "string" && provider && model ? { providerId: provider, model } : null;
      const hints = RISKS.map((risk) => ({ risk, hint: routingHint(stats, current, risk) })).filter((row) => row.hint);
      return { current, hints, stats: stats.map((row) => ({ ...row })) };
    },
    /** Repeated lessons the owner may turn into rules, and the rules already confirmed. Recounted on every open. */
    list_rule_proposals: async ({ projectId }) => {
      const sections = await ctx.listProjectSections(projectId);
      let memory = { enabled: false, inject: false };
      try {
        const settings = memorySettingsFor(db, projectId);
        memory = { enabled: settings.enabled, inject: settings.inject };
      } catch { /* invalid memory settings: rules are listed, injection is reported off */ }
      return {
        // Rules in force show how their current wording fares: attempts given it, accepted, mistakes repeated anyway.
        proposals: await Promise.all(listRuleProposals(db, projectId).map(async (row) => {
          const label = await services.ruleScan.scanLabel(projectId, row.scope, sections);
          if (row.state !== "accepted") return ruleView(row, null, label);
          const stats = ruleTrialStats(db, projectId, row.id, row.revisionStartedAt ?? row.decidedAt ?? 0);
          return ruleView(row, { applied: stats.applied, appliedAccepted: stats.appliedAccepted, recurrences: stats.recurrences.length }, label);
        })),
        memory,
        events: listRuleEvents(db, projectId, 30),
        triage: await services.ruleScan.summary(projectId),
        scan: await services.ruleScan.scanState(projectId),
        analyzer: await services.ruleScan.analyzerFor(projectId),
      };
    },
    /** Each folder of the project on each machine: does it keep docs, why, how often, and when tasks last read them. */
    memory_records_list: async ({ projectId }) => {
      const rows = db.prepare("SELECT id, kind, audience, content, concepts_json, created_at FROM lane_pilot_memory WHERE project_id=? ORDER BY created_at DESC LIMIT 500")
        .all(projectId) as Array<{ id: string; kind: "core" | "note"; audience: string; content: string; concepts_json: string; created_at: number }>;
      return { records: rows.map((row) => {
        let concepts: string[] = [];
        try { concepts = JSON.parse(row.concepts_json) as string[]; } catch { concepts = []; }
        return { id: row.id, kind: row.kind, audience: row.audience, content: row.content, concepts, createdAt: row.created_at, rule: concepts.includes("rule") };
      }) };
    },
    // A rule's record is removed with the rule (the Rules tab), so the rule never stays «accepted» without reaching writers.
    memory_record_delete: async ({ projectId, id }) => {
      const row = db.prepare("SELECT concepts_json FROM lane_pilot_memory WHERE project_id=? AND id=?").get(projectId, id) as { concepts_json: string } | undefined;
      if (!row) return { deleted: false, reason: "not_found" };
      if (row.concepts_json.includes('"rule"')) return { deleted: false, reason: "rule" };
      deleteMemoryRecord(db, projectId, id);
      return { deleted: true, reason: null };
    },
    docs_overview: async ({ projectId, recheck }) => {
      const places = await services.docsPlaces(projectId);
      const rows = [];
      for (const place of places) {
        const settings = loadProjectSettings(db, projectId, place.scopes);
        const mode = parseDocsSettings(Object.fromEntries(["docs.enabled","docs.maintain","docs.since","docs.page_cap","docs.hour"].map((key) => [key, configuredSetting(settings, key)]))).mode;
        const status = mode === "auto" ? await services.docsPlaceStatus(projectId, place, { force: recheck }) : { verdict: null, cadence: "nightly" as const, lastReadAt: services.docsLastRead(place) };
        const v = status.verdict;
        rows.push({ hostId: place.hostId, path: place.path, name: place.name, scopes: place.scopes, mode,
          verdict: v ? { need: v.need, reason: v.reason, confidence: v.confidence, at: v.at,
            facts: { codeFiles: v.facts.codeFiles, contentFiles: v.facts.contentFiles, commits30d: v.facts.commits30d, manifests: v.facts.manifests.slice(0, 5), docsPages: v.facts.docsPages } } : null,
          cadence: status.cadence, lastReadAt: status.lastReadAt });
      }
      return { places: rows };
    },
    /** The «Rescan» button; returns at once, the screen polls list_rule_proposals for progress. */
    start_rule_scan: async ({ projectId, locale }) => services.ruleScan.startScan(projectId, locale),
    save_rules_analyzer: async ({ projectId, analyzer }) => ({ analyzer: await services.ruleScan.saveAnalyzer(projectId, analyzer) }),
    rule_set_audience: async ({ projectId, ruleId, audience, always }) => ({ ok: setRuleAudience(db, projectId, ruleId, audience, always) }),
    /** Acceptance per project and ISO week: first-try, eventual, attempts per accepted task, redispatch families, causes. */
    acceptance_stats: async ({ days, projectId }) => acceptanceStats(db, days, projectId),
    decide_rule_proposal: async ({ projectId, id, action, rule }) => {
      if (action === "accept") return { proposal: ruleView(acceptRuleProposal(db, projectId, id, rule ?? getRuleProposal(db, projectId, id)?.rule ?? "")) };
      return { proposal: ruleView(action === "reject" ? rejectRuleProposal(db, projectId, id) : revokeRule(db, projectId, id)) };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "get_routing_hint" | "list_rule_proposals" | "decide_rule_proposal" | "start_rule_scan" | "save_rules_analyzer" | "docs_overview" | "memory_records_list" | "memory_record_delete" | "rule_set_audience" | "acceptance_stats">;
}
