import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BaseEdge, EdgeLabelRenderer, Handle, Panel, Position, ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { t, type I18nKey, type Locale } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Icon, type IconName } from "../../components/ui/icon";
import type { NodeTone, ViewEdge, ViewNode, WorkflowView } from "../workflow/view";
import { layoutGraph, type Direction, type Expansions, type Layout } from "./workflow-layout";
import { nodeTitle } from "./workflow-titles";
import type { NodeRun, NodeStatus } from "./workflow-run";

/**
 * The read-only canvas of a workflow: role-coloured node cards with ports, edges that carry their condition and passing
 * mode, subworkflow nodes that open into their own graph, and, in a run, a status on every node. Loaded on demand (xyflow and
 * elkjs together are most of a megabyte). The pieces are separate so the editor (W6) can add to them: a card takes an optional
 * `onAddAfter` for the «+», the canvas takes the same node and edge types with its own handlers.
 */
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
  onToggle: (() => void) | null; onAddAfter: (() => void) | null; onPick: () => void;
};
type EdgeData = { edge: ViewEdge; active: boolean | null; changed: boolean; direction: Direction };
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
  const { view, locale, direction, run, selected, changed, expanded, loading, onToggle, onAddAfter, onPick } = data;
  const side = ports(direction);
  const title = nodeTitle(view, locale);
  const kind = t(KIND_KEY[view.kind] ?? "wfKind_agent");
  const meta = [view.role && view.role !== view.kind ? view.role : kind, view.maxVisits ? `↻ ${view.maxVisits}` : null, run && run.visits > 1 ? t("wfVisits").replace("{n}", String(run.visits)) : null].filter(Boolean).join(" · ");
  return (
    <div className="lp-wf-node nodrag" data-tone={view.tone} data-kind={view.kind} data-status={run?.status ?? "none"} data-selected={selected ? "1" : "0"} data-changed={changed ? "1" : "0"} data-testid={`wf-node-${id}`}
      role="button" tabIndex={0} aria-pressed={selected} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPick(); } }} aria-label={`${title}, ${kind}${run ? `, ${t(STATUS_KEY[run.status])}` : ""}`}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={false} />
      <div className="flex min-w-0 items-start gap-2">
        <span className="lp-tile lp-wf-tile size-7" aria-hidden><Icon name={TONE_ICON[view.tone]} className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-5" title={title}>{title}</div>
          <div className="truncate text-[11px] leading-4 text-muted-foreground" title={meta}>{meta}</div>
        </div>
        {run ? <StatusPill run={run} /> : null}
      </div>
      {view.excerpt ? <p className="mt-1.5 line-clamp-2 break-words text-[11px] leading-4 text-muted-foreground">{view.excerpt}</p> : null}
      {view.calls ? <p className="mt-1.5 truncate font-mono text-[11px] leading-4 text-muted-foreground">{view.calls.id}</p> : null}
      {onToggle && view.calls ? (
        <button type="button" className="lp-wf-expand nodrag nopan" data-testid={`wf-expand-${id}`} disabled={loading} aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); onToggle(); }} onKeyDown={(event) => event.stopPropagation()}>{expanded ? t("wfCollapse") : t("wfExpand")}</button>
      ) : null}
      <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={false} />
      {onAddAfter ? <button type="button" className="lp-wf-add nodrag nopan" aria-label={t("wfAddAfter")} onClick={(event) => { event.stopPropagation(); onAddAfter(); }}>+</button> : null}
    </div>
  );
});

const NodeTerminal = memo(function NodeTerminal({ data, id }: NodeProps<FlowNode>) {
  const { view, locale, direction, run } = data;
  const side = ports(direction);
  return (
    <div className="lp-wf-terminal" data-kind={view.kind} data-status={run?.status ?? "none"} data-testid={`wf-node-${id}`}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={false} />
      <span>{nodeTitle(view, locale)}</span>
      <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={false} />
    </div>
  );
});

