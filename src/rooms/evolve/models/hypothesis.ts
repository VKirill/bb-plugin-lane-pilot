import type { ArmKind, HypothesisSource, NodeCensusEntry } from "@lane-pilot/contracts";
import {
  CLAUDE_PROFILE_ROLES,
  ROLE_MODEL_OPTIONS,
  findModel,
  findProvider,
  modelFamily,
  offeredForRole,
  priceFor,
  resolveRoleModel,
  roleRowOf,
  type ModelCatalog,
  type RoleModelOption,
} from "@lane-pilot/models";
import {
  isJudgeRole,
  parseExpr,
  type Field,
  type GraphNode,
  type ReplayCase,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { RoadRow } from "../../contracts";

export type Hypothesis = {
  workflowId: string;
  nodeId: string;
  armKind: ArmKind;
  variant: Record<string, unknown>;
  source: HypothesisSource;
  graphVersion: number;
};

export type QueuedHypothesis = Hypothesis & { id: string };

export type RunVerdictLike = {
  runId: string;
  workflowId: string;
  graphVersion: number;
  verdict: string;
  source: string;
  reason: string | null;
  note: string | null;
  decidedAt: number;
};

const JUDGE_NAME_RE = /(?:^|[-_:])(judge|critic|verifier|auditor)(?:[-_:]|$)/i;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isJudgeLikeRole = (role: string): boolean =>
  isJudgeRole(role) || JUDGE_NAME_RE.test(role);

export function hasMechanicalVerify(node: Extract<GraphNode, { type: "agent" }>): boolean {
  const v = node.verify;
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (!isRecord(v)) return false;
  return (
    "field" in v || "all" in v || "any" in v || "not" in v ||
    v.expr !== undefined || v.cmd !== undefined || v.command !== undefined || v.requiredFields !== undefined
  );
}

export const stepCostMicroUsd = (entry: NodeCensusEntry): number =>
  entry.steps > 0 ? entry.measuredCostMicroUsd / entry.steps : 0;

function isOptionOffered(catalog: ModelCatalog | null, opt: RoleModelOption, hostId: string | null): boolean | null {
  if (!catalog || catalog.providers.length === 0) return null;
  if (hostId) {
    const res = offeredForRole(catalog, opt.providerId, opt.id, hostId);
    if (res === false) return false;
    if (res === true) return true;
  }
  const provider = findProvider(catalog, opt.providerId);
  const model = findModel(provider, opt.id);
  if (provider && model) return model.hostIds.length > 0;
  return null;
}

/**
 * Picks the next cheaper model on the node's family ladder from `ROLE_MODEL_OPTIONS`
 * (ordered by `MODEL_PRICES` output price), then the cheapest model of another family offered on the host.
 */
export function pickCheaperModelVariant(input: {
  node: Extract<GraphNode, { type: "agent" }>;
  settings: Record<string, unknown>;
  catalog: ModelCatalog | null;
  hostId: string | null;
  isAllowed: (variant: Record<string, unknown>) => boolean;
}): Record<string, unknown> | null {
  const { node, settings, catalog, hostId, isAllowed } = input;
  const currentModel = node.model && !node.model.includes("{{")
    ? node.model
    : resolveRoleModel(node.role, settings).model;
  const currentFamily = modelFamily(currentModel);
  const currentPrice = priceFor(currentModel)?.output ?? null;
  const toVariant = (opt: RoleModelOption): Record<string, unknown> => ({
    provider: opt.providerId,
    model: opt.id,
    ...(opt.defaultEffort ? { reasoning: opt.defaultEffort } : {}),
  });

  const sameFamily = ROLE_MODEL_OPTIONS
    .filter((opt) => opt.family === currentFamily && priceFor(opt.id) !== null)
    .sort((a, b) => priceFor(b.id)!.output - priceFor(a.id)!.output)
    .filter((opt) => (currentPrice === null ? opt.id !== currentModel : priceFor(opt.id)!.output < currentPrice))
    .filter((opt) => isOptionOffered(catalog, opt, hostId) !== false);

  const profileOnly = CLAUDE_PROFILE_ROLES.has(roleRowOf(node.role));
  const otherFamily = profileOnly
    ? []
    : ROLE_MODEL_OPTIONS
        .filter((opt) => opt.family !== currentFamily && isOptionOffered(catalog, opt, hostId) !== false)
        .filter((opt) => {
          const p = priceFor(opt.id)?.output ?? null;
          if (currentPrice !== null) return p !== null ? p < currentPrice : isOptionOffered(catalog, opt, hostId) === true;
          return p !== null;
        })
        .sort((a, b) => {
          const aOff = isOptionOffered(catalog, a, hostId) === true ? 0 : 1;
          const bOff = isOptionOffered(catalog, b, hostId) === true ? 0 : 1;
          if (aOff !== bOff) return aOff - bOff;
          return (priceFor(a.id)?.output ?? 0) - (priceFor(b.id)?.output ?? 0);
        });

  for (const opt of [...sameFamily, ...otherFamily]) {
    const variant = toVariant(opt);
    if (isAllowed(variant)) return variant;
  }
  return null;
}

function validExpr(expr: string): boolean {
  try {
    parseExpr(expr, { itemScope: false });
    return expr.trim().length > 0;
  } catch {
    return false;
  }
}

function predicateForField(workflow: Workflow, node: GraphNode, field: Field): string {
  const matchingInput = workflow.inputs.find(
    (inp) => inp.name === field.name || field.name.endsWith(`_${inp.name}`),
  );
  if (matchingInput) {
    if (matchingInput.type === "string" && !matchingInput.required) {
      return `$inputs.${matchingInput.name} == '' || ${node.id}.${field.name} == $inputs.${matchingInput.name}`;
    }
    return `${node.id}.${field.name} == $inputs.${matchingInput.name}`;
  }
  switch (field.type) {
    case "boolean": return `${node.id}.${field.name} == true`;
    case "number": return `${node.id}.${field.name} > 0`;
    case "array": return `${node.id}.${field.name}.length > 0`;
    default: return `${node.id}.${field.name} != ''`;
  }
}

function nodeHasPredicate(node: GraphNode, predicate: string): boolean {
  if ((node.gates ?? []).includes(predicate)) return true;
  if (node.type !== "agent" || node.verify === undefined) return false;
  if (typeof node.verify === "string") return node.verify.trim() === predicate;
  if (isRecord(node.verify)) {
    const expr = (node.verify as Record<string, unknown>).expr;
    if (typeof expr === "string") return expr.trim() === predicate;
    if (Array.isArray(expr)) return expr.some((item) => typeof item === "string" && item.trim() === predicate);
  }
  return false;
}

function checkVariantForNode(node: GraphNode, predicate: string): Record<string, unknown> | null {
  if (nodeHasPredicate(node, predicate)) return null;
  if (node.type === "agent") {
    if (node.verify === undefined) return { verify: predicate };
    if (typeof node.verify === "string") return { verify: { expr: [node.verify, predicate] } };
    if (isRecord(node.verify) && !("field" in node.verify || "all" in node.verify || "any" in node.verify || "not" in node.verify)) {
      const rec = node.verify as Record<string, unknown>;
      const existing = rec.expr === undefined
        ? []
        : Array.isArray(rec.expr)
          ? [...rec.expr]
          : [rec.expr];
      return { verify: { ...rec, expr: [...existing, predicate] } };
    }
  }
  return { gates: [...(node.gates ?? []), predicate] };
}

/** Extracts a structural `verify` / `gates` check arm from a `lead_road` branch row targeting `workflow.id`. */
export function extractCheckFromRoad(
  workflow: Workflow,
  nodeById: ReadonlyMap<string, GraphNode>,
  row: RoadRow,
): { nodeId: string; variant: Record<string, unknown> } | null {
  let payload: Record<string, unknown> | null = null;
  if (row.payload_json) {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (isRecord(parsed)) payload = parsed;
    } catch {
      payload = null;
    }
  }
  if (!payload || payload.graphId !== workflow.id) return null;

  const explicitNodeId = typeof payload.nodeId === "string" ? payload.nodeId.trim() : "";
  const candidateNodes = explicitNodeId && nodeById.has(explicitNodeId)
    ? [nodeById.get(explicitNodeId)!]
    : [...nodeById.values()].filter((n) => !(n.type === "action" && n.action === "emit"));

  if (payload.verify !== undefined) {
    const target = candidateNodes.find((n) => n.type === "agent");
    if (target) {
      if (typeof payload.verify === "string" && validExpr(payload.verify)) {
        const variant = checkVariantForNode(target, payload.verify);
        if (variant) return { nodeId: target.id, variant };
      } else if (isRecord(payload.verify)) {
        return { nodeId: target.id, variant: { verify: payload.verify } };
      }
    }
  }

  if (payload.gates !== undefined) {
    const gatesList = Array.isArray(payload.gates)
      ? payload.gates.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      : typeof payload.gates === "string" && payload.gates.trim()
        ? [payload.gates.trim()]
        : [];
    const target = candidateNodes[0];
    if (target && gatesList.length > 0 && gatesList.every((g) => validExpr(g))) {
      const merged = [...new Set([...(target.gates ?? []), ...gatesList])];
      if (merged.length > (target.gates ?? []).length) return { nodeId: target.id, variant: { gates: merged } };
    }
  }

  const exprText = typeof payload.expr === "string" ? payload.expr.trim() : "";
  if (exprText && validExpr(exprText)) {
    const target = candidateNodes.find((n) => exprText.includes(`${n.id}.`)) ?? candidateNodes[0];
    if (target) {
      const variant = checkVariantForNode(target, exprText);
      if (variant) return { nodeId: target.id, variant };
    }
  }

  const fieldHint = typeof payload.field === "string"
    ? payload.field.trim()
    : typeof payload.failingField === "string"
      ? payload.failingField.trim()
      : "";
  const searchText = `${row.title} ${row.why} ${typeof payload.maskedSummary === "string" ? payload.maskedSummary : ""}`;
  for (const node of candidateNodes) {
    const match = fieldHint
      ? node.out.find((f) => f.name === fieldHint)
      : node.out.find((f) => new RegExp(`\\b${f.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(searchText));
    if (!match) continue;
    const predicate = predicateForField(workflow, node, match);
    if (!validExpr(predicate)) continue;
    const variant = checkVariantForNode(node, predicate);
    if (variant) return { nodeId: node.id, variant };
  }
  return null;
}

/** Derives a structural `verify` / `gates` check arm from an owner `wrong_result` verdict when a failing field is checkable. */
export function findCheckFromRejectedVerdict(
  workflow: Workflow,
  nodeById: ReadonlyMap<string, GraphNode>,
  verdict: RunVerdictLike,
  replayCase: ReplayCase | undefined,
): { nodeId: string; variant: Record<string, unknown> } | null {
  const note = verdict.note ?? "";
  const nodes = [...nodeById.values()].filter((n) => !(n.type === "action" && n.action === "emit") && n.type !== "human");
  for (const node of nodes) {
    const recordedOut = replayCase && isRecord(replayCase.recorded[node.id])
      ? (replayCase.recorded[node.id] as Record<string, unknown>)
      : null;
    for (const field of node.out) {
      const mentioned = note.length > 0 && new RegExp(`\\b${field.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(note);
      let broken = mentioned;
      if (!broken && recordedOut) {
        const val = recordedOut[field.name];
        const matchingInput = workflow.inputs.find(
          (inp) => inp.name === field.name || field.name.endsWith(`_${inp.name}`),
        );
        if (matchingInput && replayCase) {
          const inpVal = replayCase.inputs[matchingInput.name];
          if (inpVal !== undefined && inpVal !== null && inpVal !== "" && val !== inpVal) broken = true;
        }
        if (!broken && field.required && (val === undefined || val === null || val === "")) broken = true;
      }
      if (!broken) continue;
      const predicate = predicateForField(workflow, node, field);
      if (!validExpr(predicate)) continue;
      const variant = checkVariantForNode(node, predicate);
      if (variant) return { nodeId: node.id, variant };
    }
  }
  return null;
}
