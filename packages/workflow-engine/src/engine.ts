import { randomUUID } from "node:crypto";

import { MissingValueError } from "./expr";
import type { EvalEnv } from "./expr";
import { createJournal } from "./journal";
import type { Journal, RunRow, StepRow } from "./journal";
import { executorKey, lowerWorkflow } from "./lower";
import type { ResolveWorkflow } from "./lower";
import type { GraphNode as WorkflowNode, PassMode, QualityMode, Workflow, WorkflowEdge } from "./schema";
import { validateWorkflow } from "./validate";
import type { RunGoal } from "./goals";
import { compile } from "./compiled";
import type { Compiled } from "./compiled";
import type { EffectReconcile, NodeExecutor, StepContext, StepOutcome } from "./step-types";
import type { Usage } from "./usage";
import type { EngineOptions, RunSummary } from "./engine-types";
import { childOutcome, registerBuiltins } from "./engine-builtins";
import { start } from "./engine-start";
import { beat, claim, drive, driveLoop, idle, kick, release, retire, unbeat } from "./engine-drive";
import { cancelOpenSteps, failRun, summary } from "./run-status";
import { rescueStale, cancel, poll, resolve, resume, settle } from "./engine-resume";
import { rerunNode } from "./engine-rerun";
import { amendGoals, goalJournal } from "./engine-goals";
import { closeAfterAudit, lastAudit, shortPathFacts } from "./engine-goal-audit";
import { checkLimits, contextFor, execStep, noteUnknownUsage, runEffect, runtimeOf, runVotes, skipFan, skipOutput, skipReason, skipsFree, spawnKeyOf, unknownUsageSteps } from "./engine-step";
import { arrive, branchOf, failStep, gates, tolerates, withinConcurrency } from "./engine-branches";
import { deliver, dependencies, forEachItems, routeAll, routeEdges, routeParallel, sessionThread, tryJoin, visitsOf } from "./engine-routing";
import { env, mapWith, mergedCommits, read, refRequired } from "./step-read";
import type { Pins } from "./pins";

export { MissingValueError };
export type { EffectReconcile, NodeExecutor, PollResult, StepContext, StepDone, StepInput, StepOutcome, StepWait } from "./step-types";
export type { Usage } from "./usage";
export type { EngineOptions, RunSummary } from "./engine-types";
export { ENGINE_COMPAT_VERSION } from "./engine-types";
export { CrashError } from "./engine-errors";
export { requestGoals } from "./request-goals";

export class WorkflowEngine {
  readonly journal: Journal;
  readonly instanceId: string;
  readonly executors = new Map<string, NodeExecutor<any>>();
  readonly drives = new Map<string, Promise<RunSummary>>();
  readonly runtimes = new Map<string, unknown>();
  readonly aborts = new Map<string, AbortController>();
  /** Children whose spend a failed step already added to the parent. */
  readonly compiledRuns = new Map<string, Compiled>();
  /** Finished runs whose compiled graph and runtime are still held, oldest first: a re-run of one of them needs no rebuild. */
  readonly retired: string[] = [];
  readonly beats = new Map<string, ReturnType<typeof setInterval>>();
  readonly stoppedRuns = new Set<string>();
  private disposed = false;
  readonly now: () => number;
  get compat(): string { return this.options.compatVersion ?? this.options.harnessVersion; }
  readonly leaseMs: number;

