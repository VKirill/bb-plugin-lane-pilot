import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { CRITIC_EDIT_TRIAL_KEY, criticEditGate, criticEditTrialSettle, criticPromptProposal, criticStats } from "../../critique";
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
      // The trial loop (item 4): a bench arm with the proposal against the current critic, then decideTrial's bench
      // verdict settles it — adopt writes the prompt to the store, retire goes to the rejected buffer.
      if (gate.status === "trial" && proposal) {
        const outcome = await criticEditTrial(ctx, services, input(c, "project_id"), proposal);
        return { output: { status: outcome.action === "adopt" ? "trial" : outcome.action === "retire" ? "held" : gate.status, detail: `${gate.detail}; ${outcome.reason}`, handoff: outcome.action } };
      }
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

/**
 * The bench part of the trial: the newest set runs two arms — the current critic (base) and the candidate prompt
 * (its proposal as `code_critique.agent`) — then `bench compare` decides, and `criticEditTrialSettle` writes the
 * adopted prompt (with version and rollback) or files the candidate into the rejected buffer.
 */
export async function criticEditTrial(ctx: ServerCore, services: Services, projectId: string, proposal: string): Promise<{ action: "adopt" | "retire" | "wait"; reason: string; version?: number }> {
  const set = services.bench.status().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!set) return { action: "wait", reason: "no bench set to score the candidate" };
  const armA = `cedit-base-${projectId.slice(-6)}`, armB = `cedit-prop-${projectId.slice(-6)}`;
  const hasBoth = [armA, armB].every((arm) => set.runs.some((row) => row.arm === arm && row.state === "done"));
  if (!hasBoth) {
    if (!set.runs.some((row) => row.arm === armA)) await services.bench.run({ version: set.version, arm: armA, wait: true });
    await services.bench.run({ version: set.version, arm: armB, wait: true, settings: { "code_critique.agent": proposal } });
  }
  const comparison = services.bench.compare({ version: set.version, armA, armB });
  const outcome = await criticEditTrialSettle({
    kv: ctx.bb.storage.kv as never, stage: "code-critique", proposal,
    verdict: comparison.comparison.verdict === "inconclusive" ? null : { passed: comparison.comparison.verdict === "pass", summary: comparison.text.split("\n")[0] ?? "" },
  });
  return { action: outcome.action, reason: outcome.reason, ...(outcome.action === "adopt" ? { version: outcome.version } : {}) };
}