const NodeNote = memo(function NodeNote({ data, id }: NodeProps<FlowNode>) {
  return <div className="lp-wf-note" data-testid={`wf-node-${id}`}><p className="line-clamp-3 break-words text-[11px] leading-4">{data.view.excerpt}</p></div>;
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

const clip = (text: string, max = 38) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const FlowEdgeView = memo(function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const edge = data!.edge;
  const right = data!.direction === "RIGHT";
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
  const title = [edge.label, edge.when, edge.carries.length ? `→ ${edge.carries.join(", ")}` : null].filter(Boolean).join("\n");
  return (
    <>
      <BaseEdge id={id} path={path} className="lp-wf-edge" data-state={state} data-changed={data!.changed ? "1" : "0"} markerEnd={`url(#lp-wf-arrow-${state})`} />
      {main || showPass ? (
        <EdgeLabelRenderer>
          <div className="lp-wf-edge-label nodrag nopan" data-testid={`wf-edge-${id}`} data-state={state} data-changed={data!.changed ? "1" : "0"} title={title} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` } as CSSProperties}>
            {main ? <span className="lp-wf-edge-when">{clip(main)}</span> : null}
            {edge.label && edge.when ? <span className="lp-wf-edge-sub">{clip(edge.when)}</span> : null}
            <span className="lp-wf-pass" data-pass={edge.pass}>{t(PASS_KEY[edge.pass])}</span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

const nodeTypes = { card: NodeCard, terminal: NodeTerminal, note: NodeNote, group: NodeGroup };
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
  /** Editing hook for W6: a «+» appears on each card when this is given. */
  onAddAfter?: (key: string) => void;
  /** Narrow panels lay the graph out top to bottom. */
  direction?: Direction;
  height?: number;
};

function Canvas({ graph, locale, expansions, runs, takenEdges, changedNodes, changedEdges, selected = null, loadingKeys, onSelect, onToggleExpand, onAddAfter, direction = "RIGHT", height = 440 }: WorkflowGraphProps) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<Direction>(direction);
  const flow = useReactFlow();
  useEffect(() => setOrientation(direction), [direction]);

  useEffect(() => {
    let live = true;
    setFailed(null);
    layoutGraph(graph, expansions, orientation).then((next) => { if (live) setLayout(next); }).catch((cause) => { if (live) setFailed(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [graph, expansions, orientation]);

  // Handlers are read at click time, so a card built for an earlier render never calls an earlier closure.
  const handlers = useRef({ onSelect, onToggleExpand, onAddAfter });
  handlers.current = { onSelect, onToggleExpand, onAddAfter };
  const hasToggle = Boolean(onToggleExpand), hasAdd = Boolean(onAddAfter);
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
      id: key, type: placed.group ? "group" : view.kind === "start" || view.kind === "end" ? "terminal" : view.kind === "note" ? "note" : "card",
      position: { x: placed.x, y: placed.y }, ...(placed.parent ? { parentId: placed.parent, extent: "parent" as const } : {}),
      width: placed.width, height: placed.height, initialWidth: placed.width, initialHeight: placed.height, handles: portsOf(orientation, placed.width, placed.height),
      style: { width: placed.width, height: placed.height }, draggable: false, selectable: false, connectable: false,
      data: { view, locale, direction: orientation, run: runs?.get(key) ?? null, selected: selected === key, changed: changedNodes?.has(key) ?? false, expanded: placed.group, loading: loadingKeys?.has(key) ?? false,
        onPick: () => pick(key), onToggle: canExpand ? () => handlers.current.onToggleExpand?.(key, view) : null,
        onAddAfter: hasAdd && view.kind !== "end" && view.kind !== "note" ? () => handlers.current.onAddAfter?.(key) : null },
    } satisfies FlowNode;
  }), [layout, locale, orientation, runs, selected, changedNodes, loadingKeys, hasToggle, hasAdd, pick]);

  const edges = useMemo<FlowEdge[]>(() => (layout?.edges ?? []).map((placed) => ({
    id: placed.key, source: placed.source, target: placed.target, type: "flow", selectable: false, focusable: false,
    data: { edge: placed.edge, active: runs ? takenEdges?.has(placed.key) ?? false : null, changed: changedEdges?.has(placed.key) ?? false, direction: orientation },
  })), [layout, runs, takenEdges, changedEdges, orientation]);

  const fit = useCallback(() => { void flow.fitView({ padding: 0.14, duration: 160, maxZoom: 1 }); }, [flow]);
  // A new layout (another workflow, an expanded node, the other direction) is brought into view; a status change is not.
  useEffect(() => {
    if (!layout) return;
    // After the canvas has taken the new nodes in; fitting in the same frame measures the old ones.
    const timer = setTimeout(() => { void flow.fitView({ padding: 0.14, duration: 0, maxZoom: 1 }); }, 80);
    return () => clearTimeout(timer);
  }, [layout, flow]);

  return (
    <div className="lp-wf-canvas relative min-w-0" style={{ height }} data-testid="workflow-graph" data-layout={layout ? "ready" : failed ? "failed" : "pending"} data-direction={orientation}>
      <Markers />
      <ReactFlow<FlowNode, FlowEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} elementsSelectable={false} edgesFocusable={false}
        zoomOnScroll={false} preventScrolling={false} panOnScroll={false} zoomOnDoubleClick={false} minZoom={0.15} maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_event, node) => pick(node.id)}
        onPaneClick={() => pick(null)}
        aria-label={t("wfGraphLabel")}
      >
        <Panel position="top-right" className="lp-wf-tools">
          <Button type="button" size="sm" variant="outline" className="lp-raised size-7 p-0" aria-label={t("wfZoomIn")} onClick={() => void flow.zoomIn({ duration: 120 })}>+</Button>
          <Button type="button" size="sm" variant="outline" className="lp-raised size-7 p-0" aria-label={t("wfZoomOut")} onClick={() => void flow.zoomOut({ duration: 120 })}>−</Button>
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-label={t("wfFitView")} onClick={fit}>{t("wfFit")}</Button>
          <Button type="button" size="sm" variant="outline" className="lp-raised h-7 px-2 text-xs" aria-pressed={orientation === "DOWN"} aria-label={t("wfFlipDirection")} data-testid="wf-direction"
            onClick={() => setOrientation((current) => (current === "RIGHT" ? "DOWN" : "RIGHT"))}>{orientation === "RIGHT" ? "→" : "↓"}</Button>
        </Panel>
      </ReactFlow>
      {!layout && !failed ? <p className="lp-wf-overlay text-xs text-muted-foreground" role="status">{t("wfLayouting")}</p> : null}
      {failed ? <p className="lp-wf-overlay text-xs text-destructive" role="alert">{t("wfGraphError").replace("{error}", failed)}</p> : null}
    </div>
  );
}

/** The default export is what the screen loads lazily. */
export default function WorkflowGraph(props: WorkflowGraphProps): ReactNode {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
