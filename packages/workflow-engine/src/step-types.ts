import type { EffectRow } from "./journal";
import type { RunGoal } from "./goals";
import type { GraphNode as WorkflowNode, PassMode, QualityMode, Workflow } from "./schema";
import type { Usage } from "./usage";

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
  /** The inputs the run was started with (`$inputs`): an agent step is given them whole, so a fragment's goal reaches its helper without a `with` on every node. */
  inputs: Record<string, unknown>;
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
