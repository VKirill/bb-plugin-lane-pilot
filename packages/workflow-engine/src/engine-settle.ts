import { sha256 } from "./journal";
import { executorKey, outputFields } from "./lower";
import { asObject } from "./step-read";
import { checkStepOutput } from "./step-output";
import { addSpend, noteUnknownUsage } from "./usage";
import type { Usage } from "./usage";
import { buildStepFactColumns, emitStepFactLogs, stepHadAgentCall, usageFromStepRow } from "./run-facts";
import type { StepFactColumns } from "./run-facts";
import { failStep } from "./engine-branches";
import type { WorkflowEngine } from "./engine";

export function settle(
  engine: WorkflowEngine,
  runId: string,
  stepKey: string,
  result:
    | { output: Record<string, unknown>; usage?: Usage; threadId?: string | null; detail?: unknown }
    | { error: string; usage?: Usage; threadId?: string | null; detail?: unknown },
  meta?: { by?: "event" | "timeout" },
): boolean {
  const j = engine.journal;
  const run = j.getRun(runId), step = j.getStep(runId, stepKey);
  if (!run || !step || step.state !== "waiting") return false;
  const c = engine.compiled(run), node = c.nodes.get(step.node_id)!;
  const priorUsage = usageFromStepRow(step);
  const combinedUsage = addSpend(priorUsage, result.usage);
  const resolvedThreadId = result.threadId ?? priorUsage?.sessionId ?? null;
  const formMeta = {
    formUsed: (step.form_used as import("@lane-pilot/contracts").NodeForm | null | undefined) ?? null,
    fallbackTaken: step.fallback_taken ?? null,
    environmentFingerprint: step.environment_fingerprint ?? null,
  };
  let logEvent: { to: "succeeded" | "failed"; cols: StepFactColumns; hasAgent: boolean } | null = null;

  const settled = j.db.transaction(() => {
    if ("error" in result) {
      const factOpts = {
        usage: combinedUsage,
        nodeType: node.type,
        detail: result.detail,
        error: result.error,
        threadId: resolvedThreadId,
        ...formMeta,
      };
      const factCols = buildStepFactColumns(run, step, "failed", engine.now(), factOpts);
      if (!j.moveStep(runId, stepKey, "waiting", "failed", { ...factCols, error: result.error, ended: true })) return false;
      failStep(engine, runId, c, stepKey, `step_failed:${node.id}`, result.error);
      logEvent = { to: "failed", cols: factCols, hasAgent: stepHadAgentCall("failed", factOpts) };
      return true;
    }
    const rawOutput = executorKey(node) === "builtin:wait"
      ? meta?.by === "timeout"
        ? { ...result.output, woke: "timeout" }
        : { ...result.output, payload: result.output.payload ?? result.output, woke: result.output.woke ?? "event" }
      : result.output;
    let output: Record<string, unknown>;
    try { output = checkStepOutput(node, outputFields(c.wf, node), rawOutput); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const factOpts = {
        usage: combinedUsage,
        nodeType: node.type,
        detail: result.detail,
        error: message,
        errorCode: "output_invalid",
        threadId: resolvedThreadId,
        ...formMeta,
      };
      const factCols = buildStepFactColumns(run, step, "failed", engine.now(), factOpts);
      if (!j.moveStep(runId, stepKey, "waiting", "failed", { ...factCols, error: message, ended: true })) return false;
      failStep(engine, runId, c, stepKey, `output_invalid:${node.id}`, message);
      logEvent = { to: "failed", cols: factCols, hasAgent: stepHadAgentCall("failed", factOpts) };
      return true;
    }
    const prior = asObject(step.receipt_json);
    const outputJson = JSON.stringify(output);
    const factOpts = {
      usage: combinedUsage,
      nodeType: node.type,
      output,
      detail: result.detail ?? prior.detail,
      threadId: result.threadId ?? (typeof prior.threadId === "string" ? prior.threadId : null),
      ...formMeta,
    };
    const factCols = buildStepFactColumns(run, step, "succeeded", engine.now(), factOpts);
    if (!j.moveStep(runId, stepKey, "waiting", "succeeded", {
      ...factCols,
      output_json: outputJson,
      ended: true,
      receipt_json: JSON.stringify({
        ...prior,
        outputSha256: sha256(outputJson),
        threadId: result.threadId ?? prior.threadId ?? null,
        settledBy: "outside",
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      }),
    })) return false;
    if (result.usage) {
      j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?")
        .run(Math.round(result.usage.tokens ?? 0), Math.round((result.usage.costUsd ?? 0) * 1_000_000), runId);
      if (result.usage.unknown) j.event(runId, stepKey, "usage", null, "unknown", null);
      noteUnknownUsage(engine, runId, stepKey, result.usage);
    }
    if (run.status === "waiting") {
      j.db.prepare("UPDATE lane_pilot_wf_run SET wait_ms=wait_ms+? WHERE id=?").run(Math.max(0, engine.now() - run.updated_at), runId);
    }
    j.setRunStatus(runId, ["waiting"], "running", null);
    logEvent = { to: "succeeded", cols: factCols, hasAgent: stepHadAgentCall("succeeded", factOpts) };
    return true;
  })();
  if (settled) {
    if (logEvent) {
      const entry = logEvent as { to: "succeeded" | "failed"; cols: StepFactColumns; hasAgent: boolean };
      emitStepFactLogs(engine, runId, stepKey, node.id, entry.to, entry.cols, entry.hasAgent);
    }
    engine.log(`wf.wait woke step=${runId}/${stepKey} by=${meta?.by ?? "event"}`, "info");
    engine.clock?.arm();
  }
  return settled;
}
