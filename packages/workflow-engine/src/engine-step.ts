import { randomUUID } from "node:crypto";

import { MissingValueError, evalCondition, evalSpec, refOf, renderValue, valueSpecOf } from "./expr";
import { sha256, stableId, TERMINAL_RUN } from "./journal";
import type { EffectRow, Journal, RunRow, StepRow } from "./journal";
import { executorKey, outputFields } from "./lower";
import type { QualityMode, GraphNode as WorkflowNode } from "./schema";
import { checkOutput } from "./values";
import { parseGoals, regroundDue } from "./goals";
import type { Compiled } from "./compiled";
import { isEngineBug } from "./engine-errors";
import { asObject, env, lenient } from "./step-read";
import { checkStepOutput } from "./step-output";
import { addSpend, UNKNOWN_USAGE_MAX_WALL_SECONDS } from "./usage";
import type { Usage } from "./usage";
import type { EffectReconcile, NodeExecutor, StepContext, StepDone, StepInput, StepOutcome } from "./step-types";
import { visitsOf } from "./engine-routing";
import { failStep } from "./engine-branches";
import { cancelOpenSteps, failRun } from "./run-status";
import type { WorkflowEngine } from "./engine";

export function runtimeOf(engine: WorkflowEngine, run: RunRow): unknown {
  if (engine.runtimes.has(run.id)) return engine.runtimes.get(run.id);
  const built = engine.options.runtimeFor?.(run);
  if (built !== undefined) engine.runtimes.set(run.id, built);
  return built;
}

export function contextFor(engine: WorkflowEngine, run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode, attempt: number, signal: AbortSignal): StepContext {
  const j = engine.journal;
  const input = JSON.parse(step.input_json) as StepInput;
  const goals = parseGoals(j.getRun(run.id)?.goals_json);
  const scope = env(engine, run, step);
  const resolve = (text: string) => { const found = scope.read(refOf(text)); return found.ran ? found.value : undefined; };
  return {
    runId: run.id, stepKey: step.step_key, nodeId: node.id, node, workflow: c.wf, attempt, input, runtime: runtimeOf(engine, run), signal, mode: run.mode as QualityMode,
    // `run` was read before this step was counted: the step is number steps_used + 1 of the run.
    goals, reground: goals.length > 0 && regroundDue(run.steps_used + 1), inputs: asObject(run.inputs_json),
    spawnKey: spawnKeyOf(engine, run.id, step, attempt),
    resolve,
    render: (template) => String(renderValue(template, (ref, text) => { const found = scope.read(ref); if (!found.ran) throw new MissingValueError("reference_missing", `"${text}" has no value yet`); return found.value; }, run.mode) ?? ""),
    value: (spec) => evalSpec(valueSpecOf(spec), lenient(scope), `${node.id}`),
    template: (value) => renderValue(value, (ref) => lenient(scope).read(ref).value, run.mode),
    effect: (key, kind, fn, options) => runEffect(engine, j, run.id, step.step_key, key, kind, fn, options),
  };
}

export async function runEffect<T>(engine: WorkflowEngine, j: Journal, runId: string, stepKey: string, key: string, kind: string, fn: () => Promise<T>,
  options: { intent?: unknown; reconcile?: EffectReconcile<T> } = {}): Promise<T> {
  const db = j.db, at = () => engine.now();
  const readEffect = () => db.prepare("SELECT * FROM lane_pilot_wf_effect WHERE run_id=? AND step_key=? AND effect_key=?").get(runId, stepKey, key) as EffectRow | undefined;
  const write = (state: EffectRow["state"], result?: unknown) => {
    db.prepare("UPDATE lane_pilot_wf_effect SET state=?, result_json=COALESCE(?,result_json), updated_at=? WHERE run_id=? AND step_key=? AND effect_key=?")
      .run(state, result === undefined ? null : JSON.stringify(result), at(), runId, stepKey, key);
    j.event(runId, stepKey, "effect", null, state, `${kind}:${key}`);
  };
  const row = readEffect();
  if (row?.state === "done") return JSON.parse(row.result_json ?? "null") as T;
  if (row?.state === "unknown") throw new Error(`effect_unknown:${key}`);
  if (row?.state === "intended") {
    const verdict = options.reconcile ? await options.reconcile(row) : null;
    if (verdict?.happened === true) { write("done", verdict.result); return verdict.result; }
    if (verdict === null) { write("unknown"); throw new Error(`effect_unknown:${key}`); }
  }
  if (!row) {
    db.prepare("INSERT INTO lane_pilot_wf_effect(id,run_id,step_key,effect_key,kind,state,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,'intended',?,?,?)")
      .run(`wfeff_${randomUUID().slice(0, 12)}`, runId, stepKey, key, kind, options.intent === undefined ? null : JSON.stringify(options.intent), at(), at());
    j.event(runId, stepKey, "effect", null, "intended", `${kind}:${key}`);
  } else write("intended");
  engine.fault("effect-intended");
  try {
    const result = await fn();
    engine.fault("effect-called");
    write("done", result ?? null);
    return result;
  } catch (cause) {
    if (!isEngineBug(cause)) write("failed");
    throw cause;
  }
}

