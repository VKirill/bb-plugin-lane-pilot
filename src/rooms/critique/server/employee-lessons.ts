import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { upsertLessonProposal, listRuleProposals } from "@lane-pilot/run-insights";
import type { LanePilotDatabase } from "../../storage";
import { jev, type JudgeContext } from "@lane-pilot/jev";
import { employeeRemarkJudgment } from "@lane-pilot/jev/judgments/employee-remark";

/**
 * Employee lessons (agents-design «Пачка 4»). One mechanism, two homes: the lesson lands in the project's rule
 * proposals with `audience: "specialist:<role>"` (the existing `lane_pilot_memory` lesson path), and the same dated
 * line is appended to `lp.role.lines:<projectId>:<role>` — the section every specialist brief already renders.
 */
import { recordRoleLine } from "../../native-agent";
export { recordRoleLine } from "../../native-agent";
export { roleLinesKey } from "../../contracts/server";
const ROLE_LINES_CAP = 30;

const SNAPSHOT_KPI_RE = /\b(?:ctr|cpa|cpc|cpm|romi|roas|cr|cac|ltv|spend|clicks|impressions|конверси\w*|расход\w*)\s*(?:=|:|составил\w*|равен|сегодня|вчера|this\s+week|today)\s*[$₽€]?\s*\d[\d\s.,]*%?/i;
const DURABLE_RULE_RE = /\b(?:always|never|must|do\s+not|don't|before|after|when|if|unless|limit|floor|cap|threshold|всегда|никогда|не\s+|перед|после|если|когда|правил\w*|порог\w*)\b|[<>]=?/i;

/** Rejects point-in-time KPI readings disguised as durable employee lessons (Specialist OS E-07). */
export function snapshotLessonProblem(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return "empty_lesson";
  if (SNAPSHOT_KPI_RE.test(trimmed) && !DURABLE_RULE_RE.test(trimmed)) {
    return "snapshot_figure_not_a_lesson: record a durable rule, not a point-in-time KPI reading";
  }
  return null;
}

export async function recordEmployeeLesson(kv: BbPluginApi["storage"]["kv"], db: LanePilotDatabase, input: { projectId: string; role: string; line: string; evidence?: string }): Promise<{ line: string; proposalId: string }> {
  const problem = snapshotLessonProblem(input.line);
  if (problem) throw new Error(problem);
  const dated = await recordRoleLine(kv, input.projectId, input.role, input.line);
  const proposal = upsertLessonProposal(db as never, input.projectId, { rule: input.line.slice(0, 1000), evidence: input.evidence?.slice(0, 1000), audience: `specialist:${input.role}` as never });
  return { line: dated, proposalId: proposal.id };
}

/** The employee's slice: accepted+proposed rules recorded with `audience: specialist:<role>`. */
export function specialistMemorySlice(db: LanePilotDatabase, projectId: string, role: string): string[] {
  return listRuleProposals(db as never, projectId, { limit: 50 })
    .filter((p) => (p as { audience?: string }).audience === `specialist:${role}` && p.state !== "rejected" && p.state !== "revoked")
    .map((p) => p.rule);
}

/** «Это замечание к сотруднику X?» — Jev in shadow by default; active mode writes the lesson itself. */
export async function judgeEmployeeRemark(ctx: JudgeContext, input: { projectId: string; role: string; text: string }): Promise<{ remark: boolean; by: "jev" | "shadow" | "off" }> {
  const judge = jev();
  if (!judge) return { remark: false, by: "off" };
  const verdict = await judge.judge(employeeRemarkJudgment, { text: input.text, role: input.role }, { ...ctx, projectId: input.projectId });
  if (!verdict) return { remark: false, by: "off" };
  if (verdict.by === "jev") return { remark: verdict.decision.remark, by: "jev" };
  return { remark: verdict.by === "fallback" ? (verdict.shadow?.decision?.remark ?? false) : false, by: "shadow" };
}
