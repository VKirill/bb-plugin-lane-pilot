type StatsDb = { prepare(sql:string):{ all(...args:unknown[]):unknown[] } };
import { listAttemptBriefRows } from "../storage";

/**
 * How briefs and their outcomes compare over a period: brief size, tasks accepted on their first attempt, attempts
 * rejected for touching paths outside owns_paths. Run it for a period before and after a brief change.
 */
export function writerBriefStats(db:StatsDb, projectId:string, since:number, until:number) {
  const rows = listAttemptBriefRows(db as never, projectId, since, until);
  const contexts:number[] = [], prompts:number[] = [];
  for (const row of rows) {
    let trace:{ dispatchContext?:{ memoryText?:string; pmReadContext?:string; executionPacket?:string; rulesText?:string; promptChars?:number } } | null = null;
    try { trace = row.trace_json ? JSON.parse(row.trace_json) : null; } catch { trace = null; }
    const context = trace?.dispatchContext;
    if (!context) continue;
    contexts.push((context.memoryText ?? "").length + (context.pmReadContext ?? "").length + (context.executionPacket ?? "").length + (context.rulesText ?? "").length);
    if (typeof context.promptChars === "number") prompts.push(context.promptChars);
  }
  const tasks = new Map<string, typeof rows>();
  for (const row of rows) tasks.set(`${row.run_id}:${row.task_id}`, [...(tasks.get(`${row.run_id}:${row.task_id}`) ?? []), row]);
  const finished = [...tasks.values()].filter((attempts) => attempts.some((row) => ["accepted", "blocked", "canceled"].includes(row.state)));
  const firstTry = finished.filter((attempts) => attempts[0]!.state === "accepted").length;
  const outside = rows.filter((row) => /outside owns_paths|owns_paths rejected/.test(row.reason ?? "")).length;
  const mean = (values:number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    attempts:rows.length, finishedTasks:finished.length,
    firstAttemptAccepted:firstTry, firstAttemptAcceptedShare:finished.length ? Math.round(100 * firstTry / finished.length) : null,
    outsideOwnsPaths:outside, outsideOwnsPathsShare:rows.length ? Math.round(100 * outside / rows.length) : null,
    avgContextChars:mean(contexts), avgPromptChars:mean(prompts), briefsMeasured:prompts.length,
  };
}