/** sha256(run | step | attempt), and the number of the owner's re-runs when there were any. */
export function spawnKeyOf(engine: WorkflowEngine, runId: string, step: StepRow, attempt: number): string {
  const rerun = (asObject(step.input_json) as { rerun?: number }).rerun ?? 0;
  return sha256(`${runId}|${step.step_key}|${attempt}${rerun > 0 ? `|r${rerun}` : ""}`).slice(0, 32);
}

/** Why a node is skipped before it starts: outside its quality modes, or its skip_when holds. */
export function skipReason(engine: WorkflowEngine, run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): string | null {
  if (node.type === "join") return null;
  if (node.applicable_modes && !node.applicable_modes.includes(run.mode as QualityMode)) return `mode ${run.mode} is not one of ${node.applicable_modes.join(", ")}`;
  const expr = c.skip.get(node.id);
  if (expr && evalCondition(expr, env(engine, run, step), `${node.id} skip_when`)) return "skip_when";
  return null;
}

/** True when the node will be skipped; an expression that fails is left to the skip path below. */
export function skipsFree(engine: WorkflowEngine, run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): boolean {
  try { return skipReason(engine, run, c, step, node) !== null; } catch { return false; }
}

/** A skipped node still has a typed output: `skip_out`, checked against its declared fields. */
export function skipOutput(engine: WorkflowEngine, run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): Record<string, unknown> {
  const scope = env(engine, run, step);
  const target = node.type === "parallel" ? c.joinOf.get(node.id) ?? node : node;
  const given = Object.fromEntries(Object.entries(node.skip_out ?? {}).map(([name, value]) => [name, evalSpec(valueSpecOf(value), scope, `${node.id} skip_out.${name}`)]));
  const fields = outputFields(c.wf, target);
  if (fields === "unknown") return given;
  if (node.type === "agent" && given.handoff === undefined) given.handoff = "skipped";
  // Only what skip_out gives is checked: the fields others read are covered by the validator, the rest is absent.
  return checkOutput(fields.map((field) => ({ ...field, required: false })), given);
}

