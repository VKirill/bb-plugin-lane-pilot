import type { AttemptMetrics } from "../usage/server";

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** Runs a shell command on a BB machine (`cwd` must exist there). In the plugin this is `runOnHost`; the live driver uses a local shell or ssh. */
export interface HostPort {
  run(hostId: string, cwd: string, command: string, timeoutSec?: number): Promise<ExecResult>;
}

/** Single-quotes a word for `sh -c`. */
export const q = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/** A bench sandbox project the series runs in: a BB project named «LP bench …» whose folder holds the clone. */
export type BenchProjectRef = { projectId: string; name: string; hostId: string; path: string };

export type TaskOutcome = {
  /** The newest attempt's state, or null before the first attempt exists. */
  latestState: string | null;
  attempts: number;
};

/**
 * What the series needs from the Lane Pilot pipeline. The plugin implements it with its own services (server/plugin-ports.ts); the
 * live driver (scripts/lp-bench.ts) implements it with `bb lane-pilot …` and read-only hub queries, the way scripts/lp-drill.py does.
 */
export interface PipelinePort {
  /** The BB project «LP bench …» for a repository; null with the reason when it does not exist (the operator creates it, see `bench prepare`). */
  findProject(name: string): Promise<BenchProjectRef | null>;
  /**
   * Writes what an arm runs under: the project's settings (writer, memory and rules off, the arm's own settings; the plugin validates them like any
   * setting) and the harness override (`none`, `tree` or a harness id), and the prototype config of a project that has none.
   */
  configure(project: BenchProjectRef, input: { settings: Record<string, unknown>; harness: string; sourceProjectId: string | null }): Promise<void>;
  /** Opens a PM and a run in the project (the drill's `activate`). */
  startRun(project: BenchProjectRef): Promise<{ pmThreadId: string; runId: string }>;
  /** Sends a task contract through the normal dispatch. `taskId` is the id the pipeline gave it (it renames a task whose id it has seen: `<id>.2`). */
  dispatch(project: BenchProjectRef, pmThreadId: string, task: Record<string, unknown>): Promise<{ ok: boolean; detail: string; taskId?: string }>;
  outcome(runId: string, taskId: string): Promise<TaskOutcome>;
  /** The metrics of every attempt of a task (`lp_attempt_metrics`), with cost_state. */
  metrics(project: BenchProjectRef, runId: string, taskId: string): Promise<AttemptMetrics[]>;
  /** Stops what is still running for the task. */
  cancel(runId: string, taskId: string): Promise<void>;
  finishRun(project: BenchProjectRef, runId: string): Promise<void>;
}

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
