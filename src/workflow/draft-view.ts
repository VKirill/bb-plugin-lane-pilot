import { conditionText, cut, flat, roleTone, type ViewEdge, type ViewNode, type WorkflowView } from "./view-core";

/**
 * A workflow draft as a graph. A draft is written step by step by the workflow architect, so at any moment it may be
 * incomplete (an edge to a node that is not there yet, a node with no outputs), and the closed schema would refuse it.
 * This reads the raw JSON leniently and draws what is there; a node or edge it cannot make sense of is left out.
 * Pure and free of schema code, so the browser can use it.
 */
type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const START = "$start", END = "$end";

const KINDS = new Set(["agent", "lp-task", "action", "decision", "human", "parallel", "join", "subworkflow", "note"]);

/** The names of a node's declared output, in either spelling (a field list or a `{name: "type"}` map). */
const outNames = (node: Raw): string[] => {
  const out = node.out ?? node.output;
  if (Array.isArray(out)) return out.flatMap((item) => (isRaw(item) && text(item.name) ? [String(item.name)] : typeof item === "string" ? [item] : []));
  if (isRaw(out)) return Object.keys(out);
  return [];
};

const bilingual = (value: unknown): { en: string; ru: string } | null => {
  if (typeof value === "string" && value.trim()) return { en: value, ru: value };
  if (isRaw(value)) { const en = text(value.en), ru = text(value.ru); if (en || ru) return { en: en ?? ru!, ru: ru ?? en! }; }
  return null;
};

function node(raw: Raw): ViewNode | null {
  const id = text(raw.id);
  const type = text(raw.type);
  if (!id) return null;
  const kind = (type && KINDS.has(type) ? type : "agent") as ViewNode["kind"];
  const base: ViewNode = { id, kind, tone: "agent", title: bilingual(raw.title), label: text(raw.label), role: null, excerpt: null, uses: text(raw.uses), out: outNames(raw),
    maxVisits: typeof raw.maxVisits === "number" ? raw.maxVisits : isRaw(raw.guards) && typeof raw.guards.maxVisits === "number" ? raw.guards.maxVisits : null, stages: [], calls: null,
    modes: Array.isArray(raw.applicable_modes) ? raw.applicable_modes.filter((mode): mode is string => typeof mode === "string") : null };
  switch (kind) {
    case "agent": { const role = text(raw.role); return { ...base, tone: roleTone(role), role: role ?? "worker", excerpt: text(raw.prompt) ? cut(flat(String(raw.prompt))) : null }; }
    case "lp-task": return { ...base, tone: "build", role: "writer", stages: Array.isArray(raw.stages) ? raw.stages.filter((item): item is string => typeof item === "string") : [] };
    case "action": return { ...base, tone: "action", excerpt: text(raw.action) };
    case "decision": return { ...base, tone: "decision", excerpt: text(raw.reads_node) ?? text(raw.reads) ? `← ${text(raw.reads_node) ?? text(raw.reads)}` : null };
    case "human": return { ...base, tone: "human", role: text(raw.role), excerpt: text(raw.question ?? raw.prompt) ? cut(flat(String(raw.question ?? raw.prompt))) : null };
    case "parallel": return { ...base, tone: "flow", excerpt: text(raw.for_each ?? raw.foreach) ? `for each ${text(raw.for_each ?? raw.foreach)}` : raw.for_each || raw.foreach ? "for each" : null };
    case "join": return { ...base, tone: "flow", excerpt: text(raw.parallel) ? `← ${text(raw.parallel)}` : null };
    case "subworkflow": return { ...base, tone: "sub", calls: text(raw.workflow) ? { id: String(raw.workflow), version: typeof raw.version === "number" ? raw.version : null } : null };
    case "note": return { ...base, tone: "note", excerpt: text(raw.text) ? cut(flat(String(raw.text)), 400) : null };
    default: return base;
  }
}

const terminal = (id: string): ViewNode => ({ id, kind: id === START ? "start" : "end", tone: "terminal", title: null, label: id === START ? "start" : "end", role: null, excerpt: null, uses: null, out: [], maxVisits: null, stages: [], calls: null, modes: null });

/** The owner's placement of the nodes (`ui.positions`), leniently: an entry that is not a pair of numbers is left out. */
function placements(ui: unknown): Record<string, { x: number; y: number }> | null {
  const raw = isRaw(ui) && isRaw(ui.positions) ? ui.positions : null;
  if (!raw) return null;
  const found = Object.entries(raw).flatMap(([id, at]) => (isRaw(at) && typeof at.x === "number" && typeof at.y === "number" ? [[id === "start" ? START : id === "end" ? END : id, { x: at.x, y: at.y }] as const] : []));
  return found.length ? Object.fromEntries(found) : null;
}

/** `start` and `end` mean the entry and the exit unless a node of that name exists. */
export function draftView(workflow: unknown): WorkflowView {
  const source = isRaw(workflow) ? workflow : {};
  const nodes = (Array.isArray(source.nodes) ? source.nodes : []).flatMap((item) => { const made = isRaw(item) ? node(item) : null; return made ? [made] : []; });
  const ids = new Set(nodes.map((item) => item.id));
  const alias = (value: unknown) => { const id = text(value); return id === "start" && !ids.has("start") ? START : id === "end" && !ids.has("end") ? END : id; };
  // An entry named by `entry:` instead of an explicit edge from start.
  const entry = text(source.entry);
  const rawEdges = (Array.isArray(source.edges) ? source.edges : []).filter(isRaw);
  const pairs = rawEdges.map((edge) => ({ edge, from: alias(edge.from), to: alias(edge.to) }));
  if (entry && ids.has(entry) && !pairs.some((pair) => pair.from === START)) pairs.unshift({ edge: {}, from: START, to: entry });
  const edges: ViewEdge[] = [];
  const used = new Set<string>();
  for (const { edge, from, to } of pairs) {
    if (!from || !to || (from !== START && !ids.has(from)) || (to !== END && !ids.has(to))) continue;
    used.add(from); used.add(to);
    const pass = edge.pass === "same-session" || edge.pass === "read-prior-session" || edge.pass === "fork" ? edge.pass : "artifact";
    edges.push({ index: edges.length, from, to, when: conditionText(typeof edge.when === "string" || isRaw(edge.when) ? edge.when as never : undefined), label: text(edge.label),
      pass, carries: isRaw(edge.with) ? Object.keys(edge.with) : [] });
  }
  if (used.has(START)) nodes.unshift(terminal(START));
  if (used.has(END)) nodes.push(terminal(END));
  const positions = placements(source.ui);
  return { nodes, edges, ...(positions ? { positions } : {}) };
}

const signature = (edge: ViewEdge) => JSON.stringify([edge.from, edge.to, edge.when, edge.label, edge.pass, edge.carries]);

/**
 * What the last patch touched: nodes that are new or whose content differs from the previous version, and the canvas keys
 * (`e<index>`) of edges that are new or changed. The first version of a draft has no previous one and marks nothing.
 */
export function draftChanges(previous: WorkflowView | null, next: WorkflowView): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>(), edges = new Set<string>();
  if (!previous) return { nodes, edges };
  const before = new Map(previous.nodes.map((item) => [item.id, JSON.stringify(item)]));
  for (const item of next.nodes) if (before.get(item.id) !== JSON.stringify(item)) nodes.add(item.id);
  const known = new Set(previous.edges.map(signature));
  for (const edge of next.edges) if (!known.has(signature(edge))) edges.add(`e${edge.index}`);
  return { nodes, edges };
}