/** Runs one pending step to its end; "stop" when the engine was asked to halt at this boundary. */
export async function execStep(engine: WorkflowEngine, runId: string, stepKey: string): Promise<"done" | "stop" | "skip"> {
  const j = engine.journal;
  if (engine.options.admit && !(await engine.options.admit())) return "stop";
  if (engine.stopped()) return "stop";
  const run = j.getRun(runId)!;
  if (TERMINAL_RUN.includes(run.status)) return "skip";
  const c = engine.compiled(run);
  let step = j.getStep(runId, stepKey)!;
  if (step.state !== "pending") return "skip";
  const node = c.nodes.get(step.node_id)!;
  const found = checkLimits(engine, run, c);
  // A budget guards spending; an emit spends nothing, so what was already paid for is handed on, the overrun on record.
  // A step or time budget too: magicseo lp.plan (2026-10-30) had its critic pass on step 14 of 14, and the run was
  // blocked on the end emit — 31 minutes of planning thrown away and run again from the start.
  // A node its skip_when skips spends nothing either: invoice-send 2026-11-02 had telegram-send blocked on the skipped
  // report after the send step was done, and the parent run failed on work that was finished.
  const paidFor = found !== null && found.startsWith("budget_exceeded:") && (executorKey(node) === "builtin:emit" || skipsFree(engine, run, c, step, node));
  if (paidFor && !j.db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='budget_overrun' LIMIT 1").get(runId)) j.event(runId, stepKey, "budget_overrun", null, null, `${found}: the end emits what the run already paid for`);
  const limit = paidFor ? null : found;
  if (limit) { if (j.setRunStatus(runId, ["running", "waiting"], "blocked", limit)) { cancelOpenSteps(engine, runId); engine.aborts.get(runId)?.abort(); } return "skip"; }

  // Skipped before it starts: the quality mode or skip_when says so; the node keeps a typed output.
  try {
    const why = skipReason(engine, run, c, step, node);
    if (why) {
      const output = skipOutput(engine, run, c, step, node);
      j.db.transaction(() => {
        if (!j.moveStep(runId, stepKey, "pending", "skipped", { output_json: JSON.stringify(output), ended: true, receipt_json: JSON.stringify({ executor: executorKey(node), skipped: why, harnessVersion: engine.options.harnessVersion }) })) return;
        if (node.type === "parallel") skipFan(engine, run, c, step, node, output);
      })();
      return "done";
    }
  } catch (cause) {
    if (isEngineBug(cause)) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    const code = cause instanceof MissingValueError ? cause.code : "skip_failed";
    j.db.transaction(() => { if (j.moveStep(runId, stepKey, "pending", "canceled", { error: message, ended: true })) failRun(engine, runId, `${code}:${node.id}`); })();
    return "done";
  }

  // The node's own inputs: templates written into the step's input, once.
  try {
    if (node.with && !asObject(step.input_json).withRendered) {
      const scope = env(engine, run, step);
      const rendered = Object.fromEntries(Object.entries(renderValue(node.with, (ref) => scope.read(ref).value, run.mode) as Record<string, unknown>).filter(([, value]) => value !== undefined));
      const input = asObject(step.input_json) as unknown as StepInput & { withRendered?: boolean };
      input.with = { ...input.with, ...rendered };
      input.withRendered = true;
      j.db.prepare("UPDATE lane_pilot_wf_step SET input_json=? WHERE run_id=? AND step_key=?").run(JSON.stringify(input), runId, stepKey);
      step = j.getStep(runId, stepKey)!;
    }
  } catch (cause) {
    if (isEngineBug(cause)) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    const code = cause instanceof MissingValueError ? cause.code : "with_failed";
    j.db.transaction(() => { if (j.moveStep(runId, stepKey, "pending", "canceled", { error: message, ended: true })) failRun(engine, runId, `${code}:${node.id}`); })();
    return "done";
  }

  const startAttempt = Math.max(1, step.attempt);
  const spawnKey = spawnKeyOf(engine, runId, step, startAttempt);
  engine.fault("before-start");
  if (!j.moveStep(runId, stepKey, "pending", "running", { started: true, harness_version: engine.compat, attempt: startAttempt, spawn_key: spawnKey })) return "skip";
  j.db.prepare("UPDATE lane_pilot_wf_run SET steps_used=steps_used+1, updated_at=? WHERE id=?").run(engine.now(), runId);
  let executor = engine.executors.get(executorKey(node)!)!;
  // A majority join needs more than half of its branches: it fails the run otherwise, whatever reducer builds its output.
  if (node.type === "join" && node.policy === "majority") {
    const base = executor;
    executor = { ...base, run: async (ctx) => {
      const results = (ctx.input.with.results as unknown[] | undefined)?.length ?? 0, failed = (ctx.input.with.failed as unknown[] | undefined)?.length ?? 0;
      if (results + failed > 0 && results * 2 <= results + failed) throw new Error(`join_no_majority: ${results} of ${results + failed} branches succeeded`);
      return base.run(ctx);
    } };
  }
  const votes = node.type === "agent" ? node.votes ?? 1 : 1;
  const abort = engine.aborts.get(runId) ?? new AbortController();
  engine.aborts.set(runId, abort);
  let outcome: StepOutcome | null = null, lastError: unknown = null;
  // What the failed attempts spent: a retry that succeeds does not erase it (2026-10-29 audit A-003: 100 tokens of a failed try
  // were dropped when the second try spent 5). Kept in memory: a reload mid-step loses it rather than charging it twice.
  let spentBefore: Usage | undefined;
  for (let attempt = startAttempt; attempt <= node.maxAttempts; attempt += 1) {
    if (attempt !== startAttempt) j.db.prepare("UPDATE lane_pilot_wf_step SET attempt=?, spawn_key=?, updated_at=? WHERE run_id=? AND step_key=?").run(attempt, spawnKeyOf(engine, runId, step, attempt), engine.now(), runId, stepKey);
    try {
      engine.fault("before-run");
      const fresh = j.getStep(runId, stepKey)!;
      const attemptAbort = new AbortController();
      const forward = () => attemptAbort.abort();
      abort.signal.addEventListener("abort", forward, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const context = contextFor(engine, run, c, fresh, node, attempt, attemptAbort.signal);
        const running = votes > 1 ? runVotes(engine, executor, context, c, node, votes) : executor.run(context);
        const limited = node.timeoutSec === undefined || node.type === "human" ? running : Promise.race([running, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { attemptAbort.abort(); reject(new Error(`timeout after ${node.timeoutSec}s`)); }, node.timeoutSec! * 1000);
        })]);
        outcome = await limited;
      } finally { clearTimeout(timer); abort.signal.removeEventListener("abort", forward); }
      if (!("wait" in outcome)) {
        outcome = { ...outcome, output: checkStepOutput(node, outputFields(c.wf, node), outcome.output) };
      }
      lastError = null;
      break;
    } catch (cause) {
      if (isEngineBug(cause)) throw cause;
      lastError = cause; outcome = null;
      spentBefore = addSpend(spentBefore, (cause as { usage?: Usage } | null)?.usage);
      j.event(runId, stepKey, "attempt_failed", null, null, `${attempt}/${node.maxAttempts}: ${cause instanceof Error ? cause.message : String(cause)}`);
      if (abort.signal.aborted || engine.stopped()) break;
      // Another attempt cannot bring what the agent said it lacks.
      if (cause instanceof MissingValueError && cause.code === "agent_blocked") break;
    }
  }
  // A step whose helper gave up because the plugin is stopping did not fail: it stays running for the reload, which runs a
  // reentrant one again (its spawn found by key) and interrupts any other. magicseo replay recon (2026-10-31) was failed by a deploy.
  if (!outcome && engine.stopped()) return "stop";
  engine.fault("after-run");
  const current = j.getRun(runId)!;
  if (TERMINAL_RUN.includes(current.status)) { j.moveStep(runId, stepKey, "running", "canceled", { ended: true }); return "skip"; }
  const receipt = (extra: Record<string, unknown>) => JSON.stringify({ executor: executorKey(node), harnessVersion: engine.options.harnessVersion, engineCompat: engine.compat, ...extra });
  if (!outcome) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    const code = lastError instanceof MissingValueError ? lastError.code : "step_failed";
    // A step that failed after its helper had spent still spent: an error may carry what (`usage`), and the run is charged for it, once.
    const spentOnFailure = spentBefore;
    if (spentOnFailure && typeof spentOnFailure.tokens === "number") {
      j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?").run(Math.round(spentOnFailure.tokens ?? 0), Math.round((spentOnFailure.costUsd ?? 0) * 1_000_000), runId);
      if (spentOnFailure.unknown) j.event(runId, stepKey, "usage", null, "unknown", node.id);
      noteUnknownUsage(engine, runId, stepKey, spentOnFailure);
    }
    if (j.moveStep(runId, stepKey, "running", "failed", { error: message, ended: true, receipt_json: receipt({ code }) })) failStep(engine, runId, c, stepKey, `${code}:${node.id}`, message);
    return "done";
  }
  const usage = addSpend(spentBefore, outcome.usage);
  const addUsage = () => {
    if (!usage) return;
    j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?").run(Math.round(usage.tokens ?? 0), Math.round((usage.costUsd ?? 0) * 1_000_000), runId);
    if (usage.unknown) j.event(runId, stepKey, "usage", null, "unknown", node.id);
    noteUnknownUsage(engine, runId, stepKey, usage);
  };
  if ("wait" in outcome) {
    if (j.moveStep(runId, stepKey, "running", "waiting", { await_json: JSON.stringify({ ...outcome.wait, partial: outcome.partial ?? null }), receipt_json: receipt({ threadId: outcome.threadId ?? null, usage: usage ?? null }) })) addUsage();
    return "done";
  }
  const outputJson = JSON.stringify(outcome.output);
  j.db.transaction(() => {
    if (j.moveStep(runId, stepKey, "running", "succeeded", { output_json: outputJson, ended: true,
      receipt_json: receipt({ inputSha256: sha256(step.input_json), outputSha256: sha256(outputJson), threadId: outcome.threadId ?? null, usage: usage ?? null,
        handoff: node.type === "agent" ? outcome.output.handoff ?? null : null, ...(node.type === "agent" && outcome.output.outcome ? { outcome: outcome.output.outcome } : {}), attempts: j.getStep(runId, stepKey)!.attempt,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) }) })) addUsage();
  })();
  engine.fault("after-record");
  return "done";
}

