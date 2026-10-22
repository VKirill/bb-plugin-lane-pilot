import type { AcceptanceCard } from "../contracts";
import { getTask, getTaskGitBase, listStageReceipts } from "../storage";
import type { LanePilotDatabase } from "../storage";
import { STAGE_PROOF, isAdvisoryProof } from "../tasks";
import type { StageId } from "../tasks";
import { attemptMetrics } from "../usage/server";
import { getBaseline } from "../baseline";

/**
 * The acceptance card of a task (SMA plan P1-4): everything that says why it was accepted or not, from records that already exist —
 * the contract, the stage receipts with what decided each (code or a model's opinion), the gate events, the plan→fact table with the
 * blind check's verdicts, the stages that did not run, the risk, the base commit and the cost. A stage with no receipt, or a skipped
 * one, is listed as not run: that is not «no findings».
 */
const PIPELINE: StageId[] = ["pm-read", "plan-critique", "run-gate", "specialist-review", "writer-agent", "verification", "code-critique", "plan-fact", "acceptance-receipt"];
const NOT_RUN_HINT: Partial<Record<StageId, string>> = {
  "plan-critique": "no receipt: the plan critic did not run for this task",
  "specialist-review": "no receipt: no specialist review was asked for",
  "code-critique": "no receipt: the code critic did not run (code_critique.enabled, critic.code.default_for_risk and quality_mode decide)",
  "plan-fact": "no receipt: the attempt ended before the plan→fact check, or it ran on a version without it",
};
const clip = (text: string | null, max = 600) => (text ? text.replace(/\s+/g, " ").trim().slice(0, max) : null);
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function buildAcceptanceCard(db: LanePilotDatabase, input: { runId: string; taskId: string }): AcceptanceCard | null {
  const task = getTask(db, input.taskId);
  const run = db.prepare("SELECT project_id FROM lane_pilot_run WHERE id=?").get(input.runId) as { project_id: string } | undefined;
  if (!task || !run) return null;
  const contract = asObject(task.contract);
  const receipts = listStageReceipts(db, input.runId, input.taskId);
  const byStage = new Map(receipts.map((row) => [row.stageId, row]));

  const planFactReceipt = byStage.get("plan-fact");
  const stored = asObject(planFactReceipt?.result);
  const planFact: AcceptanceCard["planFact"] = planFactReceipt ? {
    state: planFactReceipt.state,
    table: stored.table === "ok" || stored.table === "invalid" ? stored.table : "missing",
    reason: clip(stored.tableReason as string | null ?? null, 300) ?? clip(planFactReceipt.reason, 300),
    mode: stored.mode === "gate" ? "gate" : "record",
    items: Array.isArray(stored.items) ? stored.items as NonNullable<AcceptanceCard["planFact"]>["items"] : [],
    extraRows: Array.isArray(stored.extraRows) ? (stored.extraRows as unknown[]).filter((value): value is number => typeof value === "number") : [],
    notChecked: strings(stored.notChecked),
    ...(Array.isArray(stored.wires) ? { wires: (stored.wires as Array<{ chain?: unknown; broken?: { from?: unknown; to?: unknown } | null }>).map((wire) => ({
      chain: strings(wire.chain), broken: wire.broken ? { from: String(wire.broken.from ?? ""), to: String(wire.broken.to ?? "") } : null,
    })) } : {}),
  } : null;

  const notRun: AcceptanceCard["notRun"] = [];
  for (const stageId of PIPELINE) {
    const row = byStage.get(stageId);
    if (!row) notRun.push({ stageId, why: NOT_RUN_HINT[stageId] ?? "no receipt" });
    else if (row.state === "skipped") notRun.push({ stageId, why: clip(row.reason, 300) ?? "skipped" });
  }
  for (const line of planFact?.notChecked ?? []) notRun.push({ stageId: "plan-fact", why: line });

  const gates = (db.prepare("SELECT gate, status, attempt, occurred_at FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? ORDER BY id").all(input.runId, input.taskId) as
    Array<{ gate: string; status: string; attempt: number; occurred_at: number }>).map((row) => ({ gate: row.gate, status: row.status, attempt: row.attempt, at: row.occurred_at }));

  const base = getTaskGitBase(db, input.taskId);
  const metrics = attemptMetrics(db, { projectId: run.project_id, days: 365, taskId: input.taskId }).attempts;
  const measured = metrics.filter((row) => row.costState === "measured");
  const usd = measured.length ? measured.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) : null;
  const note = metrics.find((row) => row.costState !== "measured")?.costNote ?? null;

  const baseline = getBaseline(db, input.runId, input.taskId);
  return {
    contract: { objective: typeof contract.objective === "string" ? contract.objective : null, acceptance: strings(contract.acceptance), ownsPaths: strings(contract.owns_paths) },
    risk: typeof contract.risk === "string" ? contract.risk : null,
    base: base ? { ref: base.base_ref, sha: base.base_sha ?? base.initial_head_sha, branch: base.branch, compareCommitted: base.compare_committed } : null,
    receipts: PIPELINE.flatMap((stageId) => {
      const row = byStage.get(stageId);
      if (!row) return [];
      const proof = STAGE_PROOF[stageId];
      return [{ stageId, state: row.state, proof: isAdvisoryProof(proof) ? "advisory" as const : "code" as const, proofKind: proof.kind, reason: clip(row.reason), model: row.model, updatedAt: row.updatedAt }];
    }),
    gates, planFact, notRun,
    baseline: baseline ? {
      state: baseline.state, verdict: baseline.verdict, action: baseline.action, mode: baseline.mode, summary: baseline.summary, baseSha: baseline.baseSha, at: baseline.at,
      checks: baseline.checks.map((check) => ({ command: check.command, status: check.status, note: clip(check.note, 300) ?? "", cached: check.cached === true })),
      turnedRed: baseline.after ? baseline.after.turnedRed : null,
    } : null,
    cost: {
      state: !metrics.length || !measured.length ? "not_measured" : measured.length === metrics.length ? "measured" : "partial",
      usd, tokens: measured.length ? measured.reduce((sum, row) => sum + (row.tokens?.total ?? 0), 0) : null,
      note, attempts: metrics.length, measured: measured.length,
    },
  };
}