  constructor(readonly options: EngineOptions) {
    this.now = options.now ?? Date.now;
    this.journal = createJournal(options.db, this.now, options.onEvent);
    this.instanceId = options.instanceId ?? `engine-${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 90_000;
    this.registerBuiltins();
  }

  register<R>(key: string, executor: NodeExecutor<R>): this { this.executors.set(key, executor); return this; }
  hasExecutor = (key: string): boolean => this.executors.has(key);
  /** The store or built-in workflow of an id (the resolveWorkflow option; the chain callers that hold the engine do not import the registry). */
  readonly resolveWorkflow = (id: string, version?: number) => this.options.resolveWorkflow?.(id, version) ?? null;
  fault(point: string): void { this.options.fault?.(point); }
  stopped(): boolean { return this.disposed || (this.options.isDisposed?.() ?? false); }
  log(message: string): void { this.options.log?.(`workflow: ${message}`); }

  // ---------------------------------------------------------------- definitions

  /** `definition_json` holds the lowered workflow: children resolved and pinned, nothing left to expand. */
  compiled(run: RunRow): Compiled {
    let found = this.compiledRuns.get(run.id);
    if (!found) { found = compile(JSON.parse(run.definition_json) as Workflow); this.compiledRuns.set(run.id, found); }
    return found;
  }

  /** Why a workflow cannot run here: invalid, or an executor not registered. */
  preflight(workflow: Workflow, resolve: ResolveWorkflow | undefined = this.options.resolveWorkflow): string[] {
    const problems = validateWorkflow(workflow, { resolve, ...(this.options.specialistKnown ? { specialistKnown: this.options.specialistKnown } : {}) }).filter((problem) => problem.level === "error").map((problem) => problem.message);
    const lowered = lowerWorkflow(workflow, resolve);
    for (const node of lowered.nodes) {
      if (node.type === "note") continue;
      const key = executorKey(node);
      if (!key) problems.push(`node "${node.id}" has no executor (set "uses"${node.type === "action" ? " or \"action\"" : ""})`);
      else if (!this.executors.has(key)) problems.push(`node "${node.id}": executor "${key}" is not registered`);
    }
    return problems;
  }

  // ---------------------------------------------------------------- start

  start<R>(input: {
    workflow: Workflow; inputs?: Record<string, unknown>; key?: string; runtime?: R; mode?: QualityMode;
    link?: { projectId?: string; runId?: string; taskId?: string; attemptId?: string };
    parent?: { runId: string; stepKey: string }; depth?: number;
    /** K7: what the run is for; checked against its output before it closes. */
    goals?: RunGoal[];
    /** Where its children are found when they are not the engine's: a project's own library (2026-10-29 audit A-012). */
    resolve?: ResolveWorkflow;
    /** The children the parent chain was started with; a child run is given its parent's. */
    pins?: Pins;
  }): { runId: string; created: boolean; done: Promise<RunSummary> } { return start(this, input); }

  // ---------------------------------------------------------------- driving

  /** Resolves when every run this instance is driving has stopped. */
  idle(): Promise<void> { return idle(this); }

  /** The steps of a run whose spending is not known (the provider reports no usage): its token and cost totals leave them out, and a budget cannot see them. */
  unknownUsageSteps(runId: string): string[] { return unknownUsageSteps(this, runId); }

  /** The last goal audit of a run, as the journal has it. */
  lastAudit(runId: string): { sha: string; outputSha?: string; verdict: "pass" | "gaps" | "unavailable" | "not_verified"; met: string[]; unmet: Array<{ id: string; why: string }>; notes?: string; error?: string; at: number } | null {
    return lastAudit(this, runId);
  }

  /** Every state the goals of a run have been in, oldest first: what changed, why and who said so. */
  goalJournal(runId: string): Array<{ seq: number; at: number; by: string; reason: string; goals: RunGoal[] }> {
    return goalJournal(this, runId);
  }

  /**
   * K7: the owner or the PM changes what the run is for. The whole list is replaced; the reason and the author go into the journal with the
   * list that was replaced. A run that was blocked by its goal audit is audited again against the new goals.
   */
  amendGoals(runId: string, goals: unknown, reason: string, by = "pm"): { ok: true; version: number; reopened: boolean } | { ok: false; reason: string } {
    return amendGoals(this, runId, goals, reason, by);
  }

  // ---------------------------------------------------------------- outside the loop

  /** Takes up the runs a reload left: re-runs reentrant steps, interrupts the rest, routes finished steps, goes on. */
  resume(options: { takeOver?: boolean; runtimeFor?: (run: RunRow) => unknown } = {}): Promise<string[]> { return resume(this, options); }

  /** Asks every waiting step whether what it waits for is over; settles and continues the runs it can. */
  poll(): Promise<number> { return poll(this); }

  /** Settles a waiting step from outside (a human answered, an attempt ended); false when it is not waiting any more. */
  resolve(runId: string, stepKey: string, output: Record<string, unknown>): Promise<boolean> { return resolve(this, runId, stepKey, output); }

  cancel(runId: string, reason = "canceled"): boolean { return cancel(this, runId, reason); }

  /**
   * The owner re-runs one node of a finished run: the node's last step goes back to pending, everything that came out of it (the
   * steps it routed to, their branches, the joins that waited for it, the child runs, the effects) is removed, and the run goes on
   * from there. A canceled step that was waiting for its turn when the run ended is revived. Refused while the run is active, for a
   * child run (re-run from its parent) and for a node that never ran. The new try has its own spawn key, so an agent step opens a new thread.
   * `runtime`: the caller's own state for the steps that go again (the dispatch pipeline keeps the task there); it replaces the one the run had.
   * `patch`: corrected inputs of the node, merged over the ones its step had (Maslov's live correction: fix the step's input and go on
   * on the same branch, keeping every step before it). The journal names the keys changed.
   */
  rerunNode(runId: string, nodeId: string, runtime?: unknown, patch?: Record<string, unknown>): Promise<{ ok: true; stepKey: string; removed: number } | { ok: false; reason: string }> {
    return rerunNode(this, runId, nodeId, runtime, patch);
  }

  get(runId: string): RunSummary | null { return this.journal.getRun(runId) ? this.summary(runId) : null; }

  /** Everything a live view needs: the run and its steps, with the node each belongs to. */
  snapshot(runId: string): { run: RunRow; steps: StepRow[]; events: unknown[] } | null {
    const run = this.journal.getRun(runId);
    if (!run) return null;
    return { run, steps: this.journal.steps(runId), events: this.journal.db.prepare("SELECT * FROM lane_pilot_wf_event WHERE run_id=? ORDER BY seq").all(runId) };
  }

  inFlight(): string[] { return [...this.drives.keys()]; }

  // ---------------------------------------------------------------- private delegates (moved to the engine-* / step-* / run-status modules)

  private drive(runId: string): Promise<RunSummary> { return drive(this, runId); }
  private claim(runId: string): boolean { return claim(this, runId); }
  private retire(runId: string): void { return retire(this, runId); }
  private release(runId: string): void { return release(this, runId); }
  private beat(runId: string): void { return beat(this, runId); }
  private unbeat(runId: string): void { return unbeat(this, runId); }
  private driveLoop(runId: string): Promise<RunSummary> { return driveLoop(this, runId); }
  private kick(runId: string): Promise<RunSummary> { return kick(this, runId); }
  private summary(runId: string): RunSummary { return summary(this, runId); }
  private failRun(runId: string, reason: string): void { return failRun(this, runId, reason); }
  private cancelOpenSteps(runId: string): void { return cancelOpenSteps(this, runId); }
  private shortPathFacts(run: RunRow): { size: unknown; accepted: boolean; acceptance: unknown; alreadyMet: boolean } { return shortPathFacts(this, run); }
  private closeAfterAudit(run: RunRow): Promise<"closed" | "blocked" | "stop"> { return closeAfterAudit(this, run); }
  private branchOf(run: RunRow, c: Compiled, step: StepRow): { group: string; branch: number; parallel: Extract<WorkflowNode, { type: "parallel" }>; join: Extract<WorkflowNode, { type: "join" }>; parentScope: string } | null { return branchOf(this, run, c, step); }
  private tolerates(branch: { parallel: Extract<WorkflowNode, { type: "parallel" }>; join: Extract<WorkflowNode, { type: "join" }> }): boolean { return tolerates(branch); }
  private arrive(run: RunRow, c: Compiled, branch: { group: string; branch: number; join: Extract<WorkflowNode, { type: "join" }>; parentScope: string }, stepKey: string, data: Record<string, unknown>): void { return arrive(this, run, c, branch, stepKey, data); }
  private failStep(runId: string, c: Compiled, stepKey: string, reason: string, message: string): void { return failStep(this, runId, c, stepKey, reason, message); }
  private gates(run: RunRow, c: Compiled, pending: StepRow[]): { ready: StepRow[]; changed: boolean } { return gates(this, run, c, pending); }
  private withinConcurrency(run: RunRow, c: Compiled, ready: StepRow[]): StepRow[] { return withinConcurrency(this, run, c, ready); }
  private mergedCommits(runId: string): string[] { return mergedCommits(this, runId); }
  private env(run: RunRow, step: StepRow | null, item?: { value: unknown; index?: number }): EvalEnv { return env(this, run, step, item); }
  private read(run: RunRow, step: StepRow | null, text: string): unknown { return read(this, run, step, text); }
  private refRequired(c: Compiled, text: string): boolean { return refRequired(c, text); }
  private mapWith(run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge): Record<string, unknown> { return mapWith(this, run, c, from, edge); }
  private runtimeOf(run: RunRow): unknown { return runtimeOf(this, run); }
  private contextFor(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode, attempt: number, signal: AbortSignal): StepContext { return contextFor(this, run, c, step, node, attempt, signal); }
  private runEffect<T>(j: Journal, runId: string, stepKey: string, key: string, kind: string, fn: () => Promise<T>, options: { intent?: unknown; reconcile?: EffectReconcile<T> } = {}): Promise<T> { return runEffect(this, j, runId, stepKey, key, kind, fn, options); }
  private spawnKeyOf(runId: string, step: StepRow, attempt: number): string { return spawnKeyOf(this, runId, step, attempt); }
  private skipReason(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): string | null { return skipReason(this, run, c, step, node); }
  private skipsFree(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): boolean { return skipsFree(this, run, c, step, node); }
  private skipOutput(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): Record<string, unknown> { return skipOutput(this, run, c, step, node); }
  private execStep(runId: string, stepKey: string): Promise<"done" | "stop" | "skip"> { return execStep(this, runId, stepKey); }
  private runVotes(executor: NodeExecutor<any>, context: StepContext, c: Compiled, node: WorkflowNode, votes: number): Promise<StepOutcome> { return runVotes(this, executor, context, c, node, votes); }
  private skipFan(run: RunRow, c: Compiled, fan: StepRow, node: WorkflowNode, output: Record<string, unknown>): void { return skipFan(this, run, c, fan, node, output); }
  private noteUnknownUsage(runId: string, stepKey: string, usage: Usage): void { return noteUnknownUsage(this, runId, stepKey, usage); }
  private checkLimits(run: RunRow, c: Compiled): string | null { return checkLimits(this, run, c); }
  private routeAll(run: RunRow, c: Compiled): void { return routeAll(this, run, c); }
  private visitsOf(runId: string, nodeId: string, scope: string): number { return visitsOf(this, runId, nodeId, scope); }
  private routeEdges(run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): void { return routeEdges(this, run, c, step, node); }
  private forEachItems(run: RunRow, step: StepRow, node: Extract<WorkflowNode, { type: "parallel" }>): unknown[] { return forEachItems(this, run, step, node); }
  private dependencies(node: Extract<WorkflowNode, { type: "parallel" }>, items: unknown[]): number[][] { return dependencies(node, items); }
  private routeParallel(run: RunRow, c: Compiled, step: StepRow, node: Extract<WorkflowNode, { type: "parallel" }>): void { return routeParallel(this, run, c, step, node); }
  private deliver(run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge, edgeIndex: number,
    where: { scope: string; fromScope: string; suffix: string; item?: unknown; index?: number; group?: { key: string; branch: number }; after?: number[] }): void {
    return deliver(this, run, c, from, edge, edgeIndex, where);
  }
  private sessionThread(run: RunRow, from: StepRow | null, targetId: string, pass: PassMode, scope: string): string | null { return sessionThread(this, run, from, targetId, pass, scope); }
  private tryJoin(run: RunRow, c: Compiled, groupKey: string, join: Extract<WorkflowNode, { type: "join" }>, parentScope: string): void { return tryJoin(this, run, c, groupKey, join, parentScope); }
  private registerBuiltins(): void { return registerBuiltins(this); }
  private childOutcome(child: RunSummary, node: Extract<WorkflowNode, { type: "subworkflow" }>): StepOutcome { return childOutcome(this, child, node); }
  private rescueStale(): string[] { return rescueStale(this); }
  private settle(runId: string, stepKey: string, result: { output: Record<string, unknown>; usage?: Usage; threadId?: string | null } | { error: string }): boolean { return settle(this, runId, stepKey, result); }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.beats.keys()]) unbeat(this, id);
    try { this.options.db.prepare("UPDATE lane_pilot_wf_run SET owner_id=NULL, lease_until=0 WHERE owner_id=?").run(this.instanceId); } catch { /* the database is already closed */ }
  }
}

