import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MiniMap, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type NodeChange } from "@xyflow/react";
import { t, type Locale } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Icon } from "@lane-pilot/ui-kit";
import { edgeCaption } from "../edge-label";
import type { ViewNode, WorkflowView } from "../view";
import { isBranching, layoutGraph, type Direction, type Expansions, type Layout } from "./workflow-layout";
import { nodeTitle } from "./workflow-titles";
import type { NodeRun } from "./workflow-run";
import { executorFor, type GraphModels } from "./workflow-models";
import {
  FlowEdgeView, Markers, NodeCard, NodeGroup, NodeTerminal, portsOf, TONE_ICON,
  type FlowEdge, type FlowNode, type GraphProblems, type PortData,
} from "./workflow-graph-parts";

export type { GraphProblems };
export { TONE_ICON };

/**
 * The canvas of a workflow, drawn the way n8n draws one: compact cards with an icon tile in the colour of what the step does, a status ring in a run,
 * connections with a small chip that says the condition in words, a decision with named outputs, a subworkflow drawn as a stack that opens into its own
 * graph, a minimap and zoom controls. Loaded on demand (xyflow and elkjs together are most of a megabyte).
 *
 * The editor drives the same canvas: `onAddAfter` puts a «+» on each card, `onConnect` makes the ports draggable, `onMove` lets the owner drag a step to
 * where it belongs (the page saves the places in the file), `onArrange` lays everything out again, `selectedEdge`/`onSelectEdge` pick a connection, and
 * `problems` marks the nodes and edges the validator named. The view opens at a readable zoom (never below 0.85 on its own) on the start of the chain.
 */
/** The smallest zoom «Fit» and the first view use: below it a card's text is no longer readable. */
export const READABLE_ZOOM = 0.85;
/**
 * The first view of a graph in a box: all of it when it fits at READABLE_ZOOM or more, centred; otherwise READABLE_ZOOM on the
 * anchor (the start of the chain), so the cards stay legible and the owner pans along the chain.
 */
export function readableViewport(graph: { width: number; height: number; x?: number; y?: number }, anchor: { x: number; y: number; width: number; height: number }, box: { width: number; height: number }, orientation: Direction, pad = 20): { x: number; y: number; zoom: number } {
  const fit = Math.min((box.width - pad * 2) / graph.width, (box.height - pad * 2) / graph.height, 1);
  const zoom = Math.max(fit, READABLE_ZOOM);
  if (fit >= READABLE_ZOOM) return { zoom, x: (box.width - graph.width * zoom) / 2 - (graph.x ?? 0) * zoom, y: (box.height - graph.height * zoom) / 2 - (graph.y ?? 0) * zoom };
  const centre = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
  return orientation === "DOWN"
    ? { zoom, x: box.width / 2 - centre.x * zoom, y: pad - anchor.y * zoom }
    : { zoom, x: pad - anchor.x * zoom, y: box.height / 2 - centre.y * zoom };
}

/** One step of the way into a subworkflow, for the breadcrumb above the canvas. */
export type Crumb = { label: string };

