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
export { recordRoleLine, roleLinesKey } from "../../native-agent";
const ROLE_LINES_CAP = 30;

export async function recordEmployeeLesson(kv: BbPluginApi["storage"]["kv"], db: LanePilotDatabase, input: { projectId: string; role: string; line: string; evidence?: string }): Promise<{ line: string; proposalId: string }> {
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
  const verdict = await judge.judge(employeeRemarkJudgment, { text: input.text, role: input.role }, { ...ctx, projectId: input.projectId }).catch(() => null);
  if (!verdict) return { remark: false, by: "off" };
  if (verdict.by === "jev") return { remark: verdict.decision.remark, by: "jev" };
  return { remark: verdict.by === "fallback" ? (verdict.shadow?.decision?.remark ?? false) : false, by: "shadow" };
}
