import type { GEdge, GNode, Graph, GraphKind, Vec } from "./types";

export class GraphBuilder {
  readonly graph: Graph = { nodes: [], edges: [] };
  private readonly byKey = new Map<string, number>();

  node(x: number, z: number): number {
    const key = `${x},${z}`;
    const found = this.byKey.get(key);
    if (found !== undefined) return found;
    const id = this.graph.nodes.length;
    this.graph.nodes.push({ id, x, z });
    this.byKey.set(key, id);
    return id;
  }

  edge(a: number, b: number, kind: GraphKind): void {
    if (a === b) return;
    const na = this.graph.nodes[a]!, nb = this.graph.nodes[b]!;
    this.graph.edges.push({ a, b, len: Math.hypot(na.x - nb.x, na.z - nb.z), kind });
  }
}

type Adjacency = Array<Array<{ to: number; len: number }>>;
const adjacencyCache = new WeakMap<Graph, Adjacency>();
const pathCache = new WeakMap<Graph, Map<number, number[] | null>>();

export function adjacency(graph: Graph): Adjacency {
  let adj = adjacencyCache.get(graph);
  if (adj) return adj;
  adj = graph.nodes.map(() => []);
  for (const e of graph.edges) { adj[e.a]!.push({ to: e.b, len: e.len }); adj[e.b]!.push({ to: e.a, len: e.len }); }
  adjacencyCache.set(graph, adj);
  return adj;
}

export function hasEdge(graph: Graph, a: number, b: number): boolean {
  return adjacency(graph)[a]!.some((n) => n.to === b);
}

/** Shortest node path (inclusive), or null when the nodes are not connected. Results are cached per graph. */
export function shortestPath(graph: Graph, from: number, to: number): number[] | null {
  if (from === to) return [from];
  let cache = pathCache.get(graph);
  if (!cache) { cache = new Map(); pathCache.set(graph, cache); }
  const key = from * graph.nodes.length + to;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const adj = adjacency(graph);
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap: Array<[number, number]> = [[0, from]];
  dist[from] = 0;
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]!) continue;
    if (u === to) break;
    for (const { to: v, len } of adj[u]!) {
      const nd = d + len;
      if (nd < dist[v]!) { dist[v] = nd; prev[v] = u; push([nd, v]); }
    }
  }
  let result: number[] | null = null;
  if (prev[to] !== -1) {
    result = [];
    for (let at = to; at !== -1; at = prev[at]!) result.push(at);
    result.reverse();
  }
  cache.set(key, result);
  return result;
}

export const nodePoint = (graph: Graph, id: number): Vec => ({ x: graph.nodes[id]!.x, z: graph.nodes[id]!.z });

export function pathToPoints(graph: Graph, nodes: number[]): Vec[] {
  return nodes.map((id) => nodePoint(graph, id));
}

export function pathLength(path: readonly Vec[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
  return len;
}

export function nodeDistance(graph: Graph, a: number, b: number): number {
  const na: GNode = graph.nodes[a]!, nb: GNode = graph.nodes[b]!;
  return Math.hypot(na.x - nb.x, na.z - nb.z);
}

export type { GEdge };
