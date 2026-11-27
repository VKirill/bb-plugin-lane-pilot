/**
 * Pure schedule-proposal shape validation for the lead (`class: schedule`).
 */
export const LEAD_SCHEDULE_KINDS: ReadonlySet<string> = new Set(["workflow", "errand", "agent"]);
export type LeadSchedulePayload = { name?: string; description?: string; task?: { kind?: string } & Record<string, unknown>; when?: Record<string, unknown> } & Record<string, unknown>;

/** Why a schedule proposal cannot act; null when the payload has the shape a schedule needs (the room checks the rest when it is saved). */
export function schedulePayloadProblem(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "a schedule proposal carries schedule: {name, task: {kind: workflow|errand|agent, …}, when: {type: cron, cron, timezone?}}";
  const p = payload as LeadSchedulePayload;
  if (typeof p.name !== "string" || !p.name.trim()) return "schedule.name is missing";
  const kind = p.task?.kind;
  if (typeof kind !== "string" || !LEAD_SCHEDULE_KINDS.has(kind)) return "schedule.task.kind must be workflow, errand or agent (a script is a host job: the owner's alone)";
  if (!p.when || typeof p.when !== "object") return "schedule.when is missing";
  return null;
}
