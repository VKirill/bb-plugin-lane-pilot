import { roleDefaultModel } from "./role-models";

export type ServiceJobId = "classify" | "coverage" | "plan-fact" | "report";

export type ServiceJob = {
  id: ServiceJobId;
  /** Cheap role while the pin holds. Null: the job is code and has no model to move. */
  role: string | null;
  /** Role restored when the monthly bench says the cheap pin got worse. */
  previousRole: string | null;
};

/**
 * Hub service jobs: classify runs on triager (previousRole pm-reader); code-only jobs carry role = null.
 */
export const SERVICE_JOBS: readonly ServiceJob[] = [
  { id: "classify", role: "triager", previousRole: "pm-reader" },
  { id: "coverage", role: null, previousRole: null },
  { id: "plan-fact", role: null, previousRole: null },
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
