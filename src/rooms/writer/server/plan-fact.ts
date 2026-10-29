import { taskFamily } from "../../runs";
import { runOnHost } from "@lane-pilot/host-calls";
import { readWires, wiresCommand } from "../../wires";
import type { TaskV2 } from "../../contracts";
import type { ServerCore } from "../../core/server";
import { deleteStageReceipt, getRunSettingsScopes, getStageReceiptResult, getTask, getTaskGitBase, loadProjectSettings } from "../../storage";
import { recordStage } from "../../runs/server";
import { NO_CODE_KINDS, PLAN_FACT_RULES, blindPlanFact, diffHunksCommand, existsCommand, existsFromCommandOutput, hunksFromCommandOutput, parsePlanFact, planFactOutcome, sha256, untouchedCitations } from "../../tasks";
import type { ItemVerdict, PlanFactCheck, PlanFactFacts, PlanFactTable } from "../../tasks";

export const PLAN_FACT_MODE_SETTING = "plan_fact.mode";
export type PlanFactMode = "record" | "gate";
/** `record` (default) writes the stage and shows it on the acceptance card; `gate` also sends an unproven acceptance item back to the writer. */
export const planFactMode = (settings: Record<string, unknown>): PlanFactMode => settings[PLAN_FACT_MODE_SETTING] === "gate" ? "gate" : "record";

const MAX_DIFF_PATHS = 100;

/** The table of the first answer that has a readable one; an answer without a table falls back to the earlier one (a repair round's short reply). */
export function tableFromAnswers(answers: readonly string[]): PlanFactTable {
  let first: PlanFactTable = { status: "missing" };
  for (const answer of answers) {
    const table = parsePlanFact(answer);
    if (table.status === "ok") return table;
    if (first.status === "missing") first = table;
  }
  return first;
}

/**
 * The plan→fact stage of an accepted candidate: reads the writer's table, checks every piece of evidence against the diff and the
 * check results (never the writer's prose), and records the code-decided result as the `plan-fact` receipt. A missing or unreadable
 * table is a skipped stage with its reason in `record` mode. Returns the refusal reason only in `gate` mode: for an acceptance item
 * with no evidence that holds, or for a code task with acceptance items and no readable table.
 */
/** The git base of the first accepted member of a redo's family in the run, or undefined for a task that is no redo. */
function familyBase(db: ServerCore["db"], runId: string, taskId: string) {
  const family = taskFamily(taskId);
  if (family === taskId) return undefined;
  const first = (db.prepare("SELECT DISTINCT task_id FROM lane_pilot_attempt WHERE run_id=? AND state='accepted' ORDER BY created_at").all(runId) as Array<{ task_id: string }>)
    .map((row) => row.task_id).find((id) => id !== taskId && taskFamily(id) === family);
  return first ? getTaskGitBase(db, first) : undefined;
}

/**
 * Files the earlier merged members of a redo's family changed. Their work is already in the redo's base, so a redo that re-proves it
 * cites those files without touching them again (live ph_26f65b142d, hud-lvlabel-gap.2: «game/tests/lvbar_spec.luau is not among the
 * changed files», the file hud-lvlabel-gap had changed, and the phase stopped on an unproved promise).
 */
function familyPaths(db: ServerCore["db"], runId: string, taskId: string): string[] {
  const family = taskFamily(taskId);
  if (family === taskId) return [];
  const rows = db.prepare("SELECT task_id, changed_json FROM lane_pilot_attempt_change WHERE run_id=? AND outcome='merged'").all(runId) as Array<{ task_id: string; changed_json: string }>;
  const paths = new Set<string>();
  for (const row of rows) {
    if (row.task_id === taskId || taskFamily(row.task_id) !== family) continue;
    try { for (const entry of JSON.parse(row.changed_json) as Array<{ path?: unknown }>) if (typeof entry?.path === "string") paths.add(entry.path); } catch { /* an unreadable row adds nothing */ }
  }
  return [...paths];
}

