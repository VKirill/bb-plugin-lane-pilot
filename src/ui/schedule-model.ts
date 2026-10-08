import { BOARD_COLUMNS, type BoardColumn, type RunView, type ScheduleView } from "../schedule/views";

/** Pure helpers of the automation area: card grouping, wording of a schedule, calendar days. No React, no clock but the `now` given. */

export const COLUMNS = BOARD_COLUMNS;

/** Cards by column. Scheduled ones go by their next run; the rest by the latest change. */
export function groupByColumn(schedules: readonly ScheduleView[]): Record<BoardColumn, ScheduleView[]> {
  const groups = Object.fromEntries(COLUMNS.map((column) => [column, [] as ScheduleView[]])) as Record<BoardColumn, ScheduleView[]>;
  for (const schedule of schedules) groups[schedule.column].push(schedule);
  groups.scheduled.sort((a, b) => (a.nextFires[0] ?? Infinity) - (b.nextFires[0] ?? Infinity) || a.name.localeCompare(b.name));
  for (const column of COLUMNS) if (column !== "scheduled") groups[column].sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

export type CronWords = { kind: "daily" | "weekdays" | "hourly" | "monthly"; time: string; minute: string; day: string };

const whole = /^\d{1,2}$/;
const pad = (n: string) => n.padStart(2, "0");

/** The few cron shapes a person says in words; null for everything else (the raw cron is shown then). */
export function cronWords(cron: string): CronWords | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (!whole.test(minute) || month !== "*") return null;
  const time = whole.test(hour) ? `${hour}:${pad(minute)}` : "";
  if (hour === "*" && dom === "*" && dow === "*") return { kind: "hourly", time: "", minute, day: "" };
  if (!time) return null;
  if (dom === "*" && dow === "*") return { kind: "daily", time, minute, day: "" };
  if (dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return { kind: "weekdays", time, minute, day: "" };
  if (whole.test(dom) && dow === "*") return { kind: "monthly", time, minute, day: dom };
  return null;
}

/** What the task does, in one line: the chain id, the first line of the errand, the script's command. */
export function taskSummary(schedule: Pick<ScheduleView, "task">): string {
  const task = schedule.task;
  if (task.kind === "workflow") return task.workflowId;
  if (task.kind === "errand") return task.title ?? task.task.split("\n")[0]!.slice(0, 140);
  return task.command.split("\n")[0]!.slice(0, 140);
}

// --- calendar ---------------------------------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
/** Local midnight of the day holding `at`. */
export const startOfDay = (at: number): number => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** The day `n` days from the local midnight `day` (a DST day is 23 or 25 hours, so calendar arithmetic, not +24 h). */
export const addDays = (day: number, n: number): number => { const d = new Date(day); d.setDate(d.getDate() + n); return d.getTime(); };
/** Monday of the week holding `at`. */
export const startOfWeek = (at: number): number => { const day = startOfDay(at); const dow = (new Date(day).getDay() + 6) % 7; return addDays(day, -dow); };
export const startOfMonth = (at: number): number => { const d = new Date(startOfDay(at)); d.setDate(1); return d.getTime(); };
export const addMonths = (month: number, n: number): number => { const d = new Date(month); d.setDate(1); d.setMonth(d.getMonth() + n); return d.getTime(); };

export type CalendarView = "month" | "week" | "list";

/** The days a view shows: a month as whole weeks (4 to 6), a week, the next 7 days from today. */
export function viewDays(view: CalendarView, anchor: number, now: number): number[] {
  if (view === "list") return Array.from({ length: 7 }, (_, i) => addDays(startOfDay(now), i));
  if (view === "week") { const first = startOfWeek(anchor); return Array.from({ length: 7 }, (_, i) => addDays(first, i)); }
  const first = startOfWeek(startOfMonth(anchor));
  const last = addDays(startOfMonth(addMonths(anchor, 1)), -1);
  const weeks = Math.ceil((Math.round((startOfDay(last) - first) / DAY_MS) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
}

/** The [from, to) range of ms the days cover. */
export const rangeOf = (days: readonly number[]): { from: number; to: number } => ({ from: days[0]!, to: addDays(days[days.length - 1]!, 1) - 1 });

export type CalendarEvent = { key: string; at: number; scheduleId: string; kind: "planned" | "past"; run: RunView | null; conflict: boolean };

/** Planned times and past runs as events by local day (key = midnight ms). Skipped runs are not events. */
export function eventsByDay(
  planned: ReadonlyArray<{ scheduleId: string; at: number }>, past: readonly RunView[], conflictAts: ReadonlySet<string> = new Set(),
): Map<number, CalendarEvent[]> {
  const map = new Map<number, CalendarEvent[]>();
  const put = (event: CalendarEvent) => { const day = startOfDay(event.at); (map.get(day) ?? map.set(day, []).get(day)!).push(event); };
  for (const row of planned) put({ key: `p:${row.scheduleId}:${row.at}`, at: row.at, scheduleId: row.scheduleId, kind: "planned", run: null, conflict: conflictAts.has(`${row.scheduleId}:${row.at}`) });
  for (const run of past) if (run.status !== "skipped") put({ key: `r:${run.id}`, at: run.startedAt ?? run.scheduledAt, scheduleId: run.scheduleId, kind: "past", run, conflict: false });
  for (const list of map.values()) list.sort((a, b) => a.at - b.at);
  return map;
}

export const CONFLICT_WINDOW_MS = 10 * 60_000;

/** Planned starts of two schedules on one machine within 10 minutes of each other (the backend's own rule); keys `<scheduleId>:<at>`. */
export function conflictKeys(planned: ReadonlyArray<{ scheduleId: string; at: number }>, schedules: readonly Pick<ScheduleView, "id" | "machine">[]): Map<string, string> {
  const machineOf = new Map(schedules.map((s) => [s.id, s.machine] as const));
  const byMachine = new Map<string, Array<{ scheduleId: string; at: number }>>();
  for (const row of planned) {
    const machine = machineOf.get(row.scheduleId);
    if (machine) (byMachine.get(machine) ?? byMachine.set(machine, []).get(machine)!).push(row);
  }
  const found = new Map<string, string>();
  for (const [machine, rows] of byMachine) {
    rows.sort((a, b) => a.at - b.at);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length && rows[j]!.at - rows[i]!.at <= CONFLICT_WINDOW_MS; j++) {
        if (rows[i]!.scheduleId === rows[j]!.scheduleId) continue;
        found.set(`${rows[i]!.scheduleId}:${rows[i]!.at}`, machine);
        found.set(`${rows[j]!.scheduleId}:${rows[j]!.at}`, machine);
      }
    }
  }
  return found;
}

// --- detail view ------------------------------------------------------------------------------------------------

/** The fields of an errand task that say who runs it (the schema's own names); all absent means the default decides. */
export type ModelFields = { providerId?: string | undefined; model?: string | undefined; reasoning?: string | undefined; serviceTier?: "default" | "fast" | undefined; preset?: string | undefined };
const MODEL_KEYS = ["providerId", "model", "reasoning", "serviceTier", "preset"] as const;

export function modelFieldsOf(task: ScheduleView["task"]): ModelFields {
  if (task.kind !== "errand") return {};
  return Object.fromEntries(MODEL_KEYS.filter((key) => task[key] !== undefined).map((key) => [key, task[key]])) as ModelFields;
}

/** The errand task with its model fields replaced by `fields` (an absent field is removed, so the next level decides). */
export function withModelFields(task: Extract<ScheduleView["task"], { kind: "errand" }>, fields: ModelFields): ScheduleView["task"] {
  const rest = Object.fromEntries(Object.entries(task).filter(([key]) => !(MODEL_KEYS as readonly string[]).includes(key)));
  return { ...rest, ...Object.fromEntries(MODEL_KEYS.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]])) } as ScheduleView["task"];
}

/** The definition `schedule_upsert` takes for a stored schedule with another task, everything else as it is (the id is kept). */
export function definitionWithTask(schedule: ScheduleView, task: ScheduleView["task"]): Record<string, unknown> {
  const when = schedule.when.type === "cron" ? { type: "cron", cron: schedule.when.cron, timezone: schedule.when.timezone } : { type: "once", runAt: schedule.when.runAt };
  return {
    id: schedule.id, projectId: schedule.projectId, name: schedule.name, ...(schedule.description ? { description: schedule.description } : {}), task, when,
    missed: schedule.missed, missedLimit: schedule.missedLimit, overlap: schedule.overlap, timeoutSec: schedule.timeoutSec, maxFailures: schedule.maxFailures,
  };
}

/** «SelfyStudio › Marketing»: the project and its folder section, whatever of them is known. */
export const placeText = (where: ScheduleView["where"] | undefined): string => [where?.projectName, where?.sectionName].filter(Boolean).join(" › ");
export const machineName = (where: ScheduleView["where"] | undefined): string | null => where?.hostName ?? where?.hostId ?? null;