export type WorkflowGraphProps = {
  graph: WorkflowView;
  locale: Locale;
  /** The expanded subworkflow nodes, by canvas key, with the graph each calls. */
  expansions?: Expansions;
  /** Statuses by canvas key and the edge keys a run has taken; absent for a definition. */
  runs?: ReadonlyMap<string, NodeRun>;
  takenEdges?: ReadonlySet<string>;
  /** Nodes and edges (by canvas key) the last draft patch touched; they are outlined until the next patch. */
  changedNodes?: ReadonlySet<string>;
  changedEdges?: ReadonlySet<string>;
  selected?: string | null;
  loadingKeys?: ReadonlySet<string>;
  onSelect?: (key: string | null, node: ViewNode | null) => void;
  onToggleExpand?: (key: string, node: ViewNode) => void;
  /** «Open» on a subworkflow card: the canvas goes into the called workflow; `trail` and `onTrail` are the way back. */
  onOpen?: (key: string, node: ViewNode) => void;
  trail?: readonly Crumb[];
  onTrail?: (index: number) => void;
  /** Editing: a «+» on each card. */
  onAddAfter?: (key: string) => void;
  /** Editing: the «+» on an empty canvas. */
  onAddFirst?: () => void;
  /** Editing: dragging from a port to another card makes an edge (keys are canvas keys; `$start` and `$end` are the ends). */
  onConnect?: (from: string, to: string) => void;
  /** Editing: a step was dragged; the places of all top-level steps, by node id (`$start` and `$end` for the ends). */
  onMove?: (positions: Record<string, { x: number; y: number }>) => void;
  /** Editing: lay the steps out again (the page drops the saved places). */
  onArrange?: () => void;
  /** Editing: the edge on the panel (canvas key `e<index>`) and the click that picks one. */
  selectedEdge?: string | null;
  onSelectEdge?: (key: string | null) => void;
  /** Validator problems by node id and edge key; drawn on the card or the edge label. */
  problems?: GraphProblems;
  /** A node to bring into view when it changes (the one just added). */
  focusKey?: string | null;
  /** `first` fits the view once per graph and leaves it where the owner put it after an edit; `always` (the default) refits on every new layout. */
  refit?: "always" | "first";
  /** The model of each step (a badge on the card, or BB's picker where the step holds its own); the cards are drawn without it until it is read. */
  models?: GraphModels;
  /** Narrow panels lay the graph out top to bottom. */
  direction?: Direction;
  height?: number;
};

const NO_PROBLEMS: GraphProblems = { nodes: new Map(), edges: new Map(), errors: new Set() };
const TONE_COLOR: Record<string, string> = {
  plan: "var(--lp-info)", build: "var(--lp-success)", qa: "var(--lp-warning)", review: "var(--primary)", human: "color-mix(in oklab, var(--primary) 55%, var(--destructive))",
  sub: "color-mix(in oklab, var(--lp-info) 55%, var(--lp-success))", decision: "color-mix(in oklab, var(--lp-warning) 60%, var(--foreground))",
};

