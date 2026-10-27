import type { RunRow, ScheduleRow } from "./store";

/**
 * A workflow run ends `succeeded` also on the branches that did not do the job (the owner said no, Elba showed a login wall, the
 * send failed): audit 2026-10-08 round 4, item 16. The schedule counts those as failed. A chain that says which final statuses prove
 * it (`live_success`) is judged by that; any other chain by this list of statuses that never mean «done».
 */
export const FAILED_FINAL_STATUSES: readonly string[] = ["aborted", "blocked", "failed", "failure", "error", "send_failed", "send_unconfirmed", "rolled_back"];

export type FinalRule = { output: string; in: readonly string[] } | null | undefined;

/** The rule a run's pinned definition declares (`live_success`), or null when it has none or the text is not a definition. */
export function finalRuleOf(definitionJson: string | null | undefined): FinalRule {
  try {
    const rule = (JSON.parse(definitionJson ?? "null") as { live_success?: { output?: unknown; in?: unknown } } | null)?.live_success;
    if (rule && Array.isArray(rule.in) && rule.in.every((item) => typeof item === "string")) return { output: typeof rule.output === "string" ? rule.output : "status", in: rule.in as string[] };
  } catch { /* not a definition: no rule */ }
  return null;
}

/** Whether the final output of a succeeded workflow run is a finished job; when it is not, why (one line). */
export function workflowFinish(output: Record<string, unknown> | null | undefined, rule: FinalRule): { ok: true } | { ok: false; status: string; detail: string } {
  const field = rule?.output ?? "status";
  const raw = output?.[field];
  const status = typeof raw === "string" ? raw : "";
  const bad = rule ? !rule.in.includes(status) : FAILED_FINAL_STATUSES.includes(status);
  if (!bad) return { ok: true };
  const reason = typeof output?.reason === "string" && output.reason ? `: ${output.reason}` : "";
  return { ok: false, status: status || "none", detail: `the chain ended with ${field} «${status || "none"}»${reason}`.slice(0, 500) };
}

/** The one message to the PM chat after a failed scheduled run; it says the schedule is paused when this failure paused it. */
export function scheduleFailureNotice(schedule: Pick<ScheduleRow, "name" | "consecutive_failures">, run: Pick<RunRow, "status" | "error" | "reason">, paused: boolean): string {
  const what = `Lane Pilot schedule «${schedule.name}» ${run.status === "timed_out" ? "timed out" : "failed"}: ${(run.error ?? run.reason ?? "no detail").slice(0, 300)}`;
  const times = schedule.consecutive_failures;
  return paused
    ? `${what}\nIt failed ${times} times in a row and is paused. Open the schedule board to look at the history and resume it.`
    : `${what}\nIt failed ${times} time${times === 1 ? "" : "s"} in a row; it keeps running until it has failed too often in a row, then the schedule pauses itself. The history is on the schedule board.`;
}

/**
 * The outcome a scheduled `agent` run ends with, and the history block of the next run. The agent closes its report with
 *
 *     OUTCOME
 *     summary: <one line: what you found>
 *     decision: <what you decided and did>
 *     follow-ups: <what the next run should check, or none>
 *     code-change: <the code change the project needs, or none>
 *     urgent: yes|no
 *     status: done | blocked: <why>
 *
 * The scheduler keeps the whole report as the run's output; this block is read back from its end, so the next run sees what the
 * last ones found and did without a second column to keep in step.
 */
export type AgentOutcome = { summary: string; decision: string; followUps: string; codeChange: string; urgent: boolean; status: "done" | "blocked"; blockedReason: string };

export const AGENT_OUTCOME_FORMAT = [
  "OUTCOME",
  "summary: <one line: what you found>",
  "decision: <what you decided and did, in a line or two>",
  "follow-ups: <what the next run should check or do, or none>",
  "code-change: <the code change this project needs, or none>",
  "urgent: yes|no",
  "status: done   (or: status: blocked: <what is needed>)",
];

const FIELD = /^\s*[-*]?\s*(summary|decision|follow[-_ ]?ups?|code[-_ ]?change|urgent|status)\s*:\s*(.*)$/iu;
const NONE = /^(none|no|nothing|n\/a|-|—|нет|ничего)\.?$/iu;

/**
 * What the scheduler did with a code change the agent named: the run's output ends with `HAND-OVER: <road> <id>` when Lane Pilot took it
 * (a phase, issue-quick, issue-batch), so the next run's history shows it and the same change is not handed over twice.
 */
const HAND_OVER_LINE = /^\s*HAND-OVER:/u;
export type HandOver = { state: "started"; via: string; id: string } | { state: "repeat" } | { state: "none"; reason: string };
export const handOverTrailer = (via: string, id: string): string => `HAND-OVER: ${via} ${id}`;
export function parseHandOver(report: string | null | undefined): { via: string; id: string } | null {
  const match = /^\s*HAND-OVER:\s*(\S+)\s+(\S+)\s*$/mu.exec(report ?? "");
  return match ? { via: match[1]!, id: match[2]! } : null;
}
const sameWork = (left: string, right: string) => left.toLowerCase().replace(/\s+/gu, " ").replace(/[.\s]+$/u, "").trim() === right.toLowerCase().replace(/\s+/gu, " ").replace(/[.\s]+$/u, "").trim();
/** Whether the run before this one handed over the very same change (same text), so this run does not start it again. */
export function alreadyHandedOver(previous: Pick<RunRow, "output"> | undefined, codeChange: string): boolean {
  if (!previous || !parseHandOver(previous.output)) return false;
  const before = parseAgentOutcome(previous.output)?.codeChange ?? "";
  return before !== "" && sameWork(before, codeChange);
}

