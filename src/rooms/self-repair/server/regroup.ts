import { bestEffort } from "@lane-pilot/kit";
import { jev } from "@lane-pilot/jev";
import { MAX_CANDIDATES, repairGroup } from "@lane-pilot/jev/judgments/repair-group";
import type { ServerCore } from "../../contracts/server";
import type { Incident, SelfRepairConfig, SelfRepairState } from "./types";

/** Signatures filed under a known group per pass: each is one Jev request, and the rest wait for the next pass. */
const REGROUP_PER_TICK = 8;
const MAX_ALIASES = 500;

export function createRegrouper(ctx: ServerCore) {
  /**
   * J-10: a signature seen for the first time may be another wording of a problem already known. Jev picks the known group of
   * the same kind it belongs to (`selfrepair.group`); in shadow mode the answer is only recorded and every signature stays its own
   * group, as before. Without Jev, or when it does not answer, nothing changes.
   */
  async function regroup(incidents: Incident[], current: SelfRepairState, cfg: SelfRepairConfig): Promise<number> {
    for (const row of incidents) {
      const alias = current.aliases[row.signature];
      if (alias && current.signatures[alias]) row.signature = alias;
    }
    const instance = jev();
    if (!instance) return 0;
    const fresh = [...new Set(incidents.filter((row) => !current.signatures[row.signature]).map((row) => row.signature))].slice(0, REGROUP_PER_TICK);
    const jobs: Array<{ signature: string; input: Parameters<typeof repairGroup.fallback>[0] }> = [];
    for (const signature of fresh) {
      const sample = incidents.find((row) => row.signature === signature)!;
      const candidates = Object.entries(current.signatures)
        .filter(([key]) => key.startsWith(`${sample.kind}:`))
        .sort(([, a], [, b]) => b.count - a.count || b.lastAt - a.lastAt)
        .slice(0, MAX_CANDIDATES)
        .map(([key, record]) => ({ signature: key, text: key.split(":").slice(2).join(":"), count: record.count }));
      if (candidates.length) jobs.push({ signature, input: { kind: sample.kind, reason: sample.reason, candidates } });
    }
    if (!jobs.length) return 0;
    const settings = await ctx.effectiveProjectSettings(cfg.projectId).then((value) => value.values, () => ({} as Record<string, unknown>));
    const verdicts = await bestEffort(ctx.log, "self-repair regroup judge", instance.judgeMany(repairGroup, jobs.map((job) => job.input), { projectId: cfg.projectId, subject: "selfrepair", settings }), []);
    let filed = 0;
    jobs.forEach((job, index) => {
      const verdict = verdicts[index];
      const target = verdict?.by === "jev" ? verdict.decision.signature : verdict?.by === "fallback" ? (verdict.shadow?.decision?.signature ?? null) : null;
      if (target && verdict?.receiptId != null) current.mergeSuggestions[job.signature] = { group: target, receiptId: verdict.receiptId, at: Date.now() };
      if (verdict?.by !== "jev" || !target || !current.signatures[target]) return;
      current.aliases[job.signature] = target;
      for (const row of incidents) if (row.signature === job.signature) row.signature = target;
      ctx.log(`self-repair: «${job.signature.split(":").slice(2).join(":").slice(0, 80)}» filed under the known problem «${target.split(":").slice(2).join(":").slice(0, 80)}» (Jev)`);
      filed += 1;
    });
    const entries = Object.entries(current.aliases);
    if (entries.length > MAX_ALIASES) current.aliases = Object.fromEntries(entries.slice(-MAX_ALIASES));
    const SUGGESTION_MS = 60 * 86_400_000;
    for (const [sig, s] of Object.entries(current.mergeSuggestions)) if (Date.now() - s.at > SUGGESTION_MS) delete current.mergeSuggestions[sig];
    return filed;
  }

  return regroup;
}
