import { randomUUID } from "node:crypto";
import type { LanePilotDatabase } from "../database";
import { MissingValueError, evalCondition, evalSpec, parseExpr, refOf, renderValue, toExpr, valueSpecOf } from "./expr";
import type { EvalEnv, Expr, Ref } from "./expr";
import { END, MAX_SUBWORKFLOW_DEPTH, QUALITY_MODES, START } from "./schema";
import type { Field, GraphNode as WorkflowNode, PassMode, QualityMode, Workflow, WorkflowEdge } from "./schema";
import { createJournal, sha256, stableId, TERMINAL_RUN } from "./journal";
import type { EffectRow, Journal, RunRow, RunStatus, StepRow } from "./journal";
import { executorKey, lowerWorkflow, outputFields } from "./lower";
import { definitionSha256 } from "./store";
import { WorkflowError, validateWorkflow } from "./validate";
import { checkOutput, slugOf, valueAtPath } from "./values";
import { goalsSchema, goalsSha, parseGoals, regroundDue } from "./goals";
import type { GoalAudit, RunGoal } from "./goals";

/** What a step receives: only the mapped fields (mode artifact), and where they came from. */
export type StepInput = {
  with: Record<string, unknown>;
  via: { mode: PassMode; fromStep: string | null; fromThreadId?: string | null; handoff?: string | null };
  item?: unknown;
  index?: number;
  /** Order `depends_on`: the branches that must have arrived at the join before this branch starts, and the parallel step they belong to. */
  after?: number[];
  group?: string;
  /** How many times the owner re-ran this step by hand: part of its spawn key, so the new try gets a new thread, not the old one. */
  rerun?: number;
};
export type Usage = { tokens?: number; costUsd?: number };
export type StepDone = { output: Record<string, unknown>; usage?: Usage; threadId?: string | null; detail?: unknown };
export type StepWait = { wait: { kind: string; detail?: unknown; deadline?: number }; partial?: Record<string, unknown>; usage?: Usage; threadId?: string | null };
export type StepOutcome = StepDone | StepWait;
export type PollResult = null | { output: Record<string, unknown>; usage?: Usage; threadId?: string | null } | { error: string };

export type EffectReconcile<T> = (effect: EffectRow) => Promise<{ happened: true; result: T } | { happened: false } | null>;

