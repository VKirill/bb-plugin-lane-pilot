import type { ScheduleService } from "../../../schedule/server";
import { LEAD_SCHEDULE_KINDS, schedulePayloadProblem, type LeadSchedulePayload, type LeadScheduleResult } from "../../models/lead-schedule";

export { LEAD_SCHEDULE_KINDS, schedulePayloadProblem, type LeadSchedulePayload, type LeadScheduleResult };

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  schedules: ScheduleService;
}

/**
 * Acting through schedules (roadmap §2.5, class `schedule`, `acts_via: schedule` in policy/lead-policy.json). A proposal of that class
 * carries the schedule itself; on the owner's «да», or from the tick's act step once the class is open, the schedule is created in the
 * project's board through the schedule room's own `save`, so its validation, defaults and conflict checks apply as they do to the
 * owner's hand. A script is a host job and never the lead's; an existing schedule is never edited from here.
 */
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
