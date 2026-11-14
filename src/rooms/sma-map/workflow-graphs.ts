// The workflow graphs (workflows/*.json) as hollow.ts judges them: their nodes and edges, a branch condition that can
// never be true, an action that only copies its input, an agent node with no prompt or a stub one, a node its graph's
// default inputs skip, and which nodes and edges a chain test (tests/workflow/chains-*.test.ts, `pathOf(r)).toBe("a b
// c")`) walks. Regex and JSON only — the shipped plugin has no workflows folder, so hollow-static.json carries the
// structure to the hub.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchClose } from "./symbols";

type Json = Record<string, unknown>;
export type WfNode = { id: string; type: string; action?: string; prompt?: string; uses?: unknown; skill?: unknown; profile?: unknown; out?: Json; map?: unknown; skipWhen?: string };
export type WfEdge = { index: number; from: string; to: string; when: string | null; label?: string };
export type WfGraph = { id: string; file: string; status: string; internal: boolean; inputs: Json; nodes: WfNode[]; edges: WfEdge[] };

const whenText = (when: unknown): string | null => {
  if (when === undefined || when === null || when === "") return null;
  if (typeof when === "string") return when;
  const w = when as { field?: string; op?: string; value?: unknown };
  return w.field && w.op ? `${w.field} ${w.op === "eq" ? "==" : w.op === "ne" ? "!=" : w.op} ${JSON.stringify(w.value)}` : JSON.stringify(when);
};

/** Every graph in `dir` (workflows/), in file order. */
export function loadWorkflows(dir: string): WfGraph[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Json;
    const nodes = ((raw.nodes ?? []) as Json[]).map((node) => ({
      id: String(node.id), type: String(node.type), ...(node.action ? { action: String(node.action) } : {}), ...(typeof node.prompt === "string" ? { prompt: node.prompt } : {}),
      ...(node.uses ? { uses: node.uses } : {}), ...(node.skill ? { skill: node.skill } : {}), ...(node.profile ? { profile: node.profile } : {}),
      ...(node.out && typeof node.out === "object" ? { out: node.out as Json } : {}), ...(node.map ? { map: node.map } : {}), ...(typeof node.skip_when === "string" ? { skipWhen: node.skip_when } : {}),
    }));
    const edges = ((raw.edges ?? []) as Json[]).map((edge, index) => ({ index, from: String(edge.from), to: String(edge.to), when: whenText(edge.when), ...(edge.label ? { label: String(edge.label) } : {}) }));
    return { id: String(raw.id ?? name.replace(/\.json$/, "")), file: `workflows/${name}`, status: String(raw.status ?? ""), internal: raw.internal === true, inputs: (raw.inputs ?? {}) as Json, nodes, edges };
  });
}