function Canvas({ graph, locale, expansions, runs, takenEdges, changedNodes, changedEdges, selected = null, loadingKeys, onSelect, onToggleExpand, onOpen, trail, onTrail, onAddAfter, onAddFirst, onConnect, onMove, onArrange,
  selectedEdge = null, onSelectEdge, problems = NO_PROBLEMS, focusKey = null, refit = "always", direction = "RIGHT", height = 440, models }: WorkflowGraphProps) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<Direction>(direction);
  const [hover, setHover] = useState<string | null>(null);
  // Where the owner has dragged steps to, until the saved places come back in the next layout.
  const [moved, setMoved] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const flow = useReactFlow();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => setOrientation(direction), [direction]);

  useEffect(() => {
    let live = true;
    setFailed(null);
    layoutGraph(graph, expansions, orientation).then((next) => { if (live) setLayout(next); }).catch((cause) => { if (live) setFailed(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [graph, expansions, orientation]);

  // A dragged step stays where it was dropped until the layout carries its saved place.
  useEffect(() => {
    if (!layout) return;
    setMoved((current) => {
      if (!current.size) return current;
      const keep = [...current].filter(([key, at]) => { const placed = layout.nodes.find((item) => item.key === key); return !placed || Math.abs(placed.x - at.x) > 0.5 || Math.abs(placed.y - at.y) > 0.5; });
      return keep.length === current.size ? current : new Map(keep);
    });
  }, [layout]);

  // Handlers are read at click time, so a card built for an earlier render never calls an earlier closure.
  const handlers = useRef({ onSelect, onToggleExpand, onOpen, onAddAfter, onConnect, onSelectEdge, onMove, onArrange });
  handlers.current = { onSelect, onToggleExpand, onOpen, onAddAfter, onConnect, onSelectEdge, onMove, onArrange };
  const hasToggle = Boolean(onToggleExpand), hasOpen = Boolean(onOpen), hasAdd = Boolean(onAddAfter), editing = Boolean(onConnect);
  const draggable = Boolean(onMove) && orientation === "RIGHT";
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const movedRef = useRef(moved);
  movedRef.current = moved;
  const pick = useCallback((key: string | null) => {
    handlers.current.onSelect?.(key, key ? layoutRef.current?.nodes.find((item) => item.key === key)?.node ?? null : null);
  }, []);

  // The words of a connection and the named outputs of a decision are made once per layout.
  const parts = useMemo(() => {
    const titles = new Map(graph.nodes.map((node) => [node.id, nodeTitle(node, locale)]));
    const nameOf = (id: string) => titles.get(id) ?? null;
    const placedEdges = layout?.edges ?? [];
    const bySource = new Map<string, typeof placedEdges>();
    for (const edge of placedEdges) bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge]);
    const kinds = new Map((layout?.nodes ?? []).map((item) => [item.key, item.node.kind]));
    const portsBy = new Map<string, PortData[]>();
    const portOf = new Map<string, string>();
    for (const [source, list] of bySource) {
      if (!isBranching(kinds.get(source) ?? "agent", list.map((item) => item.edge))) continue;
      const anyCondition = list.some((item) => item.edge.when || item.edge.label);
      portsBy.set(source, list.map((item) => {
        const id = `out-${item.edge.index}`;
        portOf.set(item.key, id);
        const words = edgeCaption(item.edge, locale, nameOf, { bare: true });
        const otherwise = !words && anyCondition;
        const label = words ?? (otherwise ? t("wfPortElse") : nameOf(item.edge.to) ?? item.edge.to);
        return { id, label, otherwise, when: item.edge.when, onPick: () => handlers.current.onSelectEdge?.(item.key), title: [t("wfPortLabel").replace("{name}", label), item.edge.when].filter(Boolean).join("\n") };
      }));
    }
    const captionOf = new Map<string, { caption: string | null; otherwise: boolean }>();
    for (const [source, list] of bySource) {
      const first = kinds.get(source) !== "parallel";
      const conditional = list.some((item) => item.edge.when);
      for (const item of list) captionOf.set(item.key, { caption: edgeCaption(item.edge, locale, nameOf), otherwise: first && conditional && !item.edge.when && !item.edge.label });
    }
    return { portsBy, portOf, captionOf };
  }, [graph, layout, locale]);

  // What the pointer is on: its connections are lit, its neighbours stay, the rest of the graph recedes.
  const lit = useMemo(() => {
    if (!hover || !layout) return null;
    const edgeKeys = new Set<string>(), nodeKeys = new Set<string>([hover]);
    for (const edge of layout.edges) if (edge.source === hover || edge.target === hover) { edgeKeys.add(edge.key); nodeKeys.add(edge.source); nodeKeys.add(edge.target); }
    return { edgeKeys, nodeKeys };
  }, [hover, layout]);

  const nodes = useMemo<FlowNode[]>(() => (layout?.nodes ?? []).map((placed) => {
    const view = placed.node;
    const key = placed.key;
    const canExpand = view.kind === "subworkflow" && hasToggle;
    const named = parts.portsBy.get(key) ?? [];
    const at = moved.get(key) ?? { x: placed.x, y: placed.y };
    return {
      id: key, type: placed.group ? "group" : view.kind === "start" || view.kind === "end" ? "terminal" : "card",
      position: at, ...(placed.parent ? { parentId: placed.parent, extent: "parent" as const } : {}),
      width: placed.width, height: placed.height, initialWidth: placed.width, initialHeight: placed.height, handles: portsOf(orientation, placed.width, placed.height, named),
      style: { width: placed.width, height: placed.height }, draggable: draggable && !placed.parent && !placed.group, selectable: false, connectable: editing,
      data: { view, locale, direction: orientation, run: runs?.get(key) ?? null, selected: selected === key, changed: changedNodes?.has(key) ?? false, expanded: placed.group, loading: loadingKeys?.has(key) ?? false,
        dim: false,
        problems: problems.nodes.get(key) ?? [], level: problems.errors.has(`node:${key}`) ? "error" : "warning", editing, ports: named,
        executor: models && !placed.parent && !placed.group ? executorFor(models.executors, view) ?? null : null, models: models ?? null,
        onPick: () => pick(key), onToggle: canExpand ? () => handlers.current.onToggleExpand?.(key, view) : null,
        onOpen: view.kind === "subworkflow" && hasOpen && view.calls && !placed.group ? () => handlers.current.onOpen?.(key, view) : null,
        onAddAfter: hasAdd && view.kind !== "end" && !placed.group && !named.length ? () => handlers.current.onAddAfter?.(key) : null },
    } satisfies FlowNode;
  }), [layout, locale, orientation, runs, selected, changedNodes, loadingKeys, hasToggle, hasOpen, hasAdd, editing, draggable, problems, pick, models, parts, moved]);

  const edges = useMemo<FlowEdge[]>(() => (layout?.edges ?? []).map((placed) => {
    const words = parts.captionOf.get(placed.key);
    const port = parts.portOf.get(placed.key);
    return {
      id: placed.key, source: placed.source, target: placed.target, type: "flow", selectable: false, focusable: false, ...(port ? { sourceHandle: port } : {}),
      data: { edge: placed.edge, active: runs ? takenEdges?.has(placed.key) ?? false : null, changed: changedEdges?.has(placed.key) ?? false, direction: orientation,
        selected: selectedEdge === placed.key, problems: problems.edges.get(placed.key) ?? [], level: problems.errors.has(`edge:${placed.key}`) ? "error" : "warning", onPick: () => handlers.current.onSelectEdge?.(placed.key),
        focus: "none" as const, caption: words?.caption ?? null, otherwise: words?.otherwise ?? false, fromPort: Boolean(port) },
    } satisfies FlowEdge;
  }), [layout, runs, takenEdges, changedEdges, orientation, selectedEdge, problems, parts]);

  // The hover recedes the rest of the graph with CSS (`data-hovering` on the canvas, `lp-wf-lit` on what stays), so only the pointer's own card,
  // its neighbours and their connections get a new object: every other card and connection keeps the one it had and its memo skips it.
  // Redrawing all of them on every mouse move cost about 100 ms a frame on a 60-step chain.
  const litCache = useRef(new Map<string, { base: FlowNode | FlowEdge; made: FlowNode | FlowEdge }>());
  const shownNodes = useMemo<FlowNode[]>(() => {
    const cache = litCache.current;
    return nodes.map((node) => {
      if (!lit?.nodeKeys.has(node.id)) return node;
      const prior = cache.get(`n:${node.id}`);
      if (prior && prior.base === node) return prior.made as FlowNode;
      const made = { ...node, className: "lp-wf-lit" } as FlowNode;
      cache.set(`n:${node.id}`, { base: node, made });
      return made;
    });
  }, [nodes, lit]);
  const shownEdges = useMemo<FlowEdge[]>(() => {
    const cache = litCache.current;
    return edges.map((edge) => {
      if (!lit?.edgeKeys.has(edge.id)) return edge;
      const prior = cache.get(`e:${edge.id}`);
      if (prior && prior.base === edge) return prior.made as FlowEdge;
      const made = { ...edge, className: "lp-wf-lit", data: { ...edge.data!, focus: "on" as const } } as FlowEdge;
      cache.set(`e:${edge.id}`, { base: edge, made });
      return made;
    });
  }, [edges, lit]);
  // A layout or a data change makes new base objects: the cache holds nothing for them, and what it held is dropped.
  useEffect(() => { litCache.current.clear(); }, [nodes, edges]);

  /**
   * The first view: as much of the graph as fits at a readable zoom. When the whole graph would need less than READABLE_ZOOM,
   * the view stays at that zoom on the start of the chain and the owner pans along it.
   */
  const place = useCallback((duration: number) => {
    const current = layoutRef.current;
    const box = boxRef.current;
    const width = box?.clientWidth ?? 0, boxHeight = box?.clientHeight ?? 0;
    if (!current || !current.nodes.length) return;
    if (!width || !boxHeight || !current.width || !current.height) { void flow.fitView({ padding: 0.14, duration, maxZoom: 1, minZoom: READABLE_ZOOM }); return; }
    // The view opens on the head of the chain: the leftmost step (the topmost one when the graph runs downwards).
    const top = current.nodes.filter((item) => !item.parent);
    const anchor = [...(top.length ? top : current.nodes)].sort((a, b) => (orientation === "DOWN" ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y))[0]!;
    void flow.setViewport(readableViewport(current, anchor, { width, height: boxHeight }, orientation), { duration });
  }, [flow, orientation]);

  // A new layout (another workflow, an expanded node, the other direction) is brought into view; a status change is not.
  // The editor asks for the view once: a patch re-lays the graph out, and the owner's pan and zoom stay.
  const placedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!layout) return;
    if (refit === "first" && placedFor.current === orientation) return;
    placedFor.current = orientation;
    // After the canvas has taken the new nodes in; fitting in the same frame measures the old ones.
    const timer = setTimeout(() => place(0), 80);
    return () => clearTimeout(timer);
  }, [layout, place, refit, orientation]);

  // The node just added is brought into view, at the current zoom or the readable one, whichever is larger.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!layout || !focusKey || focused.current === focusKey) return;
    const target = layout.nodes.find((item) => item.key === focusKey);
    if (!target) return;
    focused.current = focusKey;
    void flow.setCenter(target.x + target.width / 2, target.y + target.height / 2, { zoom: Math.max(flow.getZoom(), READABLE_ZOOM), duration: 200 });
  }, [layout, focusKey, flow]);

  // A drag moves the step on screen at once; the places of all steps are saved when it is dropped.
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const moves = changes.flatMap((change) => (change.type === "position" && change.position ? [[change.id, change.position] as const] : []));
    if (moves.length) setMoved((current) => { const next = new Map(current); for (const [id, at] of moves) next.set(id, { x: at.x, y: at.y }); return next; });
  }, []);
  const dropped = useCallback(() => {
    const current = layoutRef.current;
    if (!current || !handlers.current.onMove) return;
    const positions: Record<string, { x: number; y: number }> = {};
    for (const item of current.nodes) {
      if (item.parent) continue;
      const at = movedRef.current.get(item.key) ?? { x: item.x, y: item.y };
      positions[item.key] = { x: Math.round(at.x), y: Math.round(at.y) };
    }
    handlers.current.onMove(positions);
  }, []);
  const arrange = () => { setMoved(new Map()); handlers.current.onArrange?.(); };

  const notes = graph.nodes.filter((node) => node.kind === "note");
  // A chain laid out in one row does not need the whole height: the box is as tall as the row at the readable zoom, with room for the tools.
  const shown = orientation === "RIGHT" && layout ? Math.min(height, Math.max(260, Math.ceil(layout.height * READABLE_ZOOM) + 130)) : height;
  const empty = graph.nodes.length === 0;
  const crumbs = trail && trail.length > 1 ? trail : null;

  return (
    <div className="min-w-0 space-y-2">
      {crumbs ? (
        <nav className="lp-wf-crumbs" aria-label={t("wfCrumbsLabel")} data-testid="wf-crumbs">
          {crumbs.map((crumb, index) => (
            <span key={index} className="lp-wf-crumb">
              {index > 0 ? <span className="lp-wf-crumb-sep" aria-hidden>›</span> : null}
              {index < crumbs.length - 1
                ? <button type="button" className="lp-wf-crumb-link" data-testid={`wf-crumb-${index}`} onClick={() => onTrail?.(index)}>{crumb.label}</button>
                : <span className="lp-wf-crumb-here" aria-current="page" data-testid={`wf-crumb-${index}`}>{crumb.label}</span>}
            </span>
          ))}
        </nav>
      ) : null}
      <div ref={boxRef} className="lp-wf-canvas relative min-w-0" style={{ height: shown }} data-testid="workflow-graph" data-layout={layout ? "ready" : failed ? "failed" : "pending"} data-direction={orientation} data-editing={editing ? "1" : "0"} data-arranged={layout?.arranged ? "1" : "0"} data-hovering={lit ? "1" : "0"}>
        <Markers />
        <ReactFlow<FlowNode, FlowEdge>
          nodes={shownNodes} edges={shownEdges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
          nodesDraggable={draggable} nodesConnectable={editing} nodesFocusable={false} elementsSelectable={false} edgesFocusable={false} connectionRadius={28}
          zoomOnScroll={false} preventScrolling={false} panOnScroll={false} zoomOnDoubleClick={false} minZoom={0.3} maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          onNodesChange={onNodesChange} onNodeDragStop={dropped}
          onNodeMouseEnter={(_event, node) => setHover(node.id)} onNodeMouseLeave={() => setHover(null)}
          onNodeClick={(_event, node) => pick(node.id)}
          onEdgeClick={(_event, edge) => handlers.current.onSelectEdge?.(edge.id)}
          onConnect={(connection) => { if (connection.source && connection.target) handlers.current.onConnect?.(connection.source, connection.target); }}
          onPaneClick={() => { pick(null); handlers.current.onSelectEdge?.(null); }}
          aria-label={t("wfGraphLabel")}
        >
          <Panel position="top-right" className="lp-wf-tools">
            {onArrange ? <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-label={t("wfArrangeHint")} disabled={!graph.positions && moved.size === 0} data-testid="wf-arrange" onClick={arrange}>{t("wfArrange")}</Button> : null}
            <Button type="button" size="sm" variant="outline" className="lp-raised size-7 p-0" aria-label={t("wfZoomIn")} onClick={() => void flow.zoomIn({ duration: 120 })}>+</Button>
            <Button type="button" size="sm" variant="outline" className="lp-raised size-7 p-0" aria-label={t("wfZoomOut")} onClick={() => void flow.zoomOut({ duration: 120 })}>−</Button>
            <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-label={t("wfFitView")} onClick={() => place(160)}>{t("wfFit")}</Button>
            <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-pressed={orientation === "DOWN"} aria-label={t("wfFlipDirection")} data-testid="wf-direction"
              onClick={() => setOrientation((current) => (current === "RIGHT" ? "DOWN" : "RIGHT"))}>{orientation === "RIGHT" ? "→" : "↓"}</Button>
          </Panel>
          {!empty && orientation === "RIGHT" ? <MiniMap className="lp-wf-minimap" aria-label={t("wfMinimap")} pannable zoomable position="bottom-right" nodeBorderRadius={4} nodeStrokeWidth={orientation === "RIGHT" ? 9 : 14}
            style={orientation === "RIGHT" ? { width: 176, height: 64 } : { width: 72, height: 104 }}
            nodeColor={(node) => TONE_COLOR[(node.data as FlowNode["data"]).view.tone] ?? "var(--muted-foreground)"} nodeStrokeColor={(node) => TONE_COLOR[(node.data as FlowNode["data"]).view.tone] ?? "var(--muted-foreground)"} /> : null}
          <Panel position="bottom-left" className="lp-wf-hint" data-testid="wf-pan-hint">{draggable ? t("wfDragHint") : t("wfPanHint")}</Panel>
        </ReactFlow>
        {empty && onAddFirst ? (
          <div className="lp-wf-empty" data-testid="wf-empty-canvas">
            <button type="button" className="lp-wf-empty-add" data-testid="wf-empty-add" aria-label={t("wfEmptyAdd")} onClick={onAddFirst}><Icon name="SectionAdd" className="size-5" /><span>{t("wfEmptyAdd")}</span></button>
            <p className="text-xs text-muted-foreground">{t("wfEmptyAddHint")}</p>
          </div>
        ) : null}
        {!layout && !failed && !empty ? <p className="lp-wf-overlay text-xs text-muted-foreground" role="status">{t("wfLayouting")}</p> : null}
        {failed ? <p className="lp-wf-overlay text-xs text-destructive" role="alert">{t("wfGraphError").replace("{error}", failed)}</p> : null}
      </div>
      {notes.length ? (
        <ul className="lp-wf-notes" data-testid="wf-notes" aria-label={t("wfNotes")}>
          {notes.map((note) => (
            <li key={note.id}>
              <button type="button" className="lp-wf-note" data-selected={selected === note.id ? "1" : "0"} data-testid={`wf-node-${note.id}`} aria-pressed={selected === note.id} onClick={() => pick(note.id)}>
                <span className="lp-wf-note-mark" aria-hidden><Icon name="Info" className="size-3" /></span>
                <span className="min-w-0 break-words">{note.excerpt ?? t("wfNoteEmpty")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const NODE_TYPES = { card: NodeCard, terminal: NodeTerminal, group: NodeGroup };
const EDGE_TYPES = { flow: FlowEdgeView };

/** The default export is what the screen loads lazily. */
export default function WorkflowGraph(props: WorkflowGraphProps): ReactNode {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
