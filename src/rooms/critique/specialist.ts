import { z } from "zod";
import { clipped, extractModelJson, NO_TOOLS_LINE } from "@lane-pilot/workflow-engine";
import { isSerious, isVerdictShape, legacyDecisionToStatus, legacyOutputToVerdict, settleVerdict, verdictSchema, verdictSummary, withoutDecision } from "@lane-pilot/workflow-engine";
import type { Verdict, VerdictStatus } from "@lane-pilot/workflow-engine";

export const specialistResultSchema = z.object({
  decision: z.enum(["approve", "block"]),
  summary: clipped(2000),
  risks: z.array(z.object({
    severity: z.enum(["high", "critical"]),
    path: z.string().min(1).max(500),
    concern: clipped(1000),
    mitigation: clipped(1000),
  }).strict()).max(30),
}).strict();

/** The old shape (`decision`, `risks`) kept for the stage's result, plus the unified verdict: a `block` stops the task, a `rework` sends the plan back to the PM. */
export type SpecialistResult = z.infer<typeof specialistResultSchema> & { status: VerdictStatus; verdict: Verdict; demoted?: number };

export function specialistPrompt(input:{task:unknown; plan:string; agent?:string}):string {
  return [
    `You are ${input.agent?.trim() || "the specialist risk-review stage"} for a bounded software task.`,
    `Review the task and plan for concrete security, data-loss, compatibility, and recovery risks. ${NO_TOOLS_LINE}`,
    "Answer with one JSON object and nothing else: no text before or after it. Keys: status (\"pass\", \"rework\" or \"block\"), summary (string, at most 2000 characters), findings (at most 30 objects, each with file, severity \"critical\" or \"high\" (a lower risk is not reported), evidence (at most 2000 characters: what in the task or the plan shows the risk), finding (at most 1000: the concern), criterion (at most 500: the mitigation the plan lacks), and line when you can name it), evidence (string, what you examined and how, at most 4000 characters). Any other key makes the answer unreadable and the task is blocked. Use pass with an empty findings array when there is no high or critical risk.",
    "rework: a high or critical risk that the PM settles by changing the plan or the contract. block: a risk no edit of the plan removes (data loss, security, a compatibility break the owner must decide); the task stops. Block only when a concrete high or critical risk has no adequate mitigation in the supplied plan. Do not invent repository facts.",
    "TASK CONTRACT:", JSON.stringify(input.task),
    "CANONICAL PLAN:", input.plan,
  ].join("\n\n");
}

export function parseSpecialistResult(output:string):SpecialistResult {
  const raw = extractModelJson(output);
  if (isVerdictShape(raw)) {
    const { verdict, demoted } = settleVerdict(verdictSchema.parse(withoutDecision(raw)), "specialist");
    const risks = verdict.findings.filter(isSerious).map((row) => ({
      severity: row.severity as "high" | "critical",
      path: row.file || "-",
      concern: row.finding ?? row.evidence.slice(0, 1000),
      mitigation: row.criterion ?? "none stated",
    }));
    return { decision: verdict.status === "pass" ? "approve" : "block", summary: verdictSummary(verdict), risks, status: verdict.status, verdict, ...(demoted ? { demoted } : {}) };
  }
  const legacy = specialistResultSchema.parse(raw);
  const status = legacyDecisionToStatus(legacy.decision);
  return { ...legacy, status, verdict: legacyOutputToVerdict({ status, summary: legacy.summary, findings: legacy.risks.map((risk) => ({
    severity: "blocking" as const, finding: risk.concern, criterion: risk.mitigation, path: risk.path })) }) };
}

export function shouldRunSpecialist(input:{enabled:unknown; when:unknown; risk:string}):{run:boolean;reason:string|null} {
  const enabled = input.enabled;
  if (enabled == null || enabled === false || enabled === 0 || (typeof enabled === "string" && ["false", "off", "0", "no"].includes(enabled.trim().toLowerCase()))) {
    return {run:false,reason:"disabled_by_project_setting"};
  }
  if (enabled != null && ![true, 1, "true", "on", "1", "yes"].includes(enabled as never)) {
    return {run:false,reason:"invalid_specialist_enabled_setting"};
  }
  const when = input.when == null ? "high_risk" : input.when;
  if (when !== "high_risk" && when !== "always") return {run:false,reason:`unsupported_specialist_when:${String(when)}`};
  return when === "always" || input.risk === "high" || input.risk === "critical"
    ? {run:true,reason:null}
    : {run:false,reason:"risk_below_specialist_threshold"};
}
