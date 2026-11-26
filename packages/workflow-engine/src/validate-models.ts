import { PROVIDER_CAPABILITIES, ROLE_MODEL_OPTIONS, consistentProvider, nativeProviderFamily, roleModelOption } from "@lane-pilot/models";
import { START } from "./schema";
import type { GraphNode, Workflow } from "./schema";
import { isJudgeRole } from "./validate-rails";

type Agent = Extract<GraphNode, { type: "agent" }>;
type ReportProblem = (code: string, message: string, extra?: { node?: string; edge?: number }) => void;

const KNOWN_PROVIDERS = new Set([...Object.keys(PROVIDER_CAPABILITIES), ...ROLE_MODEL_OPTIONS.map((option) => option.providerId)]);
const templated = (value: string) => value.includes("{{");

/** The pair a node names, as it would run; null when the node names no model or names it by template. */
function namedPair(node: Agent): { providerId: string; model: string } | null {
  if (!node.model || templated(node.model) || (node.provider && templated(node.provider))) return null;
  const providerId = consistentProvider(node.provider, node.model);
  return providerId ? { providerId, model: node.model } : null;
}

/**
 * A node's own provider/model must be a pair that can run (the model's order is node, then the role's row in Settings, then the default),
 * and a critic or verifier may not share the pair of a writer node upstream of it unless it says so and why.
 */
export function validateNodeModels(workflow: Workflow, byId: Map<string, GraphNode>, error: ReportProblem): void {
  const agents = [...byId.values()].filter((node): node is Agent => node.type === "agent");
  for (const node of agents) {
    const extra = { node: node.id };
    if (node.provider && !templated(node.provider) && !KNOWN_PROVIDERS.has(node.provider) && !node.provider.startsWith("acp-")) {
      error("unknown_provider", `${node.id}: provider "${node.provider}" is not a provider Lane Pilot knows`, extra);
      continue;
    }
    if (node.provider && !node.model) error("model_missing", `${node.id}: names provider "${node.provider}" without a model`, extra);
    if (!node.model || templated(node.model)) continue;
    const providerId = node.provider && !templated(node.provider) ? node.provider : consistentProvider(null, node.model);
    if (!providerId) { error("unknown_model", `${node.id}: model "${node.model}" is not known and no provider is named for it`, extra); continue; }
    // The two native providers serve only the models of the table; any other provider takes any model its machine offers.
    if (nativeProviderFamily(providerId) && roleModelOption(node.model)?.providerId !== providerId) error("unknown_model", `${node.id}: "${node.model}" is not a model of provider "${providerId}"`, extra);
  }

  const parents = new Map<string, string[]>();
  for (const edge of workflow.edges) if (edge.from !== START) parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
  const upstream = (id: string): Set<string> => {
    const seen = new Set<string>(), stack = [...(parents.get(id) ?? [])];
    while (stack.length) { const next = stack.pop()!; if (!seen.has(next)) { seen.add(next); stack.push(...(parents.get(next) ?? [])); } }
    return seen;
  };
  for (const judge of agents) {
    const pair = namedPair(judge);
    if (!pair || !isJudgeRole(judge.role)) continue;
    if (judge.allow_same_model) {
      if (!judge.same_model_reason?.trim()) error("same_model_reason_missing", `${judge.id}: allow_same_model needs same_model_reason, the reason a judge may share the writer's model`, { node: judge.id });
      continue;
    }
    const before = upstream(judge.id);
    for (const writer of agents) {
      if (writer.id === judge.id || !before.has(writer.id) || isJudgeRole(writer.role)) continue;
      const other = namedPair(writer);
      if (other && other.providerId === pair.providerId && other.model === pair.model) {
        error("judge_same_model", `${judge.id}: judges ${writer.id} on the same provider and model (${pair.providerId}/${pair.model}); pick another family, or set allow_same_model: true with same_model_reason`, { node: judge.id });
      }
    }
  }
}
