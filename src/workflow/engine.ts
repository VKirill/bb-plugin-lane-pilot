import { randomUUID } from "node:crypto";
import type { LanePilotDatabase } from "../database";
import { MAX_SUBWORKFLOW_DEPTH } from "./schema";
import type { GraphNode as WorkflowNode, PassMode, Workflow, WorkflowEdge } from "./schema";
import { createJournal, sha256, stableId, TERMINAL_RUN } from "./journal";
import type { EffectRow, Journal, RunRow, RunStatus, StepRow } from "./journal";
import { outputFields, parseRef, resolvePath, validateWorkflow, WorkflowError } from "./validate";
import { checkOutput, evalCondition, MissingValueError, renderTemplate, valueAtPath } from "./values";
import { definitionSha256 } from "./store";

/** What a step receives: only the mapped fields (mode artifact), and where they came from. */
export type StepInput = {
  with: Record<string, unknown>;
  via: { mode: PassMode; fromStep: string | null; fromThreadId?: string | null; handoff?: string | null };
  item?: unknown;
  index?: number;
};
export type Usage = { tokens?: number; costUsd?: number };
export type StepDone = { output: Record<string, unknown>; usage?: Usage; threadId?: string | null };
export type StepWait = { wait: { kind: string; detail?: unknown; deadline?: number }; partial?: Record<string, unknown>; usage?: Usage; threadId?: string | null };
export type StepOutcome = StepDone | StepWait;
export type PollResult = null | { output: Record<string, unknown>; usage?: Usage; threadId?: string | null } | { error: string };

export type EffectReconcile<T> = (effect: EffectRow) => Promise<{ happened: true; result: T } | { happened: false } | null>;

export interface StepContext<R = unknown> {
  runId: string; stepKey: string; nodeId: string; node: WorkflowNode; workflow: Workflow;
  /** The try of this visit, from 1. A resumed step keeps its number, so the spawn key stays the same. */
  attempt: number; input: StepInput; runtime: R | undefined;
  /** sha256(run | step | attempt): put it in the metadata of a spawned thread to find a lost spawn again. */
  spawnKey: string; signal: AbortSignal;
  /** The value of `node.field`, `input.name`, `item` or `index` as this step sees it. */
  resolve(ref: string): unknown;
  render(template: string): string;
  /** An external call recorded as intended before and done after, so a reload neither repeats nor forgets it. */
  effect<T>(key: string, kind: string, fn: () => Promise<T>, options?: { intent?: unknown; reconcile?: EffectReconcile<T> }): Promise<T>;
}

export interface NodeExecutor<R = unknown> {
  /** True when running the step again after an interruption is safe (its external calls go through `ctx.effect`). */
  reentrant?: boolean;
  run(ctx: StepContext<R>): Promise<StepOutcome>;
  /** For a waiting step: settles it when what it waits for is over; null keeps waiting. */
  poll?(step: { runId: string; stepKey: string; nodeId: string; await: { kind: string; detail?: unknown; deadline?: number } }, ctx: { runtime: R | undefined; node: WorkflowNode }): Promise<PollResult>;
}

export type RunSummary = {
  runId: string; status: RunStatus; reason: string | null; output: Record<string, unknown> | null;
  /** The message of the step that failed the run, as the executor threw it. */
  error: string | null; failedNode: string | null;
  /** Steps waiting for something outside, with what they have so far. */
  waiting: Array<{ stepKey: string; nodeId: string; await: { kind: string; detail?: unknown }; partial: Record<string, unknown> | null }>;
  /** True when the engine stopped at a step boundary (drain or dispose); the run goes on in the next instance. */
  stopped: boolean;
};

export type EngineOptions = {
  db: LanePilotDatabase;
  harnessVersion: string;
  instanceId?: string;
  now?: () => number;
  log?: (message: string) => void;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  /** Asked before every step: false stops the run at this boundary and leaves the step pending (drain, shutdown). */
  admit?: () => boolean | Promise<boolean>;
  isDisposed?: () => boolean;
  leaseMs?: number;
  /** Test hook: called at named points of the driver; throwing simulates the process dying there. */
  fault?: (point: string) => void;
};

/** Thrown by the test hook; never treated as a step failure. */
export class CrashError extends Error {}

class RouteFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
const isEngineBug = (cause: unknown) => cause instanceof CrashError || (cause instanceof Error && /database connection is not open|closed/i.test(cause.message));

type Compiled = { wf: Workflow; nodes: Map<string, WorkflowNode>; out: Map<string, Array<{ edge: WorkflowEdge; index: number }>> };

const scopeChain = (scope: string): string[] => {
  const parts = scope ? scope.split("/") : [];
  return [...parts.map((_part, index) => parts.slice(0, parts.length - index).join("/")), ""];
};
const asObject = (text: string | null): Record<string, unknown> => (text ? JSON.parse(text) as Record<string, unknown> : {});

