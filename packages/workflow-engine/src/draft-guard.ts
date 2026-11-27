import { TIER_RANK, workKindOf, type ToolTier, type WorkKind } from "@lane-pilot/contracts";
import type { RawDefinition } from "./draft";
import { START, type Workflow } from "./schema";

export const LEARNED_DRAFT_SOURCES = [
  "path-capture",
  "branch",
  "branch-capture",
  "project-template",
  "evolve",
] as const;

export type LearnedDraftSource = (typeof LEARNED_DRAFT_SOURCES)[number];

const LEARNED_SOURCE_SET = new Set<string>(LEARNED_DRAFT_SOURCES);

export function isLearnedDraftSource(source: unknown): source is LearnedDraftSource {
  return typeof source === "string" && LEARNED_SOURCE_SET.has(source);
}

export type PermissionDiffEntry = {
  nodeId: string;
  field: string;
  from: unknown;
  to: unknown;
};

type RawObj = Record<string, unknown>;

const KIND_RANK: Readonly<Record<WorkKind, number>> = {
  routine: 0,
  project: 1,
  employee: 2,
};

const isRecord = (value: unknown): value is RawObj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNodes = (def: Workflow | RawDefinition | null): RawObj[] =>
  def && Array.isArray(def.nodes) ? (def.nodes as RawObj[]) : [];

const asEdges = (def: Workflow | RawDefinition | null): RawObj[] =>
  def && Array.isArray(def.edges) ? (def.edges as RawObj[]) : [];

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];

const tierRankOf = (value: unknown): number | undefined =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(TIER_RANK, value)
    ? TIER_RANK[value as ToolTier]
    : undefined;

function diffStringAdditions(
  nodeId: string,
  field: string,
  baseVal: unknown,
  nextVal: unknown,
  out: PermissionDiffEntry[],
): void {
  const baseList = stringList(baseVal);
  const nextList = stringList(nextVal);
  if (nextList.length === 0) return;
  const baseSet = new Set(baseList);
  const added = nextList.filter((item) => !baseSet.has(item));
  if (added.length > 0) {
    out.push({ nodeId, field, from: baseList, to: nextList });
  }
}

function diffVerify(
  nodeId: string,
  baseVerify: unknown,
  nextVerify: unknown,
  out: PermissionDiffEntry[],
): void {
  if (baseVerify === undefined || baseVerify === null) return;
  if (nextVerify === undefined || nextVerify === null) {
    out.push({ nodeId, field: "verify", from: baseVerify, to: null });
    return;
  }
  const baseIsObj = isRecord(baseVerify);
  const nextIsObj = isRecord(nextVerify);
  if (baseIsObj && !nextIsObj) {
    // Replacing an object verify (which can hold command/requiredFields) with a plain string weakens/drops structure.
    if (baseVerify.command !== undefined || baseVerify.cmd !== undefined) {
      out.push({ nodeId, field: "verify.command", from: baseVerify.command ?? baseVerify.cmd, to: null });
    } else {
      out.push({ nodeId, field: "verify", from: baseVerify, to: nextVerify });
    }
    return;
  }
  if (!baseIsObj || !nextIsObj) return;

  const baseCmd = typeof baseVerify.command === "string" ? baseVerify.command : typeof baseVerify.cmd === "string" ? baseVerify.cmd : null;
  const nextCmd = typeof nextVerify.command === "string" ? nextVerify.command : typeof nextVerify.cmd === "string" ? nextVerify.cmd : null;
  if (baseCmd !== null && nextCmd === null) {
    out.push({ nodeId, field: "verify.command", from: baseCmd, to: null });
  }

  const baseRequired = stringList(baseVerify.requiredFields);
  if (baseRequired.length > 0) {
    const nextRequired = stringList(nextVerify.requiredFields);
    const nextSet = new Set(nextRequired);
    if (baseRequired.some((f) => !nextSet.has(f))) {
      out.push({ nodeId, field: "verify.requiredFields", from: baseRequired, to: nextRequired });
    }
  }

  const baseExprs = typeof baseVerify.expr === "string" ? [baseVerify.expr] : stringList(baseVerify.expr);
  if (baseExprs.length > 0) {
    const nextExprs = typeof nextVerify.expr === "string" ? [nextVerify.expr] : stringList(nextVerify.expr);
    const nextSet = new Set(nextExprs);
    if (baseExprs.some((e) => !nextSet.has(e))) {
      out.push({ nodeId, field: "verify.expr", from: baseVerify.expr, to: nextVerify.expr ?? null });
    }
  }
}

