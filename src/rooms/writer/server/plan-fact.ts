import { runOnHost } from "@lane-pilot/host-calls";
import type { TaskV2 } from "../../contracts";
import type { ServerCore } from "../../core/server";
import { deleteStageReceipt, getRunSettingsScopes, getTaskGitBase, loadProjectSettings } from "../../storage";
import { recordStage } from "../../runs/server";
import { blindPlanFact, diffHunksCommand, hunksFromCommandOutput, parsePlanFact, planFactOutcome, sha256 } from "../../tasks";
import type { PlanFactCheck, PlanFactFacts, PlanFactTable } from "../../tasks";

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
 * table is a skipped stage with its reason, never a refusal. Returns the refusal reason only in `gate` mode, for an acceptance item
 * with no evidence that holds.
 */
export async function runPlanFactStage(ctx: ServerCore, input: {
  projectId: string; runId: string; taskId: string; attempt: number; hostId: string; task: TaskV2;
  answers: readonly string[]; produced: readonly string[]; verification: ReadonlyArray<{ command: string; exitCode: number }>;
}): Promise<{ refusal: string | null; check: PlanFactCheck }> {
  const { db, host, bb } = ctx;
  const table = tableFromAnswers(input.answers);
  const produced = [...input.produced];
  let hunks: Pick<PlanFactFacts, "hunksKnown" | "changed"> = { hunksKnown: false, changed: {} };
  const lineCount: Record<string, number> = {};
  const base = getTaskGitBase(db, input.taskId)?.base_sha ?? null;
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
  const check = blindPlanFact(input.task.acceptance, table, {
    produced, ...hunks, lineCount, root: input.task.project_cwd,
    contractCommands: input.task.verification.map((row) => row.command), ran: input.verification,
  });
  if (table.status === "ok" && base === null) check.notChecked.push("line ranges: the task has no recorded base commit (a folder without git), so only the files were checked");
  const outcome = planFactOutcome(check);
  const mode = planFactMode(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)));
  // A retry of the task reaches this stage again with a new answer: the receipt is the latest one, its earlier events stay.
  deleteStageReceipt(db, input.runId, input.taskId, "plan-fact");
  recordStage(db, {
    runId: input.runId, taskId: input.taskId, stageId: "plan-fact", state: outcome.state, attempt: input.attempt,
    input: JSON.stringify({ answerSha256: sha256(input.answers[0] ?? ""), acceptance: input.task.acceptance, produced, base }),
    result: { ...check, mode, base }, reason: outcome.reason,
  });
  return { refusal: mode === "gate" && outcome.state === "failed" ? outcome.reason : null, check };
}
