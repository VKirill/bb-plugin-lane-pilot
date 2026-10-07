import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BaseEdge, EdgeLabelRenderer, Handle, Panel, Position, ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow, useStore,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { t, type I18nKey, type Locale } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Icon, type IconName } from "../../components/ui/icon";
import type { NodeTone, ViewEdge, ViewNode, WorkflowView } from "../workflow/view";
import { layoutGraph, type Direction, type Expansions, type Layout } from "./workflow-layout";
import { nodeTitle } from "./workflow-titles";
import type { NodeRun, NodeStatus } from "./workflow-run";
import { CardModel, executorFor, type GraphModels, type StepExecutor } from "./workflow-models";

/**
 * The read-only canvas of a workflow: role-coloured node cards with ports, edges that carry their condition and passing
 * mode, subworkflow nodes that open into their own graph, and, in a run, a status on every node. Loaded on demand (xyflow and
 * elkjs together are most of a megabyte). The editor (W6) drives the same canvas: `onAddAfter` puts a «+» on each card,
 * `onConnect` makes the ports draggable, `selectedEdge`/`onSelectEdge` pick an edge, and `problems` marks the nodes and edges
 * the validator named. The view opens at a readable zoom (never below 0.7 on its own) on the start of the chain, and the owner pans.
 */
/** The smallest zoom «Fit» and the first view use: below it a card's text is no longer readable. */
export const READABLE_ZOOM = 0.7;
/**
 * The first view of a graph in a box: all of it when it fits at READABLE_ZOOM or more, centred; otherwise READABLE_ZOOM on the
 * anchor (the start of the chain), so the cards stay legible and the owner pans along the chain.
 */
export function readableViewport(graph: { width: number; height: number }, anchor: { x: number; y: number; width: number; height: number }, box: { width: number; height: number }, orientation: Direction, pad = 20): { x: number; y: number; zoom: number } {
  const fit = Math.min((box.width - pad * 2) / graph.width, (box.height - pad * 2) / graph.height, 1);
  const zoom = Math.max(fit, READABLE_ZOOM);
  if (fit >= READABLE_ZOOM) return { zoom, x: (box.width - graph.width * zoom) / 2, y: (box.height - graph.height * zoom) / 2 };
  const centre = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
  return orientation === "DOWN"
    ? { zoom, x: box.width / 2 - centre.x * zoom, y: pad - anchor.y * zoom }
    : { zoom, x: pad - anchor.x * zoom, y: box.height / 2 - centre.y * zoom };
}

/** The messages by node id and by edge key, and which of those hold an error (`node:<id>`, `edge:<key>`); the rest are warnings. */
export type GraphProblems = { nodes: ReadonlyMap<string, string[]>; edges: ReadonlyMap<string, string[]>; errors: ReadonlySet<string> };
const TONE_ICON: Record<NodeTone, IconName> = {
  plan: "Search", build: "Code", qa: "Target", review: "CircleCheck", agent: "Bot", action: "Zap", decision: "GitBranch",
  human: "UserRoundPlus", flow: "Layers", sub: "Workflow", note: "Info", terminal: "Circle",
};
const STATUS_PILL: Record<NodeStatus, string> = {
  pending: "lp-pill-muted", running: "lp-pill-info", waiting: "lp-pill-neutral", done: "lp-pill-success", failed: "lp-pill-danger", skipped: "lp-pill-muted",
};
const STATUS_KEY: Record<NodeStatus, I18nKey> = {
  pending: "wfNode_pending", running: "wfNode_running", waiting: "wfNode_waiting", done: "wfNode_done", failed: "wfNode_failed", skipped: "wfNode_skipped",
};
const KIND_KEY: Record<string, I18nKey> = {
  agent: "wfKind_agent", "lp-task": "wfKind_lp-task", action: "wfKind_action", decision: "wfKind_decision", human: "wfKind_human", parallel: "wfKind_parallel",
  join: "wfKind_join", subworkflow: "wfKind_subworkflow", note: "wfKind_note", start: "wfKind_start", end: "wfKind_end",
};
const PASS_KEY: Record<ViewEdge["pass"], I18nKey> = {
  artifact: "wfPass_artifact", "same-session": "wfPass_same-session", "read-prior-session": "wfPass_read-prior-session", fork: "wfPass_fork",
};