function diffNode(
  nodeId: string,
  baseNode: RawObj | undefined,
  nextNode: RawObj,
  out: PermissionDiffEntry[],
): void {
  const baseEffect = baseNode?.effect;
  const nextEffect = nextNode.effect;
  const baseRank = tierRankOf(baseEffect);
  const nextRank = tierRankOf(nextEffect);
  if (nextRank !== undefined) {
    const effectiveBaseRank = baseRank ?? TIER_RANK.R;
    if (nextRank > effectiveBaseRank) {
      out.push({ nodeId, field: "effect", from: baseEffect ?? null, to: nextEffect });
    }
  } else if (baseRank !== undefined && nextEffect === undefined) {
    out.push({ nodeId, field: "effect", from: baseEffect, to: null });
  }

  const baseAuthorized = baseNode?.authorized === true;
  const nextAuthorized = nextNode.authorized === true;
  if (!baseAuthorized && nextAuthorized) {
    out.push({ nodeId, field: "authorized", from: baseNode?.authorized ?? false, to: true });
  }

  diffStringAdditions(nodeId, "tools", baseNode?.tools, nextNode.tools, out);
  diffStringAdditions(nodeId, "allowedTools", baseNode?.allowedTools, nextNode.allowedTools, out);
  diffStringAdditions(nodeId, "plugins", baseNode?.plugins, nextNode.plugins, out);
  diffStringAdditions(nodeId, "mcp", baseNode?.mcp, nextNode.mcp, out);

  if (baseNode) {
    diffVerify(nodeId, baseNode.verify, nextNode.verify, out);
  }
}

function normalizeEndpoint(raw: unknown, entryNodeId?: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw === "start" || raw === "$start") return START;
  return raw;
}

function hasUngatedPathTo(def: Workflow | RawDefinition, targetId: string): boolean {
  const nodes = new Map<string, RawObj>();
  for (const n of asNodes(def)) {
    if (typeof n.id === "string" && n.type !== "note") nodes.set(n.id, n);
  }
  const outgoing = new Map<string, string[]>();
  const startTargets: string[] = [];
  for (const edge of asEdges(def)) {
    const from = normalizeEndpoint(edge.from);
    const to = normalizeEndpoint(edge.to);
    if (!from || !to) continue;
    if (from === START) startTargets.push(to);
    else {
      const list = outgoing.get(from) ?? [];
      list.push(to);
      outgoing.set(from, list);
    }
  }
  if (startTargets.length === 0 && typeof def.entry === "string") {
    startTargets.push(def.entry);
  }
  const isHumanGate = (id: string) => nodes.get(id)?.type === "human";
  const seen = new Set<string>();
  const queue = [...startTargets];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === targetId) return true;
    if (seen.has(cur) || isHumanGate(cur)) continue;
    seen.add(cur);
    for (const nxt of outgoing.get(cur) ?? []) {
      if (!seen.has(nxt)) queue.push(nxt);
    }
  }
  return false;
}

function ancestorsOf(def: Workflow | RawDefinition, targetId: string): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const edge of asEdges(def)) {
    const from = normalizeEndpoint(edge.from);
    const to = normalizeEndpoint(edge.to);
    if (!from || !to || from === START) continue;
    const list = reverse.get(to) ?? [];
    list.push(from);
    reverse.set(to, list);
  }
  const seen = new Set<string>();
  const queue = [targetId];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const prev of reverse.get(cur) ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev);
        queue.push(prev);
      }
    }
  }
  return seen;
}

function checkHumanGateRemoval(
  base: Workflow | RawDefinition,
  next: Workflow | RawDefinition,
  baseById: ReadonlyMap<string, RawObj>,
  nextById: ReadonlyMap<string, RawObj>,
  out: PermissionDiffEntry[],
): void {
  const baseEdgesPresent = asEdges(base).length > 0;
  const baseHumanIds = [...baseById.values()]
    .filter((n) => n.type === "human" && typeof n.id === "string")
    .map((n) => String(n.id));
  if (baseHumanIds.length === 0) return;

  const edges = asEdges(base);
  const directHumanDownstream = new Map<string, Set<string>>();
  for (const e of edges) {
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (baseHumanIds.includes(e.to)) {
      let set = directHumanDownstream.get(e.from);
      if (!set) directHumanDownstream.set(e.from, (set = new Set()));
      set.add(e.to);
    }
  }

  for (const [nodeId, nextNode] of nextById.entries()) {
    const effect = nextNode.effect;
    if (effect !== "L" && effect !== "S") continue;
    if (!baseById.has(nodeId)) continue;

    if (baseEdgesPresent) {
      const upstream = ancestorsOf(base, nodeId);
      const connectedHumans = new Set<string>(baseHumanIds.filter((hid) => upstream.has(hid)));
      for (const hid of directHumanDownstream.get(nodeId) ?? []) connectedHumans.add(hid);
      if (connectedHumans.size === 0) continue;
      const removed = [...connectedHumans].filter((hid) => !nextById.has(hid));
      for (const hid of removed) {
        out.push({ nodeId, field: "human", from: hid, to: null });
      }
      const hadUpstreamHuman = baseHumanIds.some((hid) => upstream.has(hid));
      if (removed.length === 0 && hadUpstreamHuman && !hasUngatedPathTo(base, nodeId) && hasUngatedPathTo(next, nodeId)) {
        const firstUpstream = baseHumanIds.find((hid) => upstream.has(hid))!;
        out.push({ nodeId, field: "human", from: firstUpstream, to: null });
      }
    } else {
      for (const hid of baseHumanIds) {
        if (!nextById.has(hid)) {
          out.push({ nodeId, field: "human", from: hid, to: null });
        }
      }
    }
  }
}

