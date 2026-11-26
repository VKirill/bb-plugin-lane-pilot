import { wayOut } from "../../../contracts";
import type { TaskOutcome } from "../../../storage";
import { TASK_DONE, TASK_NOTICE, relayClock, type RelayItem, type RelayReminder } from "../../models/relay";
import type { RelayDeps } from "./relay";

/** One message with the PM's task results and the notes of its reminders they satisfy; null when nothing is due yet. */
async function noticeText(
  deps: Pick<RelayDeps, "gateLine" | "deferralLines" | "log">,
  rows: TaskOutcome[],
  atWork: Array<string | { taskId: string; reason: string | null }>,
  notes: RelayReminder[],
): Promise<string> {
  const canceled = rows.filter((row) => row.state === "canceled").length;
  const gates = new Map<string, string>();
  for (const row of rows) {
    if (row.state !== "accepted" || !deps.gateLine) continue;
    const line = await deps.gateLine(row).catch((cause: unknown) => { deps.log(`relay: gate line unreadable for ${row.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
    if (line) gates.set(row.taskId, line);
  }
  const lines = rows.filter((row) => row.state !== "canceled").map((row) => {
    // A stop before any writer carries the contract fix (baseline): it is the PM's only word on it, so it is kept whole.
    const reasonChars = row.reason?.startsWith("verdict_block:") ? 900 : 300;
    const reason = row.state === "accepted" ? "" : row.reason ? `: ${row.reason.replace(/\s+/g, " ").slice(0, reasonChars)}` : "";
    const out = reason ? wayOut(row.state, row.reason, row.failureCode) : null;
    const gate = gates.get(row.taskId);
    return `- ${row.taskId} — ${row.state}${reason}${out ? ` → ${out}` : ""}${gate ? ` (gate: ${gate})` : ""}`;
  });
  if (canceled) lines.push(`- ${canceled} canceled`);
  const workLines = atWork.slice(0, 8).map((entry) => {
    if (typeof entry === "string") return entry;
    const short = (entry.reason ?? "").replace(/\s+/g, " ").slice(0, 200);
    const out = wayOut("pending", entry.reason);
    return `${entry.taskId} (waits: ${short}${out ? ` → ${out}` : ""})`;
  });
  const work = atWork.length ? `Still at work: ${atWork.length} (${workLines.join(", ")}${atWork.length > 8 ? ", …" : ""}).` : "None of your tasks is at work now.";
  const noted = notes.map((item) => `- (${relayClock(item.createdAt)}) ${item.note}`);
  const deferred = deps.deferralLines ? [...new Set(rows.map((row) => row.projectId))].flatMap((projectId) => deps.deferralLines!(projectId)) : [];
  return [
    "Lane Pilot: results of your tasks (states as they are now):", ...lines, "", work,
    ...(noted.length ? ["", "Your reminder notes on these tasks (written earlier; skip what is already done):", ...noted] : []),
    ...(deferred.length ? ["", ...deferred] : []),
    "", "Act only on what needs you. No reply is needed; results of your other tasks come here by themselves.",
  ].join("\n");
}

/**
 * Tells each PM the results of its tasks in one message (TASK_NOTICE), so a PM does not need a reminder per batch and
 * is not woken once per task. Open reminders of that PM on tasks that have all finished go in the same message and close.
 * Not sent while the PM is in a turn: the message would wait behind it with old states.
 */
export async function sendPendingTaskNotices(
  deps: RelayDeps,
  items: RelayItem[],
  dropQueuedRow: (item: RelayReminder) => Promise<boolean>,
): Promise<number> {
  if (!deps.taskOutcomes) return 0;
  const now = deps.now();
  const outcomes = await deps.taskOutcomes().catch((cause: unknown) => { deps.log(`relay: task results unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return [] as TaskOutcome[]; });
  const stale = outcomes.filter((row) => now - row.at > TASK_NOTICE.dropAfterMs || deps.toldDirectly?.(row));
  if (stale.length) await deps.markReported?.(stale);
  const byThread = new Map<string, TaskOutcome[]>();
  for (const row of outcomes) if (now - row.at <= TASK_NOTICE.dropAfterMs && !deps.toldDirectly?.(row)) byThread.set(row.pmThreadId, [...(byThread.get(row.pmThreadId) ?? []), row]);
  let sent = 0;
  for (const [threadId, rows] of byThread) {
    if (rows.every((row) => row.state === "canceled")) {
      await deps.markReported?.(rows);
      continue;
    }
    const reminders = items.filter((row): row is RelayReminder => row.kind === "remind" && !row.firedAt && row.threadId === threadId && !!row.taskIds?.length);
    const satisfied: RelayReminder[] = [];
    for (const item of reminders) {
      const states = await deps.taskStates(item.projectId, item.taskIds ?? []).catch((cause: unknown) => { deps.log(`relay: task states unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (states && (item.taskIds ?? []).every((task) => TASK_DONE.has(states[task] ?? ""))) satisfied.push(item);
    }
    const newest = Math.max(...rows.map((row) => row.at)), oldest = Math.min(...rows.map((row) => row.at));
    const urgent = rows.some((row) => row.state === "blocked");
    const atWork = await deps.tasksAtWork?.(threadId).catch((cause: unknown) => { deps.log(`relay: tasks-at-work unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return [] as string[]; }) ?? [];
    const due = satisfied.length > 0
      || (urgent && (now - newest >= TASK_NOTICE.settleMs || now - oldest >= TASK_NOTICE.urgentMaxMs))
      || (!atWork.length && now - newest >= TASK_NOTICE.quietMs)
      || now - oldest >= TASK_NOTICE.maxWaitMs;
    if (!due || await deps.busy?.(threadId).catch((cause: unknown) => { deps.log(`relay: busy check unreadable, thread skipped: ${cause instanceof Error ? cause.message : String(cause)}`); return true; })) continue;
    // Results wait for the project-life commit (FeedGen 2026-10-23: the PM pushed, then PROGRESS landed on main unpushed), a blocked task does not.
    if (!urgent && now - oldest < TASK_NOTICE.bookkeepingMaxMs && await deps.bookkeeping?.(rows).catch((cause: unknown) => { deps.log(`relay: bookkeeping check unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return false; })) continue;
    try {
      await deps.send(threadId, await noticeText(deps, rows, atWork, satisfied));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // An archived PM chat never reads its results, and BB answers 409 to every try: the results are dropped at once.
      // Before, each such chat was tried every 30 s for a day (about 2 850 warnings per chat on the hub, 2026-10-13..20).
      if (/archived/i.test(message)) {
        await deps.markReported?.(rows);
        deps.log(`relay: ${threadId} is archived; its ${rows.length} task result(s) are dropped`);
        continue;
      }
      deps.log(`relay: could not tell ${threadId} its task results: ${message}`);
      continue;
    }
    await deps.markReported?.(rows);
    for (const item of satisfied) { item.firedAt = now; item.firedBy = "tasks"; await dropQueuedRow(item); }
    deps.log(`relay: told ${threadId} ${rows.length} task result(s)${satisfied.length ? `, closed ${satisfied.length} reminder(s)` : ""}`);
    sent++;
  }
  return sent;
}
