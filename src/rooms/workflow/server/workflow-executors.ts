import { getRunSettingsScopes, loadProjectSettings, planningHomeInputs } from "../../storage";
import { resolvePlanningHome } from "../../contracts";
import { switchOn } from "@lane-pilot/models";
import type { GraphNode, NodeExecutor, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { createTaskLinter } from "../../tasks/server";
import { agentRequest, createWorkflowAgents, stepPacket, withResolvedModel } from "./workflow-agent";
import type { WorkflowAgents } from "./workflow-agent";
import { registerQualityLoopClassifyExecutor } from "./workflow-classify";
import { keyedSpawnSupported } from "../../platform/server";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import { chainRuntimeFor, need, pmCheckout } from "./workflow-chain-runtime";
import type { Row, Services } from "./workflow-chain-runtime";
import { registerHumanForm } from "./workflow-human-form";
import { registerDeliverableAction } from "./workflow-deliverable";
import { registerLpTask } from "./workflow-lp-task";
import { registerCheckoutActions } from "./workflow-checkout-actions";
import { deliverRunFile, noteRunFiles } from "./workflow-run-home";
import { registerProjectActions } from "./workflow-project-actions";
import { registerTaskBookActions } from "./workflow-task-book";
import { registerDelegatedActions } from "./workflow-delegated-actions";
import { recordSpecialistLedgerUsage, registerSpExecutors } from "../../specialist/server";
import { registerPassportExecutors } from "../../passport/server";

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

  // The Jev steps: the native `jev` node.
  // The failure classification step of `quality-loop`.
  registerQualityLoopClassifyExecutor(engine, ctx, agents);

  // ---------------------------------------------------------------- agent
  engine.register<ChainRuntime>("agent", {
    // A re-run after a reload is safe only when the spawn is idempotent (the VK thread keys); else the step is interrupted instead.
    get reentrant() { return keyedSpawnSupported(bb); },
    run: async (c) => {
      const rt = need(c);
      const node = c.node as Extract<GraphNode, { type: "agent" }>;
      // Every required `consumes` contract must be satisfied before starting a helper, regardless of whether `as` aliases it (`ASTRA-F-004`).
      for (const spec of node.consumes ?? []) {
        if (!spec.required) continue;
        if (spec.as) {
          if ((c.input.with[spec.as] ?? c.inputs[spec.as]) === undefined) {
            throw new Error(`consumes_missing: ${node.id} needs ${spec.kind}/${spec.version} as "${spec.as}"${spec.from ? ` from ${spec.from}` : ""}, which did not arrive`);
          }
          continue;
        }
        if (spec.from === "$inputs" || spec.from === "start") {
          const directVal = c.inputs[spec.kind];
          const isFilled = (v: unknown): boolean =>
            v !== undefined && v !== null && v !== "" && (!Array.isArray(v) || v.length > 0);
          const hasInput = directVal !== undefined ? isFilled(directVal) : Object.values(c.inputs).some(isFilled);
          if (!hasInput) {
            throw new Error(`consumes_missing: ${node.id} needs ${spec.kind}/${spec.version} from "${spec.from}", which did not arrive in inputs`);
          }
          continue;
        }
        if (spec.from) {
          if (c.resolve(spec.from) === undefined) {
            throw new Error(`consumes_missing: ${node.id} needs ${spec.kind}/${spec.version} from "${spec.from}", which has not produced an output`);
          }
          continue;
        }
        if (!spec.from) {
          const producedUpstream = c.workflow.nodes.some((candidate) => {
            if (candidate.id === node.id || candidate.type === "note") return false;
            const directProduces = candidate.produces?.some((p) => p.kind === spec.kind && p.version === spec.version);
            const childProduces =
              candidate.type === "parallel" &&
              candidate.child?.produces?.some((p) => p.kind === spec.kind && p.version === spec.version);
            if (!directProduces && !childProduces) return false;
            const joinId = candidate.id.endsWith(":child") ? candidate.id.slice(0, -6) : candidate.id;
            return c.resolve(candidate.id) !== undefined || c.resolve(joinId) !== undefined;
          });
          // Only what a step of THIS run produced counts. The old fallback took any artifact of that kind in the whole project (another run's, another
          // task's); a consumer that wants an artifact from elsewhere names it: `from` an earlier node, or `$inputs` for what the caller passed in.
          if (!producedUpstream) {
            throw new Error(`consumes_missing: ${node.id} needs ${spec.kind}/${spec.version}, which no upstream step of this run produced; name its source with \`from\` (an earlier node, or $inputs)`);
          }
        }
      }
      // The inputs that are too long to repeat stand in the packet as files and summaries: they must reach the helper's
      // workspace whole, so a file that cannot be written stops the step before a helper starts — never a packet that
      // shows required data cut (the helper would answer from data it never got).
      const plan = stepPacket(c, node);
      let filesAt: { hostId: string; path: string } | undefined;
      if (plan.files.length) {
        try {
          const checkout = await pmCheckout(rt);
          for (const file of plan.files) await deliverRunFile(bb.sdk.files, checkout, file);
          // The spill stays where the PM chat reads it (.bb/chats/<pm>/artifacts/wf-<run>/); the run's manifest says which step it is the input of.
          // Step inputs are required context: when the manifest cannot record them the step fails before a helper starts.
          await noteRunFiles(ctx, rt, c, checkout, plan.files.map((file) => ({ repoPath: file.path, content: file.text, kind: "step-input" as const, readers: [node.id] })), { required: true });
          filesAt = checkout;
        } catch (cause) {
          throw new Error(`input_delivery_failed: the ${plan.files.length} input file(s) of ${node.id} could not be delivered to the PM checkout (${cause instanceof Error ? cause.message : String(cause)}); the step does not run on cut inputs`);
        }
      }
      const req = await withResolvedModel(agentRequest(c, node, { plan, filesAt }));
      const result = await agents.run(req);
      const costUsd = result.usage?.costUsd ?? 0;
      if (costUsd > 0 && rt.projectId) {
        const wfId = c.workflow.id;
        const isSeo = wfId.startsWith("seo-") || req.role === "specialist:seo-specialist" || req.role === "seo-specialist";
        const isMkt = wfId.startsWith("mkt-") || req.role === "specialist:growth-marketer" || req.role === "growth-marketer";
        const isSp = wfId.startsWith("sp-") || wfId === "lp.specialist-eval";
        if (isSeo || isMkt || isSp) {
          const spDomain = isSeo ? "seo" : isMkt ? "marketing" : "specialist_os";
          recordSpecialistLedgerUsage(db, {
            projectId: rt.projectId,
            domain: spDomain,
            kind: "llm_usd",
            amountUsd: costUsd,
            cellKey: `${spDomain}:${wfId}`,
            runId: c.runId,
            reason: `agent:${wfId}:${node.id}`,
          });
        }
      }
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
  registerDeliverableAction(action, { planHome, services });
  registerTaskBookActions(engine, ctx, { action, planHome, lintTask });
  registerSpExecutors(engine, ctx, {
    action,
    engine,
    planHome,
    noteRunFiles: (c, rt, checkout, files) => noteRunFiles(ctx, rt, c, checkout, files),
    resolveServices: () => ({
      ...(services.schedules ? { schedules: services.schedules } : {}),
      ...(services.backlog ? { backlog: services.backlog } : {}),
      ...(services.phaseIntake !== undefined ? { phaseIntake: services.phaseIntake } : {}),
      ...(services.executeMutation ? { executeMutation: services.executeMutation } : {}),
      ...(services.allowScriptFixtureFallback !== undefined ? { allowScriptFixtureFallback: services.allowScriptFixtureFallback } : {}),
    }),
  });
  registerPassportExecutors(engine, ctx, { action });

  // ---------------------------------------------------------------- actions that go through a helper thread (skills, MCP, accounts)
  registerDelegatedActions(engine, ctx, agents);
}
