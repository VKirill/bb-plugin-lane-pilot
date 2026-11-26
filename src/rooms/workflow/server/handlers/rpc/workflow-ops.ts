import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../../contracts";
import type { ServerCore } from "../../../../contracts/server";

import { createWorkflowLibrary } from "../../services/workflow-library";
import { realDeps } from "../../services/workflow-architect";
import { createWorkflowOps, routingHintReport } from "../../services/workflow-ops";
import { createWorkflowPreflight } from "../../services/workflow-preflight";
import { answerWorkflowQuestion } from "../../services/workflow-answer";

import type { WorkflowTriggersApi } from "../../services/workflow-triggers-live";

import type { DocsApi } from "../../../../docs/server";
import type { WorkflowEngineApi } from "../../services/workflow";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  docsPlaces: DocsApi["docsPlaces"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

/** The Workflows tab's actions on a workflow: its run history, re-running one node, a dry run, the tests of a file. */
export function workflowOpsRpc(ctx: ServerCore, services: Services) {
  const ops = createWorkflowOps(ctx, services, createWorkflowLibrary(ctx, services), { preflight: createWorkflowPreflight(ctx, realDeps(ctx, services)) });
  return {
    get_routing_hint: async ({ projectId, days }) => routingHintReport(ctx.db, { projectId, days }),
    workflow_runs: (input) => ops.runs(input),
    workflow_rerun_node: (input) => ops.rerunNode(input),
    workflow_preflight: (input) => ops.preflight(input),
    workflow_run: async (input) => {
      const result = await services.workflowTriggers.start({ projectId: input.projectId, workflowId: input.id, inputs: input.inputs, source: input.source, liveTrial: input.liveTrial });
      return result.ok ? { ok: true, runId: result.runId, created: result.created, status: result.status, notChecked: result.notChecked }
        : { ok: false, reason: result.reason, message: result.message, ...(result.missing ? { missing: result.missing } : {}), ...(result.issues ? { issues: result.issues } : {}), ...(result.envRequests ? { envRequests: result.envRequests } : {}) };
    },
    workflow_answer: async (input) => {
      const result = await answerWorkflowQuestion(ctx, services, input);
      return result.ok ? { ok: true, stepKey: result.stepKey } : { ok: false, reason: result.reason, message: result.message, ...(result.options ? { options: result.options } : {}) };
    },
    workflow_dry_run: (input) => ops.dryRun(input),
    workflow_run_tests: (input) => ops.runTests(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "get_routing_hint" | "workflow_runs" | "workflow_rerun_node" | "workflow_preflight" | "workflow_run" | "workflow_answer" | "workflow_dry_run" | "workflow_run_tests">;
}