// ---- conditions ----
/** Splits on a top-level operator (outside parentheses, brackets and quotes). */
function splitTop(text: string, op: "||" | "&&"): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === "\"") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && text.startsWith(op, i)) { parts.push(text.slice(start, i)); start = i + 2; i++; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
/** Strips parentheses that wrap the whole text: «(a || b)» → «a || b», but not «(a) || (b)». */
const unwrap = (text: string): string => {
  let t = text.trim();
  while (t.startsWith("(") && matchClose(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
  return t;
};
const enumOf = (type: unknown): string[] | null => (typeof type === "string" && /^[\w-]+(\|[\w-]+)+$/.test(type) ? type.split("|") : null);

export type Truth = "true" | "false" | "unknown";

/** What an atom is worth: `values` are what the graph can know (declared enums, node ids, input defaults). */
function atomTruth(atom: string, graph: WfGraph, mode: "never" | "default"): Truth {
  const a = unwrap(atom);
  if (a === "false") return "false";
  if (a === "true") return "true";
  const ids = new Set(graph.nodes.map((node) => node.id));
  const cmp = /^(!?)\s*(\$?[\w]+)\.([\w]+)\s*(==|!=|in)\s*(.+)$/s.exec(a);
  const bare = /^(!?)\s*(\$?[\w]+)\.([\w]+)$/.exec(a);
  const hit = cmp ?? bare;
  if (!hit) return "unknown";
  const [, neg, owner, field] = hit as unknown as [string, string, string, string];
  const op = cmp?.[4];
  const literal = cmp?.[5]?.trim();
  const words = literal ? [...literal.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!) : [];
  if (owner === "$inputs") {
    const spec = graph.inputs[field] as Json | undefined;
    if (mode === "default") {
      const def = spec && "default" in spec ? spec.default : undefined;
      if (def === undefined) return "unknown";
      let value: boolean;
      if (!op) value = !!def;
      else if (literal === "true" || literal === "false") value = (def === (literal === "true")) === (op === "==");
      else if (words.length) value = words.includes(String(def)) === (op === "==" || op === "in");
      else return "unknown";
      return (neg ? !value : value) ? "true" : "false";
    }
    const allowed = enumOf(spec?.type);
    if (op && allowed && words.length && (op === "==" || op === "in") && !neg && words.every((word) => !allowed.includes(word))) return "false";
    return "unknown";
  }
  if (owner.startsWith("$") || mode === "default") return "unknown";
  if (!ids.has(owner)) return neg ? "true" : "false";
  const node = graph.nodes.find((item) => item.id === owner)!;
  if (node.type === "agent" && node.out && !(field in node.out) && !neg && (op === "==" || op === "in" || !op) && !(literal === "false" || literal === "null")) return "false";
  const allowed = enumOf(node.out?.[field]);
  if (op && allowed && words.length && (op === "==" || op === "in") && !neg && words.every((word) => !allowed.includes(word))) return "false";
  return "unknown";
}

/** "false" when the condition can never hold, "true" when it always does under `mode`, else "unknown". */
export function conditionTruth(when: string, graph: WfGraph, mode: "never" | "default"): Truth {
  const disjuncts = splitTop(unwrap(when), "||").map((d) => {
    const atoms = splitTop(unwrap(d), "&&").map((atom) => atomTruth(atom, graph, mode));
    return atoms.includes("false") ? "false" : atoms.every((atom) => atom === "true") ? "true" : "unknown";
  });
  return disjuncts.includes("true") ? "true" : disjuncts.every((d) => d === "false") ? "false" : "unknown";
}

// ---- node checks ----
// Upper-case markers only: «a structured todo» in a real prompt is not a stub (2026-11-14 calibration on the repo).
const STUB = /\b(?:TODO|TBD|FIXME|XXX)\b|lorem ipsum|\bfill me in\b/;
/** An agent node with no instruction: no prompt and nothing it uses, or a prompt that is a stub. */
export function stubPrompt(node: WfNode): string | null {
  if (node.type !== "agent") return null;
  if (!node.prompt) return node.uses || node.skill || node.profile ? null : "an agent node with no prompt, skill, profile or uses";
  if (STUB.test(node.prompt)) return `a stub prompt: «${node.prompt.slice(0, 80)}»`;
  const words = node.prompt.replace(/\{\{[^}]*\}\}/g, " ").split(/\s+/).filter((word) => /\w/.test(word)).length;
  if (words < 3 && !node.prompt.includes("{{")) return `a prompt of ${words} word(s): «${node.prompt}»`;
  return null;
}

const PASS_ACTIONS = new Set(["emit", "noop", "pass", "identity", "copy"]);
/** An action that only rewrites its input into its output, in the middle of the graph (a terminal emit IS the output). */
export function passThrough(node: WfNode, graph: WfGraph): string | null {
  if (node.type !== "action" || !PASS_ACTIONS.has(node.action ?? "")) return null;
  if (!graph.edges.some((edge) => edge.from === node.id)) return null;
  const map = node.map && typeof node.map === "object" ? Object.values(node.map as Json) : [];
  const onlyRefs = map.every((value) => typeof value === "string" && /^\$?[A-Za-z_]\w*(?:\.[\w[\]]+)+$/.test(value));
  return onlyRefs ? `action «${node.action}» only copies its input (${map.length} field(s)) and the graph goes on` : null;
}

/** The input a skip condition names, for the report: `$inputs.patterns` → its note. */
export function skippedByDefault(node: WfNode, graph: WfGraph): string | null {
  if (!node.skipWhen || conditionTruth(node.skipWhen, graph, "default") !== "true") return null;
  const names = [...node.skipWhen.matchAll(/\$inputs\.(\w+)/g)].map((m) => m[1]!);
  const notes = names.map((name) => { const spec = graph.inputs[name] as Json | undefined; return `${name}=${JSON.stringify(spec?.default)}${spec?.note ? ` (${String(spec.note).slice(0, 90)})` : ""}`; });
  return `skipped by default: skip_when «${node.skipWhen}» holds with ${notes.join(", ")}`;
}

// ---- chain-test coverage ----
/** Nodes and edges (`from>to`) that a chain test walks, per graph id: from `runSim("<graph>"` … `pathOf(…)).toBe("a b c")`. */
export function chainCoverage(testsDir: string): Record<string, string[]> {
  const out = new Map<string, Set<string>>();
  const dir = join(testsDir, "workflow");
  if (!existsSync(dir)) return {};
  for (const name of readdirSync(dir)) {
    if (!/\.test\.ts$/.test(name)) continue;
    const text = readFileSync(join(dir, name), "utf8");
    const events = [...text.matchAll(/runSim\(\s*["']([\w.-]+)["']|pathOf\([^)]*\)\)\.toBe\(\s*["']([^"']+)["']/g)];
    let graph: string | null = null;
    for (const event of events) {
      if (event[1]) { graph = event[1]; continue; }
      if (!graph || !event[2]) continue;
      const path = event[2].split(/\s+/).filter(Boolean);
      const set = out.get(graph) ?? new Set<string>();
      path.forEach((node, at) => { set.add(node); if (at > 0) set.add(`${path[at - 1]}>${node}`); });
      out.set(graph, set);
    }
  }
  return Object.fromEntries([...out].map(([graph, set]) => [graph, [...set].sort()]));
}
