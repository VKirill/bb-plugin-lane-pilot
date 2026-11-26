import { switchOn } from "@lane-pilot/models";
import { release as osRelease } from "node:os";
import { unknownReasons } from "../../../runs";
import type Database from "better-sqlite3";
import packageJson from "../../../../../package.json";
import { gateRunVerdict } from "../../../verification/server"
import { parseIntegrationGateSettings } from "../../../contracts";
import { getRun, getAttempt, getReasoningTraceJson, getTaskContractJson, listStageReceipts, loadProjectSettings, openAttemptBriefs, latestGateRun, FULL_GATE_VALID_MS, countLanePilotTables, countAttempts, listAttemptReasonsSince, listGateEventsForTask } from "../../../storage";
import { calibrationPassport } from "../../../forecast/server";
import { getAttemptChange } from "../../../rollback/server";
import { buildScorecard, checkerRows, latestCheckerRun } from "../../../checkers";

/**
 * Receipts and evidence (SMA map: Receipts and evidence). Read-only assemblies over what the stages left:
 * - passport: an attempt's provider, model, harness version, Lane Pilot version and the receipts of its stages (sma passport / model);
 * - manifest: this build — version, migrations, rooms (sma manifest);
 * - preship: what is still open before a release — unmerged work, open deferrals — each with its disposition;
 * - attemptRecord: everything about one attempt in one answer.
 */
import { listOpenDeferralBriefs } from "../../../deferral/server";

type Db = Database.Database;
/** A stored ordinal of 2 on a task with more than two attempts cannot be told apart from a legacy row the old
 * 0-2 clamp wrote: post-fix writes are exact, pre-fix writes may be clamped 3+. Flagged, never guessed. */
const ambiguousOrdinal = (stored: number, taskAttempts: number) => stored === 2 && taskAttempts > 2;

export function passport(db: Db, attemptId: string) {
  const row = getAttempt(db, attemptId);
  if (!row) return null;
  const attempt = { id: row.id, run_id: row.run_id, task_id: row.task_id, state: row.state, attempt_no: row.attempt_no, harness_version: row.harness_version, created_at: row.created_at };
  const trace = getReasoningTraceJson(db, attemptId);
  let model: Record<string, unknown> = {};
  try { const parsed = JSON.parse(trace ?? "{}") as Record<string, unknown>; model = { providerId: parsed.providerId ?? null, model: parsed.model ?? null, reasoning: parsed.reasoningLevel ?? null }; } catch { /* no trace */ }
  // Receipt rows key on (run,task,stage) and hold the last writer only — without the attempt filter a respawned
  // attempt's passport reports a later attempt's stages (attemptRecord already filters the same way).
  const taskAttempts = countAttempts(db, row.run_id, row.task_id);
  // Receipt rows key on (run,task,stage) and hold the last writer only — without the attempt filter a respawned
  // attempt's passport reports a later attempt's stages (attemptRecord already filters the same way). attempt 0
  // rows are pre-attempt task evidence (pm-read etc. run before the attempt row exists): shown as scope 'task',
  // never as proof about this attempt.
  const stages = listStageReceipts(db, row.run_id, row.task_id)
    .filter((stage) => stage.attempt === row.attempt_no || stage.attempt === 0)
    .map((stage) => ({ stage: stage.stageId, state: stage.state, input: stage.inputSha256, output: stage.outputSha256, provider: stage.providerId, model: stage.model, attempt: stage.attempt, scope: stage.attempt === 0 ? "task" : "attempt", ...(stage.attempt !== 0 && ambiguousOrdinal(stage.attempt, taskAttempts) ? { ambiguous: true } : {}) }));
  // The badge of the model that wrote this attempt's forecast (SMA k_v_passport): old priors are about another model.
  let calibration: { model: string; badge: string } | null = null;
  try {
    const contract = JSON.parse(getTaskContractJson(db, row.task_id) ?? "{}") as { forecast?: { model?: unknown } };
    if (typeof contract.forecast?.model === "string") {
      const projectId = getRun(db, row.run_id)?.project_id ?? "";
      calibration = { model: contract.forecast.model, badge: calibrationPassport(db, projectId, contract.forecast.model).badge };
    }
  } catch { /* the badge is informational; provenance stands without it */ }
  return { attempt, ...model, lanePilot: packageJson.version, ...(calibration ? { calibration } : {}), stages };
}

export function manifest(db: Db) {
  const tables = countLanePilotTables(db);
  // Diagnostics without secrets (SMA m_rd_diag): host facts and the unknown-code count — never env, paths, keys or hostnames.
  const unknownCodes = unknownReasons(listAttemptReasonsSince(db, Date.now() - 14 * 86_400_000)).reduce((total, row) => total + row.count, 0);
  return { name: packageJson.name, version: packageJson.version, platform: process.platform, osRelease: osRelease(), node: process.version, unknownCodes, tables, builtAt: new Date().toISOString() };
}

