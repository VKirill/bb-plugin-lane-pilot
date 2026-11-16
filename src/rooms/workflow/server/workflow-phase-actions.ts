import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { PhaseApi } from "../../phase/server";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import type { Row, Services } from "./workflow-chain-runtime";
import { str } from "./workflow-chain-runtime";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;

type PhaseServices = Services & { phases?: PhaseApi };

/** Code-owned phase reads and writes used by workflows. Agents never receive the phase-control plugin. */
export function registerPhaseActions(_engine: WorkflowEngine, _ctx: ServerCore, services: PhaseServices, deps: { action: Action }): void {
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
    const decision = str(c.resolve("converge.decision"));
    if (decision !== "approve" && decision !== "changes_requested") throw new Error(`invalid plan review decision: ${decision || "empty"}`);
    const findings = c.resolve("converge.findings");
    const rounds = c.resolve("converge.rounds");
    await api.planCheck({
      phaseId: phase.id,
      decision,
      by: "Lane Pilot plan-review convergence",
      summary: JSON.stringify({ findings: Array.isArray(findings) ? findings : [], rounds }),
      wfRunId: c.runId,
    });
    return { status: "recorded", phase_id: phase.id, decision };
  });
}
