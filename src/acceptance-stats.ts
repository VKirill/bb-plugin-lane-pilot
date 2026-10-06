import { failureClass } from "./failure-class";

type Db = { prepare(sql:string):{ all(...args:unknown[]):unknown[] } };

export type AcceptanceWeek = {
  /** ISO week, keyed by the task's first attempt. */
  week:string;
  /** Tasks with at least one attempt in the week. */
  dispatched:number;
  /** Of them, accepted on their first attempt. */
  firstTryAccepted:number;
  /** Of them, accepted by any attempt. */
  eventuallyAccepted:number;
  /** All attempts of the week's tasks. */
  attempts:number;
  /** Attempts per accepted task (all attempts of accepted tasks). */
  attemptsPerAccepted:number | null;
  /** Tasks sent again: id is `<stem>.N`. */
  redispatched:number;
  /** Distinct stems behind the redispatched tasks. */
  families:number;
  /** Failed attempts by coarse cause. */
  causes:Record<string, number>;
};

export type AcceptanceTotals = Omit<AcceptanceWeek, "week">;
export type AcceptanceProject = { projectId:string; totals:AcceptanceTotals; weeks:AcceptanceWeek[] };
export type AcceptanceStats = { days:number; totals:AcceptanceTotals; projects:AcceptanceProject[] };

/** Attempts still on their way are neither failures nor outcomes. */
const OPEN_STATES = new Set(["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"]);

/**
 * The plan's coarse buckets, from failureClass() first and the reason text second: ownership/dirt, outputs/empty,
 * verification, needs_human, merge, provider/limit, harness, other.
 */
export function failureCause(state:string, reason:string | null | undefined):string {
  const cls = failureClass(state, reason);
  if (cls === "judgment") return "needs_human";
  if (cls === "merge") return "merge";
  if (cls === "harness") return "harness";
  if (cls === "provider" || cls === "limit") return "provider_limit";
  const text = (reason ?? "").toLowerCase();
  if (/expected_outputs|changed no files|empty_output|output_unowned|no files/.test(text)) return "outputs_empty";
  if (/owns_paths|ownership|dirt|dirty/.test(text)) return "ownership_dirt";
  if (/verification|validation/.test(text)) return "verification";
  return "other";
}

function isoWeek(ms:number):string {
  const date = new Date(new Date(ms).toISOString().slice(0, 10) + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const round1 = (value:number) => Math.round(value * 10) / 10;

type TaskOutcome = { firstTry:boolean; accepted:boolean; redispatched:boolean; stem:string; attempts:number; failed:string[] };
type Accum = { dispatched:number; firstTryAccepted:number; eventuallyAccepted:number; attempts:number; attemptsOfAccepted:number; redispatched:number; stems:Set<string>; causes:Record<string, number> };

const emptyAccum = ():Accum => ({ dispatched:0, firstTryAccepted:0, eventuallyAccepted:0, attempts:0, attemptsOfAccepted:0, redispatched:0, stems:new Set(), causes:{} });

function fold(accum:Accum, task:TaskOutcome) {
  accum.dispatched++;
  accum.attempts += task.attempts;
  if (task.firstTry) accum.firstTryAccepted++;
  if (task.accepted) { accum.eventuallyAccepted++; accum.attemptsOfAccepted += task.attempts; }
  if (task.redispatched) { accum.redispatched++; accum.stems.add(task.stem); }
  for (const cause of task.failed) accum.causes[cause] = (accum.causes[cause] ?? 0) + 1;
}

const toTotals = (accum:Accum):AcceptanceTotals => ({
  dispatched:accum.dispatched, firstTryAccepted:accum.firstTryAccepted, eventuallyAccepted:accum.eventuallyAccepted,
  attempts:accum.attempts, attemptsPerAccepted:accum.eventuallyAccepted ? round1(accum.attemptsOfAccepted / accum.eventuallyAccepted) : null,
  redispatched:accum.redispatched, families:accum.stems.size, causes:accum.causes,
});

/** First-try acceptance, redispatches and failure causes per project and ISO week, read-only. */
export function acceptanceStats(db:Db, days:number, projectId?:string):AcceptanceStats {
  const since = Date.now() - days * 86_400_000;
  const rows = db.prepare(`SELECT r.project_id AS projectId, a.run_id AS runId, a.task_id AS taskId, a.state AS state, a.reason AS reason, a.created_at AS at
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.created_at>=? ${projectId ? "AND r.project_id=?" : ""}
    ORDER BY r.project_id, a.run_id, a.task_id, a.created_at`)
    .all(...(projectId ? [since, projectId] : [since])) as
    Array<{ projectId:string; runId:string; taskId:string; state:string; reason:string|null; at:number }>;

  const byTask = new Map<string, typeof rows>();
  const keyOf = (row:{ projectId:string; taskId:string }) => `${row.projectId}\u241f${row.taskId}`;
  for (const row of rows) byTask.set(keyOf(row), [...(byTask.get(keyOf(row)) ?? []), row]);

  const grand = emptyAccum();
  const projects = new Map<string, { totals:Accum; weeks:Map<string, Accum> }>();
  for (const [key, attempts] of byTask) {
    const [project, taskId] = key.split("\u241f") as [string, string];
    const slot = projects.get(project) ?? { totals:emptyAccum(), weeks:new Map<string, Accum>() };
    projects.set(project, slot);
    const weekName = isoWeek(attempts[0]!.at);
    const weekAccum = slot.weeks.get(weekName) ?? emptyAccum();
    slot.weeks.set(weekName, weekAccum);
    const outcome:TaskOutcome = {
      firstTry:attempts[0]!.state === "accepted",
      accepted:attempts.some((row) => row.state === "accepted"),
      redispatched:/\.\d+$/.test(taskId),
      stem:taskId.replace(/\.\d+$/, ""),
      attempts:attempts.filter((row) => !OPEN_STATES.has(row.state)).length,
      failed:attempts.filter((row) => row.state !== "accepted" && !OPEN_STATES.has(row.state))
        .map((row) => failureCause(row.state, row.reason)),
    };
    fold(grand, outcome);
    fold(slot.totals, outcome);
    fold(weekAccum, outcome);
  }

  return {
    days, totals:toTotals(grand),
    projects:[...projects.keys()].sort().map((id) => {
      const slot = projects.get(id)!;
      return {
        projectId:id, totals:toTotals(slot.totals),
        weeks:[...slot.weeks.entries()].sort(([a], [b]) => a < b ? -1 : 1)
          .map(([name, accum]) => ({ week:name, ...toTotals(accum) })),
      };
    }),
  };
}
