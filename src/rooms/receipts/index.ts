import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import packageJson from "../../../package.json";
import { gateRunVerdict, latestGateRun, parseIntegrationGateSettings } from "../verification/server";
import { loadProjectSettings } from "../storage";

/**
 * Receipts and evidence (SMA map: Receipts and evidence). Read-only assemblies over what the stages left:
 * - passport: an attempt's provider, model, harness version, Lane Pilot version and the receipts of its stages (sma passport / model);
 * - manifest: this build — version, migrations, rooms (sma manifest);
 * - chain: a task's stage receipts hashed in order, so a changed receipt shows (sma chain-tip / verify / start);
 * - preship: what is still open before a release — unmerged work, open regressions, open deferrals — each with its disposition;
 * - PR passport: the body of a pull request assembled from the task's receipts (PR passport assembler).
 */
type Db = Pick<Database.Database, "prepare">;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export function passport(db: Db, attemptId: string) {
  const attempt = db.prepare("SELECT id, run_id, task_id, state, attempt_no, harness_version, created_at FROM lane_pilot_attempt WHERE id=?").get(attemptId) as Record<string, unknown> | undefined;
  if (!attempt) return null;
  const trace = db.prepare("SELECT trace_json FROM lane_pilot_attempt_reasoning WHERE attempt_id=?").get(attemptId) as { trace_json?: string } | undefined;
  let model: Record<string, unknown> = {};
  try { const parsed = JSON.parse(trace?.trace_json ?? "{}") as Record<string, unknown>; model = { providerId: parsed.providerId ?? null, model: parsed.model ?? null, reasoning: parsed.reasoningLevel ?? null }; } catch { /* no trace */ }
  const stages = db.prepare("SELECT stage_id AS stage, state, input_sha256 AS input, output_sha256 AS output, provider_id AS provider, model FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?").all(attempt.run_id, attempt.task_id);
  return { attempt, ...model, lanePilot: packageJson.version, stages };
}

export function manifest(db: Db) {
  const tables = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%'").get() as { n: number }).n;
  return { name: packageJson.name, version: packageJson.version, tables, builtAt: new Date().toISOString() };
}

/** The chain of a task's stage receipts: each link the hash of the previous link and the receipt; the tip names the whole chain. */
export function receiptChain(db: Db, runId: string, taskId: string) {
  const rows = db.prepare("SELECT stage_id, state, input_sha256, output_sha256, updated_at FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? ORDER BY updated_at, stage_id").all(runId, taskId) as Array<Record<string, unknown>>;
  let tip = "0".repeat(64);
  const links = rows.map((row) => { tip = sha(`${tip}\n${row.stage_id}\n${row.state}\n${row.input_sha256 ?? ""}\n${row.output_sha256 ?? ""}`); return { stage: row.stage_id, state: row.state, link: tip }; });
  return { runId, taskId, tip, links };
}
/** Verify a chain against a tip recorded earlier: the same receipts give the same tip. */
export const verifyChain = (db: Db, runId: string, taskId: string, tip: string) => receiptChain(db, runId, taskId).tip === tip;

/** Preship / disposition: what is open before a release, and the disposition each needs (merge, fix, defer with a term). */
export function preship(db: Db, projectId?: string) {
  const where = projectId ? "AND r.project_id=?" : "";
  const args = projectId ? [projectId] : [];
  const open = db.prepare(`SELECT a.task_id AS taskId, a.state FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state IN ('queued','running','validation_failed','spawn_unknown') ${where} ORDER BY a.updated_at DESC LIMIT 50`).all(...args);
  const regressions = db.prepare(`SELECT task_id AS taskId, state FROM lane_pilot_regression WHERE state NOT IN ('closed','fixed') ${projectId ? "AND project_id=?" : ""} LIMIT 50`).all(...args);
  const deferrals = db.prepare(`SELECT id, kind, what AS title FROM lane_pilot_deferral WHERE closed_at IS NULL ${projectId ? "AND project_id=?" : ""} LIMIT 50`).all(...args);
  const items = [
    ...(open as Array<{ taskId: string; state: string }>).map((row) => ({ what: `task ${row.taskId} is ${row.state}`, disposition: row.state === "validation_failed" ? "fix or cancel" : "let it finish or cancel" })),
    ...(regressions as Array<{ taskId: string; state: string }>).map((row) => ({ what: `regression of ${row.taskId} (${row.state})`, disposition: "fix, or revert the task" })),
    ...(deferrals as Array<{ id: string; title: string }>).map((row) => ({ what: `deferred: ${row.title ?? row.id}`, disposition: "keep with its term" })),
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
  const task = db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=? AND run_id=?").get(taskId, runId) as { contract_json?: string } | undefined;
  const contract = JSON.parse(task?.contract_json ?? "{}") as { title?: string; display_title?: string; objective?: string; acceptance?: string[]; verification?: Array<{ command: string }> };
  const stages = db.prepare("SELECT stage_id, state FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?").all(runId, taskId) as Array<{ stage_id: string; state: string }>;
  const chain = receiptChain(db, runId, taskId);
  return [
    `## ${contract.display_title ?? contract.title ?? taskId}`, "", contract.objective ?? "", "",
    "### Acceptance", ...(contract.acceptance ?? []).map((line) => `- ${line}`), "",
    "### Checks", ...(contract.verification ?? []).map((check) => `- \`${check.command}\``), "",
    "### Stages", ...stages.map((row) => `- ${row.stage_id}: ${row.state}`), "",
    `Receipt chain tip: \`${chain.tip.slice(0, 16)}\` (Lane Pilot ${packageJson.version})`,
  ].join("\n");
}
