import type { ChainRuntime } from "../../../contracts/server";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import type { HelperRequest } from "./workflow-agent";

/** The model the schedule names for its agent (the task's `model`, `reasoning`, `serviceTier`): they stand over the settings, as the thread the old runner started did. */
export function routineModel(inputs: Record<string, unknown>): Pick<HelperRequest, "model" | "reasoning" | "serviceTier"> {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const reasoning = text(inputs.reasoning), tier = text(inputs.serviceTier);
  return {
    ...(text(inputs.model) ? { model: text(inputs.model) } : {}),
    ...(reasoning ? { reasoning } : {}),
    serviceTier: tier === "fast" ? "fast" : "default",
  };
}

/** The model fields a node names itself: they win over the role's row in Settings. */
export function nodeModelOf(ctx: StepContext<ChainRuntime>, node: Extract<GraphNode, { type: "agent" }>): Pick<HelperRequest, "provider" | "model" | "reasoning" | "serviceTier" | "nodeModel"> {
  const model = node.model ? ctx.render(node.model) : "";
  return {
    ...(node.provider ? { provider: ctx.render(node.provider) } : {}), ...(model ? { model, nodeModel: true as const } : {}),
    ...(node.reasoning ? { reasoning: node.reasoning } : {}), ...(node.service_tier ? { serviceTier: node.service_tier } : {}),
  };
}