export class WorkflowEngine {
  readonly journal: Journal;
  readonly instanceId: string;
  private readonly executors = new Map<string, NodeExecutor<any>>();
  private readonly drives = new Map<string, Promise<RunSummary>>();
  private readonly runtimes = new Map<string, unknown>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly compiledRuns = new Map<string, Compiled>();
  private readonly beats = new Map<string, ReturnType<typeof setInterval>>();
  private readonly stoppedRuns = new Set<string>();
  private disposed = false;
  private readonly now: () => number;
  private readonly leaseMs: number;

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? Date.now;
    this.journal = createJournal(options.db, this.now);
    this.instanceId = options.instanceId ?? `engine-${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 90_000;
    this.registerBuiltins();
  }

  register<R>(key: string, executor: NodeExecutor<R>): this { this.executors.set(key, executor); return this; }
  hasExecutor = (key: string): boolean => this.executors.has(key);
  private fault(point: string): void { this.options.fault?.(point); }
  private stopped(): boolean { return this.disposed || (this.options.isDisposed?.() ?? false); }
  private log(message: string): void { this.options.log?.(`workflow: ${message}`); }

  // ---------------------------------------------------------------- definitions

  private keyFor(node: WorkflowNode): string | null {
    switch (node.type) {
      case "parallel": return "builtin:parallel";
      case "join": return "builtin:join";
      case "subworkflow": return "builtin:subworkflow";
      case "decision": return node.uses ?? (node.reads ? "builtin:decision" : null);
      case "human": return node.uses ?? "builtin:human";
      case "agent": return node.uses ?? "agent";
      case "lp-task": return node.uses ?? "lp-task";
      case "action": return node.uses ?? node.action ?? null;
      default: return null;
    }
  }

  private compile(workflow: Workflow): Compiled {
    const nodes = new Map<string, WorkflowNode>(workflow.nodes.filter((node): node is WorkflowNode => node.type !== "note").map((node) => [node.id, node]));
    const out = new Map<string, Array<{ edge: WorkflowEdge; index: number }>>();
    workflow.edges.forEach((edge, index) => { const list = out.get(edge.from) ?? []; list.push({ edge, index }); out.set(edge.from, list); });
    return { wf: workflow, nodes, out };
  }

  private compiled(run: RunRow): Compiled {
    let found = this.compiledRuns.get(run.id);
    if (!found) { found = this.compile(JSON.parse(run.definition_json) as Workflow); this.compiledRuns.set(run.id, found); }
    return found;
  }

  /** Why a workflow cannot run here: invalid, or a node whose executor is not registered. */
  preflight(workflow: Workflow): string[] {
    const problems = validateWorkflow(workflow, { resolve: this.options.resolveWorkflow }).filter((problem) => problem.level === "error").map((problem) => problem.message);
    for (const node of workflow.nodes) {
      if (node.type === "note") continue;
      const key = this.keyFor(node);
      if (!key) problems.push(`node "${node.id}" has no executor (set "uses"${node.type === "action" ? " or \"action\"" : ""})`);
      else if (!this.executors.has(key)) problems.push(`node "${node.id}": executor "${key}" is not registered`);
    }
    return problems;
  }

  // ---------------------------------------------------------------- start

  /** Starts a run, or returns the one that already has this key. `done` settles when the run stops: finished, waiting or stopped. */
  start<R>(input: {
    workflow: Workflow; inputs?: Record<string, unknown>; key?: string; runtime?: R;
    link?: { projectId?: string; runId?: string; taskId?: string; attemptId?: string };
    parent?: { runId: string; stepKey: string }; depth?: number;
  }): { runId: string; created: boolean; done: Promise<RunSummary> } {
    const { workflow } = input;
    const existing = input.key ? this.options.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE idem_key=?").get(input.key) as { id: string } | undefined : undefined;
    if (existing) {
      if (input.runtime !== undefined) this.runtimes.set(existing.id, input.runtime);
      return { runId: existing.id, created: false, done: this.drive(existing.id) };
    }
    const problems = this.preflight(workflow);
    if (problems.length) throw new WorkflowError(problems.map((message) => ({ level: "error" as const, code: "preflight", message })));
    const inputs = checkOutput(workflow.inputs, input.inputs ?? {});
    const depth = input.depth ?? 0;
    if (depth > Math.min(workflow.guards.maxSubworkflowDepth, MAX_SUBWORKFLOW_DEPTH)) throw new MissingValueError("subworkflow_depth", `subworkflows go ${depth} deep; the limit is ${MAX_SUBWORKFLOW_DEPTH}`);
    const runId = `wfrun_${randomUUID().replaceAll("-", "")}`;
    const j = this.journal, at = this.now();
    const c = this.compile(workflow);
    const entry = c.out.get("start")![0]!;
    j.db.transaction(() => {
      j.db.prepare(`INSERT INTO lane_pilot_wf_run(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,
        parent_run_id,parent_step_key,depth,status,inputs_json,harness_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?)`)
        .run(runId, input.key ?? null, workflow.id, workflow.version, definitionSha256(workflow), JSON.stringify(workflow), input.link?.projectId ?? null, input.link?.runId ?? null,
          input.link?.taskId ?? null, input.link?.attemptId ?? null, input.parent?.runId ?? null, input.parent?.stepKey ?? null, depth, JSON.stringify(inputs), this.options.harnessVersion, at, at);
      j.event(runId, null, "run", null, "running", `${workflow.id}@${workflow.version}`);
      this.compiledRuns.set(runId, c);
      const run = j.getRun(runId)!;
      this.deliver(run, c, null, entry.edge, entry.index, { scope: "", fromScope: "", suffix: "" });
    })();
    this.runtimes.set(runId, input.runtime);
    return { runId, created: true, done: this.drive(runId) };
  }

  // ---------------------------------------------------------------- driving

  private drive(runId: string): Promise<RunSummary> {
    const running = this.drives.get(runId);
    if (running) return running;
    const promise = this.driveLoop(runId).finally(() => { this.drives.delete(runId); });
    this.drives.set(runId, promise);
    return promise;
  }

  /** Resolves when every run this instance is driving has stopped. */
  async idle(): Promise<void> { while (this.drives.size) await Promise.allSettled([...this.drives.values()]); }

  private claim(runId: string): boolean {
    const at = this.now();
    const result = this.options.db.prepare(`UPDATE lane_pilot_wf_run SET owner_id=?, lease_until=? WHERE id=? AND status IN ('running','waiting') AND (owner_id IS NULL OR owner_id=? OR lease_until<?)`)
      .run(this.instanceId, at + this.leaseMs, runId, this.instanceId, at);
    return result.changes > 0;
  }

  private release(runId: string): void {
    try { this.options.db.prepare("UPDATE lane_pilot_wf_run SET owner_id=NULL, lease_until=0 WHERE id=? AND owner_id=?").run(runId, this.instanceId); } catch { /* the database may be closed */ }
  }

  private beat(runId: string): void {
    const timer = setInterval(() => {
      try { this.options.db.prepare("UPDATE lane_pilot_wf_run SET lease_until=? WHERE id=? AND owner_id=?").run(this.now() + this.leaseMs, runId, this.instanceId); } catch { /* closed */ }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    this.beats.set(runId, timer);
  }

  private unbeat(runId: string): void { const timer = this.beats.get(runId); if (timer) clearInterval(timer); this.beats.delete(runId); }

  private async driveLoop(runId: string): Promise<RunSummary> {
    const j = this.journal;
    if (!this.claim(runId)) return this.summary(runId);
    this.beat(runId);
    this.stoppedRuns.delete(runId);
    try {
      for (;;) {
        if (this.stopped()) { this.stoppedRuns.add(runId); break; }
        const run = j.getRun(runId);
        if (!run || TERMINAL_RUN.includes(run.status)) break;
        this.fault("loop");
        this.routeAll(run, this.compiled(run));
        const routed = j.getRun(runId)!;
        if (TERMINAL_RUN.includes(routed.status)) break;
        const steps = j.steps(runId);
        const pending = steps.filter((step) => step.state === "pending");
        if (pending.length) {
          const settled = await Promise.allSettled(pending.map((step) => this.execStep(runId, step.step_key)));
          const crash = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
          if (crash) throw crash.reason;
          if (settled.some((item) => item.status === "fulfilled" && item.value === "stop")) { this.stoppedRuns.add(runId); break; }
          continue;
        }
        if (steps.some((step) => step.state === "waiting")) { j.setRunStatus(runId, ["running"], "waiting", null); break; }
        if (steps.some((step) => step.state === "running")) break;
        if (routed.output_json !== null) j.setRunStatus(runId, ["running", "waiting"], "succeeded", null);
        else j.setRunStatus(runId, ["running", "waiting"], "failed", "dead_end: no step is left and the exit was not reached");
        break;
      }
    } finally {
      this.unbeat(runId);
      this.release(runId);
    }
    return this.summary(runId);
  }

  private summary(runId: string): RunSummary {
    const j = this.journal;
    const run = j.getRun(runId)!;
    const steps = j.steps(runId);
    const failed = steps.find((step) => step.state === "failed");
    return {
      runId, status: run.status, reason: run.reason, output: run.output_json ? asObject(run.output_json) : null,
      error: failed?.error ?? null, failedNode: failed?.node_id ?? null,
      waiting: steps.filter((step) => step.state === "waiting").map((step) => {
        const wait = asObject(step.await_json) as { kind?: string; detail?: unknown; partial?: Record<string, unknown> };
        return { stepKey: step.step_key, nodeId: step.node_id, await: { kind: wait.kind ?? "external", detail: wait.detail }, partial: wait.partial ?? null };
      }),
      stopped: this.stoppedRuns.has(runId),
    };
  }

  private failRun(runId: string, reason: string): void {
    const j = this.journal;
    if (!j.setRunStatus(runId, ["running", "waiting"], "failed", reason)) return;
    this.cancelOpenSteps(runId);
  }

  private cancelOpenSteps(runId: string): void {
    for (const step of this.journal.steps(runId)) {
      if (step.state === "pending" || step.state === "waiting") this.journal.moveStep(runId, step.step_key, step.state, "canceled", { ended: true });
    }
  }

  private checkLimits(run: RunRow, c: Compiled): string | null {
    const budget = c.wf.budget;
    if (budget.maxSteps !== undefined && run.steps_used >= budget.maxSteps) return "budget_exceeded:steps";
    if (budget.maxTokens !== undefined && run.tokens_used >= budget.maxTokens) return "budget_exceeded:tokens";
    if (budget.maxCostUsd !== undefined && run.cost_micro_usd >= Math.round(budget.maxCostUsd * 1_000_000)) return "budget_exceeded:cost";
    if (budget.maxWallSeconds !== undefined && this.now() - run.created_at >= budget.maxWallSeconds * 1000) return "budget_exceeded:wall_time";
    return null;
  }

  // ---------------------------------------------------------------- one step

  private contextFor(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode, attempt: number, signal: AbortSignal): StepContext {
    const j = this.journal;
    const input = JSON.parse(step.input_json) as StepInput;
    const resolve = (ref: string) => this.lookup(run, step, ref);
    return {
      runId: run.id, stepKey: step.step_key, nodeId: node.id, node, workflow: c.wf, attempt, input, runtime: this.runtimes.get(run.id), signal,
      spawnKey: sha256(`${run.id}|${step.step_key}|${attempt}`).slice(0, 32),
      resolve, render: (template) => renderTemplate(template, resolve),
      effect: (key, kind, fn, options) => this.runEffect(j, run.id, step.step_key, key, kind, fn, options),
    };
  }

  private async runEffect<T>(j: Journal, runId: string, stepKey: string, key: string, kind: string, fn: () => Promise<T>,
    options: { intent?: unknown; reconcile?: EffectReconcile<T> } = {}): Promise<T> {
    const db = j.db, at = () => this.now();
    const read = () => db.prepare("SELECT * FROM lane_pilot_wf_effect WHERE run_id=? AND step_key=? AND effect_key=?").get(runId, stepKey, key) as EffectRow | undefined;
    const write = (state: EffectRow["state"], result?: unknown) => {
      db.prepare("UPDATE lane_pilot_wf_effect SET state=?, result_json=COALESCE(?,result_json), updated_at=? WHERE run_id=? AND step_key=? AND effect_key=?")
        .run(state, result === undefined ? null : JSON.stringify(result), at(), runId, stepKey, key);
      j.event(runId, stepKey, "effect", null, state, `${kind}:${key}`);
    };
    const row = read();
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
    this.fault("effect-intended");
    try {
      const result = await fn();
      this.fault("effect-called");
      write("done", result ?? null);
      return result;
    } catch (cause) {
      if (!isEngineBug(cause)) write("failed");
      throw cause;
    }
  }

  /** Runs one pending step to its end; "stop" when the engine was asked to halt at this boundary. */
  private async execStep(runId: string, stepKey: string): Promise<"done" | "stop" | "skip"> {
    const j = this.journal;
    if (this.options.admit && !(await this.options.admit())) return "stop";
    if (this.stopped()) return "stop";
    const run = j.getRun(runId)!;
    if (TERMINAL_RUN.includes(run.status)) return "skip";
    const c = this.compiled(run);
    const step = j.getStep(runId, stepKey)!;
    if (step.state !== "pending") return "skip";
    const node = c.nodes.get(step.node_id)!;
    const limit = this.checkLimits(run, c);
    if (limit) { if (j.setRunStatus(runId, ["running", "waiting"], "blocked", limit)) this.cancelOpenSteps(runId); return "skip"; }
    const startAttempt = Math.max(1, step.attempt);
    const spawnKey = sha256(`${runId}|${stepKey}|${startAttempt}`).slice(0, 32);
    this.fault("before-start");
    if (!j.moveStep(runId, stepKey, "pending", "running", { started: true, harness_version: this.options.harnessVersion, attempt: startAttempt, spawn_key: spawnKey })) return "skip";
    j.db.prepare("UPDATE lane_pilot_wf_run SET steps_used=steps_used+1, updated_at=? WHERE id=?").run(this.now(), runId);
    const executor = this.executors.get(this.keyFor(node)!)!;
    const abort = this.aborts.get(runId) ?? new AbortController();
    this.aborts.set(runId, abort);
    let outcome: StepOutcome | null = null, lastError: unknown = null;
    for (let attempt = startAttempt; attempt <= node.maxAttempts; attempt += 1) {
      if (attempt !== startAttempt) j.db.prepare("UPDATE lane_pilot_wf_step SET attempt=?, spawn_key=?, updated_at=? WHERE run_id=? AND step_key=?").run(attempt, sha256(`${runId}|${stepKey}|${attempt}`).slice(0, 32), this.now(), runId, stepKey);
      try {
        this.fault("before-run");
        const fresh = j.getStep(runId, stepKey)!;
        const attemptAbort = new AbortController();
        const forward = () => attemptAbort.abort();
        abort.signal.addEventListener("abort", forward, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const running = executor.run(this.contextFor(run, c, fresh, node, attempt, attemptAbort.signal));
          const limited = node.timeoutSec === undefined ? running : Promise.race([running, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { attemptAbort.abort(); reject(new Error(`timeout after ${node.timeoutSec}s`)); }, node.timeoutSec! * 1000);
          })]);
          outcome = await limited;
        } finally { clearTimeout(timer); abort.signal.removeEventListener("abort", forward); }
        if (!("wait" in outcome)) outcome = { ...outcome, output: checkOutput(outputFields(c.wf, node), outcome.output) };
        lastError = null;
        break;
      } catch (cause) {
        if (isEngineBug(cause)) throw cause;
        lastError = cause; outcome = null;
        j.event(runId, stepKey, "attempt_failed", null, null, `${attempt}/${node.maxAttempts}: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (abort.signal.aborted) break;
      }
    }
    this.fault("after-run");
    const current = j.getRun(runId)!;
    if (TERMINAL_RUN.includes(current.status)) { j.moveStep(runId, stepKey, "running", "canceled", { ended: true }); return "skip"; }
    const receipt = (extra: Record<string, unknown>) => JSON.stringify({ executor: this.keyFor(node), harnessVersion: this.options.harnessVersion, ...extra });
    if (!outcome) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      const code = lastError instanceof MissingValueError ? lastError.code : "step_failed";
      if (j.moveStep(runId, stepKey, "running", "failed", { error: message, ended: true, receipt_json: receipt({ code }) })) this.failRun(runId, `${code}:${node.id}`);
      return "done";
    }
    const usage = outcome.usage;
    const addUsage = () => { if (usage) j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?").run(Math.round(usage.tokens ?? 0), Math.round((usage.costUsd ?? 0) * 1_000_000), runId); };
    if ("wait" in outcome) {
      if (j.moveStep(runId, stepKey, "running", "waiting", { await_json: JSON.stringify({ ...outcome.wait, partial: outcome.partial ?? null }), receipt_json: receipt({ threadId: outcome.threadId ?? null, usage: usage ?? null }) })) addUsage();
      return "done";
    }
    const outputJson = JSON.stringify(outcome.output);
    j.db.transaction(() => {
      if (j.moveStep(runId, stepKey, "running", "succeeded", { output_json: outputJson, ended: true,
        receipt_json: receipt({ inputSha256: sha256(step.input_json), outputSha256: sha256(outputJson), threadId: outcome.threadId ?? null, usage: usage ?? null,
          handoff: node.type === "agent" ? outcome.output.handoff ?? null : null, attempts: j.getStep(runId, stepKey)!.attempt }) })) addUsage();
    })();
    this.fault("after-record");
    return "done";
  }

  // ---------------------------------------------------------------- reading values

  private lookup(run: RunRow, step: StepRow | null, text: string): unknown {
    const ref = parseRef(text);
    if (!ref) return undefined;
    if (ref.kind === "input") return valueAtPath(asObject(run.inputs_json), ref.path);
    if (ref.kind === "item" || ref.kind === "index") {
      const input = step ? asObject(step.input_json) : {};
      return ref.kind === "index" ? input.index : valueAtPath(input.item, ref.path);
    }
    const scopes = scopeChain(step?.scope ?? "");
    const row = this.journal.db.prepare(`SELECT output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state='succeeded' AND scope IN (${scopes.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT 1`)
      .get(run.id, ref.node, ...scopes) as { output_json: string | null } | undefined;
    return row?.output_json ? valueAtPath(JSON.parse(row.output_json), ref.path) : undefined;
  }

  private refRequired(c: Compiled, text: string): boolean {
    const ref = parseRef(text);
    if (!ref) return false;
    if (ref.kind === "item" || ref.kind === "index") return false;
    const fields = ref.kind === "input" ? c.wf.inputs : (c.nodes.get(ref.node!) ? outputFields(c.wf, c.nodes.get(ref.node!)!) : []);
    const resolved = resolvePath(fields, ref.path);
    return !("error" in resolved) && resolved.required && !resolved.length;
  }

  private mapWith(run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [name, ref] of Object.entries(edge.with ?? {})) {
      const value = this.lookup(run, from, ref);
      if (value === undefined || value === null) {
        if (this.refRequired(c, ref)) throw new RouteFailure("mapping_field_missing", `"${ref}" has no value for "${name}" on the edge ${edge.from} -> ${edge.to}`);
        continue;
      }
      data[name] = value;
    }
    return data;
  }

  // ---------------------------------------------------------------- routing

  private routeAll(run: RunRow, c: Compiled): void {
    const j = this.journal;
    for (const step of j.steps(run.id)) {
      if ((step.state !== "succeeded" && step.state !== "skipped") || step.routed) continue;
      try {
        j.db.transaction(() => {
          this.fault("before-route");
          const node = c.nodes.get(step.node_id)!;
          if (node.type === "parallel") this.routeParallel(run, c, step, node);
          else this.routeEdges(run, c, step, node);
          j.db.prepare("UPDATE lane_pilot_wf_step SET routed=1 WHERE run_id=? AND step_key=?").run(run.id, step.step_key);
          this.fault("after-route");
        })();
      } catch (cause) {
        if (cause instanceof RouteFailure) { this.failRun(run.id, `${cause.code}:${step.node_id}: ${cause.message}`); return; }
        if (cause instanceof MissingValueError) { this.failRun(run.id, `${cause.code}:${step.node_id}: ${cause.message}`); return; }
        throw cause;
      }
      if (TERMINAL_RUN.includes(j.getRun(run.id)!.status)) return;
    }
  }

  private visitsOf(runId: string, nodeId: string, scope: string): number {
    return (this.journal.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND scope=?").get(runId, nodeId, scope) as { n: number }).n;
  }

  private routeEdges(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): void {
    const out = c.out.get(node.id) ?? [];
    const output = asObject(step.output_json);
    const fields = outputFields(c.wf, node);
    const matching = out.filter((item) => item.edge.when && evalCondition(item.edge.when, output, fields, `${node.id}`));
    const fallback = out.find((item) => !item.edge.when);
    const candidates = [...matching, ...(fallback ? [fallback] : [])];
    if (!candidates.length) throw new RouteFailure("no_matching_edge", `no condition matched and there is no fallback edge`);
    let exhausted: string | null = null;
    for (const candidate of candidates) {
      const target = candidate.edge.to;
      const targetNode = c.nodes.get(target);
      if (targetNode && targetNode.type !== "join" && this.visitsOf(run.id, target, step.scope) >= (targetNode.maxVisits ?? 1)) {
        exhausted = exhausted ?? target;
        this.journal.event(run.id, step.step_key, "edge_skipped", null, null, `${target} reached maxVisits ${targetNode.maxVisits ?? 1}`);
        continue;
      }
      this.deliver(run, c, step, candidate.edge, candidate.index, { scope: step.scope, fromScope: step.scope, suffix: "" });
      return;
    }
    throw new RouteFailure(`guard:maxVisits`, `"${exhausted}" has used its visits`);
  }

  private routeParallel(run: RunRow, c: Compiled, step: StepRow, node: Extract<WorkflowNode, { type: "parallel" }>): void {
    const out = c.out.get(node.id) ?? [];
    const limit = node.maxFanOut ?? c.wf.guards.maxFanOut;
    let branches: Array<{ edge: WorkflowEdge; index: number; item?: unknown; idx: number }>;
    if (node.foreach) {
      const items = this.lookup(run, step, node.foreach);
      if (!Array.isArray(items)) throw new RouteFailure("foreach_not_array", `"${node.foreach}" is not a list`);
      let list = items;
      if (list.length > limit) {
        if (node.onOverflow === "truncate") { list = list.slice(0, limit); this.journal.event(run.id, step.step_key, "fan_out_truncated", null, null, `${items.length} -> ${limit}`); }
        else throw new RouteFailure("guard:maxFanOut", `${items.length} items exceed the fan-out limit ${limit}`);
      }
      branches = list.map((item, idx) => ({ edge: out[0]!.edge, index: out[0]!.index, item, idx }));
    } else {
      if (out.length > limit) throw new RouteFailure("guard:maxFanOut", `${out.length} branches exceed the fan-out limit ${limit}`);
      branches = out.map((item, idx) => ({ edge: item.edge, index: item.index, idx }));
    }
    this.journal.db.prepare("UPDATE lane_pilot_wf_step SET fan_count=? WHERE run_id=? AND step_key=?").run(branches.length, run.id, step.step_key);
    const joinNode = c.wf.nodes.find((candidate) => candidate.type === "join" && candidate.parallel === node.id)!;
    for (const branch of branches) {
      const scope = `${step.scope ? `${step.scope}/` : ""}${step.step_key}~${branch.idx}`;
      this.deliver(run, c, step, branch.edge, branch.index, { scope, fromScope: step.scope, suffix: `~${branch.idx}`, item: branch.item, index: branch.item === undefined ? undefined : branch.idx, group: { key: step.step_key, branch: branch.idx } });
    }
    if (branches.length === 0) this.tryJoin(run, c, step.step_key, joinNode as Extract<WorkflowNode, { type: "join" }>, step.scope);
  }

  /** Hands the data of an edge to its target: the exit, a join arrival, or a new step. */
  private deliver(run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge, edgeIndex: number,
    where: { scope: string; fromScope: string; suffix: string; item?: unknown; index?: number; group?: { key: string; branch: number } }): void {
    const j = this.journal;
    const data = this.mapWith(run, c, from, edge);
    if (edge.to === "end") {
      if (where.scope !== "") throw new RouteFailure("branch_reached_end", "a branch reached the exit without its join");
      j.db.prepare("UPDATE lane_pilot_wf_run SET output_json=?, updated_at=? WHERE id=?").run(JSON.stringify(data), this.now(), run.id);
      j.event(run.id, from?.step_key ?? null, "exit", null, null);
      return;
    }
    const target = c.nodes.get(edge.to)!;
    if (target.type === "join") {
      const group = where.group ?? (() => {
        const last = from?.scope.split("/").pop() ?? "";
        const at = last.lastIndexOf("~");
        return at < 0 ? null : { key: last.slice(0, at), branch: Number(last.slice(at + 1)) };
      })();
      if (!group) throw new RouteFailure("join_outside_branch", `join "${target.id}" was reached outside its parallel branches`);
      const parallelStep = j.getStep(run.id, group.key);
      if (!parallelStep || parallelStep.node_id !== target.parallel) throw new RouteFailure("join_outside_branch", `join "${target.id}" belongs to "${target.parallel}"`);
      j.db.prepare("INSERT OR IGNORE INTO lane_pilot_wf_arrival(run_id,group_key,branch,from_step,data_json,at) VALUES (?,?,?,?,?,?)")
        .run(run.id, group.key, group.branch, from?.step_key ?? group.key, JSON.stringify(data), this.now());
      this.tryJoin(run, c, group.key, target, parallelStep.scope);
      return;
    }
    const total = (j.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_step WHERE run_id=?").get(run.id) as { n: number }).n;
    if (total >= c.wf.guards.maxSteps) throw new RouteFailure("guard:maxSteps", `the run reached ${c.wf.guards.maxSteps} steps`);
    const visit = this.visitsOf(run.id, target.id, where.scope) + 1;
    const input: StepInput = {
      with: data,
      via: { mode: edge.pass, fromStep: from?.step_key ?? null,
        ...(from?.receipt_json ? { fromThreadId: (JSON.parse(from.receipt_json) as { threadId?: string | null }).threadId ?? null } : {}),
        ...(from?.output_json ? { handoff: (asObject(from.output_json).handoff as string | undefined) ?? null } : {}) },
    };
    const inherited = from && from.scope === where.scope ? asObject(from.input_json) : {};
    const item = where.item !== undefined ? where.item : inherited.item;
    const index = where.item !== undefined ? where.index : (inherited.index as number | undefined);
    if (item !== undefined) input.item = item;
    if (index !== undefined) input.index = index;
    const stepKey = `${target.id}#${visit}${where.scope ? `@${stableId(where.scope).slice(0, 6)}` : ""}`;
    const origin = stableId(from?.step_key ?? "entry", edgeIndex, where.suffix);
    const result = j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(run.id, stepKey, origin, target.id, visit, where.scope, from?.step_key ?? null, edgeIndex, JSON.stringify(input), this.now());
    if (result.changes > 0) j.event(run.id, stepKey, "step", null, "pending", from ? `from ${from.step_key}` : "entry");
  }

  private tryJoin(run: RunRow, c: Compiled, groupKey: string, join: Extract<WorkflowNode, { type: "join" }>, parentScope: string): void {
    const j = this.journal;
    const parallelStep = j.getStep(run.id, groupKey)!;
    if (parallelStep.fan_count === null) return;
    const arrivals = j.db.prepare("SELECT branch, data_json FROM lane_pilot_wf_arrival WHERE run_id=? AND group_key=? ORDER BY branch").all(run.id, groupKey) as Array<{ branch: number; data_json: string }>;
    if (arrivals.length < parallelStep.fan_count) return;
    const results = arrivals.map((row) => JSON.parse(row.data_json) as Record<string, unknown>);
    const visit = this.visitsOf(run.id, join.id, parentScope) + 1;
    const stepKey = `${join.id}#${visit}${parentScope ? `@${stableId(parentScope).slice(0, 6)}` : ""}`;
    const input: StepInput = { with: { results }, via: { mode: "artifact", fromStep: groupKey } };
    const result = j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(run.id, stepKey, stableId("join", groupKey, join.id), join.id, visit, parentScope, groupKey, null, JSON.stringify(input), this.now());
    if (result.changes > 0) j.event(run.id, stepKey, "step", null, "pending", `join of ${groupKey}`);
  }

  // ---------------------------------------------------------------- builtin executors

  private registerBuiltins(): void {
    this.register("builtin:parallel", { reentrant: true, run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "parallel" }>;
      if (node.foreach && !Array.isArray(ctx.resolve(node.foreach))) throw new Error(`foreach "${node.foreach}" is not a list`);
      return { output: {} };
    } });
    this.register("builtin:join", { reentrant: true, run: async (ctx) => {
      const results = (ctx.input.with.results as unknown[]) ?? [];
      return { output: { results, count: results.length } };
    } });
    this.register("builtin:decision", { reentrant: true, run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "decision" }>;
      const fields = outputFields(ctx.workflow, node);
      return { output: Object.fromEntries(fields.map((field) => [field.name, ctx.resolve(`${node.reads}.${field.name}`)]).filter(([, value]) => value !== undefined)) };
    } });
    this.register("builtin:human", {
      run: async (ctx) => {
        const node = ctx.node as Extract<WorkflowNode, { type: "human" }>;
        const deadline = node.timeoutSec ? this.now() + node.timeoutSec * 1000 : undefined;
        return { wait: { kind: "human", detail: { question: ctx.render(node.question), options: node.options }, ...(deadline ? { deadline } : {}) } };
      },
      poll: async (step, { node }) => {
        const human = node as Extract<WorkflowNode, { type: "human" }>;
        if (!step.await.deadline || this.now() < step.await.deadline) return null;
        if (human.onTimeout === "default" && human.defaultOption) {
          const field = human.output.find((candidate) => candidate.type === "string" || candidate.type === "enum");
          return { output: field ? { [field.name]: human.defaultOption } : {} };
        }
        return { error: "human_timeout" };
      },
    });
    this.register("builtin:subworkflow", {
      run: async (ctx) => {
        const node = ctx.node as Extract<WorkflowNode, { type: "subworkflow" }>;
        const run = this.journal.getRun(ctx.runId)!;
        const depth = run.depth + 1;
        if (depth > Math.min(ctx.workflow.guards.maxSubworkflowDepth, MAX_SUBWORKFLOW_DEPTH)) throw new MissingValueError("subworkflow_depth", `subworkflows go ${depth} deep; the limit is ${MAX_SUBWORKFLOW_DEPTH}`);
        const child = this.options.resolveWorkflow?.(node.workflow, node.version);
        if (!child) throw new Error(`workflow "${node.workflow}" was not found`);
        const inputs = Object.fromEntries(Object.entries(node.inputs).map(([name, ref]) => [name, ctx.resolve(ref)]).filter(([, value]) => value !== undefined));
        const started = this.start({ workflow: child, inputs, key: `child:${ctx.runId}:${ctx.stepKey}`, parent: { runId: ctx.runId, stepKey: ctx.stepKey }, depth,
          link: { projectId: run.project_id ?? undefined, runId: run.link_run_id ?? undefined, taskId: run.link_task_id ?? undefined } });
        return this.childOutcome(await started.done, node);
      },
      poll: async (step, { node }) => {
        const child = this.journal.db.prepare("SELECT id, status FROM lane_pilot_wf_run WHERE parent_run_id=? AND parent_step_key=?").get(step.runId, step.stepKey) as { id: string; status: RunStatus } | undefined;
        if (!child) return { error: "child run not found" };
        if (child.status === "running" || child.status === "waiting") return null;
        const outcome = this.childOutcome(this.summary(child.id), node as Extract<WorkflowNode, { type: "subworkflow" }>);
        return "wait" in outcome ? null : outcome;
      },
    });
  }

  private childOutcome(child: RunSummary, node: Extract<WorkflowNode, { type: "subworkflow" }>): StepOutcome {
    if (child.status === "succeeded") return { output: child.output ?? {} };
    if (child.status === "waiting" || child.status === "running") return { wait: { kind: "subworkflow", detail: { childRunId: child.runId } } };
    throw new Error(`subworkflow ${node.workflow} ${child.status}: ${child.error ?? child.reason ?? ""}`);
  }

  // ---------------------------------------------------------------- outside the loop

  /** Takes up the runs a reload left: re-runs reentrant steps, interrupts the rest, routes finished steps, goes on. */
  async resume(options: { takeOver?: boolean; runtimeFor?: (run: RunRow) => unknown } = {}): Promise<string[]> {
    const j = this.journal;
    const taken: string[] = [];
    const rows = j.db.prepare("SELECT * FROM lane_pilot_wf_run WHERE status='running'").all() as RunRow[];
    for (const row of rows) {
      if (this.drives.has(row.id)) continue;
      if (options.takeOver) j.db.prepare("UPDATE lane_pilot_wf_run SET owner_id=NULL, lease_until=0 WHERE id=?").run(row.id);
      if (!this.claim(row.id)) continue;
      taken.push(row.id);
      if (options.runtimeFor && !this.runtimes.has(row.id)) this.runtimes.set(row.id, options.runtimeFor(row));
      const c = this.compiled(row);
      for (const step of j.steps(row.id).filter((item) => item.state === "running")) {
        const node = c.nodes.get(step.node_id);
        const executor = node ? this.executors.get(this.keyFor(node) ?? "") : undefined;
        const sameBuild = step.harness_version === this.options.harnessVersion;
        if (executor?.reentrant && sameBuild) { j.moveStep(row.id, step.step_key, "running", "pending"); continue; }
        const why = executor?.reentrant ? "harness_changed" : "not_reentrant";
        j.moveStep(row.id, step.step_key, "running", "interrupted", { error: `interrupted by a reload (${why})`, ended: true });
        j.setRunStatus(row.id, ["running"], "interrupted", `step_interrupted:${step.node_id}:${why}`);
        this.cancelOpenSteps(row.id);
      }
      this.release(row.id);
    }
    for (const id of taken) this.drive(id).catch((cause) => this.log(`run ${id} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
    return taken;
  }

  /** Asks every waiting step whether what it waits for is over; settles and continues the runs it can. */
  async poll(): Promise<number> {
    const j = this.journal;
    const rows = j.db.prepare(`SELECT s.run_id AS runId, s.step_key AS stepKey FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
      WHERE s.state='waiting' AND r.status IN ('waiting','running') ORDER BY s.rowid`).all() as Array<{ runId: string; stepKey: string }>;
    let settled = 0;
    const touched = new Set<string>();
    for (const row of rows) {
      if (this.stopped()) break;
      const run = j.getRun(row.runId)!, step = j.getStep(row.runId, row.stepKey)!;
      const node = this.compiled(run).nodes.get(step.node_id);
      const executor = node ? this.executors.get(this.keyFor(node) ?? "") : undefined;
      if (!node || !executor?.poll) continue;
      const wait = asObject(step.await_json) as { kind: string; detail?: unknown; deadline?: number };
      let result: PollResult;
      try { result = await executor.poll({ runId: row.runId, stepKey: row.stepKey, nodeId: node.id, await: wait }, { runtime: this.runtimes.get(row.runId), node }); }
      catch (cause) { this.log(`poll of ${row.runId}/${row.stepKey} failed: ${cause instanceof Error ? cause.message : String(cause)}`); continue; }
      if (!result) continue;
      if (this.settle(row.runId, row.stepKey, result)) { settled += 1; touched.add(row.runId); }
    }
    await Promise.allSettled([...touched].map((id) => this.drive(id)));
    return settled;
  }

  /** Settles a waiting step from outside (a human answered, an attempt ended); false when it is not waiting any more. */
  resolve(runId: string, stepKey: string, output: Record<string, unknown>): Promise<boolean> {
    const ok = this.settle(runId, stepKey, { output });
    return ok ? this.drive(runId).then(() => true) : Promise.resolve(false);
  }

  private settle(runId: string, stepKey: string, result: { output: Record<string, unknown>; usage?: Usage; threadId?: string | null } | { error: string }): boolean {
    const j = this.journal;
    const run = j.getRun(runId), step = j.getStep(runId, stepKey);
    if (!run || !step || step.state !== "waiting") return false;
    const c = this.compiled(run), node = c.nodes.get(step.node_id)!;
    return j.db.transaction(() => {
      if ("error" in result) {
        if (!j.moveStep(runId, stepKey, "waiting", "failed", { error: result.error, ended: true })) return false;
        this.failRun(runId, `step_failed:${node.id}`);
        return true;
      }
      let output: Record<string, unknown>;
      try { output = checkOutput(outputFields(c.wf, node), result.output); }
      catch (cause) {
        if (!j.moveStep(runId, stepKey, "waiting", "failed", { error: cause instanceof Error ? cause.message : String(cause), ended: true })) return false;
        this.failRun(runId, `output_invalid:${node.id}`);
        return true;
      }
      const prior = asObject(step.receipt_json);
      const outputJson = JSON.stringify(output);
      if (!j.moveStep(runId, stepKey, "waiting", "succeeded", { output_json: outputJson, ended: true,
        receipt_json: JSON.stringify({ ...prior, outputSha256: sha256(outputJson), threadId: result.threadId ?? prior.threadId ?? null, settledBy: "outside" }) })) return false;
      if (result.usage) j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?").run(Math.round(result.usage.tokens ?? 0), Math.round((result.usage.costUsd ?? 0) * 1_000_000), runId);
      j.setRunStatus(runId, ["waiting"], "running", null);
      return true;
    })();
  }

  cancel(runId: string, reason = "canceled"): boolean {
    const ok = this.journal.setRunStatus(runId, ["running", "waiting"], "canceled", reason);
    if (ok) { this.aborts.get(runId)?.abort(); this.cancelOpenSteps(runId); }
    return ok;
  }

  get(runId: string): RunSummary | null { return this.journal.getRun(runId) ? this.summary(runId) : null; }

  /** Everything a live view needs: the run and its steps, with the node each belongs to. */
  snapshot(runId: string): { run: RunRow; steps: StepRow[]; events: unknown[] } | null {
    const run = this.journal.getRun(runId);
    if (!run) return null;
    return { run, steps: this.journal.steps(runId), events: this.journal.db.prepare("SELECT * FROM lane_pilot_wf_event WHERE run_id=? ORDER BY seq").all(runId) };
  }

  inFlight(): string[] { return [...this.drives.keys()]; }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.beats.keys()]) this.unbeat(id);
    try { this.options.db.prepare("UPDATE lane_pilot_wf_run SET owner_id=NULL, lease_until=0 WHERE owner_id=?").run(this.instanceId); } catch { /* the database is already closed */ }
  }
}
