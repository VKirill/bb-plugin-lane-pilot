import type { z } from "zod";
import type { rpcContract, workflowTrialCaseSchema } from "../../contracts";
import { HARNESS_VERSION, createStatusResolver } from "../../storage";
import { runDraftTest, testCasesOf, wfRunPage } from "@lane-pilot/workflow-engine";
import type { DraftTestResult } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";

import type { createWorkflowLibrary } from "./workflow-library";
import type { WorkflowPreflight } from "./workflow-preflight";

import type { WorkflowEngineApi } from "./workflow";
import type { WorkflowTriggersApi } from "./workflow-triggers-live";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

type Output<K extends keyof typeof rpcContract> = z.infer<(typeof rpcContract)[K]["output"]>;
type TrialCase = z.infer<typeof workflowTrialCaseSchema>;

const trialCase = (result: DraftTestResult): TrialCase => ({
  caseId: result.caseId, green: result.green, status: result.status, reason: result.reason, error: result.error, failedNode: result.failedNode, path: result.path,
  output: result.output, runId: result.runId, failures: result.failures, notChecked: result.notChecked,
  stubbedCalls: result.stubbed.map((call) => `${call.node} (${call.type}${call.executor !== call.type ? `: ${call.executor}` : ""})`),
});

/**
 * What the Workflows tab does with a workflow beyond reading it (W7): the run history, re-running one node of a finished run, a
 * dry run with every external action stubbed, and the tests of a workflow file with their receipt.
 */
export function createWorkflowOps(ctx: ServerCore, services: Pick<Services, "workflowEngine"> & Partial<Pick<Services, "workflowCatalog" | "workflowTriggers">>, library: Pick<ReturnType<typeof createWorkflowLibrary>, "loadStore">,
  options: { timeoutMs?: number; preflight?: Pick<WorkflowPreflight, "check"> } = {}) {
  const { db } = ctx;
  const statuses = createStatusResolver(db);

  return {
    runs(input: { id: string; projectId?: string | undefined; limit: number; before?: number | undefined }): Output<"workflow_runs"> {
      const rows = wfRunPage(db, { workflowId: input.id, projectId: input.projectId, before: input.before, limit: input.limit });
      return {
        runs: rows.slice(0, input.limit).map((row) => ({ id: row.id, status: row.status, reason: row.reason, mode: row.mode, createdAt: row.created_at, updatedAt: row.updated_at,
          tokens: row.tokens_used, costUsd: row.cost_micro_usd / 1_000_000, parentRunId: row.parent_run_id, stepsUsed: row.steps_used })),
        hasMore: rows.length > input.limit,
      };
    },

    async rerunNode(input: { runId: string; nodeId: string; with?: Record<string, unknown> | undefined }): Promise<Output<"workflow_rerun_node">> {
      const run = services.workflowEngine.journal.getRun(input.runId);
      // The per-task pipeline keeps its runtime in memory and is never re-run by hand.
      if (run?.workflow_id === "lp-task-pipeline" || run?.idem_key?.startsWith("lp-task:")) return { ok: false, reason: "pipeline_run" };
      const result = await services.workflowEngine.rerunNode(input.runId, input.nodeId, undefined, input.with);
      return result.ok ? { ok: true, stepKey: result.stepKey, removed: result.removed } : { ok: false, reason: result.reason };
    },

    async preflight(input: { id: string; projectId?: string | undefined }): Promise<Output<"workflow_preflight">> {
      const { store } = await library.loadStore(input.projectId);
      const item = store.get(input.id);
      if (!item) return { found: false, ok: false, issues: [], envRequests: [], checked: [] };
      if (!options.preflight || !input.projectId) return { found: true, ok: true, issues: [], envRequests: [], checked: [] };
      return { found: true, ...(await options.preflight.check(item.workflow, { projectId: input.projectId })) };
    },

    async dryRun(input: { id: string; projectId?: string | undefined; input: Record<string, unknown> }): Promise<Output<"workflow_dry_run">> {
      const { store } = await library.loadStore(input.projectId);
      const item = store.get(input.id);
      if (!item) return { found: false, result: null, stubbed: [] };
      const [base] = testCasesOf(item.workflow);
      const testCase = { ...base!, id: "dry-run", input: { ...base!.input, ...input.input }, expectStatus: "succeeded", notChecked: [] };
      const result = await runDraftTest({ db, harnessVersion: HARNESS_VERSION, resolveWorkflow: store.resolve, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }, item.workflow, testCase);
      const shown = trialCase(result);
      return { found: true, result: shown, stubbed: shown.stubbedCalls };
    },

    async runTests(input: { id: string; projectId?: string | undefined }): Promise<Output<"workflow_run_tests">> {
      const { store } = await library.loadStore(input.projectId);
      const item = store.get(input.id);
      if (!item) return { found: false, green: false, cases: [], status: null };
      const cases: DraftTestResult[] = [];
      for (const testCase of testCasesOf(item.workflow)) {
        cases.push(await runDraftTest({ db, harnessVersion: HARNESS_VERSION, resolveWorkflow: store.resolve, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }, item.workflow, testCase));
      }
      const green = cases.length > 0 && cases.every((row) => row.green);
      statuses.recordTest(item.workflow.id, item.sha256, green, cases.map((row) => ({ caseId: row.caseId, green: row.green, path: row.path, failures: row.failures })));
      services.workflowCatalog?.invalidate();
      // Green tests can make a file published, and a published file with a schedule needs its automation.
      if (input.projectId) services.workflowTriggers?.syncSoon(input.projectId);
      // The status the library gives it now that the receipt is in.
      const status = (await library.loadStore(input.projectId)).store.get(input.id)?.workflow.status ?? null;
      return { found: true, green, cases: cases.map(trialCase), status };
    },
  };
}
export type WorkflowOps = ReturnType<typeof createWorkflowOps>;
