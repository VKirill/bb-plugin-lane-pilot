import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { getRuleProposal, listRuleProposals, routingHint, writerAcceptanceStats, type RuleProposal } from "@lane-pilot/run-insights";
import { rpcContract } from "../../contracts";
import { loadProjectSettings } from "../../database";
import { configuredSetting } from "../context";
import { acceptRuleProposal, memorySettingsFor, refreshRuleProposals, rejectRuleProposal, revokeRule } from "../insights";
import type { ServerCore } from "../core";

const RISKS = ["low", "medium", "high", "critical"] as const;

const ruleView = ({ id, rule, author, state, occurrences, taskCount, examples, lastSeenAt, decidedAt }: RuleProposal) =>
  ({ id, rule, author, state, occurrences, taskCount, examples, lastSeenAt, decidedAt });

/** What the settings screen shows next to the writer picker: first-try acceptance per risk against the configured pair. */
export function insightsRpc(ctx: ServerCore) {
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
      refreshRuleProposals(db, projectId);
      let memory = { enabled: false, inject: false };
      try {
        const settings = memorySettingsFor(db, projectId);
        memory = { enabled: settings.enabled, inject: settings.inject };
      } catch { /* invalid memory settings: rules are listed, injection is reported off */ }
      return { proposals: listRuleProposals(db, projectId).map(ruleView), memory };
    },
    decide_rule_proposal: async ({ projectId, id, action, rule }) => {
      if (action === "accept") return { proposal: ruleView(acceptRuleProposal(db, projectId, id, rule ?? getRuleProposal(db, projectId, id)?.rule ?? "")) };
      return { proposal: ruleView(action === "reject" ? rejectRuleProposal(db, projectId, id) : revokeRule(db, projectId, id)) };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "get_routing_hint" | "list_rule_proposals" | "decide_rule_proposal">;
}
