import { planSignature, type PhaseRecord, type PlanItem } from "../logic";

/**
 * The check of a plan the PM submitted is a check of THAT plan: the run is handed the plan's sha, but the sha only names what it was started for, not
 * what its planner then returned and its critic read. The critic's pass counts for the PM's plan only when the pieces the run returned are the plan's own
 * (same ids, same contracts, covers and context), signed the way the plan was. The promise and the wave are the PM's own bookkeeping, not a contract the
 * run returns, so they are taken from the plan. `read` turns the run's output into pieces (auto-stages `planItems`; it drops a task without a string id,
 * so the raw count is compared too). Null: the same plan; else the reason it is not. The returned pieces are never copied into the PM's plan.
 */
export function checkedPlanDrift(plan: PhaseRecord["plan"], output: Record<string, unknown>, read: (output: Record<string, unknown>) => PlanItem[]): string | null {
  if (!plan) return "the phase has no plan";
  let returned: PlanItem[];
  try { returned = read(output); } catch (cause) { return `its pieces cannot be read as a plan (${cause instanceof Error ? cause.message : String(cause)})`; }
  const raw = Array.isArray(output.tasks) ? output.tasks.length : 0;
  if (raw !== plan.items.length || returned.length !== raw) return `it returned ${raw} task(s) (${returned.length} with an id), the submitted plan has ${plan.items.length} piece(s)`;
  const echoed: PlanItem[] = [];
  for (const own of plan.items) {
    const back = returned.find((item) => item.id === own.id);
    if (!back) return `piece ${own.id} of the submitted plan is not among the pieces it returned`;
    // An empty list of covers is no covers: the tool, the plan record of older versions and `planItems` each write it their own way. The same coverage keeps
    // the piece's own form (so its stored sha still holds); another one, a removed one or an added one is the returned list, and the signature then differs.
    const { covers, ...rest } = own;
    const same = JSON.stringify(covers ?? []) === JSON.stringify(back.covers ?? []);
    echoed.push({ ...rest, task: back.task, ...((same ? covers : back.covers) ? { covers: same ? covers : back.covers } : {}) });
  }
  return planSignature(echoed, plan.contextSha) === plan.sha ? null : "its pieces differ from the submitted plan (a contract or the covers changed)";
}

/** What the machine reports for the check of the PM's plan: the critic's own verdict, which counts only for pieces that are the plan's own. */
export function checkedPlanVerdict(plan: PhaseRecord["plan"], output: Record<string, unknown>, read: (output: Record<string, unknown>) => PlanItem[]): { decision: "approve" | "changes_requested"; summary: string } {
  const drift = checkedPlanDrift(plan, output, read);
  const said = (max: number) => String(typeof output.plan_verdict === "string" ? output.plan_verdict : output.plan_verdict == null ? "" : JSON.stringify(output.plan_verdict)).trim().slice(0, max);
  if (drift) return { decision: "changes_requested", summary: `the critic's run did not check the submitted plan: ${drift}` };
  return { decision: output.status === "ok" && said(200) === "pass" ? "approve" : "changes_requested", summary: said(2000) };
}
