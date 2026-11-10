import { createHash } from "node:crypto";
import { openRegressionBriefs } from "../../baseline";
import type Database from "better-sqlite3";
import packageJson from "../../../../package.json";
import { gateRunVerdict } from "../../verification/server"
import { parseIntegrationGateSettings } from "../../contracts";
import { getAttempt, getReasoningTraceJson, getTaskContractJson, listStageReceipts, loadProjectSettings, openAttemptBriefs, latestGateRun, countLanePilotTables, latestAcceptedAttemptRef, listAttemptRefsSince, listGateEventsForTask } from "../../storage";
import { scoreForecast } from "../../forecast";
import { calibrationPassport } from "../../forecast/server/report";
import { getAttemptChange } from "../../rollback";
import { attemptChangeJson } from "../../rollback/server";
import { buildScorecard, checkerRows, latestCheckerRun } from "../../checkers";

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
  // The badge of the model that wrote this attempt's forecast (SMA k_v_passport): old priors are about another model.
  let calibration: { model: string; badge: string } | null = null;
  try {
    const contract = JSON.parse(getTaskContractJson(db, row.task_id) ?? "{}") as { forecast?: { model?: unknown } };
    if (typeof contract.forecast?.model === "string") {
      const projectId = (db.prepare("SELECT project_id FROM lane_pilot_run WHERE id=?").get(row.run_id) as { project_id: string } | undefined)?.project_id ?? "";
      calibration = { model: contract.forecast.model, badge: calibrationPassport(db, projectId, contract.forecast.model).badge };
    }
  } catch { /* the badge is informational; provenance stands without it */ }
  return { attempt, ...model, lanePilot: packageJson.version, ...(calibration ? { calibration } : {}), stages };
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

/** PR passport assembler: a pull request body from the task's receipts — what, the checks that prove it, the critic, the plan-fact rows. */
export function prPassport(db: Db, runId: string, taskId: string): string {
  const task = getTaskContractJson(db, taskId, runId);
  const contract = JSON.parse(task ?? "{}") as { title?: string; display_title?: string; objective?: string; acceptance?: string[]; verification?: Array<{ command: string }>; forecast?: { files: number; checks_pass_first_try: boolean; tokens?: number; minutes?: number } };
  const receipts = listStageReceipts(db, runId, taskId);
  const stages = receipts.map((row) => ({ stage_id: row.stageId, state: row.state }));
  const chain = receiptChain(db, runId, taskId);
  // The evidence passport (SMA k_v_manifest): what was predicted against what happened, the checks' receipts, the blind check's verdict.
  const prediction = (() => {
    if (!contract.forecast) return ["no forecast"];
    const attempt = latestAcceptedAttemptRef(db, runId, taskId);
    const changedJson = attempt ? attemptChangeJson(db, attempt.id) : undefined;
    if (!attempt || changedJson === undefined) return ["waiting for acceptance"];
    const fact = { files: (JSON.parse(changedJson) as unknown[]).length, firstTry: attempt.attempt_no === 1, tokens: null, minutes: null };
    const score = scoreForecast(contract.forecast, fact);
    return [`files ${score.files.forecast} -> ${score.files.fact} (error ${score.files.error})`, `first try: forecast ${score.firstTry.forecast}, fact ${score.firstTry.fact}${score.firstTry.hit ? " (hit)" : " (miss)"}`];
  })();
  const receiptLines = receipts.flatMap((row) => {
    const result = row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : {};
    const commands = (result.ran ?? result.checks ?? result.commands) as Array<{ command?: unknown; exitCode?: unknown; outputSha256?: unknown; outputHash?: unknown }> | undefined;
    return (commands ?? []).map((check) => `- \`${String(check.command ?? "")}\`: exit ${String(check.exitCode ?? "?")}${typeof (check.outputSha256 ?? check.outputHash) === "string" ? ` (${String(check.outputSha256 ?? check.outputHash).slice(0, 12)})` : ""}`);
  });
  const blind = receipts.flatMap((row) => {
    if (row.stageId !== "plan-fact") return [];
    const result = row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : {};
    const items = result.items as Array<{ item?: unknown; acceptance?: unknown; verdict?: unknown }> | undefined;
    return (items ?? []).map((item) => `- item ${String(item.item ?? "?")}: ${String(item.verdict ?? "not checked")}${typeof item.acceptance === "string" ? ` — ${item.acceptance.slice(0, 120)}` : ""}`);
  });
  return [
    `## ${contract.display_title ?? contract.title ?? taskId}`, "", contract.objective ?? "", "",
    "### Acceptance", ...(contract.acceptance ?? []).map((line) => `- ${line}`), "",
    "### Prediction", ...prediction, "",
    "### Checks", ...(contract.verification ?? []).map((check) => `- \`${check.command}\``), "",
    "### Receipts", ...(receiptLines.length ? receiptLines : ["- no verification receipts on record"]), "",
    "### Blind check", ...(blind.length ? blind : ["- no plan-fact check on record"]), "",
    "### Stages", ...stages.map((row) => `- ${row.stage_id}: ${row.state}`), "",
    `Receipt chain tip: \`${chain.tip.slice(0, 16)}\` (Lane Pilot ${packageJson.version})`,
  ].join("\n");
}

