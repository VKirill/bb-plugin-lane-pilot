import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { CRITIC_EDIT_TRIAL_KEY, criticEditGate, criticPromptProposal, criticStats } from "../../critique";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import { builtinWorkflow } from "../../workflow";
import type { ChainRuntime } from "../../workflow/server";

/**
 * `lp.critic-edit` (workflows/lp.critic-edit.json): once a month, a proposal from critic calibration. The trial gate stays
 * held until the KV flag `lp.critic.edit.trial` is on and the run is given `bench=on`. Neither rewrites a prompt.
 */
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const PROPOSAL_KEY = (projectId: string) => `lp.critic.edit.proposal:${projectId}`;

export function mountCriticEditGraph(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  const input = (c: StepContext<ChainRuntime>, name: string) => text(c.resolve(`$inputs.${name}`));

  engine.register<ChainRuntime>("lp.critic_edit_prepare", {
    reentrant: true,
    run: async (c) => {
      const projectId = input(c, "project_id");
      const proposal = criticPromptProposal(criticStats(ctx.db as never, projectId, Date.now() - 30 * 86_400_000));
      if (proposal) await ctx.bb.storage.kv.set(PROPOSAL_KEY(projectId), { at: Date.now(), proposal } as never).catch(() => undefined);
      return { output: { status: proposal ? "ready" : "skipped", detail: proposal ?? "no critic is below the calibration bar", proposal: proposal ?? "", handoff: proposal ? "ready" : "skipped" } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.critic_edit_gate", {
    reentrant: true,
    run: async (c) => {
      const stored = await ctx.bb.storage.kv.get(CRITIC_EDIT_TRIAL_KEY).catch(() => null);
      const trialOn = stored === "on" || (typeof stored === "object" && stored !== null && (stored as { on?: boolean }).on === true);
      const proposal = text(c.resolve("prepare.proposal")) || null;
      const gate = criticEditGate({ trialOn, benchOn: input(c, "bench") === "on", proposal });
      return { output: { status: gate.status, detail: gate.detail, handoff: gate.status } };
    },
  } as NodeExecutor<ChainRuntime>);

  scheduleIsolated(ctx.bb, "critic-edit-monthly", "20 5 1 * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const workflow = builtinWorkflow("lp.critic-edit");
    if (!workflow) return;
    const month = new Date().toISOString().slice(0, 7);
    const projects = ctx.db.prepare(`SELECT DISTINCT r.project_id AS id FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
      WHERE s.updated_at>=? AND s.stage_id IN ('plan-critique','code-critique','specialist-review')`).all(Date.now() - 30 * 86_400_000) as Array<{ id: string }>;
    for (const project of projects) {
      if (ctx.isDisposed() || signal?.aborted) return;
      const key = `critic-edit:${project.id}:${month}`;
      const prior = ctx.db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key) as { status: string } | undefined;
      if (prior) continue;
      await engine.start({
        workflow, key, link: { projectId: project.id },
        runtime: { ctx, services, pmThreadId: null, projectId: project.id, runId: null, origin: "schedule" } satisfies ChainRuntime,
        inputs: { project_id: project.id, bench: "" },
      }).done.catch((cause: unknown) => ctx.log(`critic edit for ${project.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  }, { timeoutMs: 30 * 60_000 });
}