type CardData = {
  view: ViewNode; locale: Locale; direction: Direction; run: NodeRun | null; selected: boolean; changed: boolean; expanded: boolean; loading: boolean;
  onToggle: (() => void) | null; onAddAfter: (() => void) | null; onPick: () => void; problems: string[]; level: "error" | "warning"; editing: boolean;
  /** Who works on this step and what choosing a model does (the model badge or the native picker); absent when the models were not read. */
  executor: StepExecutor | null; models: GraphModels | null;
};
type EdgeData = { edge: ViewEdge; active: boolean | null; changed: boolean; direction: Direction; selected: boolean; problems: string[]; level: "error" | "warning"; onPick: () => void };
type FlowNode = Node<CardData>;
type FlowEdge = Edge<EdgeData>;

const ports = (direction: Direction) => direction === "RIGHT" ? { target: Position.Left, source: Position.Right } : { target: Position.Top, source: Position.Bottom };
/** Where the ports sit, known from the card size: edges can be drawn before the browser has measured anything. */
const portBox = (position: Position, width: number, height: number) => {
  const size = 8;
  const at = { [Position.Left]: [-size / 2, height / 2 - size / 2], [Position.Right]: [width - size / 2, height / 2 - size / 2], [Position.Top]: [width / 2 - size / 2, -size / 2], [Position.Bottom]: [width / 2 - size / 2, height - size / 2] }[position];
  return { position, x: at[0]!, y: at[1]!, width: size, height: size };
};
const portsOf = (direction: Direction, width: number, height: number) => {
  const side = ports(direction);
  return [{ type: "target" as const, ...portBox(side.target, width, height) }, { type: "source" as const, ...portBox(side.source, width, height) }];
};

function StatusPill({ run }: { run: NodeRun }) {
  const label = t(STATUS_KEY[run.status]);
  return <span className={`${STATUS_PILL[run.status]} lp-wf-status shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium`} data-status={run.status}>{run.status === "running" ? <span className="lp-wf-pulse" aria-hidden /> : null}{label}</span>;
}

const NodeCard = memo(function NodeCard({ data, id }: NodeProps<FlowNode>) {
  const { view, locale, direction, run, selected, changed, expanded, loading, onToggle, onAddAfter, onPick, problems, level, editing, executor, models } = data;
  const side = ports(direction);
  const title = nodeTitle(view, locale);
  const kind = t(KIND_KEY[view.kind] ?? "wfKind_agent");
  const role = view.role && view.role !== view.kind ? view.role : kind;
  const meta = [role, view.maxVisits ? `↻ ${view.maxVisits}` : null, run && run.visits > 1 ? t("wfVisits").replace("{n}", String(run.visits)) : null].filter(Boolean).join(" · ");
  return (
    <div className="lp-wf-node nodrag" data-tone={view.tone} data-kind={view.kind} data-status={run?.status ?? "none"} data-selected={selected ? "1" : "0"} data-changed={changed ? "1" : "0"} data-problem={problems.length ? level : "none"} data-testid={`wf-node-${id}`}
      role="button" tabIndex={0} aria-pressed={selected} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPick(); } }}
      aria-label={`${title}, ${kind}${run ? `, ${t(STATUS_KEY[run.status])}` : ""}${problems.length ? `, ${problems.join("; ")}` : ""}`}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={editing} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="lp-tile lp-wf-tile size-7 shrink-0" aria-hidden><Icon name={TONE_ICON[view.tone]} className="size-3.5" /></span>
        <span className="lp-wf-role min-w-0 flex-1 truncate" title={meta}>{meta}</span>
        {problems.length ? <span className="lp-wf-problem" data-level={level} data-testid={`wf-problem-${id}`} title={problems.join("\n")} role="img" aria-label={t("wfEditProblemsOn")}>!</span> : null}
        {run ? <StatusPill run={run} /> : null}
      </div>
      <div className="mt-1.5 truncate text-sm font-medium leading-5" title={title}>{title}</div>
      {view.excerpt ? <p className="mt-0.5 line-clamp-2 break-words text-xs leading-4 text-muted-foreground">{view.excerpt}</p> : null}
      {executor && models ? <CardModel executor={executor} models={models} id={id} /> : null}
      {view.calls ? <p className="mt-0.5 truncate font-mono text-xs leading-4 text-muted-foreground">{view.calls.id}</p> : null}
      {onToggle && view.calls ? (
        <button type="button" className="lp-wf-expand nodrag nopan" data-testid={`wf-expand-${id}`} disabled={loading} aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); onToggle(); }} onKeyDown={(event) => event.stopPropagation()}>{expanded ? t("wfCollapse") : t("wfExpand")}</button>
      ) : null}
      <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={editing} />
      {onAddAfter ? <button type="button" className="lp-wf-add nodrag nopan" data-testid={`wf-add-${id}`} aria-label={t("wfAddAfter")} title={t("wfAddAfter")} onClick={(event) => { event.stopPropagation(); onAddAfter(); }}>+</button> : null}
    </div>
  );
});

