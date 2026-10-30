import { classifyFailure, type FailureClass } from "./failure-class";
import { failureClassJudgment } from "./failure-class-judgment";
import { logFindJudgment } from "@lane-pilot/jev/judgments/log-find";
import type { Jev } from "@lane-pilot/jev";
import type { JevSettings } from "@lane-pilot/jev";

/**
 * The class of a failure with J-4 behind the rules: the rules first, and only a reason they have no confident match for goes to
 * Jev. `off` and `shadow` (the default) return the rules' class, `shadow` having recorded what Jev would have said in a receipt;
 * `active` returns Jev's class when it is clear. No Jev, no key, a failure: the rules' class.
 */
export type JudgedFailureDeps = {
  jev(): Jev | null;
  settings(): Promise<JevSettings>;
  projectId: string;
  runId: string | null;
};

export async function judgedFailureClass(deps: JudgedFailureDeps, state: string, reason: string | null | undefined, subject?: string): Promise<FailureClass> {
  const rules = classifyFailure(state, reason);
  if (rules.confident || !reason?.trim()) return rules.cls;
  const instance = deps.jev();
  if (!instance) return rules.cls;
  try {
    const settings = await deps.settings().catch(() => ({} as JevSettings));
    if (!instance.enabled(settings)) return rules.cls;
    // B8: a pointed failure line found in the log sharpens the class question (shadow records it either way).
    const lines = reason.split("\n").map((line) => line.trim()).filter(Boolean);
    let pointed: string | null = null;
    if (lines.length > 12) {
      const found = await instance.judge(logFindJudgment, { task: subject ?? "attempt", command: state.slice(0, 200), lines }, { projectId: deps.projectId, runId: deps.runId, subject: subject ?? "attempt", settings }).catch(() => null);
      const pick = found?.by === "jev" ? found.decision.line : found?.by === "fallback" ? (found.shadow?.decision?.line ?? null) : null;
      if (pick !== null && pick !== undefined) pointed = lines[pick] ?? null;
    }
    const judged = pointed ? `${state}
pointed line: ${pointed}` : state;
    const verdict = await instance.judge(failureClassJudgment, { state: judged, reason }, { projectId: deps.projectId, runId: deps.runId, subject: subject ?? "attempt", settings });
    return verdict.by === "jev" ? verdict.decision.cls : rules.cls;
  } catch { return rules.cls; }
}
