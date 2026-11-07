import { roleDefaultModel } from "@lane-pilot/models";

export type ServiceJobId = "classify" | "coverage" | "plan-fact" | "run-goal" | "report";

export type ServiceJob = {
  id: ServiceJobId;
  /** Cheap role while the pin holds. Null: the job is code and has no model to move. */
  role: string | null;
  /** Role restored when the monthly bench says the cheap pin got worse. */
  previousRole: string | null;
};

/**
 * Hub, read-only, 2026-10-30 (`lane_pilot_stage_receipt`, `lane_pilot_jev_receipt`, `lane_pilot_wf_run`):
 * - classify: intake.weight is Jev (jev-1.14.0, 411 calls, 520454 tokens, no paid model). The router escalation
 *   is `lp.route`: 5 runs, 120682 tokens, $0.01, role pm-reader (claude-haiku-5-5). That step moves to triager
 *   (Gemini 3.8 Flash); pm-reader stays the rollback.
 * - coverage: `coverageGaps` is code. No stage receipt.
 * - plan-fact: 815 receipts, model null.
 * - run-goal: `lane_pilot_run_goal` has no model column. The room does not call one.
 * - report: the `report` node of lp.close is `fs.write` (3 rows). `reportBody` is code.
 * `goal_audit` on lp.close stays auditor (gpt-6.1-sol, 7 runs): it judges authors, and it is not one of these five.
 */
export const SERVICE_JOBS: readonly ServiceJob[] = [
  { id: "classify", role: "triager", previousRole: "pm-reader" },
  { id: "coverage", role: null, previousRole: null },
  { id: "plan-fact", role: null, previousRole: null },
  { id: "run-goal", role: null, previousRole: null },
  { id: "report", role: null, previousRole: null },
];

export const servicePinKey = (id: string): string => `service_model.${id}`;

/** The role a service job runs on. A code job returns null. `service_model.<id> = "previous"` restores the old role. */
export function serviceRole(id: string, settings: Record<string, unknown>): string | null {
  const job = SERVICE_JOBS.find((row) => row.id === id);
  if (!job?.role) return null;
  return settings[servicePinKey(id)] === "previous" ? job.previousRole : job.role;
}

/** The built-in model of a role, the pair a bench arm runs. */
export function servicePair(role: string): { providerId: string; model: string } {
  const row = roleDefaultModel(role);
  return { providerId: row.providerId, model: row.model };
}
