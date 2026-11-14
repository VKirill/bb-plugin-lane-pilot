// The source facts the hollow detector (hollow.ts) judges, read from a source checkout: the workflow graphs' structure
// and their static defects (sign 1, and sign 4 candidates), the chain tests' walked paths (sign 2 waiver), the setting
// keys each map node's function reads (sign 4), markers and constant answers in map nodes' functions and in every other
// function (sign 3). The hub has no sources: scripts/sma-hollow.ts writes these facts into hollow-facts.json, and the
// CLI reads that file where src/ is absent.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import FACTS from "./hollow-facts.json";
import { settingReads } from "./reach";
import { anchorName, constantReturn, resolveSpan, symbolSpan } from "./symbols";
import { chainCoverage, conditionTruth, loadWorkflows, passThrough, skippedByDefault, stubPrompt } from "./workflow-graphs";

export type GraphFact = { id: string; file: string; status: string; nodes: Array<[id: string, type: string]>; edges: Array<[from: string, to: string, when: string | null]> };
export type WorkflowDefect = { graph: string; node?: string; edge?: [from: string, to: string, when: string | null]; sign: 1 | 4; what: string };
export type FunctionDefect = { path: string; what: string; kind: "marker" | "constant" };
export type HollowFacts = {
  generatedFrom: string;
  graphs: GraphFact[];
  workflowDefects: WorkflowDefect[];
  coverage: Record<string, string[]>;
  settingReads: Record<string, string[]>;
  anchors: Record<string, string>;
  anchorDefects: Record<string, string[]>;
  functionDefects: FunctionDefect[];
};
export const SMA_HOLLOW_FACTS = FACTS as unknown as HollowFacts;

const MARKER = /\/\/.*\b(TODO|FIXME)\b|\b(shortcut|ponytail):/;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (!["node_modules", "tests", "dist", "ui"].includes(name)) walk(path); }
      else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) files.push(relative(root, path));
    }
  };
  walk(join(root, "src/rooms"));
  try { for (const pkg of readdirSync(join(root, "packages"))) walk(join(root, "packages", pkg, "src")); } catch { /* no packages */ }
  return files.filter((file) => !file.startsWith("src/rooms/sma-map/")).sort();
}

/** The enclosing top-level declaration of a line: the nearest `function X` / `const X =` above it. */
function enclosingName(lines: readonly string[], at: number): string {
  for (let i = at; i >= 0; i--) {
    const hit = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=/.exec(lines[i]!);
    if (hit) return hit[1] ?? hit[2]!;
  }
  return "(module)";
}

/** Facts read from the checkout at `root`. `proofs`: map node id → its proof link. */
export function collectHollowFacts(root: string, proofs: Readonly<Record<string, string | undefined>>, generatedFrom = ""): HollowFacts {
  const graphs = loadWorkflows(join(root, "workflows"));
  const workflowDefects: WorkflowDefect[] = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const stub = stubPrompt(node);
      if (stub) workflowDefects.push({ graph: graph.id, node: node.id, sign: 1, what: stub });
      const pass = passThrough(node, graph);
      if (pass) workflowDefects.push({ graph: graph.id, node: node.id, sign: 1, what: pass });
      const skipped = skippedByDefault(node, graph);
      // A default-off feature flag (a boolean input or one a project setting drives) — not a choice among modes.
      if (skipped && [...(node.skipWhen ?? "").matchAll(/\$inputs\.(\w+)/g)].some((m) => { const spec = graph.inputs[m[1]!] as { type?: string; note?: string } | undefined; return spec?.type === "bool" || spec?.type === "boolean" || /setting/i.test(spec?.note ?? ""); })) {
        workflowDefects.push({ graph: graph.id, node: node.id, sign: 4, what: skipped });
      }
    }
    for (const edge of graph.edges) {
      if (edge.when && conditionTruth(edge.when, graph, "never") === "false") workflowDefects.push({ graph: graph.id, edge: [edge.from, edge.to, edge.when], sign: 1, what: `the branch «${edge.when}» can never be true (its field or value is not one its source node can give)` });
    }
  }
  const settingReadsOut: Record<string, string[]> = {};
  const anchors: Record<string, string> = {};
  const anchorDefects: Record<string, string[]> = {};
  for (const [id, proof] of Object.entries(proofs)) {
    const reads = settingReads(root, proof);
    if (reads?.length) settingReadsOut[id] = reads;
    if (!proof || /^(lane-stack|core|telegram):/.test(proof)) continue;
    const [file, symbol] = proof.split("#", 2) as [string, string | undefined];
    const name = symbol && /\.[cm]?[jt]sx?$/.test(file) ? anchorName(symbol) : null;
    const span = name ? resolveSpan(root, file, name) : null;
    if (!span) continue;
    anchors[id] = `${span.file}#${span.name}`;
    const defects: string[] = [];
    const constant = span.params !== null && span.params.trim() ? constantReturn(span.body) : null;
    if (constant) defects.push(`${span.file}#${span.name} returns the constant ${constant} whatever it is given`);
    span.text.split("\n").forEach((line, at) => { if (MARKER.test(line)) defects.push(`${span.file}:${span.start + at} ${line.trim().slice(0, 140)}`); });
    if (defects.length) anchorDefects[id] = defects;
  }
  const functionDefects: FunctionDefect[] = [];
  for (const file of sourceFiles(root)) {
    const text = readFileSync(join(root, file), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, at) => { if (MARKER.test(line)) functionDefects.push({ path: `${file}#${enclosingName(lines, at)}`, what: `${file}:${at + 1} ${line.trim().slice(0, 140)}`, kind: "marker" }); });
    for (const hit of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\(/gm)) {
      const name = hit[1] ?? hit[2]!;
      const span = symbolSpan(text, name);
      if (!span || span.params === null || !span.params.trim()) continue;
      const constant = constantReturn(span.body);
      if (constant) functionDefects.push({ path: `${file}#${name}`, what: `returns the constant ${constant} whatever it is given (${span.params.trim().slice(0, 60)})`, kind: "constant" });
    }
  }
  return {
    generatedFrom,
    graphs: graphs.map((graph) => ({ id: graph.id, file: graph.file, status: graph.status, nodes: graph.nodes.map((node) => [node.id, node.type] as [string, string]), edges: graph.edges.map((edge) => [edge.from, edge.to, edge.when] as [string, string, string | null]) })),
    workflowDefects, coverage: chainCoverage(join(root, "tests")), settingReads: settingReadsOut, anchors, anchorDefects, functionDefects,
  };
}
