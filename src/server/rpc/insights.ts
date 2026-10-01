import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { getRuleProposal, listRuleEvents, listRuleProposals, ruleTrialStats, routingHint, writerAcceptanceStats, type RuleProposal } from "@lane-pilot/run-insights";
import { rpcContract } from "../../contracts";
import { loadProjectSettings } from "../../database";
import { configuredSetting } from "../context";
import { acceptRuleProposal, memorySettingsFor, rejectRuleProposal, revokeRule } from "../insights";
import type { ServerCore } from "../core";
import type { Services } from "../services";

const RISKS = ["low", "medium", "high", "critical"] as const;

const ruleView = ({ id, rule, author, state, occurrences, taskCount, examples, evidence, lastSeenAt, decidedAt, decidedBy, trialState, revision, retiredReason, scope }: RuleProposal,
  trial: { applied: number; appliedAccepted: number; recurrences: number } | null = null, scopeLabel = "") =>
  ({ id, rule, author, state, occurrences, taskCount, examples, evidence, lastSeenAt, decidedAt, decidedBy, trialState, revision, retiredReason, trial, scope, scopeLabel });

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
    /** The «Rescan» button; returns at once, the screen polls list_rule_proposals for progress. */
    start_rule_scan: async ({ projectId, locale }) => services.ruleScan.startScan(projectId, locale),
    save_rules_analyzer: async ({ projectId, analyzer }) => ({ analyzer: await services.ruleScan.saveAnalyzer(projectId, analyzer) }),
    decide_rule_proposal: async ({ projectId, id, action, rule }) => {
      if (action === "accept") return { proposal: ruleView(acceptRuleProposal(db, projectId, id, rule ?? getRuleProposal(db, projectId, id)?.rule ?? "")) };
      return { proposal: ruleView(action === "reject" ? rejectRuleProposal(db, projectId, id) : revokeRule(db, projectId, id)) };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "get_routing_hint" | "list_rule_proposals" | "decide_rule_proposal" | "start_rule_scan" | "save_rules_analyzer">;
}
