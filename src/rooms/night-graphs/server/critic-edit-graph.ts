import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { CRITIC_EDIT_TRIAL_KEY, criticEditGate, criticEditTrialOn, criticEditTrialSettle, criticPromptProposal, criticStats } from "../../critique";
import { judgeSharedTrial, TRIAL_DEFAULTS } from "../../harness/server";
import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";

import type { ChainRuntime } from "../../contracts/server";

import type { BenchApi } from "../../bench/service";
import { bestEffort } from "@lane-pilot/kit";

import type { WorkflowEngineApi } from "../../platform/server";
import { listProjectsWithCriticReceipts } from "../../storage";
import { wfTerminalByIdemKey } from "@lane-pilot/workflow-engine";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  bench: BenchApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

/**
 * `lp.critic-edit` (workflows/lp.critic-edit.json): once a month, a proposal from critic calibration. The trial flag
 * defaults on. The gate is `judgeSharedTrial` on the nightly bench: it holds until that verdict, and a prompt is not written here.
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
      if (proposal) await bestEffort(ctx.log, "critic edit proposal write", ctx.bb.storage.kv.set(PROPOSAL_KEY(projectId), { at: Date.now(), proposal } as never), undefined);
      return { output: { status: proposal ? "ready" : "skipped", detail: proposal ?? "no critic is below the calibration bar", proposal: proposal ?? "", handoff: proposal ? "ready" : "skipped" } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.critic_edit_gate", {
    reentrant: true,
    run: async (c) => {
      const projectId = input(c, "project_id");
      const stored = await ctx.bb.storage.kv.get(CRITIC_EDIT_TRIAL_KEY);
      const bag = await ctx.bb.storage.kv.get(PROPOSAL_KEY(projectId));
      const startedAt = bag && typeof bag === "object" && typeof (bag as { at?: unknown }).at === "number" ? (bag as { at: number }).at : Date.now();
      const proposal = text(c.resolve("prepare.proposal")) || null;
      // The two bench arms (base critic vs the proposal) produce the comparison row judgeSharedTrial decides on.
      let verdict: { passed: boolean; summary: string } | null = null;
      if (criticEditTrialOn(stored) && input(c, "bench") === "on" && proposal) {
        verdict = await criticEditTrial(ctx, services, projectId, proposal);
      }
      const decision = judgeSharedTrial([], startedAt, Date.now(), TRIAL_DEFAULTS, { adoptBy: "bench", verdict });
      const gate = criticEditGate({ trialOn: criticEditTrialOn(stored), proposal, decision });
      // Adopt writes the prompt to the store (version + rollback); retire files the candidate into the rejected buffer.
      if (decision.action !== "wait" && proposal) {
        const outcome = await criticEditTrialSettle({ kv: ctx.bb.storage.kv as never, stage: "code-critique", proposal, verdict });
        return { output: { status: outcome.action === "retire" ? "retired" : gate.status, detail: `${gate.detail}; ${outcome.reason}`, handoff: outcome.action === "adopt" ? "trial" : gate.status } };
      }
      return { output: { status: gate.status, detail: gate.detail, handoff: gate.status } };
    },
  } as NodeExecutor<ChainRuntime>);

  scheduleIsolated(ctx.bb, "critic-edit-monthly", "20 5 1 * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const workflow = services.workflowEngine.resolveWorkflow("lp.critic-edit");
    if (!workflow) return;
    const month = new Date().toISOString().slice(0, 7);
    const projects = listProjectsWithCriticReceipts(ctx.db as never, Date.now() - 30 * 86_400_000).map((id) => ({ id }));
    for (const project of projects) {
      if (ctx.isDisposed() || signal?.aborted) return;
      const key = `critic-edit:${project.id}:${month}`;
      const prior = wfTerminalByIdemKey(ctx.db as never, key);
      if (prior) continue;
      await engine.start({
        workflow, key, link: { projectId: project.id },
        runtime: { ctx, services, pmThreadId: null, projectId: project.id, runId: null, origin: "schedule" } satisfies ChainRuntime,
        // `bench: "on"`: the monthly run is the one that scores a proposal on the bench (criticEditTrial runs only with a proposal and the
        // trial on). It used to pass "" and so held every proposal for ever (Gemini F-011).
        inputs: { project_id: project.id, bench: "on" },
      }).done.catch((cause: unknown) => ctx.log(`critic edit for ${project.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  }, { timeoutMs: 30 * 60_000 });
}

/**
 * The bench part of the trial: the newest set runs two arms — the current critic (base) and the candidate prompt
 * (its proposal as `code_critique.agent`) — then `bench compare` decides, and `criticEditTrialSettle` writes the
 * adopted prompt (with version and rollback) or files the candidate into the rejected buffer.
 */
export async function criticEditTrial(ctx: ServerCore, services: Services, projectId: string, proposal: string): Promise<{ passed: boolean; summary: string } | null> {
  const set = services.bench.status().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!set) return null;
  const armA = `cedit-base-${projectId.slice(-6)}`, armB = `cedit-prop-${projectId.slice(-6)}`;
  const hasBoth = [armA, armB].every((arm) => set.runs.some((row) => row.arm === arm && row.state === "done"));
  if (!hasBoth) {
    if (!set.runs.some((row) => row.arm === armA)) await services.bench.run({ version: set.version, arm: armA, wait: true });
    await services.bench.run({ version: set.version, arm: armB, wait: true, settings: { "code_critique.agent": proposal } });
  }
  const comparison = services.bench.compare({ version: set.version, armA, armB });
  return comparison.comparison.verdict === "inconclusive" ? null : { passed: comparison.comparison.verdict === "pass", summary: comparison.text.split("\n")[0] ?? "" };
}
