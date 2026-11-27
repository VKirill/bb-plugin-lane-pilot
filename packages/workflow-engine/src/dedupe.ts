import { sha256Hex } from "@lane-pilot/kit";
import type { RawDefinition } from "./draft";
import { normalizeText } from "./router";
import type { Workflow } from "./schema";

export const DEFAULT_DEDUPE_THRESHOLD = 0.8;

/** Deterministic candidate key for repeated deviations on a workflow graph, shared by discovery and branch capture. */
export function branchCandidateKey(input: {
  graphId: string;
  interventionKind: string;
  maskedSummary: string;
  stageArchetype: string;
}): string {
  const normDetail = normalizeText(input.maskedSummary) || input.stageArchetype;
  return `branch:${sha256Hex(`${input.graphId.trim()}|${input.interventionKind}|${normDetail}`).slice(0, 24)}`;
}

const DEDUPE_NODE_TYPES = new Set([
  "agent",
  "lp-task",
  "action",
  "decision",
  "human",
  "parallel",
  "join",
  "subworkflow",
]);

const STATUS_PRIORITY: Record<string, number> = {
  published: 3,
  tested: 2,
  draft: 1,
};

export type DedupeCandidate = {
  id: string;
  sig: ReadonlySet<string>;
  status: string;
};

export type DedupeMatch = {
  id: string;
  score: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function nodeIdentity(node: Record<string, unknown>): string | null {
  const type = str(node.type);
  if (!type || type === "note") return null;
  let identity = "-";
  if (type === "subworkflow") {
    identity = str(node.workflow) || str(node.uses) || "-";
  } else if (type === "agent" || type === "human") {
    identity = str(node.role) || str(node.uses) || "-";
  } else if (type === "action") {
    const uses = str(node.uses);
    const action = str(node.action);
    identity = action === "emit" && (!uses || uses === "builtin:emit") ? "emit" : uses || action || "-";
  } else if (type === "decision") {
    identity = str(node.uses) || (str(node.reads_node) || str(node.reads) ? "builtin:decision" : "-");
  } else if (type === "lp-task") {
    identity = str(node.uses) || "lp-task";
  } else if (type === "parallel") {
    identity = str(node.uses) || "parallel";
  } else if (type === "join") {
    identity = str(node.uses) || "join";
  } else {
    identity = str(node.role) || str(node.uses) || str(node.workflow) || str(node.action) || "-";
  }
  const effect = str(node.effect) || "-";
  return `${type}:${identity}:${effect}`;
}

/** Structural signature of a workflow graph as `"<type>:<role|uses|subworkflow id>:<effect ?? '-'>"`. */
export function graphSignature(
  def: Workflow | RawDefinition | { nodes?: unknown } | null | undefined,
): Set<string> {
  const sig = new Set<string>();
  const nodes = isRecord(def) && Array.isArray(def.nodes) ? def.nodes : [];
  for (const raw of nodes) {
    if (!isRecord(raw)) continue;
    const identity = nodeIdentity(raw);
    if (identity) sig.add(identity);
    if (raw.type === "parallel" && isRecord(raw.child)) {
      const childIdentity = nodeIdentity(raw.child);
      if (childIdentity) sig.add(childIdentity);
    }
  }
  return sig;
}

const KNOWN_EFFECTS = new Set([
  "-",
  "read",
  "write",
  "pure",
  "external",
  "verify",
  "mutate",
  "side_effect",
  "none",
  "idempotent",
]);

/** Structural signature from an episode trace using the same node identity format. */
export function traceSignature(trace: readonly string[]): Set<string> {
  const sig = new Set<string>();
  for (const entry of trace) {
    const trimmed = typeof entry === "string" ? entry.trim() : "";
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    if (parts.length >= 2 && DEDUPE_NODE_TYPES.has(parts[0]!)) {
      const type = parts[0]!;
      const last = parts[parts.length - 1]!.trim();
      const hasEffect = parts.length >= 3 && KNOWN_EFFECTS.has(last);
      const id = (hasEffect ? parts.slice(1, -1) : parts.slice(1)).join(":").trim() || "-";
      const effect = hasEffect ? last || "-" : "-";
      sig.add(`${type}:${id}:${effect}`);
    } else {
      sig.add(`action:${trimmed}:-`);
    }
  }
  return sig;
}

/** Jaccard similarity between two structural signature sets (0 when both are empty). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of small) {
    if (large.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Returns the closest structural match with non-zero similarity, breaking ties by status then id. */
export function nearestByStructure(
  sig: ReadonlySet<string>,
  candidates: readonly DedupeCandidate[],
): DedupeMatch | null {
  if (sig.size === 0 || candidates.length === 0) return null;
  let best: { id: string; score: number; rank: number } | null = null;
  for (const candidate of candidates) {
    const score = jaccard(sig, candidate.sig);
    if (score <= 0) continue;
    const rank = STATUS_PRIORITY[candidate.status] ?? 0;
    if (
      !best ||
      score > best.score ||
      (score === best.score && (rank > best.rank || (rank === best.rank && candidate.id.localeCompare(best.id) < 0)))
    ) {
      best = { id: candidate.id, score, rank };
    }
  }
  return best ? { id: best.id, score: best.score } : null;
}