const NodeTerminal = memo(function NodeTerminal({ data, id }: NodeProps<FlowNode>) {
  const { view, locale, direction, run, editing, onAddAfter } = data;
  const side = ports(direction);
  return (
    <div className="lp-wf-terminal" data-kind={view.kind} data-status={run?.status ?? "none"} data-testid={`wf-node-${id}`}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={editing && view.kind === "end"} />
      <span>{nodeTitle(view, locale)}</span>
      <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={editing && view.kind === "start"} />
      {onAddAfter ? <button type="button" className="lp-wf-add nodrag nopan" data-testid={`wf-add-${id}`} aria-label={t("wfAddAfter")} title={t("wfAddAfter")} onClick={(event) => { event.stopPropagation(); onAddAfter(); }}>+</button> : null}
    </div>
  );
});

const NodeGroup = memo(function NodeGroup({ data, id }: NodeProps<FlowNode>) {
  const { view, locale, direction, run, onToggle } = data;
  const side = ports(direction);
  return (
    <div className="lp-wf-group" data-testid={`wf-group-${id}`} data-status={run?.status ?? "none"}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={false} />
      <div className="lp-wf-group-head">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{nodeTitle(view, locale)}{view.calls ? <span className="ml-1.5 font-mono font-normal text-muted-foreground">{view.calls.id}</span> : null}</span>
        {run ? <StatusPill run={run} /> : null}
        {onToggle ? <button type="button" className="lp-wf-expand-inline nodrag nopan" data-testid={`wf-expand-${id}`} onClick={(event) => { event.stopPropagation(); onToggle(); }}>{t("wfCollapse")}</button> : null}
      </div>
      <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={false} />
    </div>
  );
});

const clip = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const FlowEdgeView = memo(function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const edge = data!.edge;
  const right = data!.direction === "RIGHT";
  // The label stays readable when the graph is zoomed out: it grows against the zoom, up to a fifth (more would run over the cards at either end).
  const zoom = useStore((state) => state.transform[2]);
  const grow = Math.min(1.2, Math.max(1, 0.85 / (zoom || 1)));
  // A loop back to an earlier step would run straight through the cards in between; it arcs around them instead.
  const back = right ? targetX <= sourceX : targetY <= sourceY;
  const bend = 110;
  const [path, labelX, labelY] = back
    ? right
      ? [`M ${sourceX},${sourceY} C ${sourceX + 70},${sourceY + bend} ${targetX - 70},${targetY + bend} ${targetX},${targetY}`, (sourceX + targetX) / 2, (sourceY + targetY) / 2 + bend * 0.75]
      : [`M ${sourceX},${sourceY} C ${sourceX + bend + 40},${sourceY + 70} ${targetX + bend + 40},${targetY - 70} ${targetX},${targetY}`, (sourceX + targetX) / 2 + (bend + 40) * 0.75, (sourceY + targetY) / 2]
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  const main = edge.label ?? edge.when;
  const showPass = edge.pass !== "artifact" || edge.carries.length > 0;
  const state = data!.active === null ? "idle" : data!.active ? "taken" : "untaken";
  const title = [edge.label, edge.when, edge.carries.length ? `→ ${edge.carries.join(", ")}` : null, ...data!.problems].filter(Boolean).join("\n");
  const flags = { "data-state": state, "data-changed": data!.changed ? "1" : "0", "data-selected": data!.selected ? "1" : "0", "data-problem": data!.problems.length ? data!.level : "none" };
  return (
    <>
      <BaseEdge id={id} path={path} className="lp-wf-edge" {...flags} markerEnd={`url(#lp-wf-arrow-${state})`} interactionWidth={22} />
      {main || showPass || data!.problems.length || data!.selected ? (
        <EdgeLabelRenderer>
          <div className="lp-wf-edge-label nodrag nopan" data-testid={`wf-edge-${id}`} {...flags} title={title} onClick={(event) => { event.stopPropagation(); data!.onPick(); }}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${grow})` } as CSSProperties}>
            {data!.problems.length ? <span className="lp-wf-problem" data-level={data!.level} aria-label={t("wfEditProblemsOn")}>!</span> : null}
            {main ? <span className={edge.label ? "lp-wf-edge-title" : "lp-wf-edge-when"}>{clip(main)}</span> : null}
            {edge.label && edge.when ? <span className="lp-wf-edge-sub">{clip(edge.when)}</span> : null}
            <span className="lp-wf-pass" data-pass={edge.pass}>{t(PASS_KEY[edge.pass])}</span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

const nodeTypes = { card: NodeCard, terminal: NodeTerminal, group: NodeGroup };
const edgeTypes = { flow: FlowEdgeView };

/** Arrowheads in the three edge colours, defined once per canvas (a marker cannot read a CSS variable of its edge). */
function Markers() {
  const marker = (state: string) => (
    <marker key={state} id={`lp-wf-arrow-${state}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" className={`lp-wf-arrow lp-wf-arrow-${state}`}>
      <path d="M 0 1 L 10 5 L 0 9 z" />
    </marker>
  );
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden><defs>{["idle", "taken", "untaken"].map(marker)}</defs></svg>;
}

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
  /** Editing: a «+» on each card. */
  onAddAfter?: (key: string) => void;
  /** Editing: dragging from a port to another card makes an edge (keys are canvas keys; `$start` and `$end` are the ends). */
  onConnect?: (from: string, to: string) => void;
  /** Editing: the edge on the panel (canvas key `e<index>`) and the click that picks one. */
  selectedEdge?: string | null;
  onSelectEdge?: (key: string | null) => void;
  /** Validator problems by node id and edge key; drawn on the card or the edge label. */
  problems?: GraphProblems;
  /** A node to bring into view when it changes (the one just added). */
  focusKey?: string | null;
  /** `first` fits the view once per graph and leaves it where the owner put it after an edit; `always` (the default) refits on every new layout. */
  refit?: "always" | "first";
  /** The model of each step (a badge on the card); the cards are drawn without it until it is read. */
  models?: GraphModels;
  /** Narrow panels lay the graph out top to bottom. */
  direction?: Direction;
  height?: number;
};

