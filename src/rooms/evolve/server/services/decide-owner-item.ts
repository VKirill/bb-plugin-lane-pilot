import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { closeOwnerItem, hasOpenOwnerItem, postOwnerItem, type OwnerAction, type OwnerEvidence } from "../../../owner-waiting";
import type { LanePilotDatabase } from "../../../storage";
import type { ReplayScorecard } from "../../models/replay";
import { caseCounts, type CaseCounts, type EvolveLogSink } from "../repositories/case-repository";
import { listHypotheses, type EvolveHypothesisRow } from "../repositories/ledger-repository";

export const ownerProjectId = (projectId?: string | null): string | null =>
  projectId && projectId !== "*" && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;

export const evolveOwnerItemKey = (workflowId: string): string => `evolve:${workflowId}`;

export function parseJsonObj(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function describeVariant(variantJson: string): string {
  const obj = parseJsonObj(variantJson);
  if (!obj) return variantJson.slice(0, 80);
  if (typeof obj.model === "string") {
    return `${typeof obj.provider === "string" ? `${obj.provider}/` : ""}${obj.model}`;
  }
  if (typeof obj.form === "string") {
    return `form=${obj.form}${typeof obj.fallback === "string" ? ` (fallback=${obj.fallback})` : ""}`;
  }
  if (obj.verify !== undefined) return "verify check";
  if (obj.gates !== undefined) return "gate check";
  return Object.keys(obj).join(", ") || "change";
}

function formatScorecardSummary(hyp: EvolveHypothesisRow, counts: CaseCounts): string {
  let sc: ReplayScorecard | null = null;
  if (hyp.scorecardJson) {
    try {
      sc = JSON.parse(hyp.scorecardJson) as ReplayScorecard;
    } catch {
      sc = null;
    }
  }
  if (!sc?.comparison) {
    return `cases ${counts.heldOut}/${counts.working}`;
  }
  const { passCi, gain, seconds } = sc.comparison;
  const deltaPp = ((passCi.b.rate - passCi.a.rate) * 100).toFixed(1);
  const lowPp = (passCi.diff.low * 100).toFixed(1);
  const highPp = (passCi.diff.high * 100).toFixed(1);
  const deltaStr = `success Δ ${Number(deltaPp) >= 0 ? "+" : ""}${deltaPp}pp [95% CI ${lowPp}..${highPp}pp]`;

  let gainStr = `gain=${gain}`;
  if (gain === "cost" && sc.costs.baselinePerAcceptedUsd !== null && sc.costs.candidatePerAcceptedUsd !== null) {
    gainStr = `cost/accepted $${sc.costs.baselinePerAcceptedUsd.toFixed(4)} -> $${sc.costs.candidatePerAcceptedUsd.toFixed(4)}`;
  } else if (gain === "time" && seconds.a !== null && seconds.b !== null) {
    gainStr = `median ${seconds.a.toFixed(1)}s -> ${seconds.b.toFixed(1)}s`;
  }
  return `${deltaStr}, ${gainStr}, cases ${counts.heldOut}/${counts.working}`;
}

/** Keeps at most one open `evolve:<workflowId>` owner item synced with `report_only` hypotheses. */
export function syncEvolveOwnerItem(
  db: LanePilotDatabase,
  workflowId: string,
  options: { projectId?: string | null; now?: number; log?: EvolveLogSink } = {},
): { open: boolean } {
  const now = options.now ?? Date.now();
  const key = evolveOwnerItemKey(workflowId);
  const reportOnly = listHypotheses(db, { workflowId, state: "report_only" });
  if (reportOnly.length === 0) {
    closeOwnerItem(db, key, "janitor:evolve", now);
    return { open: false };
  }

  const counts = caseCounts(db, workflowId);
  const latest = reportOnly[reportOnly.length - 1]!;
  const latestDesc = describeVariant(latest.variantJson);
  const latestMetrics = formatScorecardSummary(latest, counts);
  const extraCount = reportOnly.length > 1 ? ` (+${reportOnly.length - 1} more)` : "";

  const lines = reportOnly.map((h) =>
    `node ${h.nodeId} (${h.armKind}: ${describeVariant(h.variantJson)}): ${formatScorecardSummary(h, counts)}`,
  );
  const evidence: OwnerEvidence[] = reportOnly.map((h) => ({
    kind: "note",
    ref: h.id,
    label: `${h.nodeId} (${h.armKind}: ${describeVariant(h.variantJson)})`,
  }));
  const actions: OwnerAction[] = reportOnly.flatMap((h) => {
    const suffix = reportOnly.length > 1 ? ` (${h.nodeId})` : "";
    return [
      { id: reportOnly.length > 1 ? `approve_${h.id}` : "approve", label: `Approve${suffix}`, cli: `bb lane-pilot evolve approve ${h.id}` },
      { id: reportOnly.length > 1 ? `reject_${h.id}` : "reject", label: `Reject${suffix}`, cli: `bb lane-pilot evolve reject ${h.id}` },
    ];
  });

  if (hasOpenOwnerItem(db, { key })) {
    closeOwnerItem(db, key, "janitor:evolve-refresh", now);
  }
  postOwnerItem(
    db,
    {
      key,
      source: "evolve",
      kind: "evolve_proposal",
      reason: "decision",
      projectId: ownerProjectId(options.projectId),
      wake: false,
      what: `Улучшение ${workflowId} (${latest.nodeId}: ${latestDesc}; ${latestMetrics})${extraCount}`,
      why: lines.join("; "),
      evidence,
      actions,
    },
    now,
    options.log?.warn,
  );
  return { open: true };
}
