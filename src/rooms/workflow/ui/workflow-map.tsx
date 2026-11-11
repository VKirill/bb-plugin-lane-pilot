import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, ControlButton, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useViewport, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
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
  seo: "wmCatSeo", marketing: "wmCatMarketing", code: "wmCatCode", content: "wmCatContent", research: "wmCatResearch",
  games: "wmCatGames", business: "wmCatBusiness", routines: "wmCatRoutines", service: "wmCatService",
};
/**
 * The map's palette: one hue per category (oklch hue, chroma). A cluster, its graphs' accent bars and its legend chip all
 * take it, so a category reads as one colour from far out; the step types keep their own colours for the left bar.
 */
const CAT_HUE: Record<WorkflowCategory, [number, number]> = {
  seo: [25, 0.17], marketing: [340, 0.16], code: [255, 0.15], content: [160, 0.13], research: [300, 0.15],
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

export type MapMode = "overview" | "detail";
/** One drawing of the map: its nodes (stable objects, never rebuilt by hover or search) and each graph's centre. */
export type ModeLayout = { nodes: Node[]; centers: Map<string, { x: number; y: number }> };
/**
 * Two drawings of the same map, laid out once: «overview» — every graph a chip of one size in a grid per category;
 * «detail» — every graph a frame sized by its steps, steps inside. Edges: the steps' own (detail only) and graph→graph calls,
 * each call also in a lit version, so a hover swaps one edge object and touches nothing else.
 */
export type MapLayout = {
  overview: ModeLayout; detail: ModeLayout; categories: WorkflowCategory[];
  innerEdges: Edge[]; callEdges: Edge[]; litCalls: Map<string, Edge>;
};

const HEAD_H = 72;
const CELL_MIN_W = 480;
const CELL_MIN_H = 300;
const CELL_GAP = 48;
const CAT_HEAD = 340;
/** Overview chip: one size and one type scale for every graph. */
export const CHIP_W = 520;
export const CHIP_H = 312;
const CHIP_TITLE = 54;
const CHIP_META = 26;
/** The cluster title: one line, and the cluster is at least as wide as it. */
const CAT_TITLE = 170;
const titleWidth = (label: string) => CAT_PAD * 2 + 120 + Math.ceil(label.length * CAT_TITLE * 0.64);
const CAT_PAD = 48;
const CAT_GAP = 200;
/** Steps are drawn from this zoom on; further out a graph is one chip with its title (semantic zoom). */
export const DETAIL_ZOOM = 0.6;
export const DETAIL_ZOOM_NARROW = 0.3;
/** Back to the overview below this share of the switch-in zoom (hysteresis: a fitted graph does not flip back). */
const DETAIL_OUT = 0.4;

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


/** How visible a «calls» line is while neither of its graphs is hovered or picked. */
export const CALL_DIM = 0.08;
const graphIdOf = (node: Node): string | null =>
  node.type === "graphGroup" ? (node.data.graph as MapGraph).id : node.type === "step" ? (node.data.step as MapStep).graph : null;

const catOf = (graph: MapGraph): WorkflowCategory => (WORKFLOW_CATEGORIES as readonly string[]).includes(graph.category) ? graph.category as WorkflowCategory : "code";
const runsOf = (graphs: MapGraph[]) => graphs.reduce((sum, graph) => sum + graph.runs30d, 0);

/**
 * The library as a map: a cluster per category (most runs first, service last), a cell per graph (most runs first).
 * Both drawings are laid out here once; the screen only picks one and never re-lays out on hover, search or zoom.
 */
export async function layoutMap(data: MapData, locale: Locale = "en"): Promise<MapLayout> {
  const stepsOf = new Map<string, MapStep[]>();
  for (const step of data.steps) (stepsOf.get(step.graph) ?? stepsOf.set(step.graph, []).get(step.graph)!).push(step);
  const stepIds = new Set(data.steps.map((step) => `${step.graph}/${step.id}`));
  const innerOf = (graphId: string) => data.edges
    .filter((edge) => edge.graph === graphId && stepIds.has(`${graphId}/${edge.from}`) && stepIds.has(`${graphId}/${edge.to}`));

  const laidGraphs = new Map<string, ElkNode>();
  const engineReady = await elk();
  await Promise.all(data.graphs.map(async (graph) => {
    const laid = await engineReady.layout({
      id: graph.id,
      layoutOptions: {
        "elk.algorithm": "layered", "elk.direction": "RIGHT",
        "elk.layered.wrapping.strategy": "MULTI_EDGE", "elk.aspectRatio": "1.6",
        "elk.padding": `[top=${HEAD_H + 12},left=20,bottom=20,right=20]`,
        "elk.spacing.nodeNode": "18", "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      },
      children: (stepsOf.get(graph.id) ?? []).map((step) => ({ id: step.id, width: STEP_W, height: STEP_H })),
      edges: innerOf(graph.id).map((edge, index) => ({ id: `${index}`, sources: [edge.from], targets: [edge.to] })),
    });
    laidGraphs.set(graph.id, laid);
  }));

  const byCat = new Map<WorkflowCategory, MapGraph[]>();
  for (const graph of data.graphs) (byCat.get(catOf(graph)) ?? byCat.set(catOf(graph), []).get(catOf(graph))!).push(graph);
  // Most runs first; the service graphs (lp.*) always last — they run the most and say the least about the owner's work.
  const categories = [...byCat.keys()].sort((a, b) => Number(a === "service") - Number(b === "service")
    || runsOf(byCat.get(b)!) - runsOf(byCat.get(a)!) || WORKFLOW_CATEGORIES.indexOf(a) - WORKFLOW_CATEGORIES.indexOf(b));
  const sorted = new Map(categories.map((cat) => [cat, [...byCat.get(cat)!].sort((a, b) => b.runs30d - a.runs30d || a.id.localeCompare(b.id))]));
  const catLabel = (cat: WorkflowCategory) => t(CAT_LABEL[cat] as Parameters<typeof t>[0]);

  const draw = (mode: MapMode): ModeLayout => {
    const sizeOf = (graph: MapGraph) => {
      if (mode === "overview") return { w: CHIP_W, h: CHIP_H };
      const laid = laidGraphs.get(graph.id);
      return { w: Math.max(CELL_MIN_W, laid?.width ?? 0), h: Math.max(CELL_MIN_H, laid?.height ?? 0) };
    };
    const clusters = categories.map((cat) => {
      const graphs = sorted.get(cat)!;
      const sizes = graphs.map(sizeOf);
      const area = sizes.reduce((sum, size) => sum + (size.w + CELL_GAP) * (size.h + CELL_GAP), 0);
      // Overview: a uniform grid (≈ square in screen terms); detail: shelf rows of step-sized frames.
      const rowW = mode === "overview"
        ? Math.ceil(Math.sqrt(graphs.length * 1.4)) * (CHIP_W + CELL_GAP) - CELL_GAP
        : Math.max(...sizes.map((size) => size.w), Math.sqrt(area * 1.6));
      const packed = shelf(sizes, rowW, CELL_GAP);
      return { cat, graphs, sizes, packed, w: Math.max(packed.w + CAT_PAD * 2, titleWidth(catLabel(cat))), h: packed.h + CAT_HEAD + CAT_PAD };
    });
    const totalArea = clusters.reduce((sum, cluster) => sum + (cluster.w + CAT_GAP) * (cluster.h + CAT_GAP), 0);
    const placed = shelf(clusters, Math.max(...clusters.map((cluster) => cluster.w), Math.sqrt(totalArea * 1.8)), CAT_GAP);
    const nodes: Node[] = [];
    const centers = new Map<string, { x: number; y: number }>();
    clusters.forEach((cluster, index) => {
      const catId = `cat:${cluster.cat}`;
      const origin = placed.at[index]!;
      nodes.push({ id: catId, type: "category", position: origin, selectable: false, draggable: false,
        data: { label: catLabel(cluster.cat), cat: cluster.cat, count: cluster.graphs.length, runs: runsOf(cluster.graphs) },
        style: { width: cluster.w, height: cluster.h } });
      cluster.graphs.forEach((graph, at) => {
        const size = cluster.sizes[at]!;
        const gid = `g:${graph.id}`;
        const position = { x: CAT_PAD + cluster.packed.at[at]!.x, y: CAT_HEAD + cluster.packed.at[at]!.y };
        centers.set(graph.id, { x: origin.x + position.x + size.w / 2, y: origin.y + position.y + size.h / 2 });
        nodes.push({ id: gid, type: "graphGroup", parentId: catId, extent: "parent", selectable: false, position,
          data: { graph, label: graph.name[locale] || graph.id, lang: graph.name[locale] ? locale : "en", cat: cluster.cat, mode, steps: stepsOf.get(graph.id)?.length ?? 0, dim: false },
          style: { width: size.w, height: size.h } });
        if (mode === "overview") return;
        for (const child of laidGraphs.get(graph.id)?.children ?? []) {
          const step = (stepsOf.get(graph.id) ?? []).find((item) => item.id === child.id)!;
          nodes.push({ id: `s:${graph.id}/${step.id}`, type: "step", parentId: gid, extent: "parent", position: { x: child.x ?? 0, y: child.y ?? 0 },
            data: { step, dim: false, label: step.title?.[locale] || step.id }, style: { width: STEP_W, height: STEP_H } });
        }
      });
    });
    return { nodes, centers };
  };

  const innerEdges: Edge[] = [];
  for (const graph of data.graphs) {
    for (const edge of innerOf(graph.id)) {
      innerEdges.push({ id: `e:${graph.id}:${edge.from}->${edge.to}`, source: `s:${graph.id}/${edge.from}`, target: `s:${graph.id}/${edge.to}`,
        data: { graph: graph.id }, style: { stroke: catColor(catOf(graph), 45, 0.55), strokeWidth: 1.6 } });
    }
  }
  const callEdges: Edge[] = [];
  const litCalls = new Map<string, Edge>();
  const seen = new Set<string>();
  for (const call of data.calls) {
    const id = `c:${call.fromGraph}->${call.toGraph}`;
    if (seen.has(id) || call.fromGraph === call.toGraph) continue;
    seen.add(id);
    const edge: Edge = { id, source: `g:${call.fromGraph}`, target: `g:${call.toGraph}`, className: "wm-call", zIndex: 0,
      data: { from: call.fromGraph, to: call.toGraph },
      style: { stroke: "var(--lp-info)", strokeDasharray: "10 8", strokeWidth: 3, opacity: CALL_DIM } };
    callEdges.push(edge);
    litCalls.set(id, { ...edge, style: { ...edge.style, opacity: 0.9 } });
  }
  return { overview: draw("overview"), detail: draw("detail"), categories, innerEdges, callEdges, litCalls };
}

/** The nodes to draw: the layout's own objects, except the few whose dim flag the search changes (hover touches none). */
export function viewNodes(layout: MapLayout, mode: MapMode, dimmed: ReadonlySet<string>): Node[] {
  return layout[mode].nodes.map((node) => {
    if (node.type === "category") return node;
    const dim = dimmed.has(node.id);
    return dim === Boolean(node.data.dim) ? node : { ...node, data: { ...node.data, dim } };
  });
}

/** The edges to draw: «calls» lines are faint except those of the hovered or picked graph, which swap to their lit copy. */
export function viewEdges(layout: MapLayout, mode: MapMode, lit: ReadonlyArray<string | null | undefined>): Edge[] {
  const on = lit.filter(Boolean) as string[];
  const calls = on.length ? layout.callEdges.map((edge) => on.some((id) => id === edge.data!.from || id === edge.data!.to) ? layout.litCalls.get(edge.id)! : edge) : layout.callEdges;
  return mode === "detail" ? [...layout.innerEdges, ...calls] : calls;
}

// ------------------------------------------------------------------ nodes

function CategoryNode({ data }: NodeProps) {
  const cat = data.cat as WorkflowCategory;
  return (
    <div className="h-full w-full rounded-[48px] px-14 py-10" data-testid={`wm-cat-${cat}`}
      style={{ background: catColor(cat, 72, 0.08), border: `3px solid ${catColor(cat, 62, 0.28)}` }}>
      <div className="flex items-center gap-8">
        <span className="h-24 w-24 shrink-0 rounded-[28px]" style={{ background: catColor(cat, 62, 0.85) }} />
        <div className="min-w-0 truncate whitespace-nowrap font-extrabold leading-none tracking-tight" style={{ fontSize: CAT_TITLE, color: catColor(cat, 50, 0.6) }}>{data.label as string}</div>
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

const VOWEL = /[аеёиоуыэюяaeiouy]/i;
/**
 * Soft hyphens at syllable joins of long Cyrillic words (≥ 10 letters), so a narrow chip breaks «Исследова-тельский» with
 * a hyphen even where the browser has no Russian hyphenation dictionary (Chrome on Linux). Rules: a break needs a vowel on
 * both sides and two letters at each end; after й/ь/ъ; between vowel and consonant+vowel; between two consonants.
 */
// ponytail: syllable heuristics, not a dictionary — a rare odd split, swap for a pattern set if titles ever look wrong
export function softHyphens(text: string): string {
  return text.replace(/[а-яё]{10,}/gi, (word) => {
    let out = word[0]!;
    for (let i = 1; i < word.length; i++) {
      const left = word.slice(0, i), right = word.slice(i);
      const prev = word[i - 1]!, here = word[i]!, next = word[i + 1] ?? "";
      const ok = i >= 2 && right.length >= 2 && VOWEL.test(left) && VOWEL.test(right) && (
        /[йьъ]/i.test(prev)
        || (VOWEL.test(prev) && !VOWEL.test(here) && VOWEL.test(next))
        || (!VOWEL.test(prev) && !/[йьъ]/i.test(prev) && !VOWEL.test(here) && !/[йьъ]/i.test(here) && VOWEL.test(word[i - 2]!))
      );
      out += (ok ? "\u00ad" : "") + here;
    }
    return out;
  });
}

/** A graph: in the overview a chip of the one size and type scale; in the detail view a tinted frame over its steps. */
function GraphGroup({ data }: NodeProps) {
  const graph = data.graph as MapGraph;
  const cat = data.cat as WorkflowCategory;
  const detail = data.mode === "detail";
  const ran = graph.runs30d > 0;
  const steps = t("wmStepCount").replace("{n}", String(data.steps as number));
  return (
    <div className="relative h-full w-full cursor-pointer overflow-hidden rounded-3xl"
      data-testid={`wm-graph-${graph.id}`} data-dim={data.dim ? "1" : "0"} data-detail={detail ? "1" : "0"}
      style={{
        opacity: data.dim ? 0.25 : 1,
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
          <span className="shrink-0 text-sm text-muted-foreground">{steps} · {graphStats(graph)}</span>
        </div>
      ) : (
        <div className="flex h-full flex-col justify-between gap-3 px-8 pb-7 pt-9">
          {/* Long words break at soft hyphens (syllables) instead of mid-word; 12 px always separate it from the meta row. */}
          <div lang={data.lang as string} className="line-clamp-3 min-h-0 break-words font-semibold leading-[1.15] tracking-tight"
            style={{ fontSize: CHIP_TITLE, hyphens: "manual", WebkitHyphens: "manual" }}>{softHyphens(data.label as string)}</div>
          <div className="flex shrink-0 items-center gap-3 whitespace-nowrap" style={{ fontSize: CHIP_META }}>
            <span className="text-muted-foreground">{steps}</span>
            <span className="truncate rounded-full px-[0.6em] py-[0.15em] font-medium"
              style={ran ? { background: catColor(cat, 62, 0.14), color: catColor(cat, 38) } : { background: "var(--muted)", color: "var(--muted-foreground)" }}>
              {graphStats(graph)}
            </span>
          </div>
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
function FitTo({ target, layout, settle }: { target: string; layout: MapLayout; settle: { current: number } }) {
  const flow = useReactFlow();
  useEffect(() => {
    settle.current = Date.now() + 800;
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
  const [mode, setMode] = useState<MapMode>("overview");
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
    setData(null); setSelected(null); setMode("overview"); setReady(false);
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
    layoutMap(data, locale)
      .then((next) => {
        if (mine !== generation.current) return;
        setLayout(next);
        // Opens on `?cat=` when it names a cluster, else on the category with the most runs (the first cluster).
        setCategory((was) => was ?? (next.categories.includes(catFromUrl() as WorkflowCategory) ? catFromUrl()! : next.categories[0] ?? ANY));
        setReady(true);
      })
      .catch(() => { if (mine === generation.current) setReady(true); });
  }, [data, locale]);

  // Semantic zoom: the overview (chips) until the switch-in zoom, the detail view (steps) from it; a phone switches earlier,
  // a whole graph fits its 375 px only well below DETAIL_ZOOM. Hysteresis keeps a fitted graph from flipping back.
  const detail = mode === "detail";
  const canvasRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pendingView = useRef<{ x: number; y: number; zoom: number } | null>(null);
  /** Swaps the drawing and keeps `anchor` (or the graph nearest the view's centre) at the same place on screen. */
  const switchMode = useCallback((next: MapMode, anchor?: string) => {
    const flow = flowRef.current, rect = canvasRef.current?.getBoundingClientRect();
    if (layout && flow && rect && modeRef.current !== next) {
      const view = flow.getViewport();
      const cx = (rect.width / 2 - view.x) / view.zoom, cy = (rect.height / 2 - view.y) / view.zoom;
      const from = layout[modeRef.current].centers;
      let id = anchor ?? null, best = Infinity;
      if (!id) for (const [graph, at] of from) { const d = (at.x - cx) ** 2 + (at.y - cy) ** 2; if (d < best) { best = d; id = graph; } }
      const a = id ? from.get(id) : undefined, b = id ? layout[next].centers.get(id) : undefined;
      if (a && b) pendingView.current = { zoom: view.zoom, x: view.x + (a.x - b.x) * view.zoom, y: view.y + (a.y - b.y) * view.zoom };
    }
    setMode(next);
  }, [layout]);
  useLayoutEffect(() => {
    if (pendingView.current) { void flowRef.current?.setViewport(pendingView.current); pendingView.current = null; }
  }, [mode]);
  // While the map moves the view itself (a category fit, a tap on a graph) its passing zooms do not switch the drawing.
  // Until the first fit runs the viewport reports React Flow's default zoom 1, which must not open the steps.
  const settle = useRef(Number.POSITIVE_INFINITY);
  const onZoom = useCallback((zoom: number) => {
    if (Date.now() < settle.current) return;
    const at = (globalThis.innerWidth ?? 1280) < 640 ? DETAIL_ZOOM_NARROW : DETAIL_ZOOM;
    if (modeRef.current === "overview" && zoom >= at) switchMode("detail");
    else if (modeRef.current === "detail" && zoom < at * DETAIL_OUT) switchMode("overview");
  }, [switchMode]);

  // Hover and search swap only the objects they change; everything else keeps its identity, so nothing re-measures or blinks.
  const nodes = useMemo(() => (layout ? viewNodes(layout, mode, dimmed) : []), [layout, mode, dimmed]);
  const edges = useMemo(() => (layout ? viewEdges(layout, mode, [hot, selected?.graph.id]) : []), [layout, mode, hot, selected]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === "step") {
      const step = node.data.step as MapStep;
      const graph = data?.graphs.find((item) => item.id === step.graph);
      if (graph) setSelected({ graph, step });
      return;
    }
    if (node.type === "graphGroup") {
      const graph = node.data.graph as MapGraph;
      setSelected(null);
      // A tap on a graph opens the steps and moves the view onto it, so they are readable on a phone too.
      switchMode("detail", graph.id);
      settle.current = Date.now() + 800;
      setTimeout(() => void flowRef.current?.fitView({ nodes: [{ id: node.id }], padding: 0.04, duration: 300 }), 60);
    }
  }, [data, switchMode]);

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
      <div ref={canvasRef} className="relative overflow-hidden rounded-xl border border-border" style={{ height: "max(720px, calc(100vh - 240px))", background: CANVAS_BG }}
        data-testid="wf-map-canvas" data-layout={ready ? "ready" : "loading"} data-focus={category ?? ""} data-detail={detail ? "1" : "0"}>
        {layout ? (
          <div className="absolute inset-0"><ReactFlowProvider>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              onInit={(instance) => { flowRef.current = instance; }} defaultViewport={{ x: 0, y: 0, zoom: 0.05 }}
              onNodeClick={onNodeClick} onPaneClick={() => setSelected(null)}
              onNodeMouseEnter={(_, node) => setHot(graphIdOf(node))} onNodeMouseLeave={() => setHot(null)}
              minZoom={0.02} maxZoom={2} onlyRenderVisibleElements nodesDraggable={false} nodesConnectable={false} elementsSelectable>
              <Background variant={BackgroundVariant.Dots} gap={28} size={1.6} color="color-mix(in oklab, var(--muted-foreground) 35%, transparent)" />
              <ZoomWatch onZoom={onZoom} />
              <FitTo target={category ?? ANY} layout={layout} settle={settle} />
              <Controls showInteractive={false} showFitView={false} position="bottom-left">
                {/* «Fit»: back to the overview of the whole map. */}
                <ControlButton data-testid="wf-map-fit" title={t("wmFit")} aria-label={t("wmFit")} onClick={() => {
                  settle.current = Date.now() + 800;
                  setMode("overview"); setCategory(ANY);
                  setTimeout(() => void flowRef.current?.fitView({ padding: 0.04, duration: 300 }), 60);
                }}>⤢</ControlButton>
              </Controls>
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
