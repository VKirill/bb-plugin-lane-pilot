import { taskRedispatchBase } from "@lane-pilot/contracts";
import { buildAcceptanceCard } from "../../acceptance/server";
import { listAttemptChanges } from "../../rollback";
import { readTaskCard } from "../../runs/server";
import { getRun, listBbTaskRowsForRun, taskTimelineRow } from "../../storage";
import type { LanePilotDatabase } from "../../storage";

/**
 * A task's record for another agent (the hand-off standard, docs/guide/handoff.md: the read side). What the task asked for, what the
 * server saw done and what is left, from records that already exist: the contract, the plan, the attempts' changed files, the
 * plan-against-fact table and the stage receipts. A writer whose task depends on this one reads it instead of a PM's retelling.
 *
 * Only what the server recorded is in it. The writer's own final message stays in its thread (the id is given): a claim is in the
 * record only where the plan-against-fact check judged it.
 */
export const TASK_RECORD_USAGE = "bb lane-pilot task <task-id> [--run <run-id>] [--plan] [--json]   (what the task asked for, what was done, what is left; --plan prints the whole plan)";

/** The stages that judge a task. A thread running one of them on this task reads the record blind: what was asked and what the
 *  server saw changed, not the verdicts of the other judges and not the writer's claims (a reviewer that reads them agrees with them). */
const REVIEWER_STAGES: ReadonlySet<string> = new Set(["plan-critique", "code-critique", "specialist-review"]);
export const readsBlind = (record: TaskRecord, threadId: string | null | undefined): boolean =>
  !!threadId && record.stages.some((stage) => stage.threadId === threadId && REVIEWER_STAGES.has(stage.id));

const PLAN_HEAD = 3_000;
const FILES_SHOWN = 60;

export type TaskRecord = NonNullable<ReturnType<typeof taskRecord>>;

export function taskRecord(db: LanePilotDatabase, taskId: string, runId?: string) {
  const row = taskTimelineRow(db, taskId, runId);
  if (!row) return null;
  const card = readTaskCard(db, { runId: row.run_id, taskId });
  if (!card || card.kind !== "task" || !card.contract) return null;
  const acceptance = buildAcceptanceCard(db, { runId: row.run_id, taskId });
  const changes = listAttemptChanges(db, taskId);
  // `P1`, `P1.2`, `P1.2.2` are one task sent again: a depends_on that names `P1` means the latest of them (the writer's wait reads it so).
  const latest = listBbTaskRowsForRun(db, row.run_id).find((other) => taskRedispatchBase(other.id) === taskRedispatchBase(taskId))?.id;
  return {
    taskId, runId: row.run_id, projectId: getRun(db, row.run_id)?.project_id ?? card.projectId, title: card.title, state: card.state, reason: card.reason,
    closedWords: row.closed_words,
    resentAs: latest && latest !== taskId ? latest : null,
    contract: card.contract,
    plan: card.plan,
    attempts: card.attempts.map((attempt) => {
      const change = changes.find((item) => item.attemptId === attempt.id);
      return { no: attempt.no, state: attempt.state, reason: attempt.reason, threadId: attempt.threadId,
        outcome: change?.outcome ?? null, baseSha: change?.baseSha ?? null, mergeCommit: change?.mergeCommit ?? null, changed: change?.changed ?? [] };
    }).sort((a, b) => a.no - b.no),
    planFact: acceptance?.planFact ? { state: acceptance.planFact.state, items: acceptance.planFact.items.map((item) => ({ acceptance: item.acceptance, claimed: item.claimed, verdict: item.verdict, why: item.why })),
      notChecked: acceptance.planFact.notChecked } : null,
    stages: card.stages.map((stage) => ({ id: stage.id, state: stage.state, reason: stage.reason, threadId: stage.threadId })),
    notRun: acceptance?.notRun ?? [],
  };
}

const bullets = (label: string, items: readonly string[]) => items.length ? [`${label}:`, ...items.map((item) => `- ${item}`)] : [];