/** Receipt coverage of the helpers' claimed work (SMA k_v_subreceipts): share of writer attempts whose plan-fact check
 * read a table (passed or failed) against skipped, the cited evidence the check called phantom, and how big the
 * dispatch packets handed to helpers are (median and p90 bytes of the trace's dispatchContext). */
export function subagentReceipts(db: Db, input: { projectId?: string; days?: number } = {}) {
  const since = Date.now() - (input.days ?? 30) * 86_400_000;
  const attempts = listAttemptRefsSince(db, since, input.projectId);
  let checked = 0, skipped = 0;
  const phantoms: Array<{ taskId: string; evidence: string; code: string }> = [];
  const packets: number[] = [];
  for (const attempt of attempts) {
    const receipt = listStageReceipts(db, attempt.run_id, attempt.task_id).find((row) => row.stageId === "plan-fact");
    const result = receipt?.result && typeof receipt.result === "object" ? receipt.result as Record<string, unknown> : null;
    if (!receipt || !result || receipt.state === "skipped" || result.table === "missing" || result.table === "invalid") skipped += 1;
    else checked += 1;
    for (const item of (result?.items as Array<{ evidence?: Array<{ evidence?: unknown; code?: unknown }> }> | undefined) ?? [])
      for (const entry of item.evidence ?? [])
        if (entry.code === "file_not_in_diff" || entry.code === "lines_not_changed" || entry.code === "file_missing")
          phantoms.push({ taskId: attempt.task_id, evidence: String(entry.evidence ?? ""), code: entry.code });
    const trace = getReasoningTraceJson(db, attempt.id);
    if (trace) {
      try {
        const packet = (JSON.parse(trace) as { dispatchContext?: unknown }).dispatchContext;
        if (typeof packet === "string" && packet) packets.push(Buffer.byteLength(packet));
      } catch { /* unreadable trace */ }
    }
  }
  const sorted = [...packets].sort((a, b) => a - b);
  const pick = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : null;
  return { attempts: attempts.length, coverage: { checked, skipped, share: attempts.length ? Math.round((checked / attempts.length) * 100) / 100 : null }, phantoms, pack: { samples: packets.length, median: pick(0.5), p90: pick(0.9) } };
}

/**
 * Everything about one attempt in one answer (SMA ap_run_dir): the writer thread (its stream in BB), the stage
 * receipts and gate evaluations of that attempt number, what the writer was given (the reasoning trace's dispatch
 * context), the verification stage's commands with their results, the code critic's input hash and the attempt-change row.
 */
export function attemptRecord(db: Db, attemptId: string) {
  const row = getAttempt(db, attemptId);
  if (!row) return null;
  const receipts = listStageReceipts(db, row.run_id, row.task_id).filter((stage) => stage.attempt === row.attempt_no);
  const gates = listGateEventsForTask(db, row.run_id, row.task_id).filter((event) => event.attempt === row.attempt_no);
  let dispatchContext: unknown = null;
  try { dispatchContext = (JSON.parse(getReasoningTraceJson(db, attemptId) ?? "{}") as { dispatchContext?: unknown }).dispatchContext ?? null; } catch { /* no trace */ }
  const verification = receipts.find((stage) => stage.stageId === "verification")?.result ?? null;
  const criticInputHash = receipts.find((stage) => stage.stageId === "code-critique")?.inputSha256 ?? null;
  const change = getAttemptChange(db, attemptId) ?? null;
  return {
    attempt: { id: row.id, runId: row.run_id, taskId: row.task_id, state: row.state, reason: row.reason, attemptNo: row.attempt_no, threadId: row.thread_id, createdAt: row.created_at },
    stageReceipts: receipts.map((stage) => ({ stage: stage.stageId, state: stage.state, reason: stage.reason, input: stage.inputSha256, output: stage.outputSha256, threadId: stage.threadId, updatedAt: stage.updatedAt })),
    gateEvents: gates,
    dispatchContext,
    verification,
    criticInputHash,
    change: change ? { outcome: change.outcome, mergeCommit: change.mergeCommit, changed: change.changed } : null,
  };
}
