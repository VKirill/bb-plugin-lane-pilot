import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useViewport, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import { t, type Locale } from "@lane-pilot/i18n";
import { Button, Icon, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from "../categories";

/**
 * «Карта графов»: every workflow of the library on one canvas — category shelves, a box per graph, and inside each
 * graph its steps with their connections; dashed links mark a graph calling another (a subworkflow node). A graph is
 * collapsed to one box until it is clicked or the view is zoomed in, so a library of a thousand steps stays readable.
 */

type MapData = Omit<z.infer<typeof rpcContract.workflow_map.output>, "project">;
type MapGraph = MapData["graphs"][number];
type MapStep = MapData["steps"][number];

const STEP_W = 200;
const STEP_H = 56;
const BOX_W = 240;
const BOX_H = 64;
const EXPAND_ZOOM = 0.55;
const COLLAPSE_ZOOM = 0.35;
const ANY = "any";

/** One colour per step type, shared by the cards and the legend. */
const TYPE_COLOR: Record<string, string> = {
  agent: "var(--primary)", human: "color-mix(in oklab, var(--primary) 55%, var(--destructive))", action: "var(--lp-success)",
  decision: "color-mix(in oklab, var(--lp-warning) 60%, var(--foreground))", jev: "color-mix(in oklab, var(--lp-warning) 60%, var(--foreground))",
  parallel: "var(--lp-info)", subworkflow: "color-mix(in oklab, var(--lp-info) 55%, var(--lp-success))", join: "var(--lp-info)",
  "lp-task": "var(--lp-success)", note: "var(--muted-foreground)",
};
const TYPE_LABEL: Record<string, string> = {
  agent: "wmTypeAgent", human: "wmTypeHuman", action: "wmTypeAction", decision: "wmTypeDecision", jev: "wmTypeJev",
  parallel: "wmTypeParallel", subworkflow: "wmTypeSubworkflow", join: "wmTypeJoin", "lp-task": "wmTypeLpTask", note: "wmTypeAgent",
};
const CAT_LABEL: Record<WorkflowCategory, string> = {
  seo: "wmCatSeo", code: "wmCatCode", content: "wmCatContent", research: "wmCatResearch",
  games: "wmCatGames", business: "wmCatBusiness", routines: "wmCatRoutines", service: "wmCatService",
};
const LEGEND_TYPES = ["agent", "human", "action", "decision", "parallel", "subworkflow", "lp-task", "join"] as const;

const stepTitle = (step: MapStep, locale: Locale) => step.title?.[locale] || step.id;
const graphName = (graph: MapGraph, locale: Locale) => graph.name[locale] || graph.id;

/** What an owner types matches: the graph's name in either language, its id, tags, or a step's title, id, role or skills. */
function matches(data: MapData, query: string): { graphs: Set<string>; steps: Set<string> } {
  const needle = query.trim().toLowerCase();
  const graphs = new Set<string>();
  const steps = new Set<string>();
  if (needle) {
    for (const graph of data.graphs) {
      if ([graph.id, graph.name.en, graph.name.ru, ...graph.tags].some((text) => text.toLowerCase().includes(needle))) graphs.add(graph.id);
    }
    for (const step of data.steps) {
      if (graphs.has(step.graph)) { steps.add(`${step.graph}/${step.id}`); continue; }
      const hay = [step.id, step.title?.en ?? "", step.title?.ru ?? "", step.role ?? "", ...step.skills];
      if (hay.some((text) => text.toLowerCase().includes(needle))) steps.add(`${step.graph}/${step.id}`);
    }
  }
  return { graphs, steps };
}

// ------------------------------------------------------------------ layout

type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNode[]; edges?: { id: string; sources: string[]; targets: string[] }[]; layoutOptions?: Record<string, string> };
type ElkEngine = { layout(graph: ElkNode): Promise<ElkNode> };
let engine: Promise<ElkEngine> | null = null;
const elk = (): Promise<ElkEngine> => (engine ??= import("elkjs/lib/elk.bundled.js").then((module) => new module.default()));

export type MapLayout = { nodes: Node[]; edges: Edge[] };

/**
 * One elk run over the forest: a category is a compound node of graph boxes; an expanded graph is a compound node of its
 * steps. Inter-graph `calls` become edges from the calling step to the called graph's box (`INCLUDE_CHILDREN` lets a
 * leaf inside one group point at another group).
 */
