import type { Services } from "../../platform/server";

/**
 * Acting through schedules (roadmap §2.5, class `schedule`, `acts_via: schedule` in policy/lead-policy.json). A proposal of that class
 * carries the schedule itself; on the owner's «да», or from the tick's act step once the class is open, the schedule is created in the
 * project's board through the schedule room's own `save`, so its validation, defaults and conflict checks apply as they do to the
 * owner's hand. A script is a host job and never the lead's; an existing schedule is never edited from here.
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

export type LeadScheduleResult = { ok: true; id: string; name: string } | { ok: false; reason: string };

/** Creates the schedule in the project's board as the lead; the branch and the reason go into its description so the board says where it came from. */
export async function createLeadSchedule(services: Pick<Services, "schedules">, input: { projectId: string; payload: unknown; roadId: string; by: string; why: string }): Promise<LeadScheduleResult> {
  const problem = schedulePayloadProblem(input.payload);
  if (problem) return { ok: false, reason: problem };
  const { projectId: _foreign, id: _existing, description, ...rest } = input.payload as LeadSchedulePayload;
  const origin = `Proposed by the lead («Штурман»), road tree branch ${input.roadId}: ${input.why}`;
  const text = [typeof description === "string" ? description.trim() : "", origin].filter(Boolean).join("\n").slice(0, 2000);
  try {
    const saved = await services.schedules.save({ ...rest, projectId: input.projectId, description: text }, input.by);
    if (!saved.ok) return { ok: false, reason: `schedule refused: ${saved.problems.join("; ")}`.slice(0, 300) };
    return { ok: true, id: saved.schedule.id, name: saved.schedule.name };
  } catch (cause) {
    return { ok: false, reason: `schedule failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300) };
  }
}