/** Preship / disposition: what is open before a release, and the disposition each needs (merge, fix, defer with a term). */
export function preship(db: Db, projectId?: string) {
  const open = openAttemptBriefs(db, { projectId: projectId ?? null });
  const deferrals = listOpenDeferralBriefs(db, projectId);
  const items = [
    ...(open as Array<{ taskId: string; state: string }>).map((row) => ({ what: `task ${row.taskId} is ${row.state}`, disposition: row.state === "validation_failed" ? "fix or cancel" : "let it finish or cancel" })),
    ...(deferrals).map((row) => ({ what: `deferred: ${row.title ?? row.id}`, disposition: "keep with its term" })),
  ];
  // The ship gate (Astra F1): «all tasks accepted» says nothing about the post-merge check on main. Its latest run
  // still out, red or never run stops the ship; a project without a gate passes as before.
  const gate = latestGateRun(db, projectId);
  const fullGateOn = !!projectId && switchOn(loadProjectSettings(db as never, projectId), "ship.full_gate");
  if (gate) {
    const verdict = gateRunVerdict(gate);
    if (verdict.pending) {
      items.push({ what: `integration gate is still running (${gate.command})`, disposition: "wait for its verdict, then preship again" });
    } else if (gate.state === "passed" && fullGateOn && Date.now() - gate.updatedAt > FULL_GATE_VALID_MS) {
      // The same six-hour validity the ship gate applies (SMA k_ws_fullgate), only where the project set ship.full_gate to on.
      // Preship cannot name the shipped head without a host, so the head check stays with lp.integration_gate_status.
      items.push({ what: `integration gate's green mark on ${gate.head ? gate.head.slice(0, 12) : "main"} is older than six hours`, disposition: `rerun the gate: run \`${gate.command}\` on main (or merge a task to trigger it)` });
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
  // A checker that misses a defect class it exists to catch stops the ship (SMA k_lib_consequences): the scorecard of the
  // latest finished checker run names each such regression; pass-then-fail work stays covered by the open-regression items.
  const run = latestCheckerRun(db as never);
  if (run) {
    for (const regression of buildScorecard(checkerRows(db as never, run.id)).regressions) {
      items.push({ what: `${regression.checker} missed planted ${regression.defectClass} it is designed to catch`, disposition: "fix the checker, then run `bb lane-pilot checkers` again" });
    }
  }
  return { clear: items.every((item) => item.disposition === "keep with its term"), items };
}

/**
 * Everything about one attempt in one answer (SMA ap_run_dir): the writer thread (its stream in BB), the stage
 * receipts and gate evaluations of that attempt number, what the writer was given (the reasoning trace's dispatch
 * context), the verification stage's commands with their results, the code critic's input hash and the attempt-change row.
 */
export function attemptRecord(db: Db, attemptId: string) {
  const row = getAttempt(db, attemptId);
  if (!row) return null;
  const taskAttempts = countAttempts(db, row.run_id, row.task_id);
  const receipts = listStageReceipts(db, row.run_id, row.task_id).filter((stage) => stage.attempt === row.attempt_no);
  const gates = listGateEventsForTask(db, row.run_id, row.task_id).filter((event) => event.attempt === row.attempt_no);
  let dispatchContext: unknown = null;
  try { dispatchContext = (JSON.parse(getReasoningTraceJson(db, attemptId) ?? "{}") as { dispatchContext?: unknown }).dispatchContext ?? null; } catch { /* no trace */ }
  const verification = receipts.find((stage) => stage.stageId === "verification")?.result ?? null;
  const criticInputHash = receipts.find((stage) => stage.stageId === "code-critique")?.inputSha256 ?? null;
  const change = getAttemptChange(db, attemptId) ?? null;
  return {
    attempt: { id: row.id, runId: row.run_id, taskId: row.task_id, state: row.state, reason: row.reason, attemptNo: row.attempt_no, threadId: row.thread_id, createdAt: row.created_at },
    stageReceipts: receipts.map((stage) => ({ stage: stage.stageId, state: stage.state, reason: stage.reason, input: stage.inputSha256, output: stage.outputSha256, threadId: stage.threadId, updatedAt: stage.updatedAt, attempt: stage.attempt, ...(ambiguousOrdinal(stage.attempt, taskAttempts) ? { ambiguous: true } : {}) })),
    gateEvents: gates.map((event) => ({ ...event, ...(ambiguousOrdinal(event.attempt, taskAttempts) ? { ambiguous: true } : {}) })),
    dispatchContext,
    verification,
    criticInputHash,
    change: change ? { outcome: change.outcome, mergeCommit: change.mergeCommit, changed: change.changed } : null,
  };
}