export async function layoutMap(data: MapData, expanded: ReadonlySet<string>, dimmed: ReadonlySet<string>, locale: Locale = "en"): Promise<MapLayout> {
  const byGraph = new Map<string, { graph: MapGraph; steps: MapStep[] }>();
  for (const graph of data.graphs) byGraph.set(graph.id, { graph, steps: [] });
  for (const step of data.steps) byGraph.get(step.graph)?.steps.push(step);

  const categories = new Map<WorkflowCategory, MapGraph[]>();
  for (const graph of data.graphs) {
    const cat = (WORKFLOW_CATEGORIES as readonly string[]).includes(graph.category) ? graph.category as WorkflowCategory : "code";
    (categories.get(cat) ?? categories.set(cat, []).get(cat)!).push(graph);
  }

  const stepIds = new Set(data.steps.map((step) => `${step.graph}/${step.id}`));
  const children: ElkNode[] = [];
  const callEdges: ElkNode["edges"] = [];
  for (const cat of WORKFLOW_CATEGORIES) {
    const graphs = categories.get(cat);
    if (!graphs?.length) continue;
    const boxes: ElkNode[] = [];
    for (const graph of graphs) {
      const gid = `g:${graph.id}`;
      const steps = byGraph.get(graph.id)!.steps;
      if (expanded.has(graph.id) && steps.length) {
        const kids: ElkNode[] = steps.map((step) => ({ id: `s:${graph.id}/${step.id}`, width: STEP_W, height: STEP_H }));
        const inner = data.edges.filter((edge) => edge.graph === graph.id)
          .filter((edge) => stepIds.has(`${edge.graph}/${edge.from}`) && stepIds.has(`${edge.graph}/${edge.to}`))
          .map((edge, index) => ({ id: `e:${graph.id}:${index}`, sources: [`s:${edge.graph}/${edge.from}`], targets: [`s:${edge.graph}/${edge.to}`] }));
        boxes.push({ id: gid, children: kids, edges: inner, layoutOptions: {
          "elk.direction": "RIGHT",
          "elk.padding": "[top=44,left=14,bottom=14,right=14]",
          "elk.spacing.nodeNode": "16", "elk.layered.spacing.nodeNodeBetweenLayers": "64",
        } });
      } else {
        boxes.push({ id: gid, width: BOX_W, height: BOX_H });
      }
    }
    children.push({ id: `cat:${cat}`, children: boxes, layoutOptions: {
      "elk.direction": "DOWN", "elk.padding": "[top=44,left=18,bottom=18,right=18]",
      "elk.spacing.nodeNode": "28",
    } });
  }
  for (const call of data.calls) {
    const source = `s:${call.fromGraph}/${call.fromStep}`;
    callEdges.push({ id: `c:${call.fromGraph}/${call.fromStep}->${call.toGraph}`, sources: [expanded.has(call.fromGraph) && stepIds.has(source.slice(2)) ? source : `g:${call.fromGraph}`], targets: [`g:${call.toGraph}`] });
  }

  const laid = await (await elk()).layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "48", "elk.layered.spacing.nodeNodeBetweenLayers": "160",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
    },
    children, edges: callEdges,
  });

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const graphOf = new Map(data.graphs.map((graph) => [graph.id, graph]));
  const stepByRef = new Map(data.steps.map((step) => [`${step.graph}/${step.id}`, step]));
  const walk = (parent: ElkNode, parentId: string | null, offset: { x: number; y: number }) => {
    for (const child of parent.children ?? []) {
      const x = offset.x + (child.x ?? 0);
      const y = offset.y + (child.y ?? 0);
      if (child.id.startsWith("cat:")) {
        const cat = child.id.slice(4) as WorkflowCategory;
        nodes.push({ id: child.id, type: "category", position: { x, y }, data: { label: t(CAT_LABEL[cat] as Parameters<typeof t>[0]), cat }, selectable: false, draggable: false, style: { width: child.width, height: child.height } });
        walk(child, child.id, { x, y });
      } else if (child.id.startsWith("g:")) {
        const gid = child.id.slice(2);
        const graph = graphOf.get(gid)!;
        const open = expanded.has(gid) && (child.children?.length ?? 0) > 0;
        const dim = dimmed.has(`g:${gid}`);
        nodes.push({ id: child.id, type: open ? "graphGroup" : "graphBox", position: { x, y }, parentId: parentId ?? undefined, extent: "parent",
          data: { graph, dim, label: graph.name[locale] || graph.id, steps: byGraph.get(gid)?.steps.length ?? 0 },
          style: open ? { width: child.width, height: child.height } : { width: child.width ?? BOX_W, height: child.height ?? BOX_H } });
        if (child.children?.length) walk(child, child.id, { x, y });
      } else if (child.id.startsWith("s:")) {
        const ref = child.id.slice(2);
        const [gid, sid] = [ref.slice(0, ref.lastIndexOf("/")), ref.slice(ref.lastIndexOf("/") + 1)];
        const step = stepByRef.get(ref)!;
        nodes.push({ id: child.id, type: "step", position: { x, y }, parentId: parentId ?? undefined, extent: "parent",
          data: { step, dim: dimmed.has(child.id), label: step.title?.[locale] || step.id },
          style: { width: child.width ?? STEP_W, height: child.height ?? STEP_H } });
      }
    }
  };
  walk(laid, null, { x: 0, y: 0 });

  for (const edge of laid.edges ?? []) {
    for (const source of edge.sources) for (const target of edge.targets) {
      edges.push({ id: edge.id, source, target, className: "wm-call", animated: false,
        style: { stroke: "var(--lp-info)", strokeDasharray: "6 4", strokeWidth: 1.5, opacity: 0.9 } });
    }
  }
  // Edges inside expanded graphs.
  for (const edge of data.edges) {
    if (!expanded.has(edge.graph)) continue;
    const source = `s:${edge.graph}/${edge.from}`, target = `s:${edge.graph}/${edge.to}`;
    if (stepIds.has(`${edge.graph}/${edge.from}`) && stepIds.has(`${edge.graph}/${edge.to}`)) {
      edges.push({ id: `e:${edge.graph}:${edge.from}->${edge.to}`, source, target, style: { stroke: "var(--muted-foreground)", strokeWidth: 1.2, opacity: 0.7 } });
    }
  }
  return { nodes, edges };
}