/**
 * `votes` > 1: the node runs that many times independently (own spawn keys) and the answer is decided by code, not by a model:
 * a boolean is true when more than half of the answers say true, a number is the median, any other scalar the most common
 * value; arrays and objects come from the first answer that agrees with the majority on the booleans. More than half of
 * the votes must answer, else the step fails.
 */
export async function runVotes(engine: WorkflowEngine, executor: NodeExecutor<any>, context: StepContext, c: Compiled, node: WorkflowNode, votes: number): Promise<StepOutcome> {
  const settled = await Promise.allSettled(Array.from({ length: votes }, (_unused, index) =>
    executor.run({ ...context, vote: { index, of: votes }, spawnKey: sha256(`${context.spawnKey}|vote${index}`).slice(0, 32) })));
  const answers: StepDone[] = [];
  let failedSpend: Usage | undefined;
  for (const item of settled) {
    if (item.status === "rejected") { if (isEngineBug(item.reason)) throw item.reason; failedSpend = addSpend(failedSpend, (item.reason as { usage?: Usage } | null)?.usage); continue; }
    if ("wait" in item.value) throw new Error(`node ${node.id}: votes need an executor that answers in one step`);
    answers.push(item.value);
  }
  const spent = answers.reduce<Usage | undefined>((sum, answer) => addSpend(sum, answer.usage), failedSpend);
  if (answers.length * 2 <= votes) throw Object.assign(new Error(`votes: ${answers.length} of ${votes} answered, a majority is needed`), spent ? { usage: spent } : {});
  const fields = outputFields(c.wf, node);
  const names = fields === "unknown" ? [...new Set(answers.flatMap((answer) => Object.keys(answer.output)))] : fields.map((field) => field.name);
  const types = new Map((fields === "unknown" ? [] : fields).map((field) => [field.name, field.type]));
  const decided: Record<string, unknown> = {};
  for (const name of names) {
    const values = answers.map((answer) => answer.output[name]).filter((value) => value !== undefined && value !== null);
    if (!values.length) continue;
    const type = types.get(name);
    if (type === "boolean" || values.every((value) => typeof value === "boolean")) decided[name] = values.filter((value) => value === true).length * 2 > values.length;
    else if (type === "number" || values.every((value) => typeof value === "number")) { const sorted = [...values as number[]].sort((a, b) => a - b); decided[name] = sorted[Math.floor((sorted.length - 1) / 2)]; }
    else if (values.every((value) => typeof value === "string")) {
      const counts = new Map<string, number>();
      for (const value of values as string[]) counts.set(value, (counts.get(value) ?? 0) + 1);
      const best = Math.max(...counts.values());
      decided[name] = name === "handoff" ? values.find((value) => (value as string).trim()) ?? values[0] : (values as string[]).find((value) => counts.get(value) === best);
    }
  }
  const booleans = Object.entries(decided).filter(([, value]) => typeof value === "boolean");
  const agreeing = answers.find((answer) => booleans.every(([name, value]) => answer.output[name] === value)) ?? answers[0]!;
  for (const name of names) if (decided[name] === undefined && agreeing.output[name] !== undefined) decided[name] = agreeing.output[name];
  return { output: decided, usage: spent ?? { tokens: 0, costUsd: 0 }, threadId: answers.find((answer) => answer.threadId)?.threadId ?? null,
    detail: { votes: answers.map((answer) => ({ output: answer.output, threadId: answer.threadId ?? null })), asked: votes } };
}

