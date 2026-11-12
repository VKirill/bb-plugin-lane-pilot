import type { NodeExecutor, GraphNode, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { agentRequest, withResolvedModel, type WorkflowAgents } from "./workflow-agent";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";

/**
 * Custom executor for `quality-loop.classify`: no failures, no triager. With failures, the triager agent (the role that already
 * runs in this loop) sorts them into code_defects and env_issues; no small classifier decides before it.
 */
export function registerQualityLoopClassifyExecutor(
  engine: WorkflowEngine,
  _ctx: ServerCore,
  agents: WorkflowAgents,
): void {
  engine.register<ChainRuntime>("quality-loop.classify", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<GraphNode, { type: "agent" }>;

      const rawFailures = (c.input.with.failures ?? c.resolve("test_gen.failures") ?? c.inputs.failures ?? []) as unknown[];
      const failures = Array.isArray(rawFailures) ? rawFailures : [];

      if (!failures.length) {
        return {
          output: {
            failures: [],
            code_defects: [],
            test_defects: 0,
            env_issues: [],
            code_defect_count: 0,
          },
        };
      }

      const resolved = await withResolvedModel(agentRequest(c, node));
      const result = await agents.run(resolved);
      return {
        output: result.output,
        threadId: result.threadId,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  } as NodeExecutor<ChainRuntime>);
}
