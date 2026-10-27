import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { runGraphHelper, sumUsage } from "../../workflow/server";
import type { ChainRuntime, GraphHelperRun } from "../../workflow/server";
import type { ServerCore, Services } from "../../core/server";
import type { AnalyzerSelection, JobResult, ScanJob } from "../../self-repair/server";

/**
 * The night rules scan as graphs (workflows/lp.rules-scan.json, workflows/lp.rules-ask.json). Planning and judging stay code: `collect` triages
 * the failures with System One and plans the model calls, `apply` turns the answers into proposals, trials and rewrites. The model work is the
 * `analyze` step: one hidden analyzer thread per planned call, in turn, on the analyzer the project has (its own pick, else the `rules-analyzer`
 * row of the role table). The cron `rules-nightly` and the «Rescan» button start the graph (`startScan` in rule-scan.ts); `lp.rules-ask` is the
 * one-call graph the learning review asks (`runAnalyzer`). Both run in a project with no PM chat.
 */
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function mountRulesScanGraph(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  const scan = services.ruleScan;
  const input = (c: StepContext<ChainRuntime>, name: string): string => text(c.resolve(`$inputs.${name}`));
  const stopped = (c: StepContext<ChainRuntime>): boolean => ctx.isDisposed() || c.signal.aborted;

  /** One analyzer call as a step's helper: the thread, its answer and what it spent. A thread that does not finish in time is stopped. */
  const runJob = (c: StepContext<ChainRuntime>, job: { key: string; projectId: string; title: string; prompt: string; metadata: Record<string, unknown> }, place: { hostId: string; path: string }, analyzer: AnalyzerSelection) =>
    runGraphHelper(ctx, c, {
      key: job.key, label: "rules_analyzer", waitMs: scan.graph.ANALYZER_LIMIT_MS, projectId: job.projectId,
      spawn: (graph) => scan.graph.spawnAnalyzer({ projectId: job.projectId, title: job.title, prompt: job.prompt, place, analyzer, metadata: job.metadata }, graph),
    });

  engine.register<ChainRuntime>("lp.rules_collect", {
    reentrant: true,
    run: async (c) => {
      const projectId = input(c, "project_id");
      const plan = await scan.graph.collectScan(projectId, input(c, "locale") === "ru" ? "ru" : "en");
      return {
        output: {
          state: plan.state, triaged: plan.triaged, groups: plan.groups, jobs: plan.jobs, host_id: plan.hostId, path: plan.path, analyzer: plan.analyzer ?? {},
          handoff: plan.state === "fallback" ? "System One unavailable: the text-grouping fallback ran" : `${plan.triaged} triaged, ${plan.jobs.length} analyzer call(s) planned`,
        },
      };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.rules-analyzer", {
    // Each call is a spawn effect keyed by its job: a step a reload cut off finds the threads it already made.
    reentrant: true,
    run: async (c) => {
      const projectId = input(c, "project_id");
      const jobs = list(c.resolve("collect.jobs")) as ScanJob[];
      const analyzer = c.resolve("collect.analyzer") as AnalyzerSelection | undefined;
      const place = { hostId: text(c.resolve("collect.host_id")), path: text(c.resolve("collect.path")) };
      const results: JobResult[] = [];
      const ran: GraphHelperRun[] = [];
      for (const job of jobs) {
        try {
          const run = await runJob(c, { key: job.id, projectId, title: job.title, prompt: job.prompt, metadata: job.kind === "analyze" ? { category: job.category } : { ruleId: job.ruleId } }, place, analyzer as AnalyzerSelection);
          ran.push(run);
          results.push({ id: job.id, text: run.text, error: null });
        } catch (cause) {
          // A reload or a cancel ends the step where it stands; any other failure is one call's, and the others still run.
          if (stopped(c)) throw cause;
          results.push({ id: job.id, text: null, error: cause instanceof Error ? cause.message : String(cause) });
        }
      }
      const failed = results.filter((row) => row.text === null);
      if (jobs.length > 0 && failed.length === jobs.length) throw new Error(`rules analyzer failed: ${failed[0]?.error ?? "no answer"}`);
      return { output: { results, failed: failed.length, handoff: `${results.length - failed.length} of ${results.length} analyzer call(s) answered` }, ...sumUsage(ran) };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.rules_apply", {
    reentrant: true,
    run: async (c) => {
      const projectId = input(c, "project_id");
      const applied = await scan.graph.applyScan(projectId, { state: text(c.resolve("collect.state")) === "fallback" ? "fallback" : "ok" }, list(c.resolve("collect.jobs")) as ScanJob[], list(c.resolve("analyze.results")) as JobResult[]);
      // The scan is recorded as it ended; a call that gave nothing usable makes the run a failed one, so the wall sees it.
      if (applied.errors > 0) throw new Error(applied.reason ?? "rules analyzer answers were unusable");
      return { output: { proposals: applied.proposals, adopted: applied.adopted, errors: applied.errors, reason: applied.reason ?? "", handoff: `${applied.proposals} proposal(s), ${applied.adopted} adopted` } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.rules-ask", {
    reentrant: true,
    run: async (c) => {
      const run = await runJob(c, {
        key: "ask", projectId: input(c, "project_id"), title: input(c, "title"), prompt: input(c, "prompt"),
        metadata: (c.resolve("$inputs.metadata") as Record<string, unknown> | undefined) ?? {},
      }, { hostId: input(c, "host_id"), path: input(c, "path") }, c.resolve("$inputs.analyzer") as AnalyzerSelection);
      return { output: { text: run.text, thread_id: run.threadId, handoff: "rules analyzer answered" }, ...run.usage };
    },
  } as NodeExecutor<ChainRuntime>);
}
