import type { WorkflowView, ViewNode, ViewEdge } from "../workflow/view";

/**
 * Where the nodes of a workflow graph go. elkjs does the layering (it handles loops and nested graphs); this module feeds it
 * fixed-size cards and turns the answer into positions a canvas can use. A subworkflow node that is expanded becomes a group:
 * the called graph is laid out inside it first, and the group takes the size of its content. Notes are not laid out (see `build`).
 */
/** The slice of elk's graph format used here (elkjs's own typings do not pass strict library checks, see elk-shim.d.ts). */
type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNode[]; edges?: ElkExtendedEdge[]; layoutOptions?: Record<string, string> };
type ElkExtendedEdge = { id: string; sources: string[]; targets: string[] };

export const CARD = { width: 264, height: 140 } as const;
const TERMINAL = { width: 76, height: 34 } as const;
export const GROUP_PAD = { top: 40, side: 14, bottom: 14 } as const;

export type Direction = "RIGHT" | "DOWN";
/** Expanded subworkflow nodes by canvas key (`call`, or `call/inner` one level down): the graph each one calls. */
export type Expansions = ReadonlyMap<string, WorkflowView>;
export type Placed = {
  /** The id on the canvas: `a/b` for node `b` inside the expanded subworkflow node `a`. */
  key: string; node: ViewNode; x: number; y: number; width: number; height: number; parent: string | null;
  /** Set when this node is an expanded subworkflow node: the placed contents are in the list under it. */
  group: boolean;
};
export type PlacedEdge = { key: string; edge: ViewEdge; source: string; target: string };
export type Layout = { nodes: Placed[]; edges: PlacedEdge[]; width: number; height: number };

const sizeOf = (node: ViewNode) => (node.kind === "start" || node.kind === "end" ? TERMINAL : CARD);

/** Mirrors an edge list so that a node's id is the one the canvas uses. */
const keyOf = (prefix: string, id: string) => (prefix ? `${prefix}/${id}` : id);

type ElkPart = { placed: Map<string, Omit<Placed, "x" | "y" | "width" | "height">>; edges: Map<string, PlacedEdge> };

/** A graph level as an elk node: the cards, the groups (recursively) and the edges between them. Entry and exit nodes of an expanded graph are left out: the group's own ports stand for them. */
function build(graph: WorkflowView, expansions: Expansions | undefined, prefix: string, inner: boolean, into: ElkPart): { children: ElkNode[]; edges: ElkExtendedEdge[] } {
  const children: ElkNode[] = [];
  const edges: ElkExtendedEdge[] = [];
  const present = new Set<string>();
  for (const node of graph.nodes) {
    if (inner && (node.kind === "start" || node.kind === "end")) continue;
    // A note has no edges, so the layout would drop it far from what it explains; the canvas lists notes beside the graph instead.
    if (node.kind === "note") continue;
    const key = keyOf(prefix, node.id);
    present.add(node.id);
    const expansion = node.kind === "subworkflow" ? expansions?.get(key) : undefined;
    if (expansion) {
      const level = build(expansion, expansions, key, true, into);
      children.push({ id: key, children: level.children, edges: level.edges,
        layoutOptions: { "elk.padding": `[top=${GROUP_PAD.top},left=${GROUP_PAD.side},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.side}]` } });
      into.placed.set(key, { key, node, parent: prefix || null, group: true });
    } else {
      const { width, height } = sizeOf(node);
      children.push({ id: key, width, height });
      into.placed.set(key, { key, node, parent: prefix || null, group: false });
    }
  }
  for (const edge of graph.edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue;
    const key = `${keyOf(prefix, `e${edge.index}`)}`;
    const source = keyOf(prefix, edge.from), target = keyOf(prefix, edge.to);
    edges.push({ id: key, sources: [source], targets: [target] });
    into.edges.set(key, { key, edge, source, target });
  }
  return { children, edges };
}

const OPTIONS = (direction: Direction) => ({
  "elk.algorithm": "layered",
  "elk.direction": direction,
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": direction === "RIGHT" ? "230" : "96",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.cycleBreaking.strategy": "GREEDY",
  "elk.edgeRouting": "POLYLINE",
  "elk.padding": "[top=16,left=16,bottom=16,right=16]",
});

type ElkEngine = { layout(graph: ElkNode): Promise<ElkNode> };
let engine: Promise<ElkEngine> | null = null;
/** elkjs is the heavy part of the graph view (over a megabyte); it is read when a graph is first drawn, once. */
const elk = (): Promise<ElkEngine> => (engine ??= import("elkjs/lib/elk.bundled.js").then((module) => new module.default()));

export async function layoutGraph(graph: WorkflowView, expansions: Expansions | undefined, direction: Direction): Promise<Layout> {
  const part: ElkPart = { placed: new Map(), edges: new Map() };
  const level = build(graph, expansions, "", false, part);
  const laid = await (await elk()).layout({ id: "root", layoutOptions: OPTIONS(direction), children: level.children, edges: level.edges });
  const nodes: Placed[] = [];
  // Parents before children: the canvas needs a group in the list ahead of what it holds.
  const walk = (parent: ElkNode, parentKey: string | null) => {
    for (const child of parent.children ?? []) {
      const base = part.placed.get(child.id);
      if (!base) continue;
      nodes.push({ ...base, x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? CARD.width, height: child.height ?? CARD.height, parent: parentKey });
      if (child.children?.length) walk(child, child.id);
    }
  };
  walk(laid, null);
  return { nodes, edges: [...part.edges.values()], width: laid.width ?? 0, height: laid.height ?? 0 };
}
