import { createJournal, wfChildRuns } from "@lane-pilot/workflow-engine";
import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { PhaseRefusal, type PhaseApi } from "../../phase/server";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import type { Row, Services } from "./workflow-chain-runtime";
import { str } from "./workflow-chain-runtime";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;

type PhaseServices = Services & { phases?: PhaseApi };

/** Code-owned phase reads and writes used by workflows. Agents never receive the phase-control plugin. */
export function registerPhaseActions(_engine: WorkflowEngine, ctx: ServerCore, services: PhaseServices, deps: { action: Action }): void {
  const { action } = deps;
  const phases = (): PhaseApi => {
    const api = services.phases;
    if (!api) throw new Error("phase_api_unavailable: workflow phase actions require the phase driver");
    return api;
  };

  action("lp.phase_status", async (c, rt) => {
    const api = phases();
    const requested = str(c.resolve("$inputs.phase_id")).trim();
    if (!requested) throw new Error("phase_id is required for lp.phase_status");
    const phase = api.resolve(rt.projectId, requested);
    if (!phase) throw new Error(`phase_not_found: ${requested}`);
    const status = api.status(phase.id);
    return {
      status: {
        phase_id: status.phase.id,
        title: status.phase.title,
        stage: status.phase.stage,
        state: status.phase.state,
        next: status.next.text,
        gates: status.gates,
        plan: status.phase.record.plan ?? null,
        context: status.phase.record.context ?? null,
        book: status.book.slice(0, 6000),
      },
    };
  });

  action("lp.phase_plan_check", async (c, rt) => {
    const api = phases();
    const requested = str(c.resolve("$inputs.phase_id")).trim();
    if (!requested) throw new Error("phase_id is required for lp.phase_plan_check");
    const phase = api.resolve(rt.projectId, requested);
    if (!phase) throw new Error(`phase_not_found: ${requested}`);
    const decision = str(c.resolve("proof.decision"));
    if (decision !== "approve" && decision !== "changes_requested") throw new Error(`invalid plan review decision: ${decision || "empty"}`);
    const findings = c.resolve("proof.findings");
    const rounds = c.resolve("proof.rounds");
    const fromStep = c.input.via.fromStep;
    if (!fromStep) throw new Error("phase_plan_check_child_missing: the phase check must follow the completed proof subworkflow");
    const journal = createJournal(ctx.db);
    const children = wfChildRuns(ctx.db, c.runId).filter((child) => child.parent_step_key === fromStep && child.workflow_id === "plan-review-convergence-proof");
    if (children.length !== 1) throw new Error(`phase_plan_check_child_missing: expected one proof child for ${fromStep}, found ${children.length}`);
    const child = journal.getRun(children[0]!.id);
    if (!child || child.status !== "succeeded") throw new Error(`phase_plan_check_child_incomplete: proof child ${children[0]!.id} did not end succeeded`);
    const report = { findings: Array.isArray(findings) ? findings : [], rounds };
    try {
      await api.planCheck({ phaseId: phase.id, decision, by: "Lane Pilot plan-review convergence", summary: JSON.stringify(report), wfRunId: child.id });
    } catch (cause) {
      // changes_requested is a recorded rework outcome: planCheck stores the independent receipt before its admission gate refuses
      // to advance. Swallow only that exact, persisted result; every binding, context, or unrelated gate error remains visible.
      const latest = api.resolve(rt.projectId, phase.id);
      const critique = latest?.record.plan?.critique;
      const recordedRework = cause instanceof PhaseRefusal
        && cause.message === "the plan is not admitted"
        && decision === "changes_requested"
        && latest?.record.plan?.sha === phase.record.plan?.sha
        && critique?.decision === "changes_requested"
        && critique.independence?.ok === true
        && critique.independence.wfRunId === child.id;
      if (!recordedRework) throw cause;
    }
    return { status: "recorded", phase_id: phase.id, decision, checker_run_id: child.id };
  });
}
