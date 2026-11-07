import { createHash } from "node:crypto";
import { openRegressionBriefs } from "../../baseline";
import type Database from "better-sqlite3";
import packageJson from "../../../../package.json";
import { gateRunVerdict } from "../../verification/server"
import { parseIntegrationGateSettings } from "../../contracts";
import { getAttempt, getReasoningTraceJson, getTaskContractJson, listStageReceipts, loadProjectSettings, openAttemptBriefs, latestGateRun, countLanePilotTables } from "../../storage";

/**
 * Receipts and evidence (SMA map: Receipts and evidence). Read-only assemblies over what the stages left:
 * - passport: an attempt's provider, model, harness version, Lane Pilot version and the receipts of its stages (sma passport / model);
 * - manifest: this build — version, migrations, rooms (sma manifest);
 * - chain: a task's stage receipts hashed in order, so a changed receipt shows (sma chain-tip / verify / start);
 * - preship: what is still open before a release — unmerged work, open regressions, open deferrals — each with its disposition;
 * - PR passport: the body of a pull request assembled from the task's receipts (PR passport assembler).
 */
import { listOpenDeferralBriefs } from "../../deferral/server";

type Db = Database.Database;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export function passport(db: Db, attemptId: string) {
  const row = getAttempt(db, attemptId);
  if (!row) return null;
  const attempt = { id: row.id, run_id: row.run_id, task_id: row.task_id, state: row.state, attempt_no: row.attempt_no, harness_version: row.harness_version, created_at: row.created_at };
  const trace = getReasoningTraceJson(db, attemptId);
  let model: Record<string, unknown> = {};
  try { const parsed = JSON.parse(trace ?? "{}") as Record<string, unknown>; model = { providerId: parsed.providerId ?? null, model: parsed.model ?? null, reasoning: parsed.reasoningLevel ?? null }; } catch { /* no trace */ }
  const stages = listStageReceipts(db, row.run_id, row.task_id)
    .map((stage) => ({ stage: stage.stageId, state: stage.state, input: stage.inputSha256, output: stage.outputSha256, provider: stage.providerId, model: stage.model }));
  return { attempt, ...model, lanePilot: packageJson.version, stages };
}

export function manifest(db: Db) {
  const tables = countLanePilotTables(db);
  return { name: packageJson.name, version: packageJson.version, tables, builtAt: new Date().toISOString() };
}

/** The chain of a task's stage receipts: each link the hash of the previous link and the receipt; the tip names the whole chain. */
export function receiptChain(db: Db, runId: string, taskId: string) {
  const rows = listStageReceipts(db, runId, taskId).slice().sort((a, b) => a.updatedAt - b.updatedAt || a.stageId.localeCompare(b.stageId));
  let tip = "0".repeat(64);
  const links = rows.map((row) => { tip = sha(`${tip}\n${row.stageId}\n${row.state}\n${row.inputSha256 ?? ""}\n${row.outputSha256 ?? ""}`); return { stage: row.stageId, state: row.state, link: tip }; });
  return { runId, taskId, tip, links };
}
/** Verify a chain against a tip recorded earlier: the same receipts give the same tip. */
export const verifyChain = (db: Db, runId: string, taskId: string, tip: string) => receiptChain(db, runId, taskId).tip === tip;

/** Preship / disposition: what is open before a release, and the disposition each needs (merge, fix, defer with a term). */
export function preship(db: Db, projectId?: string) {
  const open = openAttemptBriefs(db, { projectId: projectId ?? null });
  const regressions = openRegressionBriefs(db, projectId);
  const deferrals = listOpenDeferralBriefs(db, projectId);
  const items = [
    ...(open as Array<{ taskId: string; state: string }>).map((row) => ({ what: `task ${row.taskId} is ${row.state}`, disposition: row.state === "validation_failed" ? "fix or cancel" : "let it finish or cancel" })),
    ...(regressions as Array<{ taskId: string; state: string }>).map((row) => ({ what: `regression of ${row.taskId} (${row.state})`, disposition: "fix, or revert the task" })),
    ...(deferrals).map((row) => ({ what: `deferred: ${row.title ?? row.id}`, disposition: "keep with its term" })),
  ];
  // The ship gate (Astra F1): «all tasks accepted» says nothing about the post-merge check on main. Its latest run
  // still out, red or never run stops the ship; a project without a gate passes as before.
  const gate = latestGateRun(db, projectId);
  if (gate) {
    const verdict = gateRunVerdict(gate);
    if (verdict.pending) {
      items.push({ what: `integration gate is still running (${gate.command})`, disposition: "wait for its verdict, then preship again" });
    } else if (verdict.failed) {
      items.push(gate.state === "failed"
        ? { what: `integration gate is ${verdict.line} on ${gate.head ? gate.head.slice(0, 12) : "main"}`, disposition: "a failing check on main: dispatch a fix task" }
        : { what: `integration gate ${verdict.line}`, disposition: `rerun the gate: run \`${gate.command}\` on main (or merge a task to trigger it)` });
    }
  } else if (projectId) {
    // No gate run was ever recorded. An explicit command means the gate exists and has not run on this head;
    // an empty setting leaves detection to the host, which preship cannot ask — passes as today.
    const settings = parseIntegrationGateSettings(loadProjectSettings(db as never, projectId));
    if (!settings.gateOff && settings.gateCommand) {
      items.push({ what: `integration gate not run: no run of \`${settings.gateCommand}\` is recorded for this project`, disposition: `rerun the gate: run \`${settings.gateCommand}\` on main (or merge a task to trigger it)` });
    }
  }
  return { clear: items.every((item) => item.disposition === "keep with its term"), items };
}

/** PR passport assembler: a pull request body from the task's receipts — what, the checks that prove it, the critic, the plan-fact rows. */
export function prPassport(db: Db, runId: string, taskId: string): string {
  const task = getTaskContractJson(db, taskId, runId);
  const contract = JSON.parse(task ?? "{}") as { title?: string; display_title?: string; objective?: string; acceptance?: string[]; verification?: Array<{ command: string }> };
  const stages = listStageReceipts(db, runId, taskId).map((row) => ({ stage_id: row.stageId, state: row.state }));
  const chain = receiptChain(db, runId, taskId);
  return [
    `## ${contract.display_title ?? contract.title ?? taskId}`, "", contract.objective ?? "", "",
    "### Acceptance", ...(contract.acceptance ?? []).map((line) => `- ${line}`), "",
    "### Checks", ...(contract.verification ?? []).map((check) => `- \`${check.command}\``), "",
    "### Stages", ...stages.map((row) => `- ${row.stage_id}: ${row.state}`), "",
    `Receipt chain tip: \`${chain.tip.slice(0, 16)}\` (Lane Pilot ${packageJson.version})`,
  ].join("\n");
}
