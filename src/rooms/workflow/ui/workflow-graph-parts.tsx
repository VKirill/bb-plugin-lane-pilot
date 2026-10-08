import { memo, type CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath, useStore, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { Icon, type IconName } from "@lane-pilot/ui-kit";
import type { NodeTone, ViewEdge, ViewNode } from "@lane-pilot/workflow-engine";
import { PORT_STEP, type Direction } from "./workflow-layout";
import { nodeTitle } from "./workflow-titles";
import type { NodeRun, NodeStatus } from "./workflow-run";
import { CardModel, type GraphModels, type StepExecutor } from "./workflow-models";

/**
 * The pieces of the canvas, drawn the way n8n draws a workflow: a compact card with an icon tile in the colour of what the step does,
 * a title, one line under it and the model; a status ring round the tile during a run; a decision with named outputs; a subworkflow
 * drawn as a stack; and connections that carry a small chip with the condition in words, the expression itself in its tooltip.
 */
export type GraphProblems = { nodes: ReadonlyMap<string, string[]>; edges: ReadonlyMap<string, string[]>; errors: ReadonlySet<string> };

/** The icon of a step: by what it does (its tone), a decision and the flow nodes by what they are. */
export const TONE_ICON: Record<NodeTone, IconName> = {
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

/** A named output of a decision: the card's port and its label. */
export type PortData = { id: string; label: string; title: string; otherwise: boolean; when: string | null; onPick: () => void };

export type CardData = {
  view: ViewNode; locale: Locale; direction: Direction; run: NodeRun | null; selected: boolean; changed: boolean; expanded: boolean; loading: boolean;
  /** Another step is under the pointer and this one is not on its path. */
  dim: boolean;
  onToggle: (() => void) | null; onOpen: (() => void) | null; onAddAfter: (() => void) | null; onPick: () => void; problems: string[]; level: "error" | "warning"; editing: boolean;
  /** Who works on this step and what choosing a model does (the badge or the native picker); absent when the models were not read. */
  executor: StepExecutor | null; models: GraphModels | null;
  ports: PortData[];
};
export type EdgeData = {
  edge: ViewEdge; active: boolean | null; changed: boolean; direction: Direction; selected: boolean; problems: string[]; level: "error" | "warning"; onPick: () => void;
  /** The pointer is on a step: this connection leaves or enters it («on»), or belongs to the rest of the graph («dim»). */
  focus: "on" | "dim" | "none";
  /** The condition in words (or the author's label); the fallback of a step with conditions says «otherwise». */
  caption: string | null; otherwise: boolean;
  /** Leaves a decision through a named output: the output carries the words, not the connection. */
  fromPort: boolean;
};
export type FlowNode = Node<CardData>;
export type FlowEdge = Edge<EdgeData>;

export const ports = (direction: Direction) => direction === "RIGHT" ? { target: Position.Left, source: Position.Right } : { target: Position.Top, source: Position.Bottom };
/** Where a named output sits: stacked on the right edge of the card, or spread along the bottom one. */
export const portSpot = (direction: Direction, index: number, count: number, width: number, height: number) =>
  direction === "RIGHT" ? { x: width, y: (height - count * PORT_STEP) / 2 + index * PORT_STEP + PORT_STEP / 2 } : { x: (width * (index + 1)) / (count + 1), y: height };
/** Where the ports sit, known from the card size: edges can be drawn before the browser has measured anything. */
const portBox = (position: Position, x: number, y: number) => ({ position, x: x - 4, y: y - 4, width: 8, height: 8 });
export const portsOf = (direction: Direction, width: number, height: number, named: readonly PortData[] = []) => {
  const side = ports(direction);
  const input = direction === "RIGHT" ? portBox(side.target, 0, height / 2) : portBox(side.target, width / 2, 0);
  const output = (id: string | null, x: number, y: number) => ({ type: "source" as const, ...(id ? { id } : {}), ...portBox(side.source, x, y) });
  return [{ type: "target" as const, ...input }, ...(named.length ? named.map((port, index) => { const at = portSpot(direction, index, named.length, width, height); return output(port.id, at.x, at.y); }) : [output(null, direction === "RIGHT" ? width : width / 2, direction === "RIGHT" ? height / 2 : height)])];
};

function StatusPill({ run, compact = false }: { run: NodeRun; compact?: boolean }) {
  const label = t(STATUS_KEY[run.status]);
  return <span className={`${STATUS_PILL[run.status]} lp-wf-status shrink-0 rounded-full ${compact ? "px-1.5 text-[10px] leading-4" : "px-2 py-0.5 text-[11px]"} font-medium`} data-status={run.status}>{run.status === "running" ? <span className="lp-wf-pulse" aria-hidden /> : null}{label}</span>;
}

/** One line under the title: what the step is, plus how often it may run and how often it did. */
function subtitleOf(view: ViewNode, run: NodeRun | null): string {
  const kind = t(KIND_KEY[view.kind] ?? "wfKind_agent");
  const what = view.kind === "agent" ? view.role ?? kind
    : view.kind === "subworkflow" ? view.calls?.id ?? kind
      : view.kind === "action" ? view.excerpt ?? kind
        : view.kind === "human" ? [kind, view.role].filter(Boolean).join(" · ")
          : view.kind === "lp-task" ? kind
            : [kind, view.excerpt].filter(Boolean).join(" ");
  return [what, view.maxVisits ? `↻ ${view.maxVisits}` : null, run && run.visits > 1 ? t("wfVisits").replace("{n}", String(run.visits)) : null].filter(Boolean).join(" · ");
}

/** The tooltip of a card: the title, what the step says it does, and what it calls. */
const cardTitle = (view: ViewNode, title: string): string => [title, view.excerpt && view.kind !== "action" ? view.excerpt : null, view.calls ? t("wfNodeCalls").replace("{id}", view.calls.id) : null].filter(Boolean).join("\n");

/** How many times a card and an edge were drawn: a test and the live harness read it to see that a hover redraws only what it changes. */
export const renderStats = { cards: 0, edges: 0 };
(globalThis as { __lpRenderStats?: typeof renderStats }).__lpRenderStats = renderStats;

export const NodeCard = memo(function NodeCard({ data, id }: NodeProps<FlowNode>) {
  renderStats.cards += 1;
  const { view, locale, direction, run, selected, changed, expanded, loading, dim, onToggle, onOpen, onAddAfter, onPick, problems, level, editing, executor, models, ports: named } = data;
  const side = ports(direction);
  const title = nodeTitle(view, locale);
  const kind = t(KIND_KEY[view.kind] ?? "wfKind_agent");
  const sub = view.kind === "subworkflow";
  return (
    <div className="lp-wf-cardbox">
    {sub ? <><span className="lp-wf-stack lp-wf-stack-2" aria-hidden /><span className="lp-wf-stack lp-wf-stack-1" aria-hidden /></> : null}
    <div className="lp-wf-node" data-tone={view.tone} data-kind={view.kind} data-status={run?.status ?? "none"} data-selected={selected ? "1" : "0"} data-changed={changed ? "1" : "0"} data-dim={dim ? "1" : "0"}
      data-problem={problems.length ? level : "none"} data-testid={`wf-node-${id}`} title={cardTitle(view, title)}
      role="button" tabIndex={0} aria-pressed={selected} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPick(); } }}
      aria-label={`${title}, ${kind}${run ? `, ${t(STATUS_KEY[run.status])}` : ""}${problems.length ? `, ${problems.join("; ")}` : ""}`}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={editing} />
      <span className="lp-wf-ring" data-status={run?.status ?? "none"} aria-hidden><span className="lp-wf-icon"><Icon name={TONE_ICON[view.tone]} className="size-[18px]" /></span></span>
      <div className="lp-wf-body">
        <div className="lp-wf-title-row">
          <span className="lp-wf-title" title={title}>{title}</span>
          {problems.length ? <span className="lp-wf-problem" data-level={level} data-testid={`wf-problem-${id}`} title={problems.join("\n")} role="img" aria-label={t("wfEditProblemsOn")}>!</span> : null}
          {run && run.status !== "pending" ? <StatusPill run={run} compact /> : null}
        </div>
        <div className="lp-wf-sub" data-kind={view.kind}>{subtitleOf(view, run)}</div>
        {executor && models ? <CardModel executor={executor} models={models} id={id} /> : null}
        {sub && (onOpen || (onToggle && view.calls)) ? (
          <div className="lp-wf-actions nodrag nopan">
            {onOpen ? <button type="button" className="lp-wf-open" data-testid={`wf-open-${id}`} aria-label={t("wfOpenSubLabel")} title={t("wfOpenSubLabel")} onClick={(event) => { event.stopPropagation(); onOpen(); }} onKeyDown={(event) => event.stopPropagation()}>{t("wfOpenSub")} ›</button> : null}
            {onToggle && view.calls ? (
              <button type="button" className="lp-wf-expand" data-testid={`wf-expand-${id}`} disabled={loading} aria-expanded={expanded}
                onClick={(event) => { event.stopPropagation(); onToggle(); }} onKeyDown={(event) => event.stopPropagation()}>{expanded ? t("wfCollapse") : t("wfExpand")}</button>
            ) : null}
          </div>
        ) : null}
      </div>
      {named.length ? named.map((port, index) => {
        const style: CSSProperties = direction === "RIGHT" ? { top: `calc(50% + ${(index - (named.length - 1) / 2) * PORT_STEP}px)` } : { left: `${((index + 1) / (named.length + 1)) * 100}%` };
        return (
          <span key={port.id}>
            <Handle type="source" id={port.id} position={side.source} className="lp-wf-port lp-wf-port-named" style={style} isConnectable={false} />
            <span className="lp-wf-portlabel nodrag nopan" data-otherwise={port.otherwise ? "1" : "0"} data-when={port.when ?? ""} data-testid={`wf-port-${id}-${port.id}`} title={port.title} onClick={(event) => { event.stopPropagation(); port.onPick(); }}
              style={direction === "RIGHT" ? { top: style.top } : { left: style.left }}>{port.label}</span>
          </span>
        );
      }) : <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={editing} />}
      {onAddAfter ? <button type="button" className="lp-wf-add nodrag nopan" data-testid={`wf-add-${id}`} aria-label={t("wfAddAfter")} title={t("wfAddAfter")} onClick={(event) => { event.stopPropagation(); onAddAfter(); }}>+</button> : null}
    </div>
    </div>
  );
});