const NO_PROBLEMS: GraphProblems = { nodes: new Map(), edges: new Map(), errors: new Set() };

function Canvas({ graph, locale, expansions, runs, takenEdges, changedNodes, changedEdges, selected = null, loadingKeys, onSelect, onToggleExpand, onAddAfter, onConnect, selectedEdge = null, onSelectEdge,
  problems = NO_PROBLEMS, focusKey = null, refit = "always", direction = "RIGHT", height = 440, models }: WorkflowGraphProps) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<Direction>(direction);
  const flow = useReactFlow();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => setOrientation(direction), [direction]);

  useEffect(() => {
    let live = true;
    setFailed(null);
    layoutGraph(graph, expansions, orientation).then((next) => { if (live) setLayout(next); }).catch((cause) => { if (live) setFailed(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [graph, expansions, orientation]);

  // Handlers are read at click time, so a card built for an earlier render never calls an earlier closure.
  const handlers = useRef({ onSelect, onToggleExpand, onAddAfter, onConnect, onSelectEdge });
  handlers.current = { onSelect, onToggleExpand, onAddAfter, onConnect, onSelectEdge };
  const hasToggle = Boolean(onToggleExpand), hasAdd = Boolean(onAddAfter), editing = Boolean(onConnect);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const pick = useCallback((key: string | null) => {
    handlers.current.onSelect?.(key, key ? layoutRef.current?.nodes.find((item) => item.key === key)?.node ?? null : null);
  }, []);

  const nodes = useMemo<FlowNode[]>(() => (layout?.nodes ?? []).map((placed) => {
    const view = placed.node;
    const key = placed.key;
    const canExpand = view.kind === "subworkflow" && hasToggle;
    return {
      id: key, type: placed.group ? "group" : view.kind === "start" || view.kind === "end" ? "terminal" : "card",
      position: { x: placed.x, y: placed.y }, ...(placed.parent ? { parentId: placed.parent, extent: "parent" as const } : {}),
      width: placed.width, height: placed.height, initialWidth: placed.width, initialHeight: placed.height, handles: portsOf(orientation, placed.width, placed.height),
      style: { width: placed.width, height: placed.height }, draggable: false, selectable: false, connectable: editing,
      data: { view, locale, direction: orientation, run: runs?.get(key) ?? null, selected: selected === key, changed: changedNodes?.has(key) ?? false, expanded: placed.group, loading: loadingKeys?.has(key) ?? false,
        problems: problems.nodes.get(key) ?? [], level: problems.errors.has(`node:${key}`) ? "error" : "warning", editing,
        executor: models && !placed.parent && !placed.group ? executorFor(models.executors, view) ?? null : null, models: models ?? null,
        onPick: () => pick(key), onToggle: canExpand ? () => handlers.current.onToggleExpand?.(key, view) : null,
        onAddAfter: hasAdd && view.kind !== "end" && !placed.group ? () => handlers.current.onAddAfter?.(key) : null },
    } satisfies FlowNode;
  }), [layout, locale, orientation, runs, selected, changedNodes, loadingKeys, hasToggle, hasAdd, editing, problems, pick, models]);

  const edges = useMemo<FlowEdge[]>(() => (layout?.edges ?? []).map((placed) => ({
    id: placed.key, source: placed.source, target: placed.target, type: "flow", selectable: false, focusable: false,
    data: { edge: placed.edge, active: runs ? takenEdges?.has(placed.key) ?? false : null, changed: changedEdges?.has(placed.key) ?? false, direction: orientation,
      selected: selectedEdge === placed.key, problems: problems.edges.get(placed.key) ?? [], level: problems.errors.has(`edge:${placed.key}`) ? "error" : "warning", onPick: () => handlers.current.onSelectEdge?.(placed.key) },
  })), [layout, runs, takenEdges, changedEdges, orientation, selectedEdge, problems]);

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
    const anchor = current.nodes.find((item) => item.node.kind === "start" && !item.parent) ?? current.nodes.find((item) => !item.parent) ?? current.nodes[0]!;
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

  const notes = graph.nodes.filter((node) => node.kind === "note");
  // A chain laid out in one row does not need the whole height: the box is as tall as the row at the readable zoom, with room for the tools.
  const shown = orientation === "RIGHT" && layout ? Math.min(height, Math.max(240, Math.ceil(layout.height * READABLE_ZOOM) + 120)) : height;

  return (
    <div className="min-w-0 space-y-2">
      <div ref={boxRef} className="lp-wf-canvas relative min-w-0" style={{ height: shown }} data-testid="workflow-graph" data-layout={layout ? "ready" : failed ? "failed" : "pending"} data-direction={orientation} data-editing={editing ? "1" : "0"}>
        <Markers />
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          nodesDraggable={false} nodesConnectable={editing} nodesFocusable={false} elementsSelectable={false} edgesFocusable={false} connectionRadius={28}
          zoomOnScroll={false} preventScrolling={false} panOnScroll={false} zoomOnDoubleClick={false} minZoom={0.4} maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => pick(node.id)}
          onEdgeClick={(_event, edge) => handlers.current.onSelectEdge?.(edge.id)}
          onConnect={(connection) => { if (connection.source && connection.target) handlers.current.onConnect?.(connection.source, connection.target); }}
          onPaneClick={() => { pick(null); handlers.current.onSelectEdge?.(null); }}
          aria-label={t("wfGraphLabel")}
        >
          <Panel position={orientation === "DOWN" ? "bottom-right" : "top-right"} className="lp-wf-tools">
            <Button type="button" size="sm" variant="outline" className="lp-raised size-7 p-0" aria-label={t("wfZoomIn")} onClick={() => void flow.zoomIn({ duration: 120 })}>+</Button>
            <Button type="button" size="sm" variant="outline" className="lp-raised size-7 p-0" aria-label={t("wfZoomOut")} onClick={() => void flow.zoomOut({ duration: 120 })}>−</Button>
            <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-label={t("wfFitView")} onClick={() => place(160)}>{t("wfFit")}</Button>
            <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-pressed={orientation === "DOWN"} aria-label={t("wfFlipDirection")} data-testid="wf-direction"
              onClick={() => setOrientation((current) => (current === "RIGHT" ? "DOWN" : "RIGHT"))}>{orientation === "RIGHT" ? "→" : "↓"}</Button>
          </Panel>
          <Panel position="bottom-left" className="lp-wf-hint" data-testid="wf-pan-hint">{t("wfPanHint")}</Panel>
        </ReactFlow>
        {!layout && !failed ? <p className="lp-wf-overlay text-xs text-muted-foreground" role="status">{t("wfLayouting")}</p> : null}
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

/** The default export is what the screen loads lazily. */
export default function WorkflowGraph(props: WorkflowGraphProps): ReactNode {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
