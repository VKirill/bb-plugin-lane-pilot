import { TERMINAL_RUN } from "./journal";
import type { RunSummary } from "./engine-types";
import { asObject } from "./step-read";
import type { WorkflowEngine } from "./engine";

export function summary(engine: WorkflowEngine, runId: string): RunSummary {
  const j = engine.journal;
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
    stopped: engine.stoppedRuns.has(runId),
  };
}

export function failRun(engine: WorkflowEngine, runId: string, reason: string): void {
  const j = engine.journal;
  if (!j.setRunStatus(runId, ["running", "waiting"], "failed", reason)) return;
  cancelOpenSteps(engine, runId);
  engine.aborts.get(runId)?.abort(); // the sibling branches still running stop (their threads are stopped) instead of finishing work nobody will read
}

export function cancelOpenSteps(engine: WorkflowEngine, runId: string): void {
  for (const step of engine.journal.steps(runId)) {
    if (step.state === "pending" || step.state === "waiting") engine.journal.moveStep(runId, step.step_key, step.state, "canceled", { ended: true });
  }
}