/** A skipped fan-out has no branches: the join it belongs to is skipped with the same typed output. */
export function skipFan(engine: WorkflowEngine, run: RunRow, c: Compiled, fan: StepRow, node: WorkflowNode, output: Record<string, unknown>): void {
  const join = c.joinOf.get(node.id);
  if (!join) return;
  const j = engine.journal;
  const visit = visitsOf(engine, run.id, join.id, fan.scope) + 1;
  const stepKey = `${join.id}#${visit}${fan.scope ? `@${stableId(fan.scope).slice(0, 6)}` : ""}`;
  j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,output_json,routed,ended_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'skipped',?,?,0,?,?)`)
    .run(run.id, stepKey, stableId("join", fan.step_key, join.id), join.id, visit, fan.scope, fan.step_key, null, JSON.stringify({ with: {}, via: { mode: "artifact", fromStep: fan.step_key } }), JSON.stringify(output), engine.now(), engine.now());
  j.db.prepare("UPDATE lane_pilot_wf_step SET routed=1 WHERE run_id=? AND step_key=?").run(run.id, fan.step_key);
  j.event(run.id, stepKey, "step", null, "skipped", `join of skipped ${fan.step_key}`);
}

/** A step whose provider reported no usage: the run's journal says so once, and `checkLimits` takes it from there. */
export function noteUnknownUsage(engine: WorkflowEngine, runId: string, stepKey: string, usage: Usage): void {
  if (!usage.unknown) return;
  const j = engine.journal;
  if (j.db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='usage_unknown' LIMIT 1").get(runId)) return;
  j.event(runId, stepKey, "usage_unknown", null, null, `the provider reported no usage for this step: a token or money budget cannot count it; the run is held to ${UNKNOWN_USAGE_MAX_WALL_SECONDS / 60} minutes unless the budget sets its own`);
}

/** The steps of a run whose spending is not known (the provider reports no usage): its token and cost totals leave them out, and a budget cannot see them. */
export function unknownUsageSteps(engine: WorkflowEngine, runId: string): string[] {
  return (engine.journal.db.prepare("SELECT step_key FROM lane_pilot_wf_event WHERE run_id=? AND kind='usage' AND to_state='unknown' ORDER BY seq").all(runId) as Array<{ step_key: string }>).map((row) => row.step_key);
}

export function checkLimits(engine: WorkflowEngine, run: RunRow, c: Compiled): string | null {
  const budget = c.wf.budget;
  // A token or money budget is blind to a step without usage events; the run then gets a time and step limit of its own.
  if ((budget.maxTokens !== undefined || budget.maxCostUsd !== undefined) && engine.journal.db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='usage_unknown' LIMIT 1").get(run.id)) {
    if (budget.maxWallSeconds === undefined && engine.now() - run.created_at - run.wait_ms >= UNKNOWN_USAGE_MAX_WALL_SECONDS * 1000) return "budget_exceeded:usage_unknown_wall_time";
  }
  // No step budget: every loop is bounded by maxVisits, money and time by their own budgets. The one step stop in 277 hub runs
  // was false (magicseo lp.plan, 2026-10-30: the critic passed on step 14 of 14). guards.maxSteps still catches an engine fault.
  if (budget.maxTokens !== undefined && run.tokens_used >= budget.maxTokens) return "budget_exceeded:tokens";
  if (budget.maxCostUsd !== undefined && run.cost_micro_usd >= Math.round(budget.maxCostUsd * 1_000_000)) return "budget_exceeded:cost";
  if (budget.maxWallSeconds !== undefined && engine.now() - run.created_at - run.wait_ms >= budget.maxWallSeconds * 1000) return "budget_exceeded:wall_time";
  return null;
}

