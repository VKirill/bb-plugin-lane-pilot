import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { applyOutcomeLabels } from "@lane-pilot/jev";
import { planModelLabels, modelLabelPrompt, compareModelDecision, modelLabelable } from "@lane-pilot/jev";
import { recordOutcome } from "@lane-pilot/jev";
import { listJudgments } from "@lane-pilot/jev";
import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { builtinWorkflow } from "../../workflow";
import type { ChainRuntime } from "../../workflow/server";
import { runGraphHelper } from "../../workflow/server";
import { sweepFailureClassOutcomes, sweepInvoiceCheckOutcomes, sweepPlanFactOutcomes, sweepRouteWorkflowOutcomes, sweepWriterModelOutcomes } from "../../runs";

import type { RuleScanApi } from "../../self-repair/server/rule-scan";
import type { WorkflowEngineApi } from "../../workflow/server/workflow";
import type { WriterHostApi } from "../../writer/server/writer-host";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  ruleScan: RuleScanApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

export const JEV_LABELS_WORKFLOW = "lp.jev-labels";
export const JEV_LABELS_SCHEDULE = "jev-labels-nightly";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * The nightly judge-labeling graph (H1, workflows/lp.jev-labels.json): `outcome` writes the labels the pipeline's own
 * truth carries (the sweeps of src/rooms/runs/failure-class-model.ts plus the rules of packages/jev/src/labels-outcome.ts),
 * `model` asks the project's rules analyzer to re-answer sampled receipts blind (`agree:model`/`disagree:model`), `report`
 * leaves the receipt line. Runs with no PM chat like the other night graphs.
 */
export function mountJevLabelsGraph(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  const input = (c: StepContext<ChainRuntime>, name: string): string => text(c.resolve(`$inputs.${name}`));

  engine.register<ChainRuntime>("lp.jev_labels_outcome", {
    reentrant: true,
    run: async () => {
      const counts: Record<string, number> = {
        "failure.class": sweepFailureClassOutcomes(ctx.db as never),
        "invoice.check": sweepInvoiceCheckOutcomes(ctx.db as never),
        "route.workflow": sweepRouteWorkflowOutcomes(ctx.db as never),
        "plan.fact": sweepPlanFactOutcomes(ctx.db as never),
        "writer.model": sweepWriterModelOutcomes(ctx.db as never).length,
        ...applyOutcomeLabels(ctx.db as never),
      };
      return { output: { status: "done", counts, labeled: Object.values(counts).reduce((a, b) => a + b, 0) } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.jev_labels_model", {
    reentrant: true,
    run: async (c) => {
      const projectId = input(c, "project_id") || "*";
      const judgments = listJudgments().filter((judgment) => {
        // Judgments whose sampled inputs exist get relabeled; skip what cannot be re-rendered.
        try { return true; } catch { return false; }
      });
      const jobs = planModelLabels(ctx.db as never, judgments);
      if (!jobs.length) return { output: { status: "done", results: [], labeled: 0, handoff: "no sampled receipts to relabel" } };

      const place = await services.resolveProjectWriterHost({ projectId: projectId === "*" ? undefined : projectId } as never).catch(() => null);
      const analyzer = await services.ruleScan.analyzerFor(projectId, place && (place as { status?: string }).status === "resolved" ? { hostId: (place as { hostId: string }).hostId, path: (place as { path: string }).path } : null).catch(() => null);
      if (!analyzer || !place || (place as { status?: string }).status !== "resolved") {
        return { output: { status: "skipped", results: [], labeled: 0, handoff: "no analyzer or host for model labels" } };
      }
      const placeResolved = { hostId: (place as { hostId: string }).hostId, path: (place as { path: string }).path };
      const byId = new Map(listJudgments().map((judgment) => [judgment.id, judgment]));
      const results: Array<{ receiptId: number; judgment: string; outcome: string | null; error?: string }> = [];
      for (const job of jobs) {
        if (ctx.isDisposed() || c.signal.aborted) throw new Error("jev labels: stopped");
        const judgment = byId.get(job.judgment);
        if (!judgment || !modelLabelable(judgment, job.input)) { results.push({ receiptId: job.receiptId, judgment: job.judgment, outcome: null }); continue; }
        try {
          const prompt = modelLabelPrompt(judgment, job.input);
          const run = await runGraphHelper(ctx, c, {
            key: `jev-label:${job.receiptId}`, label: "jev_labeler", waitMs: services.ruleScan.graph.ANALYZER_LIMIT_MS, projectId,
            spawn: (graph) => services.ruleScan.graph.spawnAnalyzer(
              { projectId, title: `jev relabel ${job.judgment} #${job.receiptId}`, prompt, place: placeResolved, analyzer, metadata: { judgment: job.judgment, receiptId: job.receiptId } }, graph),
          });
          const decision = (ctx.db.prepare("SELECT decision FROM lane_pilot_jev_receipt WHERE id=?").get(job.receiptId) as { decision: string | null } | undefined)?.decision ?? null;
          const outcome = compareModelDecision(judgment, job.input, run.text, decision);
          if (outcome) recordOutcome(ctx.db as never, job.receiptId, outcome);
          results.push({ receiptId: job.receiptId, judgment: job.judgment, outcome });
        } catch (cause) {
          if (ctx.isDisposed() || c.signal.aborted) throw cause;
          results.push({ receiptId: job.receiptId, judgment: job.judgment, outcome: null, error: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      return { output: { status: "done", results, labeled: results.filter((row) => row.outcome).length, handoff: `${results.filter((row) => row.outcome).length} of ${jobs.length} sampled receipts relabeled` } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.jev_labels_report", {
    reentrant: true,
    run: async (c) => {
      const outcomeCounts = c.resolve("outcome.counts") as Record<string, unknown> | undefined;
      const outcomeLabeled = num(c.resolve("outcome.labeled"));
      const modelLabeled = num(c.resolve("model.labeled"));
      const matured = (ctx.db.prepare(`SELECT judgment, COUNT(*) AS n FROM lane_pilot_jev_receipt WHERE outcome IS NOT NULL AND (outcome LIKE 'agree%' OR outcome LIKE 'disagree%') GROUP BY judgment HAVING n >= 50`).all() as Array<{ judgment: string }>).length;
      const byJudgment = Object.entries(outcomeCounts ?? {}).filter(([, n]) => num(n) > 0).map(([id, n]) => `${id} ${num(n)}`).join(", ");
      const summary = `labels: ${outcomeLabeled} outcome${byJudgment ? ` (${byJudgment})` : ""}, ${modelLabeled} model, ${matured} judgments now ≥ 50 labels`;
      ctx.log(summary);
      return { output: { status: "done", summary, judgments_at_50: matured } };
    },
  } as NodeExecutor<ChainRuntime>);

  // Nightly after the rules scan (03:30 UTC): the labels land while the machine is idle anyway.
  scheduleIsolated(ctx.bb, JEV_LABELS_SCHEDULE, "45 3 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const workflow = builtinWorkflow(JEV_LABELS_WORKFLOW);
    if (!workflow) return;
    const key = `jev-labels:${new Date().toISOString().slice(0, 10)}`;
    const prior = ctx.db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key) as { status: string } | undefined;
    if (prior) return;
    await engine.start({
      workflow, key, link: { projectId: "*" },
      runtime: { ctx, services, pmThreadId: null, projectId: "*", runId: null, origin: "schedule" } satisfies ChainRuntime,
      inputs: { project_id: "*" },
    }).done.catch((cause: unknown) => ctx.log(`jev labels nightly failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 60 * 60_000 });
}
