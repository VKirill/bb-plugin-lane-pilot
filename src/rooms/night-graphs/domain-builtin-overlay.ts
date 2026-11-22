import type { Workflow } from "@lane-pilot/workflow-engine";
import { builtinWorkflow, isEvolvableDomainBuiltinId, rawBuiltinWorkflowSource } from "../workflow";

export type FactoryDomainBase = {
  workflowId: string;
  version: number;
  def: Record<string, unknown>;
  workflow: Workflow;
};

export type DomainBuiltinCatalogSummary = {
  id: string;
  version: number;
  title: unknown;
  category?: unknown;
  triggers?: string[];
  inputs?: string[];
  outputs?: string[];
  nodes?: Array<{
    id: string;
    type: string;
    skipWhen?: string;
    ownsPaths?: string[];
    options?: string[];
    workflow?: string;
  }>;
};

/** Maps an evolvable domain built-in workflow ID to its broad evolution family. */
export function domainFamilyOfBuiltinId(workflowId: string): string | null {
  const id = workflowId.trim().toLowerCase();
  if (!isEvolvableDomainBuiltinId(id)) return null;
  if (id.startsWith("seo-")) return "seo";
  if (id.startsWith("mkt-")) return "marketing";
  if (id === "reels" || id === "3d-asset" || id === "roblox-asset") return "media";
  if (id === "social-post" || id === "insights-post" || id === "ins.post" || id === "x-to-telegram-digest") return "content";
  if (id === "web-research" || id === "research-dossier" || id === "api-recon") return "research";
  return null;
}

/** Resolves the raw factory JSON and parsed `Workflow` for an evolvable domain built-in (`null` for core locked built-ins). */
export function resolveFactoryDomainBase(workflowId: string): FactoryDomainBase | null {
  const id = workflowId.trim();
  if (!isEvolvableDomainBuiltinId(id)) return null;
  const workflow = builtinWorkflow(id);
  const def = rawBuiltinWorkflowSource(id);
  if (!workflow || !def) return null;
  return { workflowId: id, version: workflow.version, def, workflow };
}

/**
 * Verifies that a global overlay over a factory domain built-in preserves backwards-compatible `inputs` and `outputs`
 * so existing callers (`sp-specialist-tick`, `seo-cocoon -> seo-brief -> seo-page`, chat triggers) never break.
 */
export function checkDomainBuiltinOverlayCompatibility(baseWorkflow: Workflow, candidateWorkflow: Workflow): string[] {
  const issues: string[] = [];
  const candInputs = new Map(candidateWorkflow.inputs.map((f) => [f.name, f]));
  const baseInputs = new Map(baseWorkflow.inputs.map((f) => [f.name, f]));
  for (const baseField of baseWorkflow.inputs) {
    const nextField = candInputs.get(baseField.name);
    if (!nextField) {
      issues.push(`missing_factory_input:${baseField.name}`);
      continue;
    }
    if (baseField.type !== nextField.type && nextField.type !== "string" && nextField.type !== "json") {
      issues.push(`incompatible_input_type:${baseField.name}(${baseField.type}->${nextField.type})`);
    }
  }
  for (const nextField of candidateWorkflow.inputs) {
    if (!baseInputs.has(nextField.name) && nextField.required && nextField.default === undefined) {
      issues.push(`new_required_input_without_default:${nextField.name}`);
    }
  }
  const candOutputs = new Map(candidateWorkflow.outputs.map((f) => [f.name, f]));
  for (const baseOut of baseWorkflow.outputs) {
    if (!candOutputs.has(baseOut.name)) {
      issues.push(`missing_factory_output:${baseOut.name}`);
    }
  }
  return issues;
}

/** Summarizes a `Workflow` for `EvolveCatalogContext.existingGlobal`. */
export function summarizeWorkflowForEvolveCatalog(wf: Workflow, leanViolations?: string[]): DomainBuiltinCatalogSummary & { leanViolations?: string[] } {
  return {
    id: wf.id,
    version: wf.version,
    title: wf.name,
    ...(wf.category ? { category: wf.category } : {}),
    triggers: wf.triggers.map((t) => t.type),
    inputs: wf.inputs.map((f) => `${f.name}:${f.type}${f.required ? "!" : ""}`),
    outputs: wf.outputs.map((f) => `${f.name}:${f.type}`),
    nodes: wf.nodes.filter((n) => n.type !== "note").map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.skip_when ? { skipWhen: typeof n.skip_when === "string" ? n.skip_when : JSON.stringify(n.skip_when) } : {}),
      ...(n.type === "lp-task" ? { ownsPaths: n.owns_paths } : {}),
      ...(n.type === "human" ? { options: n.options } : {}),
      ...(n.type === "subworkflow" ? { workflow: n.workflow } : {}),
    })),
    ...(leanViolations?.length ? { leanViolations } : {}),
  };
}
