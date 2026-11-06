import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useViewport, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import { t, type Locale } from "@lane-pilot/i18n";
import { Button, Icon, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from "../categories";

/**
 * «Карта графов»: every workflow of the library on one canvas — a cluster per category, a framed cell per graph, its steps
 * inside; dashed links mark a graph calling another (a subworkflow node). Semantic zoom: far out a graph is a chip with its
 * title, close up its steps and edges show (nothing moves). Opens on the category with the most runs, or on `?cat=`.
 */

type MapData = Omit<z.infer<typeof rpcContract.workflow_map.output>, "project">;
type MapGraph = MapData["graphs"][number];
type MapStep = MapData["steps"][number];

const STEP_W = 240;
const STEP_H = 64;
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
/**
 * The map's palette: one hue per category (oklch hue, chroma). A cluster, its graphs' accent bars and its legend chip all
 * take it, so a category reads as one colour from far out; the step types keep their own colours for the left bar.
 */
const CAT_HUE: Record<WorkflowCategory, [number, number]> = {
  seo: [25, 0.17], code: [255, 0.15], content: [160, 0.13], research: [300, 0.15],
  games: [200, 0.12], business: [85, 0.14], routines: [55, 0.16], service: [250, 0.03],
};
export const catColor = (cat: WorkflowCategory, lightness = 62, alpha = 1): string => {
  const [hue, chroma] = CAT_HUE[cat] ?? CAT_HUE.code;
  return `oklch(${lightness}% ${chroma} ${hue} / ${alpha})`;
};
const CANVAS_BG = "color-mix(in oklab, var(--background) 93%, var(--primary))";

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

export type MapLayout = { nodes: Node[]; edges: Edge[]; categories: WorkflowCategory[] };

const HEAD_H = 72;
const CELL_MIN_W = 480;
const CELL_MIN_H = 300;
const CELL_GAP = 48;
const CAT_HEAD = 380;
const CAT_PAD = 48;
const CAT_GAP = 200;
/** Steps are drawn from this zoom on; further out a graph is one chip with its title (semantic zoom). */
export const DETAIL_ZOOM = 0.6;
export const DETAIL_ZOOM_NARROW = 0.3;

/** Shelf packing: boxes in rows no wider than `maxW`; returns positions and the bounding size. */
function shelf(sizes: { w: number; h: number }[], maxW: number, gap: number): { at: { x: number; y: number }[]; w: number; h: number } {
  const at: { x: number; y: number }[] = [];
  let x = 0, y = 0, row = 0, w = 0;
  for (const size of sizes) {
    if (x > 0 && x + size.w > maxW) { x = 0; y += row + gap; row = 0; }
    at.push({ x, y });
    x += size.w + gap;
    row = Math.max(row, size.h);
    w = Math.max(w, x - gap);
  }
  return { at, w, h: y + row };
}

/** The largest font (canvas px) at which `text` fits the box when wrapped; the far-out chip title scales with its graph. */
export function chipFont(text: string, w: number, h: number): number {
  // Words wrap whole, so a line holds fewer characters than the width allows: 0.66 em per character keeps it inside.
  for (let size = 200; size > 20; size -= 2) {
    const perLine = Math.max(1, Math.floor((w - 56) / (size * 0.66)));
    let lines = 1, used = 0;
    for (const word of text.split(/\s+/)) {
      const need = used ? used + 1 + word.length : word.length;
      if (need <= perLine) { used = need; continue; }
      lines += used ? 1 : 0;
      lines += Math.floor(Math.max(0, word.length - 1) / perLine); // a word longer than a line breaks (break-words)
      used = word.length % perLine || perLine;
    }
    if (lines * size * 1.25 + 2 * size * 0.55 * 1.4 <= h - 56) return size;
  }
  return 20;
}

/** How visible a «calls» line is while neither of its graphs is hovered or picked. */
export const CALL_DIM = 0.08;
const graphIdOf = (node: Node): string | null =>
  node.type === "graphGroup" ? (node.data.graph as MapGraph).id : node.type === "step" ? (node.data.step as MapStep).graph : null;

const catOf = (graph: MapGraph): WorkflowCategory => (WORKFLOW_CATEGORIES as readonly string[]).includes(graph.category) ? graph.category as WorkflowCategory : "code";
const runsOf = (graphs: MapGraph[]) => graphs.reduce((sum, graph) => sum + graph.runs30d, 0);

/**
 * The library as a map: a cluster per category (most runs first), inside it a framed cell per graph (most runs first),
 * inside a cell the graph's steps laid out by elk. Every step is laid out once, so zooming only shows or hides them and
 * nothing moves; dashed edges join a graph to the graphs it calls.
 */
export async function layoutMap(data: MapData, dimmed: ReadonlySet<string>, locale: Locale = "en"): Promise<MapLayout> {
  const stepsOf = new Map<string, MapStep[]>();
  for (const step of data.steps) (stepsOf.get(step.graph) ?? stepsOf.set(step.graph, []).get(step.graph)!).push(step);
  const stepIds = new Set(data.steps.map((step) => `${step.graph}/${step.id}`));
  const innerEdges = (graphId: string) => data.edges
    .filter((edge) => edge.graph === graphId && stepIds.has(`${graphId}/${edge.from}`) && stepIds.has(`${graphId}/${edge.to}`));

  const laidGraphs = new Map<string, ElkNode>();
  const engineReady = await elk();
  await Promise.all(data.graphs.map(async (graph) => {
    const steps = stepsOf.get(graph.id) ?? [];
    const laid = await engineReady.layout({
      id: graph.id,
      layoutOptions: {
        "elk.algorithm": "layered", "elk.direction": "RIGHT",
        "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": "1.6",
        "elk.padding": `[top=${HEAD_H + 12},left=20,bottom=20,right=20]`,
        "elk.spacing.nodeNode": "18", "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      },
      children: steps.map((step) => ({ id: step.id, width: STEP_W, height: STEP_H })),
      edges: innerEdges(graph.id).map((edge, index) => ({ id: `${index}`, sources: [edge.from], targets: [edge.to] })),
    });
    laidGraphs.set(graph.id, laid);
  }));
  const sizeOf = (graph: MapGraph) => {
    const laid = laidGraphs.get(graph.id);
    return { w: Math.max(CELL_MIN_W, laid?.width ?? 0), h: Math.max(CELL_MIN_H, laid?.height ?? 0) };
  };

  const byCat = new Map<WorkflowCategory, MapGraph[]>();
  for (const graph of data.graphs) (byCat.get(catOf(graph)) ?? byCat.set(catOf(graph), []).get(catOf(graph))!).push(graph);
  // Most runs first; the service graphs (lp.*) always last — they run the most and say the least about the owner's work.
  const categories = [...byCat.keys()].sort((a, b) => Number(a === "service") - Number(b === "service")
    || runsOf(byCat.get(b)!) - runsOf(byCat.get(a)!) || WORKFLOW_CATEGORIES.indexOf(a) - WORKFLOW_CATEGORIES.indexOf(b));

  const clusters = categories.map((cat) => {
    const graphs = [...byCat.get(cat)!].sort((a, b) => b.runs30d - a.runs30d || a.id.localeCompare(b.id));
    const sizes = graphs.map(sizeOf);
    const area = sizes.reduce((sum, size) => sum + (size.w + CELL_GAP) * (size.h + CELL_GAP), 0);
    const widest = Math.max(...sizes.map((size) => size.w));
    const packed = shelf(sizes, Math.max(widest, Math.sqrt(area * 1.6)), CELL_GAP);
    return { cat, graphs, sizes, packed, w: packed.w + CAT_PAD * 2, h: packed.h + CAT_HEAD + CAT_PAD };
  });
  const totalArea = clusters.reduce((sum, cluster) => sum + (cluster.w + CAT_GAP) * (cluster.h + CAT_GAP), 0);
  const placed = shelf(clusters, Math.max(...clusters.map((cluster) => cluster.w), Math.sqrt(totalArea * 1.8)), CAT_GAP);

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  clusters.forEach((cluster, index) => {
    const catId = `cat:${cluster.cat}`;
    nodes.push({ id: catId, type: "category", position: placed.at[index]!, selectable: false, draggable: false,
      data: { label: t(CAT_LABEL[cluster.cat] as Parameters<typeof t>[0]), cat: cluster.cat, count: cluster.graphs.length, runs: runsOf(cluster.graphs) },
      style: { width: cluster.w, height: cluster.h } });
    cluster.graphs.forEach((graph, at) => {
      const size = cluster.sizes[at]!;
      const label = graph.name[locale] || graph.id;
      const gid = `g:${graph.id}`;
      nodes.push({ id: gid, type: "graphGroup", parentId: catId, extent: "parent", selectable: false,
        position: { x: CAT_PAD + cluster.packed.at[at]!.x, y: CAT_HEAD + cluster.packed.at[at]!.y },
        data: { graph, label, cat: cluster.cat, dim: dimmed.has(gid), steps: stepsOf.get(graph.id)?.length ?? 0, font: chipFont(label, size.w, size.h) },
        style: { width: size.w, height: size.h } });
      for (const child of laidGraphs.get(graph.id)?.children ?? []) {
        const step = (stepsOf.get(graph.id) ?? []).find((item) => item.id === child.id)!;
        const sid = `s:${graph.id}/${step.id}`;
        nodes.push({ id: sid, type: "step", parentId: gid, extent: "parent", position: { x: child.x ?? 0, y: child.y ?? 0 },
          data: { step, dim: dimmed.has(sid), label: step.title?.[locale] || step.id }, style: { width: STEP_W, height: STEP_H } });
      }
      innerEdges(graph.id).forEach((edge) => {
        edges.push({ id: `e:${graph.id}:${edge.from}->${edge.to}`, source: `s:${graph.id}/${edge.from}`, target: `s:${graph.id}/${edge.to}`,
          data: { graph: graph.id }, style: { stroke: catColor(cluster.cat, 45, 0.55), strokeWidth: 1.6 } });
      });
    });
  });
  const seen = new Set<string>();
  for (const call of data.calls) {
    const id = `c:${call.fromGraph}->${call.toGraph}`;
    if (seen.has(id) || call.fromGraph === call.toGraph) continue;
    seen.add(id);
    edges.push({ id, source: `g:${call.fromGraph}`, target: `g:${call.toGraph}`, className: "wm-call", zIndex: 0,
      data: { from: call.fromGraph, to: call.toGraph },
      style: { stroke: "var(--lp-info)", strokeDasharray: "10 8", strokeWidth: 3, opacity: CALL_DIM } });
  }
  return { nodes, edges, categories };
}

// ------------------------------------------------------------------ nodes

function CategoryNode({ data }: NodeProps) {
  const cat = data.cat as WorkflowCategory;
  return (
    <div className="h-full w-full rounded-[48px] px-14 py-10" data-testid={`wm-cat-${cat}`}
      style={{ background: catColor(cat, 72, 0.08), border: `3px solid ${catColor(cat, 62, 0.28)}` }}>
      <div className="flex items-center gap-8">
        <span className="h-24 w-24 shrink-0 rounded-[28px]" style={{ background: catColor(cat, 62, 0.85) }} />
        <div className="font-extrabold leading-none tracking-tight" style={{ fontSize: 190, color: catColor(cat, 50, 0.6) }}>{data.label as string}</div>
      </div>
      <div className="mt-6 font-medium" style={{ fontSize: 60, color: catColor(cat, 42, 0.75) }}>
        {t("wmCatSummary").replace("{graphs}", String(data.count as number)).replace("{runs}", String(data.runs as number))}
      </div>
    </div>
  );
}

function graphStats(graph: MapGraph): string {
  if (!graph.runs30d) return t("wmNoStats");
  return t("wmGraphStats").replace("{runs}", String(graph.runs30d)).replace("{pct}", String(Math.round((graph.successRate ?? 0) * 100)));
}

/** A graph's frame: far out a white chip with a category bar and a title that fills it; close up a tinted frame over its steps. */
function GraphGroup({ data }: NodeProps) {
  const graph = data.graph as MapGraph;
  const cat = data.cat as WorkflowCategory;
  const detail = data.detail as boolean;
  const font = data.font as number;
  const ran = graph.runs30d > 0;
  const meta = (size: number) => (
    <div className="mt-3 flex flex-wrap items-center gap-3" style={{ fontSize: size }}>
      <span className="text-muted-foreground">{t("wmStepCount").replace("{n}", String(data.steps as number))}</span>
      <span className="rounded-full px-[0.6em] py-[0.15em] font-medium"
        style={ran ? { background: catColor(cat, 62, 0.14), color: catColor(cat, 38) } : { background: "var(--muted)", color: "var(--muted-foreground)" }}>
        {graphStats(graph)}
      </span>
    </div>
  );
  return (
    <div className="relative h-full w-full cursor-pointer overflow-hidden rounded-3xl transition-shadow"
      data-testid={`wm-graph-${graph.id}`} data-dim={data.dim ? "1" : "0"} data-detail={detail ? "1" : "0"}
      style={{
        opacity: data.dim ? 0.25 : ran || detail ? 1 : 0.82,
        background: detail ? catColor(cat, 72, 0.06) : "var(--card)",
        border: `2px solid ${catColor(cat, 62, detail ? 0.35 : 0.22)}`,
        boxShadow: detail ? "none" : `0 2px 4px rgb(0 0 0 / 0.04), 0 22px 44px -24px ${catColor(cat, 45, 0.45)}`,
      }}>
      <Handle type="target" position={Position.Left} className="!invisible" />
      <Handle type="source" position={Position.Right} className="!invisible" />
      <div className="absolute inset-x-0 top-0 h-3" style={{ background: catColor(cat, 62, detail ? 0.5 : 0.9) }} />
      {detail ? (
        <div className="flex items-baseline gap-3 px-5 pt-6" data-testid={`wm-graph-head-${graph.id}`}>
          <span className="truncate text-2xl font-semibold" title={graph.id}>{data.label as string}</span>
          <span className="shrink-0 text-sm text-muted-foreground">{t("wmStepCount").replace("{n}", String(data.steps as number))} · {graphStats(graph)}</span>
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center overflow-hidden px-7 pb-5 pt-8">
          <div className="break-words font-semibold leading-tight tracking-tight" style={{ fontSize: font }}>{data.label as string}</div>
          {meta(Math.max(18, font * 0.42))}
        </div>
      )}
    </div>
  );
}

function StepNode({ data }: NodeProps) {
  const step = data.step as MapStep;
  const color = TYPE_COLOR[step.type] ?? "var(--muted-foreground)";
  return (
    <div className="flex h-full w-full cursor-pointer flex-col justify-center rounded-[10px] border border-border bg-card py-1.5 pl-3 pr-2 shadow-sm transition-shadow hover:shadow-md"
      data-testid={`wm-step-${step.graph}/${step.id}`} data-type={step.type} data-dim={data.dim ? "1" : "0"}
      style={{ opacity: data.dim ? 0.2 : 1, borderLeft: `5px solid ${color}` }}>
      <Handle type="target" position={Position.Left} className="!invisible" />
      <Handle type="source" position={Position.Right} className="!invisible" />
      <div className="truncate text-[15px] font-medium leading-snug" title={step.id}>{data.label as string}</div>
      <div className="truncate text-xs text-muted-foreground">{t((TYPE_LABEL[step.type] ?? "wmTypeAgent") as Parameters<typeof t>[0])}{step.role ? ` · ${step.role}` : ""}</div>
    </div>
  );
}

const nodeTypes = { category: CategoryNode, graphGroup: GraphGroup, step: StepNode };

// ------------------------------------------------------------------ screen

function ZoomWatch({ onZoom }: { onZoom: (zoom: number) => void }) {
  const { zoom } = useViewport();
  useEffect(() => onZoom(zoom), [zoom, onZoom]);
  return null;
}

/** Moves the view to the picked category's cluster, or to the whole map for «all», whenever the pick or the layout changes. */
function FitTo({ target, layout }: { target: string; layout: MapLayout }) {
  const flow = useReactFlow();
  useEffect(() => {
    const run = () => void flow.fitView(target === ANY ? { padding: 0.04, duration: 300 } : { nodes: [{ id: `cat:${target}` }], padding: 0.03, duration: 300 });
    const timer = setTimeout(run, 30);
    return () => clearTimeout(timer);
  }, [flow, target, layout]);
  return null;
}

/** `?cat=<category>` in the page address opens the map on that cluster. */
const catFromUrl = (): string | null => {
  try { return new URLSearchParams(globalThis.location?.search ?? "").get("cat"); } catch { return null; }
};

export function WorkflowMap({ locale, projectId, onOpenGraph }: { locale: Locale; projectId?: string | null; onOpenGraph?: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState(0);
  const [layout, setLayout] = useState<MapLayout | null>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<{ graph: MapGraph; step: MapStep } | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const [copied, setCopied] = useState(false);
  // The step as markdown, to paste into a chat or hand to an agent.
  const copyStep = (graph: MapGraph, step: MapStep) => {
    const text = [`### ${stepTitle(step, locale)} (\`${step.id}\`) — ${graphName(graph, locale)} (\`${graph.id}\`)`, "", ...step.facts.map((fact) => `- **${fact.label}:** ${fact.value}`)].join("\n");
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    setData(null); setSelected(null); setOpened(new Set()); setReady(false);
    rpc.call("workflow_map", { ...(projectId ? { projectId } : {}), locale: locale === "ru" ? "ru" : "en" })
      .then((result) => { if (live) { setData(result); setError(null); } })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [rpc, projectId]);

  const found = useMemo(() => (data ? matches(data, query) : { graphs: new Set<string>(), steps: new Set<string>() }), [data, query]);
  const searching = query.trim().length > 0;
  const dimmed = useMemo(() => {
    const set = new Set<string>();
    if (!searching || !data) return set;
    for (const graph of data.graphs) if (!found.graphs.has(graph.id)) set.add(`g:${graph.id}`);
    for (const step of data.steps) if (!found.steps.has(`${step.graph}/${step.id}`) && !found.graphs.has(step.graph)) set.add(`s:${step.graph}/${step.id}`);
    return set;
  }, [data, found, searching]);

  useEffect(() => {
    if (!data) return;
    const mine = ++generation.current;
    setReady(false);
    layoutMap(data, dimmed, locale)
      .then((next) => {
        if (mine !== generation.current) return;
        setLayout(next);
        // Opens on `?cat=` when it names a cluster, else on the category with the most runs (the first cluster).
        setCategory((was) => was ?? (next.categories.includes(catFromUrl() as WorkflowCategory) ? catFromUrl()! : next.categories[0] ?? ANY));
        setReady(true);
      })
      .catch(() => { if (mine === generation.current) setReady(true); });
  }, [data, dimmed, locale]);

  // Semantic zoom: far out a graph is a chip; from DETAIL_ZOOM on (or once clicked) its steps and edges show. Nothing is re-laid out.
  // A phone shows steps from a lower zoom: a whole graph fits its 375 px only well below DETAIL_ZOOM.
  const detail = zoom >= ((globalThis.innerWidth ?? 1280) < 640 ? DETAIL_ZOOM_NARROW : DETAIL_ZOOM);
  const shown = useMemo(() => {
    if (!layout) return null;
    const open = (graphId: string) => detail || opened.has(graphId);
    return {
      nodes: layout.nodes.map((node) => node.type === "graphGroup" ? { ...node, data: { ...node.data, detail: open((node.data.graph as MapGraph).id) } }
        : node.type === "step" ? { ...node, hidden: !open((node.data.step as MapStep).graph) } : node),
      edges: layout.edges.map((edge) => {
        if (edge.data?.graph) return { ...edge, hidden: !open(edge.data.graph as string) };
        // «Calls» lines stay faint unless one of their two graphs is hovered or has the picked step.
        const lit = edge.data && [hot, selected?.graph.id].some((id) => id && (id === edge.data!.from || id === edge.data!.to));
        return lit ? { ...edge, style: { ...edge.style, opacity: 0.9 } } : edge;
      }),
    };
  }, [layout, detail, opened, hot, selected]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === "step") {
      const step = node.data.step as MapStep;
      const graph = data?.graphs.find((item) => item.id === step.graph);
      if (graph) setSelected({ graph, step });
      return;
    }
    if (node.type === "graphGroup") {
      const graph = node.data.graph as MapGraph;
      setOpened((prev) => new Set(prev).add(graph.id));
      setSelected(null);
      // A tap on a graph also moves the view onto it, so its steps are readable on a phone too.
      setTimeout(() => void flowRef.current?.fitView({ nodes: [{ id: node.id }], padding: 0.04, duration: 300 }), 30);
    }
  }, [data]);

  const picked = category && category !== ANY ? data?.graphs.filter((graph) => catOf(graph) === category) ?? [] : data?.graphs ?? [];
  const pickedIds = new Set(picked.map((graph) => graph.id));
  const stats = data
    ? t("wmStats").replace("{graphs}", String(picked.length)).replace("{steps}", String(data.steps.filter((step) => pickedIds.has(step.graph)).length))
      .replace("{edges}", String(data.edges.filter((edge) => pickedIds.has(edge.graph)).length + data.calls.filter((call) => pickedIds.has(call.fromGraph)).length))
    : "";

  return (
    <div className="flex min-w-0 flex-col gap-[var(--lp-gap,16px)]" data-testid="wf-map">
      {/* Head: a dark band with the title, the counters and the controls, then the legend — both outside the canvas. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card" data-testid="wf-map-head">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-foreground px-[20px] py-3 text-background">
          <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[11px] font-bold text-white"
              style={{ background: `linear-gradient(135deg, ${catColor("games", 70)}, ${catColor("code", 55)})` }}>LP</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold">{t("wfTabMap")}</div>
              <div className="truncate text-xs opacity-70" data-testid="wf-map-stats">
                {stats}
                {data?.commit ? ` · ${t("wmFromCommit").replace("{commit}", data.commit)}` : ""}
              </div>
            </div>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 text-foreground sm:w-auto">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("wmSearch")} className="h-8 w-full min-w-0 text-xs sm:w-56" data-testid="wf-map-search" />
            <Select value={category ?? ANY} onValueChange={(value) => { setCategory(value); setSelected(null); }}>
              <SelectTrigger className="h-8 w-full text-xs sm:w-40" data-testid="wf-map-cat"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t("wmCategoryAll")}</SelectItem>
                {(layout?.categories ?? WORKFLOW_CATEGORIES).map((cat) => <SelectItem key={cat} value={cat}>{t(CAT_LABEL[cat] as Parameters<typeof t>[0])}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-[20px] py-3 text-[11px] text-muted-foreground" data-testid="wf-map-legend">
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            <span className="shrink-0 font-semibold uppercase tracking-wide">{t("wmLegendCats")}</span>
            {(layout?.categories ?? []).map((cat) => {
              const on = category === cat;
              return (
                <button key={cat} type="button" data-testid={`wf-map-chip-${cat}`} aria-pressed={on} onClick={() => { setCategory(on ? ANY : cat); setSelected(null); }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition-colors"
                  style={on ? { background: catColor(cat, 62, 0.16), borderColor: catColor(cat, 55, 0.6), color: catColor(cat, 35) } : { borderColor: "var(--border)" }}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: catColor(cat, 62) }} />
                  {t(CAT_LABEL[cat] as Parameters<typeof t>[0])}
                </button>
              );
            })}
          </div>
          <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 sm:flex">
            <span className="font-semibold uppercase tracking-wide">{t("wmLegendSteps")}</span>
            {LEGEND_TYPES.map((type) => (
              <span key={type} className="inline-flex items-center gap-1.5">
                <span className="h-3 w-1.5 rounded-full" style={{ backgroundColor: TYPE_COLOR[type] }} />
                {t(TYPE_LABEL[type] as Parameters<typeof t>[0])}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: "var(--lp-info)" }} />{t("wmCalls")}</span>
            <span className="ml-auto">{detail ? t("wmZoomOut") : t("wmZoomIn")}</span>
          </div>
        </div>
      </div>

      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs" data-testid="wf-map-error">{t("wmError").replace("{message}", error)}</div> : null}

      {/* The window's height (720 px at least); React Flow sits in an absolute box, its `height: 100%` needs a sized parent. */}
      <div className="relative overflow-hidden rounded-xl border border-border" style={{ height: "max(720px, calc(100vh - 240px))", background: CANVAS_BG }}
        data-testid="wf-map-canvas" data-layout={ready ? "ready" : "loading"} data-focus={category ?? ""} data-detail={detail ? "1" : "0"}>
        {shown && layout ? (
          <div className="absolute inset-0"><ReactFlowProvider>
            <ReactFlow
              nodes={shown.nodes} edges={shown.edges} nodeTypes={nodeTypes}
              onInit={(instance) => { flowRef.current = instance; }}
              onNodeClick={onNodeClick} onPaneClick={() => setSelected(null)}
              onNodeMouseEnter={(_, node) => setHot(graphIdOf(node))} onNodeMouseLeave={() => setHot(null)}
              minZoom={0.02} maxZoom={2} onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} elementsSelectable>
              <Background variant={BackgroundVariant.Dots} gap={28} size={1.6} color="color-mix(in oklab, var(--muted-foreground) 35%, transparent)" />
              <ZoomWatch onZoom={setZoom} />
              <FitTo target={category ?? ANY} layout={layout} />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
          </ReactFlowProvider></div>
        ) : null}
        {searching && data && found.graphs.size === 0 && found.steps.size === 0 ? (
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