export async function runPlanFactStage(ctx: ServerCore, input: {
  projectId: string; runId: string; taskId: string; attempt: number; hostId: string; task: TaskV2;
  answers: readonly string[]; produced: readonly string[]; verification: ReadonlyArray<{ command: string; exitCode: number }>;
}): Promise<{ refusal: string | null; check: PlanFactCheck; state: "passed" | "failed" | "skipped" }> {
  const { db, host, bb } = ctx;
  const table = tableFromAnswers(input.answers);
  const gitBaseFamily = familyBase(db, input.runId, input.taskId);
  const produced = [...new Set([...input.produced, ...(gitBaseFamily ? familyPaths(db, input.runId, input.taskId) : [])])];
  let hunks: Pick<PlanFactFacts, "hunksKnown" | "changed"> = { hunksKnown: false, changed: {} };
  const lineCount: Record<string, number> = {};
  // A working-tree base (compare_committed off) records no base commit, only the head the writer started from: the diff is against it.
  // A redo of a piece whose earlier member was accepted (piece.2 after piece): the piece's work is already merged, so the redo's own
  // diff holds little of it. The family's base is the base, so lines this same piece wrote earlier count as its proof (live
  // ph_ae0a8de9db: the redo's evidence in scripts/notes.js was «not in a changed hunk»).
  const gitBase = gitBaseFamily ?? getTaskGitBase(db, input.taskId);
  const base = gitBase ? gitBase.base_sha ?? gitBase.initial_head_sha : null;
  if (table.status === "ok" && base && produced.length > 0 && produced.length <= MAX_DIFF_PATHS) {
    try {
      const out = await runOnHost(host, { hostId: input.hostId, cwd: input.task.project_cwd, command: diffHunksCommand(base, produced), timeoutSec: 30 });
      hunks = hunksFromCommandOutput(out.stdout, produced);
    } catch { /* hunks stay unknown: the report says the lines were not checked */ }
    const cited = new Set(table.rows.flatMap((row) => row.evidence ?? []).map((entry) => /^(.+?)(?::\d+(?:-\d+)?)?$/.exec(entry.trim())?.[1] ?? ""));
    for (const [path, ranges] of Object.entries(hunks.changed)) {
      if (ranges !== "all" || !cited.has(path)) continue;
      const file = await bb.sdk.files.read({ hostId: input.hostId, rootPath: input.task.project_cwd, path: `${input.task.project_cwd}/${path}` }).catch(() => null);
      if (file && typeof file.content === "string") lineCount[path] = file.content.split("\n").length;
    }
  }
  // A file the table cites but the candidate did not change is shown to exist before an "unchanged" item may rest on it; unread, nothing is known.
  let exists: Record<string, boolean> | undefined;
  const cited = table.status === "ok" ? untouchedCitations(table.rows, produced, input.task.project_cwd) : [];
  if (cited.length) {
    try { exists = existsFromCommandOutput((await runOnHost(host, { hostId: input.hostId, cwd: input.task.project_cwd, command: existsCommand(cited), timeoutSec: 30 })).stdout, cited); } catch { /* unknown: the report says so */ }
  }
  const check = blindPlanFact(input.task.acceptance, table, {
    produced, ...hunks, lineCount, ...(exists ? { exists } : {}), root: input.task.project_cwd,
    contractCommands: input.task.verification.map((row) => row.command), ran: input.verification,
  });
  if (input.task.wires?.length) {
    const ran = await runOnHost(host, { hostId: input.hostId, cwd: input.task.project_cwd, command: wiresCommand(input.task.wires), timeoutSec: 60 }).catch(() => null);
    if (ran) check.wires = readWires(input.task.wires, ran.stdout);
    else check.notChecked.push("wires: the search in the worktree could not run, so the declared wires were not checked");
  }
  if (table.status === "ok" && base === null) check.notChecked.push("line ranges: the task has no recorded base commit (a folder without git), so only the files were checked");
  const mode = planFactMode(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)));
  // In gate mode a code task that promises something must hand in a readable table: «not checked» is not «proved».
  const outcome = planFactOutcome(check, mode === "gate" && input.task.acceptance.length > 0 && !NO_CODE_KINDS.has(input.task.kind ?? ""));
  // A retry of the task reaches this stage again with a new answer: the receipt is the latest one, its earlier events stay.
  deleteStageReceipt(db, input.runId, input.taskId, "plan-fact");
  recordStage(db, {
    runId: input.runId, taskId: input.taskId, stageId: "plan-fact", state: outcome.state, attempt: input.attempt,
    input: JSON.stringify({ answerSha256: sha256(input.answers[0] ?? ""), acceptance: input.task.acceptance, produced, base }),
    result: { ...check, mode, base, rules: PLAN_FACT_RULES }, reason: outcome.reason,
  });
  return { refusal: mode === "gate" && outcome.state === "failed" ? outcome.reason : null, check, state: outcome.state };
}

/** The writer's table as the check read it, from a receipt's items: a recheck weighs the same evidence, not a new answer. */
export function tableFromItems(items: ReadonlyArray<Pick<ItemVerdict, "item" | "claimed" | "evidence" | "why">>): string {
  const rows = items.filter((item) => item.claimed !== "none").map((item) => item.claimed === "not_done"
    ? { item: item.item, status: "not_done", why: item.why ?? "not done" }
    : { item: item.item, status: "done", evidence: item.evidence.map((entry) => entry.evidence), ...(item.why ? { why: item.why } : {}) });
  return "```plan-fact\n" + JSON.stringify(rows) + "\n```";
}

/**
 * A failed plan-fact receipt written by older rules of the check (PLAN_FACT_RULES), weighed again by the current ones without the
 * writer: the same table, the files and the check results of the task's verification receipt, the diff read again. Once per receipt:
 * the new one carries the current rules. Null when there is nothing to weigh again.
 */
export async function recheckPlanFact(ctx: ServerCore, input: { projectId: string; runId: string; taskId: string; hostId: string }): Promise<"passed" | "failed" | "skipped" | null> {
  const row = ctx.db.prepare("SELECT state, attempt FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id='plan-fact'").get(input.runId, input.taskId) as { state: string; attempt: number } | undefined;
  if (row?.state !== "failed") return null;
  const old = getStageReceiptResult(ctx.db, input.runId, input.taskId, "plan-fact").result as { rules?: number; table?: string; items?: ItemVerdict[] } | null;
  if (!old || (old.rules ?? 1) >= PLAN_FACT_RULES || old.table !== "ok" || !old.items?.length) return null;
  const task = getTask(ctx.db, input.taskId)?.contract as TaskV2 | undefined;
  if (!task?.acceptance?.length || !task.project_cwd) return null;
  const checked = getStageReceiptResult(ctx.db, input.runId, input.taskId, "verification").result as { produced?: string[]; verification?: Array<{ command: string; exitCode: number }> } | null;
  const { state } = await runPlanFactStage(ctx, { projectId: input.projectId, runId: input.runId, taskId: input.taskId, attempt: row.attempt, hostId: input.hostId, task,
    answers: [tableFromItems(old.items)], produced: checked?.produced ?? [], verification: (checked?.verification ?? []).map(({ command, exitCode }) => ({ command, exitCode })) });
  return state;
}