// ------------------------------------------------------------------ nodes

function CategoryNode({ data }: NodeProps) {
  return (
    <div className="h-full w-full rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2" data-testid={`wm-cat-${data.cat as string}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{data.label as string}</div>
    </div>
  );
}

function graphStats(graph: MapGraph): string {
  if (!graph.runs30d) return t("wmNoStats");
  return t("wmGraphStats").replace("{runs}", String(graph.runs30d)).replace("{pct}", String(Math.round((graph.successRate ?? 0) * 100)));
}

function GraphBox({ id, data }: NodeProps) {
  const graph = data.graph as MapGraph;
  return (
    <div className="lp-card flex h-full w-full cursor-pointer flex-col justify-center rounded-lg border border-border px-3 py-2 shadow-sm transition-opacity hover:border-primary/60"
      data-testid={`wm-graph-${graph.id}`} data-dim={data.dim ? "1" : "0"} style={{ opacity: data.dim ? 0.25 : 1 }}>
      <Handle type="target" position={Position.Left} className="!invisible" />
      <Handle type="source" position={Position.Right} className="!invisible" />
      <div className="truncate text-sm font-medium" title={graph.id}>{(data.label as string) || graph.id}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t("wmStepCount").replace("{n}", String(data.steps as number))}</span>
        <span className="truncate">{graphStats(graph)}</span>
      </div>
    </div>
  );
}

function GraphGroup({ data }: NodeProps) {
  const graph = data.graph as MapGraph;
  return (
    <div className="h-full w-full rounded-lg border border-border bg-muted/30" data-testid={`wm-graph-${graph.id}`} data-dim={data.dim ? "1" : "0"} style={{ opacity: data.dim ? 0.35 : 1 }}>
      <Handle type="target" position={Position.Left} className="!invisible" />
      <Handle type="source" position={Position.Right} className="!invisible" />
      <div className="flex items-center gap-2 px-3 pt-2" data-testid={`wm-graph-head-${graph.id}`}>
        <span className="truncate text-sm font-medium" title={graph.id}>{(data.label as string) || graph.id}</span>
        <span className="text-[11px] text-muted-foreground">{graphStats(graph)}</span>
        <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" data-testid={`wm-collapse-${graph.id}`} data-collapse={graph.id} aria-label={t("wmClose")}>−</button>
      </div>
    </div>
  );
}

function StepNode({ data }: NodeProps) {
  const step = data.step as MapStep;
  const color = TYPE_COLOR[step.type] ?? "var(--muted-foreground)";
  return (
    <div className="flex h-full w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 transition-opacity hover:border-primary/60"
      data-testid={`wm-step-${step.graph}/${step.id}`} data-type={step.type} data-dim={data.dim ? "1" : "0"} style={{ opacity: data.dim ? 0.2 : 1 }}>
      <Handle type="target" position={Position.Left} className="!invisible" />
      <Handle type="source" position={Position.Right} className="!invisible" />
      <span className="h-6 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <div className="min-w-0">
        <div className="truncate text-xs font-medium" title={step.id}>{data.label as string}</div>
        <div className="truncate text-[10px] text-muted-foreground">{t((TYPE_LABEL[step.type] ?? "wmTypeAgent") as Parameters<typeof t>[0])}{step.role ? ` · ${step.role}` : ""}</div>
      </div>
    </div>
  );
}

const nodeTypes = { category: CategoryNode, graphBox: GraphBox, graphGroup: GraphGroup, step: StepNode };

// ------------------------------------------------------------------ screen

function ZoomExpand({ onZoom }: { onZoom: (zoom: number) => void }) {
  const { zoom } = useViewport();
  useEffect(() => onZoom(zoom), [zoom, onZoom]);
  return null;
}

export function WorkflowMap({ locale, projectId, onOpenGraph }: { locale: Locale; projectId?: string | null; onOpenGraph?: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ANY);
  const [clicked, setClicked] = useState<ReadonlySet<string>>(new Set());
  const [zoomed, setZoomed] = useState(false);
  const [layout, setLayout] = useState<MapLayout | null>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<{ graph: MapGraph; step: MapStep } | null>(null);
  const [copied, setCopied] = useState(false);
  // The step as markdown, to paste into a chat or hand to an agent.
  const copyStep = (graph: MapGraph, step: MapStep) => {
    const text = [`### ${stepTitle(step, locale)} (\`${step.id}\`) — ${graphName(graph, locale)} (\`${graph.id}\`)`, "", ...step.facts.map((fact) => `- **${fact.label}:** ${fact.value}`)].join("\n");
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    setData(null); setSelected(null); setClicked(new Set()); setReady(false);
    rpc.call("workflow_map", { ...(projectId ? { projectId } : {}), locale: locale === "ru" ? "ru" : "en" })
      .then((result) => { if (live) { setData(result); setError(null); } })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [rpc, projectId]);

  const filtered = useMemo(() => {
    if (!data || category === ANY) return data;
    const keep = new Set(data.graphs.filter((graph) => graph.category === category).map((graph) => graph.id));
    return { ...data, graphs: data.graphs.filter((graph) => keep.has(graph.id)), steps: data.steps.filter((step) => keep.has(step.graph)),
      edges: data.edges.filter((edge) => keep.has(edge.graph)), calls: data.calls.filter((call) => keep.has(call.fromGraph) && keep.has(call.toGraph)) };
  }, [data, category]);

  const found = useMemo(() => (filtered ? matches(filtered, query) : { graphs: new Set<string>(), steps: new Set<string>() }), [filtered, query]);
  const searching = query.trim().length > 0;
  const dimmed = useMemo(() => {
    const set = new Set<string>();
    if (!searching || !filtered) return set;
    for (const graph of filtered.graphs) if (!found.graphs.has(graph.id)) set.add(`g:${graph.id}`);
    for (const step of filtered.steps) if (!found.steps.has(`${step.graph}/${step.id}`) && !found.graphs.has(step.graph)) set.add(`s:${step.graph}/${step.id}`);
    return set;
  }, [filtered, found, searching]);

  // A graph expands when it is clicked or the view is zoomed in far enough to read its cards.
  const expanded = useMemo(() => {
    const ids = new Set(clicked);
    if (zoomed && filtered) for (const graph of filtered.graphs) ids.add(graph.id);
    return ids;
  }, [clicked, zoomed, filtered]);

  const onZoom = useCallback((zoom: number) => {
    setZoomed((was) => (was ? zoom >= COLLAPSE_ZOOM : zoom >= EXPAND_ZOOM));
  }, []);

  useEffect(() => {
    if (!filtered) return;
    const mine = ++generation.current;
    setReady(false);
    layoutMap(filtered, expanded, dimmed, locale)
      .then((next) => { if (mine === generation.current) { setLayout(next); setReady(true); } })
      .catch(() => { if (mine === generation.current) setReady(true); });
  }, [filtered, expanded, dimmed, locale]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === "step") {
      const step = node.data.step as MapStep;
      const graph = filtered?.graphs.find((item) => item.id === step.graph);
      if (graph) setSelected({ graph, step });
      return;
    }
    if (node.type === "graphBox") {
      const graph = node.data.graph as MapGraph;
      setClicked((prev) => new Set(prev).add(graph.id));
      setSelected(null);
      return;
    }
    if (node.type === "graphGroup") {
      const hit = ((_ as { target?: HTMLElement })?.target)?.closest?.("[data-collapse]");
      const gid = hit?.getAttribute("data-collapse");
      if (gid) setClicked((prev) => { const next = new Set(prev); next.delete(gid); return next; });
    }
  }, [filtered]);

  const stats = filtered
    ? t("wmStats").replace("{graphs}", String(filtered.graphs.length)).replace("{steps}", String(filtered.steps.length)).replace("{edges}", String(filtered.edges.length + filtered.calls.length))
    : "";

  return (
    <div className="flex min-h-[480px] min-w-0 flex-col gap-[var(--lp-gap,16px)]" data-testid="wf-map">
      <div className="lp-strip flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 text-xs text-muted-foreground" data-testid="wf-map-stats">
          {stats}
          {data?.commit ? ` · ${t("wmFromCommit").replace("{commit}", data.commit)}` : ""}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("wmSearch")} className="h-8 w-48 max-w-full text-xs" data-testid="wf-map-search" />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-8 w-40 text-xs" data-testid="wf-map-cat"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("wmCategoryAll")}</SelectItem>
              {WORKFLOW_CATEGORIES.map((cat) => <SelectItem key={cat} value={cat}>{t(CAT_LABEL[cat] as Parameters<typeof t>[0])}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs" data-testid="wf-map-error">{t("wmError").replace("{message}", error)}</div> : null}

      <div className="relative min-h-[480px] flex-1 overflow-hidden rounded-lg border border-border" data-testid="wf-map-canvas" data-layout={ready ? "ready" : "loading"}>
        {layout ? (
          // An absolute box: React Flow fills `height: 100%`, which resolves to 0 inside a flex item that has only a min-height (the map was blank).
          <div className="absolute inset-0"><ReactFlowProvider>
            <ReactFlow
              nodes={layout.nodes} edges={layout.edges} nodeTypes={nodeTypes}
              onNodeClick={onNodeClick} onPaneClick={() => setSelected(null)}
              minZoom={0.05} maxZoom={2} onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false}
              elementsSelectable fitView fitViewOptions={{ padding: 0.08 }}>
              <ZoomExpand onZoom={onZoom} />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap pannable zoomable className="!h-24 !w-36" />
              <Panel position="top-left">
                <div className="flex max-w-[70vw] flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground" data-testid="wf-map-legend">
                  {LEGEND_TYPES.map((type) => (
                    <span key={type} className="inline-flex items-center gap-1">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: TYPE_COLOR[type] }} />
                      {t(TYPE_LABEL[type] as Parameters<typeof t>[0])}
                    </span>
                  ))}
                  <span className="inline-flex items-center gap-1"><span className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: "var(--lp-info)" }} />{t("wmCalls")}</span>
                </div>
              </Panel>
            </ReactFlow>
          </ReactFlowProvider></div>
        ) : null}
        {searching && filtered && found.graphs.size === 0 && found.steps.size === 0 ? (
          <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground" data-testid="wf-map-empty">{t("wmEmpty")}</div>
        ) : null}

        {selected ? (
          <aside className="absolute inset-x-0 bottom-0 z-10 max-h-[45%] overflow-auto rounded-t-xl border-t border-border bg-card p-[var(--lp-card-pad,20px)] shadow-lg sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-4 sm:max-h-none sm:w-80 sm:rounded-xl sm:border" data-testid="wf-map-card">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{stepTitle(selected.step, locale)}</div>
                <div className="truncate text-xs text-muted-foreground">{graphName(selected.graph, locale)}</div>
              </div>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="wf-map-card-close" onClick={() => setSelected(null)}>{t("wmClose")}</Button>
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              {selected.step.facts.map((fact) => (
                <div key={fact.label} data-testid="wf-map-fact"><dt className="text-muted-foreground">{fact.label}</dt><dd className="whitespace-pre-wrap break-words">{fact.value}</dd></div>
              ))}
              <div><dt className="text-muted-foreground">stats</dt><dd>{graphStats(selected.graph)}</dd></div>
            </dl>
            <Button type="button" size="sm" variant="outline" className="mt-4 w-full" data-testid="wf-map-copy" onClick={() => copyStep(selected.graph, selected.step)}>
              {copied ? t("wmCopied") : t("wmCopyStep")}
            </Button>
            {onOpenGraph ? (
              <Button type="button" size="sm" className="mt-2 w-full" data-testid="wf-map-open" onClick={() => onOpenGraph(selected.graph.id)}>
                <Icon name="ArrowUpRight" className="mr-1 h-3.5 w-3.5" />{t("wmOpenGraph")}
              </Button>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