export const NodeTerminal = memo(function NodeTerminal({ data, id }: NodeProps<FlowNode>) {
  const { view, locale, direction, run, editing, onAddAfter, dim } = data;
  const side = ports(direction);
  return (
    <div className="lp-wf-terminal" data-kind={view.kind} data-status={run?.status ?? "none"} data-dim={dim ? "1" : "0"} data-testid={`wf-node-${id}`}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={editing && view.kind === "end"} />
      <span>{nodeTitle(view, locale)}</span>
      <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={editing && view.kind === "start"} />
      {onAddAfter ? <button type="button" className="lp-wf-add nodrag nopan" data-testid={`wf-add-${id}`} aria-label={t("wfAddAfter")} title={t("wfAddAfter")} onClick={(event) => { event.stopPropagation(); onAddAfter(); }}>+</button> : null}
    </div>
  );
});

export const NodeGroup = memo(function NodeGroup({ data, id }: NodeProps<FlowNode>) {
  const { view, locale, direction, run, onToggle } = data;
  const side = ports(direction);
  return (
    <div className="lp-wf-group" data-testid={`wf-group-${id}`} data-status={run?.status ?? "none"}>
      <Handle type="target" position={side.target} className="lp-wf-port" isConnectable={false} />
      <div className="lp-wf-group-head">
        <span className="lp-wf-group-icon" aria-hidden><Icon name="Workflow" className="size-3.5" /></span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{nodeTitle(view, locale)}{view.calls ? <span className="ml-1.5 font-mono font-normal text-muted-foreground">{view.calls.id}</span> : null}</span>
        {run ? <StatusPill run={run} /> : null}
        {onToggle ? <button type="button" className="lp-wf-expand-inline nodrag nopan" data-testid={`wf-expand-${id}`} onClick={(event) => { event.stopPropagation(); onToggle(); }}>{t("wfCollapse")}</button> : null}
      </div>
      <Handle type="source" position={side.source} className="lp-wf-port" isConnectable={false} />
    </div>
  );
});

