import type { WorkflowView, ViewNode, ViewEdge } from "../view";

/**
 * Where the nodes of a workflow graph go. elkjs does the layering (it handles loops and nested graphs); this module feeds it
 * fixed-size cards and turns the answer into positions a canvas can use. A subworkflow node that is expanded becomes a group:
 * the called graph is laid out inside it first, and the group takes the size of its content. Notes are not laid out (see `build`).
 */
/** The slice of elk's graph format used here (elkjs's own typings do not pass strict library checks, see elk-shim.d.ts). */
type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNode[]; edges?: ElkExtendedEdge[]; layoutOptions?: Record<string, string> };
type ElkExtendedEdge = { id: string; sources: string[]; targets: string[] };

/** A card is as tall as its title, its subtitle and the model line need; a decision with named outputs grows by a row per output. */
export const CARD = { width: 252, height: 76 } as const;
const TERMINAL = { width: 84, height: 36 } as const;
/** The room one named output of a decision takes, and the card's top and bottom margin around them. */
export const PORT_STEP = 26;
const PORT_MARGIN = 18;
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
/** `x` and `y` are where the drawn graph starts (a node the owner dragged left of the origin moves them below zero). */
export type Layout = { nodes: Placed[]; edges: PlacedEdge[]; width: number; height: number; x: number; y: number; arranged: boolean };

/**
 * A step with more than one way out and a condition on one of them has its outputs named on the card (a decision always has): the way out is chosen
 * at the card, like an n8n IF or Switch, and the connections carry no condition of their own. A fan-out runs all its edges, so it has none to name.
 */
export const isBranching = (kind: ViewNode["kind"], out: readonly ViewEdge[]): boolean =>
  out.length > 1 && kind !== "parallel" && kind !== "start" && kind !== "end" && kind !== "note" && (kind === "decision" || out.some((edge) => edge.when !== null));
export const branchEdges = (graph: WorkflowView, node: ViewNode): ViewEdge[] => {
  const out = graph.edges.filter((edge) => edge.from === node.id);
  return isBranching(node.kind, out) ? out : [];
};

const sizeOf = (node: ViewNode, graph?: WorkflowView) => {
  if (node.kind === "start" || node.kind === "end") return TERMINAL;
  const ports = graph ? branchEdges(graph, node).length : 0;
  return ports ? { width: CARD.width, height: Math.max(CARD.height, PORT_MARGIN * 2 + ports * PORT_STEP) } : CARD;
};

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
      const { width, height } = sizeOf(node, graph);
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
  "elk.spacing.nodeNode": direction === "RIGHT" ? "36" : "64",
  "elk.layered.spacing.nodeNodeBetweenLayers": direction === "RIGHT" ? "180" : "78",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  // The order the author wrote the steps in decides which connection is the loop back, so a chain reads from its start to its end.
  "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.edgeRouting": "POLYLINE",
  "elk.padding": "[top=16,left=16,bottom=16,right=16]",
});

type ElkEngine = { layout(graph: ElkNode): Promise<ElkNode> };
let engine: Promise<ElkEngine> | null = null;
/**
 * elkjs is the heavy part of the graph view (1.4 MB): it is evaluated when a graph is first drawn, once. `bb plugin build` bundles
 * the app into one `app.js` (esbuild `outfile`, no splitting), so this import defers parsing only; it is still downloaded with the page.
 */
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
  const positioned = direction === "RIGHT" ? placeByOwner(nodes, [...part.edges.values()], graph.positions) : false;
  const extent = bounds(nodes, laid.width ?? 0, laid.height ?? 0, positioned);
  return { nodes, edges: [...part.edges.values()], ...extent, arranged: positioned };
}

/** The drawn box of the graph: elk's own when it placed everything, else the box around the nodes where the owner put them. */
function bounds(nodes: Placed[], laidWidth: number, laidHeight: number, positioned: boolean): { x: number; y: number; width: number; height: number } {
  const top = nodes.filter((item) => !item.parent);
  if (!positioned || !top.length) return { x: 0, y: 0, width: laidWidth, height: laidHeight };
  const x = Math.min(...top.map((item) => item.x)), y = Math.min(...top.map((item) => item.y));
  return { x, y, width: Math.max(...top.map((item) => item.x + item.width)) - x, height: Math.max(...top.map((item) => item.y + item.height)) - y };
}

/**
 * The owner's own placement (`ui.positions`), over what elk laid out: a node with a stored position goes there; one without (added after the
 * owner arranged the graph) goes to the right of the node that leads to it, so a new step never lands on top of an old one. Top-level nodes only:
 * the inside of an expanded subworkflow keeps elk's order. Returns whether anything was placed by hand.
 */
function placeByOwner(nodes: Placed[], edges: PlacedEdge[], positions: WorkflowView["positions"]): boolean {
  if (!positions || !Object.keys(positions).length) return false;
  const top = nodes.filter((item) => !item.parent).sort((a, b) => a.x - b.x || a.y - b.y);
  if (!top.some((item) => positions[item.key])) return false;
  const done = new Map<string, Placed>();
  for (const item of top) { const at = positions[item.key]; if (at) { item.x = at.x; item.y = at.y; done.set(item.key, item); } }
  const used = new Set<string>();
  const slot = (x: number, y: number) => `${Math.round(x / 20)}:${Math.round(y / 20)}`;
  for (const item of done.values()) used.add(slot(item.x, item.y));
  for (const item of top) {
    if (done.has(item.key)) continue;
    const lead = edges.find((edge) => edge.target === item.key && done.has(edge.source));
    const from = lead ? done.get(lead.source)! : null;
    if (from) {
      let y = from.y;
      while (used.has(slot(from.x + from.width + 90, y))) y += item.height + 28;
      item.x = from.x + from.width + 90; item.y = y;
    }
    done.set(item.key, item);
    used.add(slot(item.x, item.y));
  }
  return true;
}
