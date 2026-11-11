import type Database from "better-sqlite3";

import type { RunRow, RunStatus, StepRow } from "./journal";
import type { GoalAudit, RunGoal } from "./goals";
import type { Workflow } from "./schema";

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
export const LEGACY_BUILD_STAMP = /^\d+\.\d+\.\d+/;

export type EngineOptions = {
  db: Database.Database;
  /** The build (package version): written to receipts and to the run row, informational. */
  harnessVersion: string;
  /** What a reload compares to decide whether an in-flight step may be re-run (default: `harnessVersion`, i.e. every build is its own). */
  compatVersion?: string;
  instanceId?: string;
  now?: () => number;
  log?: (message: string) => void;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  /** Whether `specialist:<id>` names an agent that exists; a start naming one that does not is refused with the validator's message. */
  specialistKnown?: (id: string) => boolean | null;
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
