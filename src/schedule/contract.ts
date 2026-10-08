import { z } from "zod";
import { conflictSchema, hostOptionSchema, runViewSchema, scheduleViewSchema } from "./views";

/**
 * The RPCs of the schedule board (spread into `rpcContract`, src/contracts.ts). The board, the calendar and the create form use
 * these and nothing else; docs/schedule-board.md lists them with examples.
 *
 * `schedule_upsert`, `schedule_delete`, `schedule_pause`, `schedule_resume`, `schedule_run_now` and `schedule_cancel_run` change
 * what the hub runs on its own: the guard of an agent's shell keeps `bb plugin rpc call` away from them (lane-stack/hooks/guard_shell.py);
 * an agent changes schedules through the PM tools, which ask the owner first.
 */
const projectId = z.string().min(1);
const nextCount = z.number().int().min(0).max(50);

export const scheduleRpcContract = {
  /** Every schedule of a project (or of the hub), each with its next fire times, last run and board column, and the machines a script can run on. */
  schedule_list: {
    input: z.object({ projectId: projectId.optional(), next: nextCount.optional() }).strict(),
    output: z.object({ schedules: z.array(scheduleViewSchema), hosts: z.array(hostOptionSchema), now: z.number() }).strict(),
  },
  /** One schedule with its newest runs (`runs`, default 20). */
  schedule_get: {
    input: z.object({ id: z.string().min(1), runs: z.number().int().min(0).max(200).optional(), next: nextCount.optional() }).strict(),
    output: z.object({ schedule: scheduleViewSchema.nullable(), runs: z.array(runViewSchema), runTotal: z.number() }).strict(),
  },
  /** The history of a schedule, newest first. Output of a run is cut to 64 KB. */
  schedule_runs: {
    input: z.object({ id: z.string().min(1), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() }).strict(),
    output: z.object({ runs: z.array(runViewSchema), total: z.number() }).strict(),
  },
  /** Checks a definition without saving it: problems that stop it, warnings, machine conflicts, the next fire times. `definition` is the same object `schedule_upsert` takes. */
  schedule_preview: {
    input: z.object({ definition: z.record(z.string(), z.unknown()), next: nextCount.optional() }).strict(),
    output: z.object({ ok: z.boolean(), problems: z.array(z.string()), warnings: z.array(z.string()), conflicts: z.array(conflictSchema), nextFires: z.array(z.number()), timeoutSec: z.number().nullable() }).strict(),
  },
  /** Creates a schedule (no `id` in the definition) or replaces one (`id`). Refused with `problems` when the definition is wrong; `warnings` and `conflicts` do not stop it. */
  schedule_upsert: {
    input: z.object({ definition: z.record(z.string(), z.unknown()) }).strict(),
    output: z.object({ ok: z.boolean(), schedule: scheduleViewSchema.nullable(), problems: z.array(z.string()), warnings: z.array(z.string()), conflicts: z.array(conflictSchema) }).strict(),
  },
  schedule_delete: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  schedule_pause: {
    input: z.object({ id: z.string().min(1), reason: z.string().max(300).optional() }).strict(),
    output: z.object({ schedule: scheduleViewSchema.nullable() }).strict(),
  },
  schedule_resume: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ schedule: scheduleViewSchema.nullable() }).strict(),
  },
  /** A run now, also of a paused schedule. `key` makes a repeated request the same run. The run starts within seconds; read it with `schedule_runs`. */
  schedule_run_now: {
    input: z.object({ id: z.string().min(1), key: z.string().min(1).max(80).optional() }).strict(),
    output: z.object({ ok: z.boolean(), run: runViewSchema.nullable(), created: z.boolean(), reason: z.string().optional() }).strict(),
  },
  /** Stops a run: a queued one is dropped, a running one is told to stop. */
  schedule_cancel_run: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  /** For the calendar: planned fire times of the active schedules and the runs that happened in [from, to] (ms). A schedule with more than 300 planned times in the range is listed in `truncated`. */
  schedule_calendar: {
    input: z.object({ projectId: projectId.optional(), from: z.number(), to: z.number() }).strict(),
    output: z.object({ planned: z.array(z.object({ scheduleId: z.string(), at: z.number() }).strict()), past: z.array(runViewSchema), truncated: z.array(z.string()) }).strict(),
  },
};