export interface StepContext<R = unknown> {
  runId: string; stepKey: string; nodeId: string; node: WorkflowNode; workflow: Workflow;
  /** The try of this visit, from 1. A resumed step keeps its number, so the spawn key stays the same. */
  attempt: number; input: StepInput; runtime: R | undefined;
  /** The quality mode of the run (`$mode`). */
  mode: QualityMode;
  /** K7: the goals of the run, and whether this step's brief should repeat them (the first step, then every third). */
  goals: RunGoal[]; reground: boolean;
  /** sha256(run | step | attempt): put it in the metadata of a spawned thread to find a lost spawn again (with the vote number, when votes > 1). */
  spawnKey: string; signal: AbortSignal;
  /** Set when the node has `votes` > 1: this is one of `of` independent runs of the same step. */
  vote?: { index: number; of: number };
  /** The value of `node.field`, `$inputs.name`, `ctx.x`, `item` or `index` as this step sees it. */
  resolve(ref: string): unknown;
  /** Writes `{{ref}}` placeholders into a text. */
  render(template: string): string;
  /** A value in an expression-valued position (`'text'`, `node.field`, `a + b`, a bare word is itself). */
  value(spec: unknown): unknown;
  /** A value with `{{ref}}` placeholders written in (a lone placeholder keeps the type of what it names; a node that has not run gives nothing). */
  template(value: unknown): unknown;
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

/**
 * The engine/schema compatibility version: what a step stamped at start and what a reload compares. Bump it only when the journal
 * layout or the semantics of a running step change in a way an old in-flight step cannot be resumed under; NOT on a plugin release.
 */
export const ENGINE_COMPAT_VERSION = "wfe-1";
/** A step stamped before compat versions existed carries the plugin's package version; with a compat version set such a stamp counts as compatible. */
const LEGACY_BUILD_STAMP = /^\d+\.\d+\.\d+/;

export type EngineOptions = {
  db: LanePilotDatabase;
  /** The build (package version): written to receipts and to the run row, informational. */
  harnessVersion: string;
  /** What a reload compares to decide whether an in-flight step may be re-run (default: `harnessVersion`, i.e. every build is its own). */
  compatVersion?: string;
  instanceId?: string;
  now?: () => number;
  log?: (message: string) => void;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  /** Asked before every step: false stops the run at this boundary and leaves the step pending (drain, shutdown). */
  admit?: () => boolean | Promise<boolean>;
  isDisposed?: () => boolean;
  /** The runtime of a run this instance did not start (after a reload): built from the run row, once, when a step needs it. */
  runtimeFor?: (run: RunRow) => unknown;
  /** What a reload does to a run that was in flight: pick up where the journal stopped, or end it as interrupted. */
  resumePolicy?: (run: RunRow) => "continue" | "interrupt";
  leaseMs?: number;
  /** K7: judges the run's output against its goals before the run closes. A throw means the audit could not be made: the run closes and says so. */
  auditGoals?: (input: { run: RunRow; goals: RunGoal[]; output: Record<string, unknown>; steps: StepRow[]; signal: AbortSignal }) => Promise<GoalAudit>;
  /** Called after every journal event of a run (a step moved, the run changed): the hook for live screens. */
  onEvent?: (runId: string) => void;
  /** Test hook: called at named points of the driver; throwing simulates the process dying there. */
  fault?: (point: string) => void;
};

/** Thrown by the test hook; never treated as a step failure. */
export class CrashError extends Error {}
export { MissingValueError };

class RouteFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
const isEngineBug = (cause: unknown) => cause instanceof CrashError || (cause instanceof Error && /database connection is not open|closed/i.test(cause.message));

type Out = Array<{ edge: WorkflowEdge; index: number }>;
type Compiled = {
  wf: Workflow; nodes: Map<string, WorkflowNode>; out: Map<string, Out>;
  /** Conditions parsed once, by edge index and by node id (skip_when). */
  when: Map<number, Expr>; skip: Map<string, Expr>;
  joinOf: Map<string, Extract<WorkflowNode, { type: "join" }>>;
};

const scopeChain = (scope: string): string[] => {
  const parts = scope ? scope.split("/") : [];
  return [...parts.map((_part, index) => parts.slice(0, parts.length - index).join("/")), ""];
};
const asObject = (text: string | null): Record<string, unknown> => (text ? JSON.parse(text) as Record<string, unknown> : {});
const STARTED = ["succeeded", "failed", "running", "waiting", "interrupted"];
/** In a value position (`emit.map`, `skip_out`, a node's `with`) a node that has not run gives nothing, where a condition on it would fail the run. */
const lenient = (env: EvalEnv): EvalEnv => ({ ...env, read: (ref) => { const found = env.read(ref); return found.ran ? found : { ran: true, value: undefined }; } });

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
  private get compat(): string { return this.options.compatVersion ?? this.options.harnessVersion; }
  private readonly leaseMs: number;

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? Date.now;
    this.journal = createJournal(options.db, this.now, options.onEvent);
    this.instanceId = options.instanceId ?? `engine-${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 90_000;
    this.registerBuiltins();
  }

  register<R>(key: string, executor: NodeExecutor<R>): this { this.executors.set(key, executor); return this; }
  hasExecutor = (key: string): boolean => this.executors.has(key);
  private fault(point: string): void { this.options.fault?.(point); }
  /** sha256(run | step | attempt), and the number of the owner's re-runs when there were any. */
  private spawnKeyOf(runId: string, step: StepRow, attempt: number): string {
    const rerun = (asObject(step.input_json) as { rerun?: number }).rerun ?? 0;
    return sha256(`${runId}|${step.step_key}|${attempt}${rerun > 0 ? `|r${rerun}` : ""}`).slice(0, 32);
  }
  private stopped(): boolean { return this.disposed || (this.options.isDisposed?.() ?? false); }
  private log(message: string): void { this.options.log?.(`workflow: ${message}`); }

  // ---------------------------------------------------------------- definitions

  private compile(wf: Workflow): Compiled {
    const nodes = new Map<string, WorkflowNode>(wf.nodes.filter((node): node is WorkflowNode => node.type !== "note").map((node) => [node.id, node]));
    const out = new Map<string, Out>();
    const when = new Map<number, Expr>(), skip = new Map<string, Expr>();
    wf.edges.forEach((edge, index) => {
      const list = out.get(edge.from) ?? []; list.push({ edge, index }); out.set(edge.from, list);
      if (edge.when !== undefined && edge.from !== START) when.set(index, toExpr(edge.when, edge.from));
    });
    for (const node of nodes.values()) if (node.skip_when !== undefined) skip.set(node.id, toExpr(node.skip_when, node.id));
    const joinOf = new Map<string, Extract<WorkflowNode, { type: "join" }>>();
    for (const node of nodes.values()) if (node.type === "join") joinOf.set(node.parallel, node);
    return { wf, nodes, out, when, skip, joinOf };
  }

  /** `definition_json` holds the lowered workflow: children resolved and pinned, nothing left to expand. */
  private compiled(run: RunRow): Compiled {
    let found = this.compiledRuns.get(run.id);
    if (!found) { found = this.compile(JSON.parse(run.definition_json) as Workflow); this.compiledRuns.set(run.id, found); }
    return found;
  }

  /** Why a workflow cannot run here: invalid, or an executor not registered. */
  preflight(workflow: Workflow): string[] {
    const problems = validateWorkflow(workflow, { resolve: this.options.resolveWorkflow }).filter((problem) => problem.level === "error").map((problem) => problem.message);
    const lowered = lowerWorkflow(workflow, this.options.resolveWorkflow);
    for (const node of lowered.nodes) {
      if (node.type === "note") continue;
      const key = executorKey(node);
      if (!key) problems.push(`node "${node.id}" has no executor (set "uses"${node.type === "action" ? " or \"action\"" : ""})`);
      else if (!this.executors.has(key)) problems.push(`node "${node.id}": executor "${key}" is not registered`);
    }
    return problems;
  }

  // ---------------------------------------------------------------- start

  /** Starts a run, or returns the one that already has this key. `done` settles when the run stops: finished, waiting or stopped. */
  start<R>(input: {
    workflow: Workflow; inputs?: Record<string, unknown>; key?: string; runtime?: R; mode?: QualityMode;
    link?: { projectId?: string; runId?: string; taskId?: string; attemptId?: string };
    parent?: { runId: string; stepKey: string }; depth?: number;
    /** K7: what the run is for; checked against its output before it closes. */
    goals?: RunGoal[];
  }): { runId: string; created: boolean; done: Promise<RunSummary> } {
    const { workflow } = input;
    const existing = input.key ? this.options.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE idem_key=?").get(input.key) as { id: string } | undefined : undefined;
    if (existing) {
      if (input.runtime !== undefined) this.runtimes.set(existing.id, input.runtime);
      return { runId: existing.id, created: false, done: this.drive(existing.id) };
    }
    const problems = this.preflight(workflow);
    if (problems.length) throw new WorkflowError(problems.map((message) => ({ level: "error" as const, code: "preflight", message })));
    const withDefaults = { ...(input.inputs ?? {}) };
    for (const field of workflow.inputs) if (withDefaults[field.name] === undefined && field.default !== undefined) withDefaults[field.name] = field.default;
    const inputs = checkOutput(workflow.inputs, withDefaults);
    const depth = input.depth ?? 0;
    if (depth > Math.min(workflow.guards.maxSubworkflowDepth, MAX_SUBWORKFLOW_DEPTH)) throw new MissingValueError("subworkflow_depth", `subworkflows go ${depth} deep; the limit is ${MAX_SUBWORKFLOW_DEPTH}`);
    // The mode the caller asked for: the input as given, else the mode passed along (a subworkflow inherits its parent's), else the default.
    const given = (input.inputs ?? {}).quality_mode;
    const asked: QualityMode = (QUALITY_MODES as readonly unknown[]).includes(given) ? given as QualityMode : input.mode ?? workflow.quality_mode?.default ?? "standard";
    const floor = workflow.quality_mode?.min;
    const mode: QualityMode = workflow.quality_mode?.fixed ?? (floor && QUALITY_MODES.indexOf(asked) < QUALITY_MODES.indexOf(floor) ? floor : asked);
    const goals = goalsSchema.parse(input.goals ?? []);
    const runId = `wfrun_${randomUUID().replaceAll("-", "")}`;
    const j = this.journal, at = this.now();
    const lowered = lowerWorkflow(workflow, this.options.resolveWorkflow);
    const c = this.compile(lowered);
    const entry = c.out.get(START)![0]!;
    j.db.transaction(() => {
      j.db.prepare(`INSERT INTO lane_pilot_wf_run(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,
        parent_run_id,parent_step_key,depth,status,mode,inputs_json,harness_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?)`)
        .run(runId, input.key ?? null, workflow.id, workflow.version, definitionSha256(workflow), JSON.stringify(lowered), input.link?.projectId ?? null, input.link?.runId ?? null,
          input.link?.taskId ?? null, input.link?.attemptId ?? null, input.parent?.runId ?? null, input.parent?.stepKey ?? null, depth, mode, JSON.stringify(inputs), this.options.harnessVersion, at, at);
      if (goals.length) j.db.prepare("UPDATE lane_pilot_wf_run SET goals_json=? WHERE id=?").run(JSON.stringify(goals), runId);
      j.event(runId, null, "run", null, "running", `${workflow.id}@${workflow.version} mode ${mode}`);
      if (goals.length) j.event(runId, null, "goals", null, null, JSON.stringify({ goals, reason: "the goals the run started with", by: "start" }));
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
          const gates = this.gates(routed, this.compiled(routed), pending);
          // A branch blocked by a failed dependency was settled just now: route again before looking at what is ready.
          if (gates.changed) continue;
          if (gates.ready.length) {
            const settled = await Promise.allSettled(gates.ready.map((step) => this.execStep(runId, step.step_key)));
            const crash = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
            if (crash) throw crash.reason;
            if (settled.some((item) => item.status === "fulfilled" && item.value === "stop")) { this.stoppedRuns.add(runId); break; }
            continue;
          }
          // Every pending step waits for a branch that has not arrived: without a running or waiting step nothing can free them.
          if (!steps.some((step) => step.state === "running" || step.state === "waiting")) { this.failRun(runId, "deadlock: branches wait for dependencies that never arrive"); break; }
        }
        if (steps.some((step) => step.state === "waiting")) { j.setRunStatus(runId, ["running"], "waiting", null); break; }
        if (steps.some((step) => step.state === "running")) break;
        if (routed.output_json !== null) { if (await this.closeAfterAudit(routed) === "stop") this.stoppedRuns.add(runId); }
        else j.setRunStatus(runId, ["running", "waiting"], "failed", "dead_end: no step is left and the exit was not reached");
        break;
      }
    } finally {
      this.unbeat(runId);
      this.release(runId);
    }
    return this.summary(runId);
  }

  /**
   * K7: a run that has goals is judged against them before it closes. All met: it closes. Some not: it is `blocked` with the
   * unmet goal ids as the reason, the verdict is in the journal, and the PM either fixes the work (re-run a node: the run reaches
   * its exit and is audited again) or amends the goals with a reason (which audits again). An audit that could not be made closes
   * the run and says so in its reason: a broken auditor must not hold every run.
   */
  private async closeAfterAudit(run: RunRow): Promise<"closed" | "blocked" | "stop"> {
    const j = this.journal;
    const close = (reason: string | null) => { j.setRunStatus(run.id, ["running", "waiting"], "succeeded", reason); return "closed" as const; };
    const goals = parseGoals(run.goals_json), audit = this.options.auditGoals;
    if (!goals.length || !audit) return close(null);
    const sha = goalsSha(goals);
    const last = this.lastAudit(run.id);
    if (last?.sha === sha && last.verdict === "pass") return close(null);
    const abort = this.aborts.get(run.id) ?? new AbortController();
    this.aborts.set(run.id, abort);
    let result: GoalAudit;
    try { result = await audit({ run, goals, output: asObject(run.output_json), steps: j.steps(run.id), signal: abort.signal }); }
    catch (cause) {
      if (isEngineBug(cause)) throw cause;
      if (this.stopped()) return "stop";
      const message = cause instanceof Error ? cause.message : String(cause);
      j.event(run.id, null, "goal_audit", null, "unavailable", JSON.stringify({ sha, verdict: "unavailable", error: message.slice(0, 500) }));
      return close(`goal_audit_unavailable: ${message.slice(0, 300)}`);
    }
    const unmet = result.unmet.filter((entry) => goals.some((goal) => goal.id === entry.id));
    // A goal the auditor did not mention at all is not met: silence is not evidence.
    for (const goal of goals) if (!result.met.includes(goal.id) && !unmet.some((entry) => entry.id === goal.id)) unmet.push({ id: goal.id, why: "the audit gave no verdict on this goal" });
    const verdict = unmet.length ? "gaps" : "pass";
    j.event(run.id, null, "goal_audit", null, verdict, JSON.stringify({ sha, verdict, met: result.met.filter((id) => goals.some((goal) => goal.id === id) && !unmet.some((entry) => entry.id === id)), unmet, ...(result.notes ? { notes: result.notes.slice(0, 1000) } : {}) }));
    if (!unmet.length) return close(null);
    j.setRunStatus(run.id, ["running", "waiting"], "blocked", `goal_audit: not met: ${unmet.map((entry) => entry.id).join(", ")}`);
    return "blocked";
  }

  /** The last goal audit of a run, as the journal has it. */
  lastAudit(runId: string): { sha: string; verdict: "pass" | "gaps" | "unavailable"; met: string[]; unmet: Array<{ id: string; why: string }>; notes?: string; error?: string; at: number } | null {
    const row = this.journal.db.prepare("SELECT detail, at FROM lane_pilot_wf_event WHERE run_id=? AND kind='goal_audit' ORDER BY seq DESC LIMIT 1").get(runId) as { detail: string | null; at: number } | undefined;
    if (!row?.detail) return null;
    try { const detail = JSON.parse(row.detail) as Record<string, unknown>; return { sha: String(detail.sha ?? ""), verdict: detail.verdict as "pass", met: (detail.met as string[] | undefined) ?? [], unmet: (detail.unmet as Array<{ id: string; why: string }> | undefined) ?? [], ...(typeof detail.notes === "string" ? { notes: detail.notes } : {}), ...(typeof detail.error === "string" ? { error: detail.error } : {}), at: row.at }; } catch { return null; }
  }

  /** Every state the goals of a run have been in, oldest first: what changed, why and who said so. */
  goalJournal(runId: string): Array<{ seq: number; at: number; by: string; reason: string; goals: RunGoal[] }> {
    const rows = this.journal.db.prepare("SELECT seq, at, detail FROM lane_pilot_wf_event WHERE run_id=? AND kind='goals' ORDER BY seq").all(runId) as Array<{ seq: number; at: number; detail: string | null }>;
    return rows.flatMap((row) => {
      try { const detail = JSON.parse(row.detail ?? "{}") as { goals?: unknown; reason?: unknown; by?: unknown }; return [{ seq: row.seq, at: row.at, by: String(detail.by ?? ""), reason: String(detail.reason ?? ""), goals: parseGoals(JSON.stringify(detail.goals ?? [])) }]; } catch { return []; }
    });
  }

  /**
   * K7: the owner or the PM changes what the run is for. The whole list is replaced; the reason and the author go into the journal with the
   * list that was replaced. A run that was blocked by its goal audit is audited again against the new goals.
   */
  amendGoals(runId: string, goals: unknown, reason: string, by = "pm"): { ok: true; version: number; reopened: boolean } | { ok: false; reason: string } {
    const j = this.journal;
    const run = j.getRun(runId);
    if (!run) return { ok: false, reason: "not_found" };
    if (run.status === "canceled") return { ok: false, reason: "run_canceled" };
    const parsed = goalsSchema.safeParse(goals);
    if (!parsed.success) return { ok: false, reason: `invalid_goals: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "goals"} ${issue.message}`).join("; ")}` };
    const why = reason.trim();
    if (why.length < 3) return { ok: false, reason: "reason_required" };
    const before = parseGoals(run.goals_json);
    const reopen = run.status === "blocked" && (run.reason ?? "").startsWith("goal_audit");
    j.db.transaction(() => {
      j.db.prepare("UPDATE lane_pilot_wf_run SET goals_json=?, updated_at=? WHERE id=?").run(parsed.data.length ? JSON.stringify(parsed.data) : null, this.now(), runId);
      j.event(runId, null, "goals", null, null, JSON.stringify({ goals: parsed.data, before, reason: why.slice(0, 600), by }));
      if (reopen) j.setRunStatus(runId, ["blocked"], "running", null);
    })();
    if (reopen) void this.kick(runId).catch((cause) => this.log(`run ${runId} stopped after its goals were amended: ${cause instanceof Error ? cause.message : String(cause)}`));
    return { ok: true, version: this.goalJournal(runId).length, reopened: reopen };
  }

  private summary(runId: string): RunSummary {
    const j = this.journal;
    const run = j.getRun(runId)!;
    const steps = j.steps(runId);
    // The step that ended the run when the reason names it (a join that lost its majority), else the first one that failed.
    const failed = steps.find((step) => step.state === "failed" && run.reason?.endsWith(`:${step.node_id}`)) ?? steps.find((step) => step.state === "failed");
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

  /** The parallel a branch scope belongs to, with its join; null outside a branch. */
  private branchOf(run: RunRow, c: Compiled, step: StepRow): { group: string; branch: number; parallel: Extract<WorkflowNode, { type: "parallel" }>; join: Extract<WorkflowNode, { type: "join" }>; parentScope: string } | null {
    const last = step.scope.split("/").pop() ?? "";
    const at = last.lastIndexOf("~");
    if (at < 0) return null;
    const group = last.slice(0, at), parallelStep = this.journal.getStep(run.id, group);
    const parallel = parallelStep ? c.nodes.get(parallelStep.node_id) : undefined;
    const join = parallel ? c.joinOf.get(parallel.id) : undefined;
    if (!parallelStep || !parallel || parallel.type !== "parallel" || !join) return null;
    return { group, branch: Number(last.slice(at + 1)), parallel, join, parentScope: parallelStep.scope };
  }

  /** A failed branch ends the run, unless its join takes a partial result: policy majority or all_or_low_confidence, or `on_child_fail`. */
  private tolerates(branch: { parallel: Extract<WorkflowNode, { type: "parallel" }>; join: Extract<WorkflowNode, { type: "join" }> }): boolean {
    return branch.parallel.on_child_fail !== undefined || branch.join.policy !== "all";
  }

  /** A branch arrives at its join as failed: the join sees it in `failed` and decides by its policy. */
  private arrive(run: RunRow, c: Compiled, branch: { group: string; branch: number; join: Extract<WorkflowNode, { type: "join" }>; parentScope: string }, stepKey: string, data: Record<string, unknown>): void {
    this.journal.db.prepare("INSERT OR IGNORE INTO lane_pilot_wf_arrival(run_id,group_key,branch,from_step,data_json,at) VALUES (?,?,?,?,?,?)")
      .run(run.id, branch.group, branch.branch, stepKey, JSON.stringify(data), this.now());
    this.journal.event(run.id, stepKey, "branch_failed", null, null, String(data.$failed ?? ""));
    this.tryJoin(run, c, branch.group, branch.join, branch.parentScope);
  }

  private failStep(runId: string, c: Compiled, stepKey: string, reason: string, message: string): void {
    const run = this.journal.getRun(runId), step = this.journal.getStep(runId, stepKey);
    const branch = run && step ? this.branchOf(run, c, step) : null;
    if (run && branch && this.tolerates(branch)) { this.arrive(run, c, branch, stepKey, { $failed: message }); return; }
    this.failRun(runId, reason);
  }

  /** Steps of an ordered parallel start when the branches they depend on have arrived; one whose dependency failed is blocked (on_child_fail). */
  private gates(run: RunRow, c: Compiled, pending: StepRow[]): { ready: StepRow[]; changed: boolean } {
    const j = this.journal;
    const ready: StepRow[] = [];
    let changed = false;
    for (const step of pending) {
      const input = asObject(step.input_json) as { after?: number[]; group?: string };
      if (!input.after?.length || !input.group) { ready.push(step); continue; }
      const arrived = new Map((j.db.prepare("SELECT branch, data_json FROM lane_pilot_wf_arrival WHERE run_id=? AND group_key=?").all(run.id, input.group) as Array<{ branch: number; data_json: string }>)
        .map((row) => [row.branch, asObject(row.data_json)]));
      if (input.after.some((dep) => !arrived.has(dep))) continue;
      const failed = input.after.find((dep) => arrived.get(dep)!.$failed !== undefined);
      const branch = failed !== undefined ? this.branchOf(run, c, step) : null;
      if (failed === undefined || !branch || branch.parallel.on_child_fail !== "block_dependents") { ready.push(step); continue; }
      const dependency = (asObject(j.getStep(run.id, input.group)!.input_json) as { items?: unknown[] }).items?.[failed];
      const label = typeof dependency === "object" && dependency !== null && typeof (dependency as { id?: unknown }).id === "string" ? (dependency as { id: string }).id : String(failed);
      if (!j.moveStep(run.id, step.step_key, "pending", "canceled", { error: `upstream_blocked:${label}`, ended: true })) continue;
      this.arrive(run, c, branch, step.step_key, { $failed: `upstream_blocked:${label}`, $blocked: true });
      changed = true;
    }
    return { ready: this.withinConcurrency(run, c, ready), changed };
  }

  /** `concurrency` on a fan-out: only that many branches run at once, in branch order; the first step of the others waits for a free place. */
  private withinConcurrency(run: RunRow, c: Compiled, ready: StepRow[]): StepRow[] {
    const starts = new Map<string, Array<{ step: StepRow; branch: number; limit: number }>>();
    const keep = new Set(ready.map((step) => step.step_key));
    for (const step of ready) {
      const branch = this.branchOf(run, c, step);
      if (!branch || branch.parallel.concurrency === undefined || step.parent_key !== branch.group) continue;
      const list = starts.get(branch.group) ?? [];
      list.push({ step, branch: branch.branch, limit: branch.parallel.concurrency });
      starts.set(branch.group, list);
    }
    for (const [group, list] of starts) {
      const active = new Set<number>();
      const open = this.journal.db.prepare("SELECT scope FROM lane_pilot_wf_step WHERE run_id=? AND state IN ('running','waiting')").all(run.id) as Array<{ scope: string }>;
      for (const row of open) { const segment = row.scope.split("/").find((part) => part.startsWith(`${group}~`)); if (segment) active.add(Number(segment.slice(group.length + 1))); }
      const room = Math.max(0, list[0]!.limit - active.size);
      for (const item of list.sort((a, b) => a.branch - b.branch).slice(room)) keep.delete(item.step.step_key);
    }
    return ready.filter((step) => keep.has(step.step_key));
  }

  private failRun(runId: string, reason: string): void {
    const j = this.journal;
    if (!j.setRunStatus(runId, ["running", "waiting"], "failed", reason)) return;
    this.cancelOpenSteps(runId);
    this.aborts.get(runId)?.abort(); // the sibling branches still running stop (their threads are stopped) instead of finishing work nobody will read
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
    if (budget.maxWallSeconds !== undefined && this.now() - run.created_at - run.wait_ms >= budget.maxWallSeconds * 1000) return "budget_exceeded:wall_time";
    return null;
  }

  // ---------------------------------------------------------------- reading values

  private mergedCommits(runId: string): string[] {
    const out: string[] = [];
    const walk = (id: string) => {
      const rows = this.journal.db.prepare("SELECT output_json FROM lane_pilot_wf_step WHERE run_id=? AND state='succeeded' AND output_json LIKE '%merged_commits%' ORDER BY rowid").all(id) as Array<{ output_json: string }>;
      for (const row of rows) { const value = asObject(row.output_json).merged_commits; if (Array.isArray(value)) for (const commit of value) if (typeof commit === "string" && !out.includes(commit)) out.push(commit); }
      for (const child of this.journal.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").all(id) as Array<{ id: string }>) walk(child.id);
    };
    walk(runId);
    return out;
  }

  /** The values a step's expressions see: inputs, mode, context, the item of its branch, and the latest output of each node. */
  private env(run: RunRow, step: StepRow | null, item?: { value: unknown; index?: number }): EvalEnv {
    const scopes = scopeChain(step?.scope ?? "");
    const stepInput = step ? asObject(step.input_json) : {};
    return {
      read: (ref: Ref) => {
        switch (ref.kind) {
          case "input": return { ran: true, value: valueAtPath(asObject(run.inputs_json), ref.path) };
          case "mode": return { ran: true, value: run.mode };
          case "var": return { ran: true, value: ref.path[0] === "date" ? new Date(this.now()).toISOString().slice(0, 10) : ref.path[0] === "slug" ? slugOf(asObject(run.inputs_json)) : run.id };
          case "ctx": {
            const name = ref.path[0];
            const value = name === "run_id" ? run.id : name === "goal" ? asObject(run.inputs_json).goal : name === "merged_commits" ? this.mergedCommits(run.id) : undefined;
            return { ran: true, value: valueAtPath(value, ref.path.slice(1)) };
          }
          case "item": {
            const base = item ? item.value : stepInput.item;
            return { ran: item !== undefined || stepInput.item !== undefined, value: valueAtPath(base, ref.path) };
          }
          case "index": return { ran: true, value: item ? item.index : stepInput.index };
          default: {
            const row = this.journal.db.prepare(`SELECT output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state IN ('succeeded','skipped') AND scope IN (${scopes.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT 1`)
              .get(run.id, ref.node, ...scopes) as { output_json: string | null } | undefined;
            if (!row) return { ran: false, value: undefined };
            const output = asObject(row.output_json);
            return { ran: true, value: ref.path.length ? valueAtPath(output, ref.path) : output };
          }
        }
      },
      visits: (node) => (this.journal.db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state IN (${STARTED.map(() => "?").join(",")}) AND scope IN (${scopes.map(() => "?").join(",")})`)
        .get(run.id, node, ...STARTED, ...scopes) as { n: number }).n,
    };
  }

  private read(run: RunRow, step: StepRow | null, text: string): unknown {
    const ref = refOf(text);
    const found = this.env(run, step).read(ref);
    if (!found.ran) throw new MissingValueError("reference_missing", `"${text}" has no value yet`);
    return found.value;
  }

  private refRequired(c: Compiled, text: string): boolean {
    const ref = refOf(text);
    if (ref.kind !== "node" && ref.kind !== "input") return false;
    const fields = ref.kind === "input" ? c.wf.inputs : (c.nodes.get(ref.node!) ? outputFields(c.wf, c.nodes.get(ref.node!)) : []);
    if (fields === "unknown") return false;
    const field = fields.find((candidate) => candidate.name === ref.path[0]);
    return Boolean(field?.required) && ref.path.length === 1;
  }

  private mapWith(run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(edge.with ?? {})) {
      const ref = refOf(text);
      const found = this.env(run, from).read(ref);
      if (!found.ran || found.value === undefined || found.value === null) {
        if (this.refRequired(c, text)) throw new RouteFailure("mapping_field_missing", `"${text}" has no value for "${name}" on the edge ${edge.from} -> ${edge.to}`);
        continue;
      }
      data[name] = found.value;
    }
    return data;
  }

  // ---------------------------------------------------------------- one step

  private runtimeOf(run: RunRow): unknown {
    if (this.runtimes.has(run.id)) return this.runtimes.get(run.id);
    const built = this.options.runtimeFor?.(run);
    if (built !== undefined) this.runtimes.set(run.id, built);
    return built;
  }

  private contextFor(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode, attempt: number, signal: AbortSignal): StepContext {
    const j = this.journal;
    const input = JSON.parse(step.input_json) as StepInput;
    const goals = parseGoals(j.getRun(run.id)?.goals_json);
    const env = this.env(run, step);
    const resolve = (text: string) => { const found = env.read(refOf(text)); return found.ran ? found.value : undefined; };
    return {
      runId: run.id, stepKey: step.step_key, nodeId: node.id, node, workflow: c.wf, attempt, input, runtime: this.runtimeOf(run), signal, mode: run.mode as QualityMode,
      // `run` was read before this step was counted: the step is number steps_used + 1 of the run.
      goals, reground: goals.length > 0 && regroundDue(run.steps_used + 1),
      spawnKey: this.spawnKeyOf(run.id, step, attempt),
      resolve,
      render: (template) => String(renderValue(template, (ref, text) => { const found = env.read(ref); if (!found.ran) throw new MissingValueError("reference_missing", `"${text}" has no value yet`); return found.value; }, run.mode) ?? ""),
      value: (spec) => evalSpec(valueSpecOf(spec), lenient(env), `${node.id}`),
      template: (value) => renderValue(value, (ref) => lenient(env).read(ref).value, run.mode),
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

  /** Why a node is skipped before it starts: outside its quality modes, or its skip_when holds. */
  private skipReason(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): string | null {
    if (node.type === "join") return null;
    if (node.applicable_modes && !node.applicable_modes.includes(run.mode as QualityMode)) return `mode ${run.mode} is not one of ${node.applicable_modes.join(", ")}`;
    const expr = c.skip.get(node.id);
    if (expr && evalCondition(expr, this.env(run, step), `${node.id} skip_when`)) return "skip_when";
    return null;
  }

  /** A skipped node still has a typed output: `skip_out`, checked against its declared fields. */
  private skipOutput(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): Record<string, unknown> {
    const env = this.env(run, step);
    const target = node.type === "parallel" ? c.joinOf.get(node.id) ?? node : node;
    const given = Object.fromEntries(Object.entries(node.skip_out ?? {}).map(([name, value]) => [name, evalSpec(valueSpecOf(value), env, `${node.id} skip_out.${name}`)]));
    const fields = outputFields(c.wf, target);
    if (fields === "unknown") return given;
    if (node.type === "agent" && given.handoff === undefined) given.handoff = "skipped";
    // Only what skip_out gives is checked: the fields others read are covered by the validator, the rest is absent.
    return checkOutput(fields.map((field) => ({ ...field, required: false })), given);
  }

  /** Runs one pending step to its end; "stop" when the engine was asked to halt at this boundary. */
  private async execStep(runId: string, stepKey: string): Promise<"done" | "stop" | "skip"> {
    const j = this.journal;
    if (this.options.admit && !(await this.options.admit())) return "stop";
    if (this.stopped()) return "stop";
    const run = j.getRun(runId)!;
    if (TERMINAL_RUN.includes(run.status)) return "skip";
    const c = this.compiled(run);
    let step = j.getStep(runId, stepKey)!;
    if (step.state !== "pending") return "skip";
    const node = c.nodes.get(step.node_id)!;
    const limit = this.checkLimits(run, c);
    if (limit) { if (j.setRunStatus(runId, ["running", "waiting"], "blocked", limit)) { this.cancelOpenSteps(runId); this.aborts.get(runId)?.abort(); } return "skip"; }

    // Skipped before it starts: the quality mode or skip_when says so; the node keeps a typed output.
    try {
      const why = this.skipReason(run, c, step, node);
      if (why) {
        const output = this.skipOutput(run, c, step, node);
        j.db.transaction(() => {
          if (!j.moveStep(runId, stepKey, "pending", "skipped", { output_json: JSON.stringify(output), ended: true, receipt_json: JSON.stringify({ executor: executorKey(node), skipped: why, harnessVersion: this.options.harnessVersion }) })) return;
          if (node.type === "parallel") this.skipFan(run, c, step, node, output);
        })();
        return "done";
      }
    } catch (cause) {
      if (isEngineBug(cause)) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause instanceof MissingValueError ? cause.code : "skip_failed";
      j.db.transaction(() => { if (j.moveStep(runId, stepKey, "pending", "canceled", { error: message, ended: true })) this.failRun(runId, `${code}:${node.id}`); })();
      return "done";
    }

    // The node's own inputs: templates written into the step's input, once.
    try {
      if (node.with && !asObject(step.input_json).withRendered) {
        const env = this.env(run, step);
        const rendered = Object.fromEntries(Object.entries(renderValue(node.with, (ref) => env.read(ref).value, run.mode) as Record<string, unknown>).filter(([, value]) => value !== undefined));
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
      j.db.transaction(() => { if (j.moveStep(runId, stepKey, "pending", "canceled", { error: message, ended: true })) this.failRun(runId, `${code}:${node.id}`); })();
      return "done";
    }

    const startAttempt = Math.max(1, step.attempt);
    const spawnKey = this.spawnKeyOf(runId, step, startAttempt);
    this.fault("before-start");
    if (!j.moveStep(runId, stepKey, "pending", "running", { started: true, harness_version: this.compat, attempt: startAttempt, spawn_key: spawnKey })) return "skip";
    j.db.prepare("UPDATE lane_pilot_wf_run SET steps_used=steps_used+1, updated_at=? WHERE id=?").run(this.now(), runId);
    let executor = this.executors.get(executorKey(node)!)!;
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
    const abort = this.aborts.get(runId) ?? new AbortController();
    this.aborts.set(runId, abort);
    let outcome: StepOutcome | null = null, lastError: unknown = null;
    for (let attempt = startAttempt; attempt <= node.maxAttempts; attempt += 1) {
      if (attempt !== startAttempt) j.db.prepare("UPDATE lane_pilot_wf_step SET attempt=?, spawn_key=?, updated_at=? WHERE run_id=? AND step_key=?").run(attempt, this.spawnKeyOf(runId, step, attempt), this.now(), runId, stepKey);
      try {
        this.fault("before-run");
        const fresh = j.getStep(runId, stepKey)!;
        const attemptAbort = new AbortController();
        const forward = () => attemptAbort.abort();
        abort.signal.addEventListener("abort", forward, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const context = this.contextFor(run, c, fresh, node, attempt, attemptAbort.signal);
          const running = votes > 1 ? this.runVotes(executor, context, c, node, votes) : executor.run(context);
          const limited = node.timeoutSec === undefined || node.type === "human" ? running : Promise.race([running, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { attemptAbort.abort(); reject(new Error(`timeout after ${node.timeoutSec}s`)); }, node.timeoutSec! * 1000);
          })]);
          outcome = await limited;
        } finally { clearTimeout(timer); abort.signal.removeEventListener("abort", forward); }
        if (!("wait" in outcome)) {
          const fields = outputFields(c.wf, node);
          outcome = { ...outcome, output: fields === "unknown" ? outcome.output : checkOutput(fields, outcome.output) };
        }
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
    const receipt = (extra: Record<string, unknown>) => JSON.stringify({ executor: executorKey(node), harnessVersion: this.options.harnessVersion, engineCompat: this.compat, ...extra });
    if (!outcome) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      const code = lastError instanceof MissingValueError ? lastError.code : "step_failed";
      if (j.moveStep(runId, stepKey, "running", "failed", { error: message, ended: true, receipt_json: receipt({ code }) })) this.failStep(runId, c, stepKey, `${code}:${node.id}`, message);
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
          handoff: node.type === "agent" ? outcome.output.handoff ?? null : null, attempts: j.getStep(runId, stepKey)!.attempt,
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) }) })) addUsage();
    })();
    this.fault("after-record");
    return "done";
  }

  /**
   * `votes` > 1: the node runs that many times independently (own spawn keys) and the answer is decided by code, not by a model:
   * a boolean is true when more than half of the answers say true, a number is the median, any other scalar the most common
   * value; arrays and objects come from the first answer that agrees with the majority on the booleans. More than half of
   * the votes must answer, else the step fails.
   */
  private async runVotes(executor: NodeExecutor<any>, context: StepContext, c: Compiled, node: WorkflowNode, votes: number): Promise<StepOutcome> {
    const settled = await Promise.allSettled(Array.from({ length: votes }, (_unused, index) =>
      executor.run({ ...context, vote: { index, of: votes }, spawnKey: sha256(`${context.spawnKey}|vote${index}`).slice(0, 32) })));
    const answers: StepDone[] = [];
    for (const item of settled) {
      if (item.status === "rejected") { if (isEngineBug(item.reason)) throw item.reason; continue; }
      if ("wait" in item.value) throw new Error(`node ${node.id}: votes need an executor that answers in one step`);
      answers.push(item.value);
    }
    if (answers.length * 2 <= votes) throw new Error(`votes: ${answers.length} of ${votes} answered, a majority is needed`);
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
    const tokens = answers.reduce((sum, answer) => sum + (answer.usage?.tokens ?? 0), 0), costUsd = answers.reduce((sum, answer) => sum + (answer.usage?.costUsd ?? 0), 0);
    return { output: decided, usage: { tokens, costUsd }, threadId: answers.find((answer) => answer.threadId)?.threadId ?? null,
      detail: { votes: answers.map((answer) => ({ output: answer.output, threadId: answer.threadId ?? null })), asked: votes } };
  }

  /** A skipped fan-out has no branches: the join it belongs to is skipped with the same typed output. */
  private skipFan(run: RunRow, c: Compiled, fan: StepRow, node: WorkflowNode, output: Record<string, unknown>): void {
    const join = c.joinOf.get(node.id);
    if (!join) return;
    const j = this.journal;
    const visit = this.visitsOf(run.id, join.id, fan.scope) + 1;
    const stepKey = `${join.id}#${visit}${fan.scope ? `@${stableId(fan.scope).slice(0, 6)}` : ""}`;
    j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,output_json,routed,ended_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'skipped',?,?,0,?,?)`)
      .run(run.id, stepKey, stableId("join", fan.step_key, join.id), join.id, visit, fan.scope, fan.step_key, null, JSON.stringify({ with: {}, via: { mode: "artifact", fromStep: fan.step_key } }), JSON.stringify(output), this.now(), this.now());
    j.db.prepare("UPDATE lane_pilot_wf_step SET routed=1 WHERE run_id=? AND step_key=?").run(run.id, fan.step_key);
    j.event(run.id, stepKey, "step", null, "skipped", `join of skipped ${fan.step_key}`);
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
    const env = this.env(run, step);
    const matching = out.filter((item) => { const expr = c.when.get(item.index); return expr !== undefined && evalCondition(expr, env, `${node.id} -> ${item.edge.to}`); });
    const fallback = out.find((item) => item.edge.when === undefined);
    const candidates = [...matching, ...(fallback ? [fallback] : [])];
    if (!candidates.length) throw new RouteFailure("no_matching_edge", `no condition matched and there is no fallback edge`);
    let exhausted: string | null = null;
    for (const candidate of candidates) {
      const target = candidate.edge.to;
      const targetNode = c.nodes.get(target);
      if (targetNode && targetNode.type !== "join" && targetNode.maxVisits !== undefined && this.visitsOf(run.id, target, step.scope) >= targetNode.maxVisits) {
        exhausted = exhausted ?? target;
        this.journal.event(run.id, step.step_key, "edge_skipped", null, null, `${target} reached maxVisits ${targetNode.maxVisits}`);
        continue;
      }
      this.deliver(run, c, step, candidate.edge, candidate.index, { scope: step.scope, fromScope: step.scope, suffix: "" });
      return;
    }
    throw new RouteFailure(`guard:maxVisits`, `"${exhausted}" has used its visits`);
  }

  /** The list a for_each walks: a reference (with an optional `where`), a literal list, or a list picked by an input or the mode. */
  private forEachItems(run: RunRow, step: StepRow, node: Extract<WorkflowNode, { type: "parallel" }>): unknown[] {
    const source = node.for_each;
    const env = this.env(run, step);
    let items: unknown;
    if (Array.isArray(source)) items = source;
    else if (typeof source === "string") {
      const [reference, where] = source.split(/\s+where\s+/, 2) as [string, string | undefined];
      const found = env.read(refOf(reference.trim()));
      if (!found.ran) throw new RouteFailure("foreach_missing", `"${reference.trim()}" has no value`);
      items = found.value;
      if (where !== undefined && Array.isArray(items)) {
        const expr = parseExpr(where, { itemScope: true });
        items = items.filter((item, index) => evalCondition(expr, this.env(run, step, { value: item, index }), `${node.id} where`));
      }
    } else if (source && typeof source === "object") {
      const table = source as { by: string } & Record<string, unknown>;
      const picked = env.read(refOf(table.by));
      const key = String(picked.value);
      items = key in table ? table[key] : table.default;
    }
    if (!Array.isArray(items)) throw new RouteFailure("foreach_not_array", `for_each of "${node.id}" is not a list`);
    if (node.batch_size && node.batch_size > 1) {
      const chunks: unknown[][] = [];
      for (let at = 0; at < items.length; at += node.batch_size) chunks.push(items.slice(at, at + node.batch_size));
      return chunks;
    }
    return items;
  }

  /** Order `depends_on`: item `i` waits for the items whose `id` its `depends_on` names (an id outside the list is taken as done). A cycle fails the run. */
  private dependencies(node: Extract<WorkflowNode, { type: "parallel" }>, items: unknown[]): number[][] {
    const ids = items.map((item) => (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : null));
    const after = items.map((item, index) => {
      const list = typeof item === "object" && item !== null ? (item as { depends_on?: unknown }).depends_on : undefined;
      return (Array.isArray(list) ? list : []).map((id) => ids.indexOf(String(id))).filter((at) => at >= 0 && at !== index);
    });
    const state = new Map<number, "open" | "done">();
    const visit = (at: number): void => {
      if (state.get(at) === "done") return;
      if (state.get(at) === "open") throw new RouteFailure("depends_cycle", `the items of "${node.id}" depend on each other in a cycle through ${ids[at] ?? at}`);
      state.set(at, "open");
      for (const next of after[at]!) visit(next);
      state.set(at, "done");
    };
    after.forEach((_unused, at) => visit(at));
    return after;
  }

  private routeParallel(run: RunRow, c: Compiled, step: StepRow, node: Extract<WorkflowNode, { type: "parallel" }>): void {
    const out = c.out.get(node.id) ?? [];
    const limit = node.max_fan_out ?? c.wf.guards.maxFanOut;
    let branches: Array<{ edge: WorkflowEdge; index: number; item?: unknown; idx: number }>;
    if (node.for_each !== undefined) {
      const list = this.forEachItems(run, step, node);
      let used = list;
      if (list.length > limit) {
        if (node.onOverflow === "truncate") { used = list.slice(0, limit); this.journal.event(run.id, step.step_key, "fan_out_truncated", null, null, `${list.length} -> ${limit}`); }
        else throw new RouteFailure("guard:maxFanOut", `${list.length} items exceed the fan-out limit ${limit}`);
      }
      branches = used.map((item, idx) => ({ edge: out[0]!.edge, index: out[0]!.index, item, idx }));
    } else {
      if (out.length > limit) throw new RouteFailure("guard:maxFanOut", `${out.length} branches exceed the fan-out limit ${limit}`);
      branches = out.map((item, idx) => ({ edge: item.edge, index: item.index, idx }));
    }
    this.journal.db.prepare("UPDATE lane_pilot_wf_step SET fan_count=? WHERE run_id=? AND step_key=?").run(branches.length, run.id, step.step_key);
    const joinNode = c.joinOf.get(node.id)!;
    const after = node.order === "depends_on" ? this.dependencies(node, branches.map((branch) => branch.item)) : null;
    // The items are kept on the parallel step: a blocked branch names the dependency it waited for from them.
    this.journal.db.prepare("UPDATE lane_pilot_wf_step SET input_json=? WHERE run_id=? AND step_key=?").run(JSON.stringify({ ...asObject(step.input_json), items: branches.map((branch) => branch.item ?? null) }), run.id, step.step_key);
    for (const branch of branches) {
      const scope = `${step.scope ? `${step.scope}/` : ""}${step.step_key}~${branch.idx}`;
      this.deliver(run, c, step, branch.edge, branch.index, { scope, fromScope: step.scope, suffix: `~${branch.idx}`, item: branch.item, index: branch.item === undefined ? undefined : branch.idx, group: { key: step.step_key, branch: branch.idx },
        ...(after?.[branch.idx]?.length ? { after: after[branch.idx] } : {}) });
    }
    if (branches.length === 0) this.tryJoin(run, c, step.step_key, joinNode, step.scope);
  }

  /** Hands the data of an edge to its target: the exit, a join arrival, or a new step. */
  private deliver(run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge, edgeIndex: number,
    where: { scope: string; fromScope: string; suffix: string; item?: unknown; index?: number; group?: { key: string; branch: number }; after?: number[] }): void {
    const j = this.journal;
    const data = this.mapWith(run, c, from, edge);
    if (edge.to === END) {
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
        ...(edge.pass !== "artifact" || from?.receipt_json ? { fromThreadId: this.sessionThread(run, from, target.id, edge.pass, where.scope) } : {}),
        ...(from?.output_json ? { handoff: (asObject(from.output_json).handoff as string | undefined) ?? null } : {}) },
    };
    const inherited = from && from.scope === where.scope ? asObject(from.input_json) : {};
    const item = where.item !== undefined ? where.item : inherited.item;
    const index = where.item !== undefined ? where.index : (inherited.index as number | undefined);
    if (item !== undefined) input.item = item;
    if (index !== undefined) input.index = index;
    if (where.after?.length && where.group) { input.after = where.after; input.group = where.group.key; }
    const stepKey = `${target.id}#${visit}${where.scope ? `@${stableId(where.scope).slice(0, 6)}` : ""}`;
    const origin = stableId(from?.step_key ?? "entry", edgeIndex, where.suffix);
    const result = j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(run.id, stepKey, origin, target.id, visit, where.scope, from?.step_key ?? null, edgeIndex, JSON.stringify(input), this.now());
    if (result.changes > 0) j.event(run.id, stepKey, "step", null, "pending", from ? `from ${from.step_key}` : "entry");
  }

  /**
   * The thread a step goes on in (same-session) or reads (read-prior-session): for a loop back to an agent, that agent's own earlier
   * session; else the source step's thread, and when the source is not an agent (a lint, a check) the latest helper thread of the branch.
   */
  private sessionThread(run: RunRow, from: StepRow | null, targetId: string, pass: PassMode, scope: string): string | null {
    const threadOf = (row: { receipt_json: string | null } | undefined | null): string | null => {
      if (!row?.receipt_json) return null;
      const id = (JSON.parse(row.receipt_json) as { threadId?: string | null }).threadId;
      return typeof id === "string" && id ? id : null;
    };
    const latest = (node?: string) => this.journal.db.prepare(`SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND scope=?${node ? " AND node_id=?" : ""} AND receipt_json LIKE '%"threadId":"%' ORDER BY rowid DESC LIMIT 1`)
      .get(...(node ? [run.id, scope, node] : [run.id, scope])) as { receipt_json: string | null } | undefined;
    if (pass === "same-session") { const own = threadOf(latest(targetId)); if (own) return own; }
    return threadOf(from) ?? (pass === "artifact" ? null : threadOf(latest()));
  }

  private tryJoin(run: RunRow, c: Compiled, groupKey: string, join: Extract<WorkflowNode, { type: "join" }>, parentScope: string): void {
    const j = this.journal;
    const parallelStep = j.getStep(run.id, groupKey)!;
    if (parallelStep.fan_count === null) return;
    const arrivals = j.db.prepare("SELECT branch, data_json FROM lane_pilot_wf_arrival WHERE run_id=? AND group_key=? ORDER BY branch").all(run.id, groupKey) as Array<{ branch: number; data_json: string }>;
    if (arrivals.length < parallelStep.fan_count) return;
    const parsed = arrivals.map((row) => ({ branch: row.branch, data: JSON.parse(row.data_json) as Record<string, unknown> }));
    const items = (asObject(parallelStep.input_json) as { items?: unknown[] }).items ?? [];
    // `results`: the branches that finished, in branch order. `failed`: the ones a tolerant join lets pass, with their item and error.
    const results = parsed.filter((row) => row.data.$failed === undefined).map((row) => row.data);
    const failed = parsed.filter((row) => row.data.$failed !== undefined).map((row) => ({ branch: row.branch, item: items[row.branch] ?? null, error: String(row.data.$failed), blocked: row.data.$blocked === true }));
    const rows = parsed.map((row) => ({ branch: row.branch, item: items[row.branch] ?? null, ok: row.data.$failed === undefined, ...(row.data.$failed === undefined ? { data: row.data } : { error: String(row.data.$failed), blocked: row.data.$blocked === true }) }));
    const visit = this.visitsOf(run.id, join.id, parentScope) + 1;
    const stepKey = `${join.id}#${visit}${parentScope ? `@${stableId(parentScope).slice(0, 6)}` : ""}`;
    const input: StepInput = { with: { results, failed, rows, items }, via: { mode: "artifact", fromStep: groupKey } };
    const result = j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(run.id, stepKey, stableId("join", groupKey, join.id), join.id, visit, parentScope, groupKey, null, JSON.stringify(input), this.now());
    if (result.changes > 0) j.event(run.id, stepKey, "step", null, "pending", `join of ${groupKey}`);
  }

  // ---------------------------------------------------------------- builtin executors

  private registerBuiltins(): void {
    this.register("builtin:parallel", { reentrant: true, run: async () => ({ output: {} }) });
    this.register("builtin:join", { reentrant: true, run: async (ctx) => {
      const results = (ctx.input.with.results as Array<Record<string, unknown>>) ?? [];
      const output: Record<string, unknown> = { results, count: results.length, failed_count: ((ctx.input.with.failed as unknown[] | undefined) ?? []).length };
      // The default reducer: a declared array field is the concatenation of the same field of every branch.
      for (const field of outputFields(ctx.workflow, ctx.node) as Field[]) {
        if (field.type === "array" && output[field.name] === undefined) output[field.name] = results.flatMap((row) => (Array.isArray(row[field.name]) ? row[field.name] as unknown[] : []));
      }
      return { output };
    } });
    this.register("builtin:decision", { reentrant: true, run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "decision" }>;
      const fields = outputFields(ctx.workflow, node) as Field[];
      return { output: Object.fromEntries(fields.map((field) => [field.name, ctx.resolve(`${node.reads_node}.${field.name}`)]).filter(([, value]) => value !== undefined)) };
    } });
    this.register("builtin:emit", { reentrant: true, run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "action" }>;
      return { output: Object.fromEntries(Object.entries(node.map ?? {}).map(([name, value]) => [name, ctx.value(value)]).filter(([, value]) => value !== undefined)) };
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
        // A question whose answer kinds include `timeout` is answered by the clock; otherwise onTimeout says.
        const kind = human.out.find((field) => field.name === "answer_kind");
        if (kind?.values?.includes("timeout")) return { output: { answer: "", answer_kind: "timeout" } };
        if (human.onTimeout === "default" && human.defaultOption) {
          const field = human.out.find((candidate) => candidate.type === "string" || candidate.type === "enum");
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
        const mapped = Object.fromEntries(Object.entries(node.inputs).map(([name, ref]) => [name, ctx.resolve(ref)]).filter(([, value]) => value !== undefined));
        const inputs = { ...mapped, ...ctx.input.with };
        const known = new Set(child.inputs.map((field) => field.name));
        const started = this.start({ workflow: child, inputs: Object.fromEntries(Object.entries(inputs).filter(([name]) => known.has(name))), key: `child:${ctx.runId}:${ctx.stepKey}`, mode: ctx.mode,
          parent: { runId: ctx.runId, stepKey: ctx.stepKey }, depth, link: { projectId: run.project_id ?? undefined, runId: run.link_run_id ?? undefined, taskId: run.link_task_id ?? undefined } });
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
      if (this.options.resumePolicy?.(row) === "interrupt") {
        for (const step of j.steps(row.id).filter((item) => item.state === "running")) j.moveStep(row.id, step.step_key, "running", "interrupted", { error: "interrupted by a reload", ended: true });
        j.setRunStatus(row.id, ["running"], "interrupted", "interrupted_by_reload");
        this.cancelOpenSteps(row.id);
        this.release(row.id);
        continue;
      }
      for (const step of j.steps(row.id).filter((item) => item.state === "running")) {
        const node = c.nodes.get(step.node_id);
        const executor = node ? this.executors.get(executorKey(node) ?? "") : undefined;
        const compatible = step.harness_version === this.compat || (this.options.compatVersion !== undefined && LEGACY_BUILD_STAMP.test(step.harness_version ?? ""));
        if (executor?.reentrant && compatible) { j.moveStep(row.id, step.step_key, "running", "pending"); continue; }
        const why = executor?.reentrant ? "harness_changed" : "not_reentrant";
        const detail = executor?.reentrant ? `: the step began under engine ${step.harness_version ?? "unknown"}, this one is ${this.compat}` : "";
        j.moveStep(row.id, step.step_key, "running", "interrupted", { error: `interrupted by a reload (${why}${detail})`, ended: true });
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
      const executor = node ? this.executors.get(executorKey(node) ?? "") : undefined;
      if (!node || !executor?.poll) continue;
      const wait = asObject(step.await_json) as { kind: string; detail?: unknown; deadline?: number };
      let result: PollResult;
      try { result = await executor.poll({ runId: row.runId, stepKey: row.stepKey, nodeId: node.id, await: wait }, { runtime: this.runtimes.get(row.runId) ?? this.options.runtimeFor?.(run), node }); }
      catch (cause) { this.log(`poll of ${row.runId}/${row.stepKey} failed: ${cause instanceof Error ? cause.message : String(cause)}`); continue; }
      if (!result) continue;
      if (this.settle(row.runId, row.stepKey, result)) { settled += 1; touched.add(row.runId); }
    }
    await Promise.allSettled([...touched].map((id) => this.kick(id)));
    return settled;
  }

  /** Settles a waiting step from outside (a human answered, an attempt ended); false when it is not waiting any more. */
  resolve(runId: string, stepKey: string, output: Record<string, unknown>): Promise<boolean> {
    const ok = this.settle(runId, stepKey, { output });
    return ok ? this.kick(runId).then(() => true) : Promise.resolve(false);
  }

  /**
   * Drives a run after something settled one of its steps. A drive that is just ending (it saw the step waiting a moment ago) would
   * be handed back by `drive` and leave the run `running` with nobody driving it, so it is waited for first and the run is driven again.
   */
  private async kick(runId: string): Promise<RunSummary> {
    const running = this.drives.get(runId);
    if (running) await running.catch(() => undefined);
    return this.drive(runId);
  }

  private settle(runId: string, stepKey: string, result: { output: Record<string, unknown>; usage?: Usage; threadId?: string | null } | { error: string }): boolean {
    const j = this.journal;
    const run = j.getRun(runId), step = j.getStep(runId, stepKey);
    if (!run || !step || step.state !== "waiting") return false;
    const c = this.compiled(run), node = c.nodes.get(step.node_id)!;
    return j.db.transaction(() => {
      if ("error" in result) {
        if (!j.moveStep(runId, stepKey, "waiting", "failed", { error: result.error, ended: true })) return false;
        this.failStep(runId, c, stepKey, `step_failed:${node.id}`, result.error);
        return true;
      }
      let output: Record<string, unknown>;
      try { const fields = outputFields(c.wf, node); output = fields === "unknown" ? result.output : checkOutput(fields, result.output); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!j.moveStep(runId, stepKey, "waiting", "failed", { error: message, ended: true })) return false;
        this.failStep(runId, c, stepKey, `output_invalid:${node.id}`, message);
        return true;
      }
      const prior = asObject(step.receipt_json);
      const outputJson = JSON.stringify(output);
      if (!j.moveStep(runId, stepKey, "waiting", "succeeded", { output_json: outputJson, ended: true,
        receipt_json: JSON.stringify({ ...prior, outputSha256: sha256(outputJson), threadId: result.threadId ?? prior.threadId ?? null, settledBy: "outside" }) })) return false;
      if (result.usage) j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?").run(Math.round(result.usage.tokens ?? 0), Math.round((result.usage.costUsd ?? 0) * 1_000_000), runId);
      if (run.status === "waiting") j.db.prepare("UPDATE lane_pilot_wf_run SET wait_ms=wait_ms+? WHERE id=?").run(Math.max(0, this.now() - run.updated_at), runId);
      j.setRunStatus(runId, ["waiting"], "running", null);
      return true;
    })();
  }

  cancel(runId: string, reason = "canceled"): boolean {
    const ok = this.journal.setRunStatus(runId, ["running", "waiting"], "canceled", reason);
    if (ok) { this.aborts.get(runId)?.abort(); this.cancelOpenSteps(runId); }
    return ok;
  }

  /**
   * The owner re-runs one node of a finished run: the node's last step goes back to pending, everything that came out of it (the
   * steps it routed to, their branches, the joins that waited for it, the child runs, the effects) is removed, and the run goes on
   * from there. A canceled step that was waiting for its turn when the run ended is revived. Refused while the run is active, for a
   * child run (re-run from its parent) and for a node that never ran. The new try has its own spawn key, so an agent step opens a new thread.
   */
  async rerunNode(runId: string, nodeId: string): Promise<{ ok: true; stepKey: string; removed: number } | { ok: false; reason: string }> {
    const j = this.journal;
    const run = j.getRun(runId);
    if (!run) return { ok: false, reason: "not_found" };
    if (!TERMINAL_RUN.includes(run.status) || this.drives.has(runId)) return { ok: false, reason: "run_active" };
    if (run.parent_run_id) return { ok: false, reason: "child_run" };
    const c = this.compiled(run);
    if (!c.nodes.has(nodeId)) return { ok: false, reason: "unknown_node" };
    const steps = j.steps(runId);
    const target = [...steps].reverse().find((step) => step.node_id === nodeId && step.state !== "pending");
    if (!target) return { ok: false, reason: "node_not_run" };
    if (target.state === "running" || target.state === "waiting") return { ok: false, reason: "step_active" };

    const gone = new Set<string>();
    const arrivals = j.db.prepare("SELECT group_key, from_step FROM lane_pilot_wf_arrival WHERE run_id=?").all(runId) as Array<{ group_key: string; from_step: string }>;
    for (let grew = true; grew;) {
      grew = false;
      for (const step of steps) {
        if (step.step_key === target.step_key || gone.has(step.step_key)) continue;
        const fedBy = step.parent_key !== null && (step.parent_key === target.step_key || gone.has(step.parent_key));
        // A join waited for the branches of its parallel: when a branch arrival goes, the join goes with it.
        const joinOfGone = step.parent_key !== null && c.nodes.get(step.node_id)?.type === "join" && arrivals.some((row) => row.group_key === step.parent_key && (row.from_step === target.step_key || gone.has(row.from_step)));
        if (fedBy || joinOfGone) { gone.add(step.step_key); grew = true; }
      }
    }
    const doomed = new Set([target.step_key, ...gone]);
    const childRuns = (id: string): string[] => {
      const rows = j.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").all(id) as Array<{ id: string }>;
      return rows.flatMap((row) => [row.id, ...childRuns(row.id)]);
    };
    const attached = (j.db.prepare("SELECT id, parent_step_key FROM lane_pilot_wf_run WHERE parent_run_id=?").all(runId) as Array<{ id: string; parent_step_key: string }>)
      .filter((row) => doomed.has(row.parent_step_key)).flatMap((row) => [row.id, ...childRuns(row.id)]);
    const started = [...doomed].filter((key) => steps.find((step) => step.step_key === key)?.state !== "pending").length;
    const input = asObject(target.input_json) as unknown as StepInput;
    const nextInput = JSON.stringify({ ...input, rerun: (input.rerun ?? 0) + 1 });

    j.db.transaction(() => {
      const marks = (list: string[]) => list.map(() => "?").join(",");
      const dropped = [...gone], all = [target.step_key, ...dropped];
      for (const child of attached) {
        for (const table of ["lane_pilot_wf_step", "lane_pilot_wf_arrival", "lane_pilot_wf_effect"]) j.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(child);
        j.db.prepare("DELETE FROM lane_pilot_wf_run WHERE id=?").run(child);
      }
      if (dropped.length) j.db.prepare(`DELETE FROM lane_pilot_wf_step WHERE run_id=? AND step_key IN (${marks(dropped)})`).run(runId, ...dropped);
      j.db.prepare(`DELETE FROM lane_pilot_wf_arrival WHERE run_id=? AND (from_step IN (${marks(all)}) OR group_key IN (${marks(all)}))`).run(runId, ...all, ...all);
      j.db.prepare(`DELETE FROM lane_pilot_wf_effect WHERE run_id=? AND step_key IN (${marks(all)})`).run(runId, ...all);
      j.db.prepare(`UPDATE lane_pilot_wf_step SET state='pending', attempt=0, input_json=?, output_json=NULL, error=NULL, await_json=NULL, spawn_key=NULL, receipt_json=NULL,
        routed=0, fan_count=NULL, started_at=NULL, ended_at=NULL, updated_at=? WHERE run_id=? AND step_key=?`).run(nextInput, this.now(), runId, target.step_key);
      for (const step of steps) {
        if (doomed.has(step.step_key) || step.state !== "canceled" || step.error !== null) continue;
        j.db.prepare("UPDATE lane_pilot_wf_step SET state='pending', ended_at=NULL, updated_at=? WHERE run_id=? AND step_key=?").run(this.now(), runId, step.step_key);
      }
      j.db.prepare("UPDATE lane_pilot_wf_run SET status='running', reason=NULL, output_json=NULL, steps_used=MAX(0, steps_used-?), owner_id=NULL, lease_until=0, updated_at=? WHERE id=?").run(started, this.now(), runId);
      j.event(runId, target.step_key, "rerun", target.state, "pending", `node ${nodeId}: ${doomed.size} step(s) reset or removed`);
    })();
    this.compiledRuns.delete(runId);
    this.aborts.set(runId, new AbortController()); // a failed or blocked run fired its controller; the re-run's steps and goal audit need a live one
    void this.kick(runId).catch((cause) => this.log(`run ${runId} stopped after a re-run: ${cause instanceof Error ? cause.message : String(cause)}`));
    return { ok: true, stepKey: target.step_key, removed: gone.size };
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