export const FlowEdgeView = memo(function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  renderStats.edges += 1;
  const edge = data!.edge;
  const right = data!.direction === "RIGHT";
  // The chip stays readable when the graph is zoomed out: it grows against the zoom, up to a fifth (more would run over the cards at either end).
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
  const caption = data!.caption ?? (data!.otherwise ? t("wfOtherwise") : null);
  const showCaption = caption !== null && !data!.fromPort;
  const showPass = edge.pass !== "artifact";
  const state = data!.active === null ? "idle" : data!.active ? "taken" : "untaken";
  // The expression stays reachable: in the tooltip of the chip, and under the caption once the connection is picked.
  const title = [edge.label, edge.when, edge.carries.length ? `→ ${edge.carries.join(", ")}` : null, showPass ? t(PASS_KEY[edge.pass]) : null, ...data!.problems].filter(Boolean).join("\n");
  const flags = { "data-state": state, "data-changed": data!.changed ? "1" : "0", "data-selected": data!.selected ? "1" : "0", "data-problem": data!.problems.length ? data!.level : "none", "data-focus": data!.focus };
  const chip = showCaption || showPass || data!.problems.length > 0 || data!.selected;
  return (
    <>
      <BaseEdge id={id} path={path} className="lp-wf-edge" {...flags} markerEnd={`url(#lp-wf-arrow-${data!.focus === "on" && state === "idle" ? "on" : state})`} interactionWidth={22} />
      {chip ? (
        <EdgeLabelRenderer>
          <div className="lp-wf-chip nodrag nopan" data-testid={`wf-edge-${id}`} data-when={edge.when ?? ""} data-otherwise={data!.otherwise && !data!.caption ? "1" : "0"} {...flags} title={title}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${grow})` } as CSSProperties} onClick={(event) => { event.stopPropagation(); data!.onPick(); }}>
            {data!.problems.length ? <span className="lp-wf-problem" data-level={data!.level} aria-label={t("wfEditProblemsOn")}>!</span> : null}
            {showCaption ? <span className="lp-wf-chip-text">{caption}</span> : null}
            {showPass ? <span className="lp-wf-pass" data-pass={edge.pass}>{t(PASS_KEY[edge.pass])}</span> : null}
            {data!.selected && edge.when ? <span className="lp-wf-chip-expr">{edge.when}</span> : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

/** Arrowheads in the edge colours, defined once per canvas (a marker cannot read a CSS variable of its edge). */
export function Markers() {
  const marker = (state: string) => (
    <marker key={state} id={`lp-wf-arrow-${state}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" className={`lp-wf-arrow lp-wf-arrow-${state}`}>
      <path d="M 0 1 L 10 5 L 0 9 z" />
    </marker>
  );
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden><defs>{["idle", "taken", "untaken", "on"].map(marker)}</defs></svg>;
}