/** The outcome block at the end of an agent's report, or null when it has no `OUTCOME` line or no summary. */
export function parseAgentOutcome(report: string | null | undefined): AgentOutcome | null {
  const lines = (report ?? "").split("\n");
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) if (/^[\s`*#>_]*OUTCOME[\s`*:_]*$/iu.test(lines[index]!)) { start = index; break; }
  if (start < 0) return null;
  const fields = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (HAND_OVER_LINE.test(line)) break;
    const match = FIELD.exec(line.replace(/`+/gu, ""));
    if (match) { current = match[1]!.toLowerCase().replace(/[-_ ]/gu, "").replace(/^followups$/u, "followup"); fields.set(current, match[2]!.trim()); }
    else if (current && line.trim()) fields.set(current, `${fields.get(current)} ${line.trim()}`.trim());
  }
  const summary = fields.get("summary") ?? "";
  if (!summary) return null;
  const status = fields.get("status") ?? "done";
  const blocked = /^blocked\b/iu.test(status);
  const none = (value: string | undefined) => (!value || NONE.test(value.trim()) ? "" : value.trim());
  return {
    summary: summary.slice(0, 400), decision: none(fields.get("decision")).slice(0, 600), followUps: none(fields.get("followup")).slice(0, 600), codeChange: none(fields.get("codechange")).slice(0, 1500),
    urgent: /^(yes|true|да)\b/iu.test(fields.get("urgent") ?? ""), status: blocked ? "blocked" : "done",
    blockedReason: blocked ? status.replace(/^blocked\s*:?\s*/iu, "").trim().slice(0, 400) || "blocked without a reason" : "",
  };
}

/** The «previous runs» block of an agent's first message: newest first, each with its time, state and what it reported. Empty text when there are no runs. */
export function agentHistoryBlock(runs: ReadonlyArray<Pick<RunRow, "scheduled_at" | "status" | "output" | "error" | "reason">>, maxChars = 9000): string {
  const entries: string[] = [];
  let used = 0;
  for (const run of runs) {
    const outcome = parseAgentOutcome(run.output);
    const head = `- ${new Date(run.scheduled_at).toISOString().replace(/:\d\d\.\d{3}Z$/u, "Z")} · ${run.status}`;
    const body = outcome
      ? [`  summary: ${outcome.summary}`, outcome.decision && `  decision: ${outcome.decision}`, outcome.followUps && `  follow-ups: ${outcome.followUps}`, outcome.codeChange && `  code change needed: ${outcome.codeChange}`,
        outcome.status === "blocked" && `  blocked: ${outcome.blockedReason}`]
      : [`  no structured outcome${run.error ? `: ${run.error.slice(0, 300)}` : run.reason ? `: ${run.reason.slice(0, 300)}` : ""}${run.output ? `; the end of its report: ${run.output.trim().slice(-300).replace(/\s+/gu, " ")}` : ""}`];
    const handed = parseHandOver(run.output);
    const entry = [head, ...body.filter(Boolean), ...(handed ? [`  handed over to Lane Pilot: ${handed.via} ${handed.id} (do not name this change again unless it changed)`] : [])].join("\n");
    if (used + entry.length > maxChars) break;
    used += entry.length;
    entries.push(entry);
  }
  return entries.join("\n");
}

/** The owner's morning line for a finished agent run (Russian, like the other lines of the list). */
export function agentOwnerLine(schedule: Pick<ScheduleRow, "id" | "name">, agentId: string, outcome: AgentOutcome, handOver: HandOver = { state: "none", reason: "" }): { what: string; why: string } {
  const code = !outcome.codeChange ? "" : handOver.state === "started" ? `Нужна правка кода: ${outcome.codeChange} Передано Lane Pilot (${handOver.via} ${handOver.id}); агент код не трогает.`
    : handOver.state === "repeat" ? `Нужна та же правка кода, что и в прошлый запуск (уже передана Lane Pilot): ${outcome.codeChange}`
    : `Нужна правка кода (агент её не делает${handOver.reason ? `, Lane Pilot её не взял: ${handOver.reason}` : ""}; передай её в Lane Pilot): ${outcome.codeChange}`;
  const parts = [
    outcome.status === "blocked" ? `Агент остановился: ${outcome.blockedReason}.` : outcome.decision && `Решение: ${outcome.decision}`,
    outcome.followUps && `Дальше: ${outcome.followUps}`,
    code,
    `Расписание ${schedule.id}: bb lane-pilot schedule show ${schedule.id}. Ничего не ждёт тебя.`,
  ];
  return { what: `«${schedule.name}» (${agentId}): ${outcome.summary}`, why: parts.filter(Boolean).join(" ") };
}