/** The record with what a judge of this task must not read taken out (see REVIEWER_STAGES). */
export const blindRecord = (record: TaskRecord): TaskRecord => ({ ...record, reason: null, planFact: null, notRun: [],
  stages: [],
  attempts: record.attempts.map((attempt) => ({ ...attempt, reason: null, threadId: null })) });

/** The record as text an agent reads: short by default, the plan cut to its head unless `fullPlan`. */
export function renderTaskRecord(record: TaskRecord, opts: { fullPlan?: boolean } = {}): string {
  const plan = record.plan?.trim() ?? "";
  const planCut = !opts.fullPlan && plan.length > PLAN_HEAD;
  const done = record.attempts.filter((attempt) => attempt.changed.length || attempt.mergeCommit);
  const open = record.planFact?.items.filter((item) => item.verdict !== "proven") ?? [];
  return [
    `Task ${record.taskId}: ${record.title}`,
    `run ${record.runId} · state ${record.state}${record.reason ? ` (${record.reason})` : ""}${record.closedWords ? ` · closed by the PM: ${record.closedWords}` : ""}`,
    ...(record.resentAs ? [`This task was sent again as ${record.resentAs}: its work is there (bb lane-pilot task ${record.resentAs}).`] : []),
    "",
    "## What it asked for",
    ...(record.contract.objective ? [record.contract.objective] : []),
    ...bullets("acceptance", record.contract.acceptance),
    ...(record.contract.ownsPaths.length ? [`owns_paths: ${record.contract.ownsPaths.join(", ")}`] : []),
    ...(record.contract.dependsOn.length ? [`depends_on: ${record.contract.dependsOn.join(", ")} (read each with bb lane-pilot task <id>)`] : []),
    ...(plan ? ["", "## Plan", planCut ? `${plan.slice(0, PLAN_HEAD)}\n[… ${plan.length - PLAN_HEAD} more characters: add --plan …]` : plan] : []),
    "",
    "## What the server saw done",
    ...(done.length ? done.flatMap((attempt) => [
      `attempt ${attempt.no}: ${attempt.outcome ?? attempt.state}${attempt.mergeCommit ? `, merged as ${attempt.mergeCommit.slice(0, 12)}` : ""}${attempt.baseSha ? ` on base ${attempt.baseSha.slice(0, 12)}` : ""}`,
      ...attempt.changed.slice(0, FILES_SHOWN).map((file) => `  ${file.status} ${file.path}`),
      ...(attempt.changed.length > FILES_SHOWN ? [`  … and ${attempt.changed.length - FILES_SHOWN} more files (bb lane-pilot changes ${record.taskId})`] : []),
    ]) : ["no change of an attempt is on record"]),
    ...(record.planFact ? ["", `## Acceptance against fact (${record.planFact.state})`,
      ...record.planFact.items.map((item) => `- [${item.verdict}] ${item.acceptance}${item.why ? ` — ${item.why}` : ""}`)] : []),
    ...(record.stages.length ? ["", "## Stages"] : []),
    ...record.stages.map((stage) => `- ${stage.id}: ${stage.state}${stage.reason ? ` (${stage.reason})` : ""}`),
    ...(record.notRun.length ? ["did not run (not the same as no findings):", ...record.notRun.map((row) => `- ${row.stageId}: ${row.why}`)] : []),
    "",
    "## What is left",
    ...(record.state === "accepted" && !open.length && !(record.planFact?.notChecked.length) ? ["nothing on record: the task is accepted and every acceptance item is proven"] : [
      ...(record.state !== "accepted" ? [`the task is ${record.state}${record.reason ? `: ${record.reason}` : ""}`] : []),
      ...open.map((item) => `- not proven: ${item.acceptance}`),
      ...(record.planFact?.notChecked ?? []).map((line) => `- not checked: ${line}`),
    ]),
    ...(record.attempts.at(-1)?.threadId ? ["", `The writer's own words are in its thread: @thread:${record.attempts.at(-1)!.threadId}`] : []),
  ].join("\n");
}
