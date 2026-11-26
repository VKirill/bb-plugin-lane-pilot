import { ownsPathsOverlap } from "@lane-pilot/kit";

/**
 * The dependency graph of a plan (owner's rule, ТЗ sma-parity 4д; SMA bf_waves, p2_waves, p4_deps): a dependency is the explicit
 * `depends_on` field, never the order of the plan text; the waves are laid out from those links by code, not written by a planner;
 * a cycle is a plan error before anything is issued; and what may start now depends only on a task's own dependencies, so a failed
 * task holds its dependents and nobody else. Pure: no database, no clock.
 */
export type DepNode = { id: string; depends_on?: readonly string[] | null; owns_paths?: readonly string[] | null };

export type PlanGraph = {
  /** Layered waves: a task's wave is 1 + the highest wave of its dependencies; tasks keep the plan's order inside a wave. */
  waves: string[][];
  /** Each task's wave from 1. A task on a cycle, or one that depends on such a task, has none: its wave cannot be computed. */
  waveOf: Record<string, number>;
  /** The first cycle found, closed: `[a, b, c, a]` reads «a depends on b, b on c, c on a»; null when there is none. */
  cycle: string[] | null;
  /** `[task, dep]` for every dependency that names no task of the plan (the caller decides whether that is an outside task or an error). */
  unknown: Array<[string, string]>;
  /** `[a, b]` for two tasks of one computed wave whose owns_paths overlap: they could not run beside each other. */
  sameWaveOverlap: Array<[string, string]>;
};

const depsOf = (node: DepNode): string[] => [...new Set((node.depends_on ?? []).filter((dep): dep is string => typeof dep === "string" && dep.length > 0))];

/** The first cycle among the nodes, walked from each node in order; `names(dep, id)` says whether a depends_on entry names a node. */
export function findCycle(nodes: readonly DepNode[], names: (dep: string, id: string) => boolean = (dep, id) => dep === id): string[] | null {
  const edges = new Map(nodes.map((node) => [node.id, nodes.filter((other) => depsOf(node).some((dep) => names(dep, other.id))).map((other) => other.id)]));
  const state = new Map<string, "open" | "done">();
  const trail: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "open") return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, "open");
    trail.push(id);
    for (const next of edges.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    trail.pop();
    state.set(id, "done");
    return null;
  };
  for (const node of nodes) {
    const found = visit(node.id);
    if (found) return found;
  }
  return null;
}

/** Waves, cycle, unknown dependencies and same-wave owns_paths overlaps of a plan. Duplicate ids keep their first node. */
export function planGraph(nodes: readonly DepNode[], overlap: (a: readonly string[], b: readonly string[]) => boolean = (a, b) => ownsPathsOverlap([...a], [...b])): PlanGraph {
  const unique = nodes.filter((node, at) => nodes.findIndex((other) => other.id === node.id) === at);
  const ids = new Set(unique.map((node) => node.id));
  const unknown: Array<[string, string]> = [];
  for (const node of unique) for (const dep of depsOf(node)) if (!ids.has(dep) && dep !== node.id) unknown.push([node.id, dep]);
  const inPlan = (node: DepNode) => depsOf(node).filter((dep) => ids.has(dep));
  const waveOf: Record<string, number> = {};
  // Kahn by layers: a task joins the first layer in which all its dependencies of the plan already have a wave.
  for (let layer = 1, placed = true; placed; layer++) {
    placed = false;
    const ready = unique.filter((node) => waveOf[node.id] === undefined && inPlan(node).every((dep) => waveOf[dep] !== undefined && waveOf[dep]! < layer));
    for (const node of ready) { waveOf[node.id] = layer; placed = true; }
  }
  const count = Math.max(0, ...Object.values(waveOf));
  const waves = Array.from({ length: count }, (_unused, at) => unique.filter((node) => waveOf[node.id] === at + 1).map((node) => node.id));
  const sameWaveOverlap: Array<[string, string]> = [];
  for (const wave of waves) {
    const members = wave.map((id) => unique.find((node) => node.id === id)!);
    for (const [i, a] of members.entries()) for (const b of members.slice(i + 1)) {
      if ((a.owns_paths?.length ?? 0) && (b.owns_paths?.length ?? 0) && overlap(a.owns_paths!, b.owns_paths!)) sameWaveOverlap.push([a.id, b.id]);
    }
  }
  return { waves, waveOf, cycle: findCycle(unique), unknown, sameWaveOverlap };
}

/** A cycle as one line: «a → b → a». */
export const cycleText = (cycle: readonly string[]) => cycle.join(" → ");

export type ReadyState = {
  /** Tasks whose work is accepted (merged). */
  accepted: ReadonlySet<string>;
  /** Tasks that ended without their work (blocked, failed, canceled) and are not redone yet. */
  failed?: ReadonlySet<string>;
  /** Tasks already started or issued: they are not offered again. */
  started?: ReadonlySet<string>;
};

export type Readiness = {
  /** May start now: every dependency of the plan is accepted. In plan order. */
  ready: string[];
  /** Wait for dependencies still at work or not started. */
  waiting: Array<{ id: string; on: string[] }>;
  /** Wait because a dependency (directly or further up) failed: they start once it is redone and accepted. */
  heldByFailure: Array<{ id: string; failed: string[] }>;
};

/**
 * What may start now (SMA p4_deps; owner's rule 5): a task starts when its own dependencies are accepted. A failed task holds the
 * tasks that depend on it, directly or through others, and nothing else: an independent task is ready whatever failed beside it.
 * A dependency outside the plan is not this graph's to judge and does not hold the task here (the writer's wait reads it).
 */
export function readyNow(nodes: readonly DepNode[], state: ReadyState): Readiness {
  const ids = new Set(nodes.map((node) => node.id));
  const failed = state.failed ?? new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const failedAbove = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    return [...new Set(depsOf(byId.get(id) ?? { id }).filter((dep) => ids.has(dep) && !state.accepted.has(dep))
      .flatMap((dep) => (failed.has(dep) ? [dep] : failedAbove(dep, seen))))];
  };
  const out: Readiness = { ready: [], waiting: [], heldByFailure: [] };
  for (const node of nodes) {
    if (state.accepted.has(node.id) || failed.has(node.id) || state.started?.has(node.id)) continue;
    const open = depsOf(node).filter((dep) => ids.has(dep) && !state.accepted.has(dep));
    if (!open.length) { out.ready.push(node.id); continue; }
    const broken = failedAbove(node.id);
    if (broken.length) out.heldByFailure.push({ id: node.id, failed: broken });
    else out.waiting.push({ id: node.id, on: open });
  }
  return out;
}