/**
 * Compares `base` against `next` and returns every permission-widening change:
 * elevated `effect` rank, `authorized: true`, `tools`/`allowedTools`/`plugins`/`mcp` additions,
 * `requires` additions, `verify` removal/weakening, `human` gate removal on `L`/`S` steps,
 * and graph-level `kind` elevation.
 */
export function permissionDiff(
  base: Workflow | RawDefinition | null,
  next: Workflow | RawDefinition,
): PermissionDiffEntry[] {
  const out: PermissionDiffEntry[] = [];
  const baseNodes = asNodes(base);
  const nextNodes = asNodes(next);

  const baseById = new Map<string, RawObj>();
  for (const node of baseNodes) {
    if (typeof node.id === "string" && node.id && node.type !== "note") {
      baseById.set(node.id, node);
    }
  }
  const nextById = new Map<string, RawObj>();
  for (const node of nextNodes) {
    if (typeof node.id === "string" && node.id && node.type !== "note") {
      nextById.set(node.id, node);
    }
  }

  for (const [nodeId, nextNode] of nextById.entries()) {
    const baseNode = baseById.get(nodeId);
    diffNode(nodeId, baseNode, nextNode, out);
    if (nextNode.type === "parallel" && isRecord(nextNode.child)) {
      const baseChild = baseNode && baseNode.type === "parallel" && isRecord(baseNode.child) ? baseNode.child : undefined;
      diffNode(`${nodeId}.child`, baseChild, nextNode.child, out);
    }
  }

  if (base !== null) {
    checkHumanGateRemoval(base, next, baseById, nextById, out);
  }

  const baseReq = base && isRecord(base.requires) ? base.requires : {};
  const nextReq = isRecord(next.requires) ? next.requires : {};
  diffStringAdditions("$workflow", "requires.plugins", baseReq.plugins, nextReq.plugins, out);
  diffStringAdditions("$workflow", "requires.secrets", baseReq.secrets, nextReq.secrets, out);
  diffStringAdditions("$workflow", "requires.tools", baseReq.tools, nextReq.tools, out);
  diffStringAdditions("$workflow", "requires.mcp", baseReq.mcp, nextReq.mcp, out);
  if (baseReq.browserSession !== true && nextReq.browserSession === true) {
    out.push({ nodeId: "$workflow", field: "requires.browserSession", from: false, to: true });
  }

  const nextKindRaw = typeof next.kind === "string" ? next.kind : undefined;
  const nextKind = workKindOf(nextKindRaw as WorkKind | undefined);
  if (base !== null) {
    const baseKindRaw = typeof base.kind === "string" ? base.kind : undefined;
    const baseKind = workKindOf(baseKindRaw as WorkKind | undefined);
    if (KIND_RANK[nextKind] > KIND_RANK[baseKind]) {
      out.push({ nodeId: "$workflow", field: "kind", from: baseKindRaw ?? "routine", to: nextKindRaw ?? nextKind });
    }
  } else if (nextKind === "employee") {
    out.push({ nodeId: "$workflow", field: "kind", from: null, to: "employee" });
  }

  return out;
}

/** Formats permission-widening diff entries into a concise single-line summary for owner desk items and logs. */
export function formatPermissionDiffSummary(diffs: readonly PermissionDiffEntry[], maxChars = 1500): string {
  const text = diffs
    .map((entry) => `${entry.nodeId}.${entry.field}: ${JSON.stringify(entry.from)} -> ${JSON.stringify(entry.to)}`)
    .join("; ");
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}
