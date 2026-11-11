import { getRunSettingsScopes, loadProjectSettings, planningHomeInputs } from "../../storage";
import { resolvePlanningHome } from "../../contracts";
import { switchOn } from "@lane-pilot/models";
import type { GraphNode, NodeExecutor, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { createTaskLinter } from "../../tasks/server";
import { agentRequest, createWorkflowAgents, stepPacket, withResolvedModel } from "./workflow-agent";
import type { WorkflowAgents } from "./workflow-agent";
import { registerRouterExecutor } from "./workflow-router-model";
import { registerQualityLoopClassifyExecutor } from "./workflow-classify";
import { keyedSpawnSupported } from "../../platform/server";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import { chainRuntimeFor, need, pmCheckout } from "./workflow-chain-runtime";
import type { Row, Services } from "./workflow-chain-runtime";
import { registerHumanForm } from "./workflow-human-form";
import { registerJevSteps } from "./workflow-jev-steps";
import { registerDeliverableAction, registerDeliverableNode } from "./workflow-deliverable";
import { registerLpTask } from "./workflow-lp-task";
import { registerCheckoutActions } from "./workflow-checkout-actions";
import { registerProjectActions } from "./workflow-project-actions";
import { registerTaskBookActions } from "./workflow-task-book";
import { registerDelegatedActions } from "./workflow-delegated-actions";

export { provideLpTaskPipeline, chainRuntimeFor } from "./workflow-chain-runtime";
export { workflowQuestionKey, humanOptions, humanFields, humanOutput, MACHINE_HUMAN_WAIT_SEC } from "./workflow-human-form";
export { shortPathCriticDefault, commandOf, PLAN_CHECK_TIMEOUT_SEC, withContractDefaults } from "./workflow-task-contract";
export { quickStateEdit, debugSessionSlug, debugSessionDoc } from "./workflow-planning-files";
export { secretKeyName } from "../../anamnesis";

/**
 * The executors that run a chain on the host: the generic agent step, the owner's question, the code task of a chain, the actions
 * that read the plugin's own state or the PM's checkout, and the actions that go through a helper thread (a skill, an MCP tool, the
 * owner's accounts) the way errands do. The pure ones (dedupe, the verdict thresholds, the citation check) are in workflow/actions.ts.
 */
export function registerChainExecutors(engine: WorkflowEngine, ctx: ServerCore, services: Services, agents: WorkflowAgents = createWorkflowAgents()): void {
  const { bb, db, host } = ctx;
  /** The planning home of a project on the checkout's host (SMA d_project_planning), checked on that host; null: planning lives in the checkout. */
  const planHome = (projectId: string, checkout: { hostId: string; path: string }): Promise<string | null> =>
    resolvePlanningHome({ host: ctx.host, hostId: checkout.hostId, cwd: checkout.path, inputs: planningHomeInputs(db, projectId), log: bb.log });
  const lintTask = createTaskLinter(ctx, services);
  const rebuild = chainRuntimeFor(ctx, services);
  const runtimeOf = (c: { runtime: unknown }, runId?: string): ChainRuntime | undefined => {
    if (c.runtime) return c.runtime as ChainRuntime;
    const row = runId ? engine.journal.getRun(runId) : undefined;
    return row ? rebuild(row) : undefined;
  };
  // A project's switch for a new behaviour (unset = off, as before the change): read when the node runs, so any graph can use it.
  const flagOf = (rt: ChainRuntime, key: string): boolean => switchOn(loadProjectSettings(db, rt.projectId, rt.runId ? getRunSettingsScopes(db, rt.runId) : []), key);

  // The model step of the router's graph `lp.route`.
  registerRouterExecutor(engine, agents);

  // The Jev steps: the native `jev` node, the citation check, the skill-tree pick.
  registerJevSteps(engine, ctx, { runtimeOf });
  // `deliverable.validate` — the three-layer acceptance of a non-code artifact.
  registerDeliverableNode(engine, ctx, services, { runtimeOf });
  // The failure classification step of `quality-loop`.
  registerQualityLoopClassifyExecutor(engine, ctx, agents);

  // ---------------------------------------------------------------- agent
  engine.register<ChainRuntime>("agent", {
    // A re-run after a reload is safe only when the spawn is idempotent (the VK thread keys); else the step is interrupted instead.
    get reentrant() { return keyedSpawnSupported(bb); },
    run: async (c) => {
      const rt = need(c);
      const node = c.node as Extract<GraphNode, { type: "agent" }>;
      // A required artifact that arrives under a name (`consumes.as`) must be there before a helper is started for it.
      for (const spec of node.consumes ?? []) {
        if (spec.required && spec.as && (c.input.with[spec.as] ?? c.inputs[spec.as]) === undefined) throw new Error(`consumes_missing: ${node.id} needs ${spec.kind}/${spec.version} as "${spec.as}"${spec.from ? ` from ${spec.from}` : ""}, which did not arrive`);
      }
      // The inputs that are too long to repeat stand in the packet as a file and a summary: the files are written first, and if that fails the packet shows them cut.
      const plan = stepPacket(c, node);
      let byReference = true;
      if (plan?.files.length) {
        try {
          const checkout = await pmCheckout(rt);
          for (const file of plan.files) await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${file.path}`, content: file.text, contentEncoding: "utf8", createParents: true });
        } catch (cause) {
          byReference = false;
          bb.log.warn(`Lane Pilot could not write the input files of ${node.id} (${cause instanceof Error ? cause.message : String(cause)}); the packet shows them cut`);
        }
      }
      const result = await agents.run(await withResolvedModel(agentRequest(c, node, { byReference })));
      return { output: result.output, threadId: result.threadId, ...(result.usage ? { usage: result.usage } : {}) };
    },
  } as NodeExecutor<ChainRuntime>);

  // ---------------------------------------------------------------- human: the owner's question as a BB form
  registerHumanForm(engine, ctx, agents, { runtimeOf });

  // ---------------------------------------------------------------- lp-task: one code task through the writer pipeline
  registerLpTask(engine, ctx, services, agents, { runtimeOf, lintTask });

  // ---------------------------------------------------------------- actions on the plugin's own state and the PM's checkout
  const action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) =>
    engine.register<ChainRuntime>(key, { reentrant: true, run: async (c) => ({ output: await run(c, need(c)) }) } as NodeExecutor<ChainRuntime>);

  registerCheckoutActions(engine, ctx, { action, planHome, flagOf });
  registerProjectActions(engine, ctx, { action, planHome, flagOf });
  registerDeliverableAction(action);
  registerTaskBookActions(engine, ctx, { action, planHome, lintTask });

  // ---------------------------------------------------------------- actions that go through a helper thread (skills, MCP, accounts)
  registerDelegatedActions(engine, ctx, agents);
}
