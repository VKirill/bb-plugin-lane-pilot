// `sma-map --states | --gaps | --hollow [--live --days N] [--json] [--region N]`: the four proofs per node, the gaps
// batches are cut from, and the hollow findings. Without a database (a source checkout) reachability runs on the
// registry defaults and traces are not read; `--live` on the hub reads the global and project settings, node-level
// traces and the live hollow signs. A source checkout recomputes the static facts; the hub reads hollow-facts.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SMA_EVIDENCE } from "./evidence";
import { SMA_NODES, SMA_REGIONS } from "./graph";
import { collectHollowFacts, SMA_HOLLOW_FACTS, type HollowFacts } from "./hollow-facts";
import { hollowCounts, hollowFindings, readHollowLive, type HollowFinding } from "./hollow";
import { readSmaLive, smaGroups } from "./live";
import { anchorName, resolveSpan } from "./symbols";
import { smaRows, smaStateCounts, type ProofRoots, type SmaRow } from "./model";
import { SMA_PROVENANCE, versionSeen } from "./provenance";
import { defaultSettings, hubSettings, type HubSettings } from "./settings-registry";
import { gapList, nodeStates, stateReport, type NodeState } from "./states";
import { readDrills, type TraceContext } from "./traces";

type Result = { exitCode: number; stdout?: string; stderr?: string };
type Db = { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
const flag = (argv: readonly string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

export const PROOF_FLAGS = ["--states", "--gaps", "--hollow"] as const;
export const wantsProofs = (argv: readonly string[]) => PROOF_FLAGS.some((name) => argv.includes(name));

export type ProofRun = { rows: SmaRow[]; states: NodeState[]; findings: HollowFinding[]; facts: HollowFacts; factsFresh: boolean; hub: HubSettings | null; days: number; live: boolean; drills: number | null; drillDir: string };

/** Everything the three reports need, computed once. */
export function proofRun(argv: readonly string[], roots: ProofRoots, db: Db | null, cwd: string, now = Date.now(), pluginRoot?: string): ProofRun {
  const days = Math.max(1, Math.min(365, Number(flag(argv, "--days") ?? 30) || 30));
  const since = now - days * 86_400_000;
  const rows = smaRows();
  const root = roots.lanePilot;
  const factsFresh = !!root && existsSync(join(root, "workflows"));
  const facts = factsFresh ? collectHollowFacts(root, Object.fromEntries(rows.map((row) => [row.id, row.proof]))) : SMA_HOLLOW_FACTS;
  const hub = db ? hubSettings(db, since) : null;
  // The receipts live in THE PLUGIN's folder, not where the command was typed: on the hub `bb lane-pilot` runs from any directory.
  const drillDir = flag(argv, "--drills") ?? process.env.LP_DRILLS_DIR ?? join(pluginRoot ?? cwd, ".agents/runs/drills");
  const drills = readDrills(drillDir);
  const live = !!db;
  const traceCtx: TraceContext | undefined = db || drills ? { ...(db ? { db } : {}), drills } : undefined;
  const liveGroups = db ? new Set(readSmaLive(db, smaGroups(SMA_NODES as never, SMA_REGIONS), since).filter((row) => (row.n ?? 0) > 0).map((row) => row.key)) : null;
  const states = nodeStates({
    rows, root, settings: hub?.global ?? defaultSettings(), ...(hub ? { hub } : {}), settingReads: facts.settingReads, ...(db ? { seen: versionSeen(db) } : {}),
    ...(traceCtx ? { traceCtx, since } : {}), ...(liveGroups ? { groupObserved: (row: SmaRow) => liveGroups.has(`${row.region} | ${row.group}`) } : {}),
  });
  const traces = new Map(states.filter((state) => state.observed !== null).map((state) => [state.id, { judged: true, n: state.observed ? 1 : 0 }] as const));
  const findings = hollowFindings({ rows, evidence: SMA_EVIDENCE, facts, settings: hub?.global ?? defaultSettings(), ...(live ? { traces } : {}), ...(db ? { live: readHollowLive(db, since, days) } : {}) });
  return { rows, states, findings, facts, factsFresh, hub, days, live, drills: drills ? drills.length : null, drillDir };
}

/** Past this many lines an anchor is a dispatcher, not the unit the card describes: a mutation or a hollow sign there hits unrelated code. */
export const DISPATCHER_LINES = 150;
export type AnchorInfo = { file: string; symbol?: string; lines: number; flag?: string };
/** Where a node's proof anchor really lands (the span behind re-exports) and what is wrong with it; null for a proof into another repository or no sources. */
export function anchorInfo(proof: string | undefined, root: string): AnchorInfo | null {
  if (!proof || !root || /^(lane-stack|core|telegram):/.test(proof)) return null;
  const [where, symbol] = proof.split("#", 2) as [string, string | undefined];
  const path = where.replace(/:\d+$/, "");
  const full = join(root, path);
  if (!existsSync(full)) return { file: path, ...(symbol ? { symbol } : {}), lines: 0, flag: "the anchor file does not exist" };
  const name = symbol ? anchorName(symbol) : null;
  const span = name ? resolveSpan(root, path, name) : null;
  const file = span?.file ?? path;
  const lines = span ? span.text.split("\n").length : readFileSync(full, "utf8").split("\n").length;
  const flag = /^tests\//.test(file) ? "anchor under tests/: a mutation cannot live there, move the code to src/ (docs/sma-evidence.md)"
    : span && lines > DISPATCHER_LINES ? `anchor is ${lines} lines: a dispatcher, not the unit the card describes; re-point it` : undefined;
  return { file, ...(name ? { symbol: name } : {}), lines, ...(flag ? { flag } : {}) };
}

const regionFilter = (argv: readonly string[]): number | null => {
  const arg = flag(argv, "--region");
  if (arg === undefined) return null;
  if (/^\d+$/.test(arg)) return Number(arg);
  const at = SMA_REGIONS.findIndex((name) => name.toLowerCase().includes(arg.toLowerCase()));
  return at >= 0 ? at : -1;
};

export function runProofCli(argv: readonly string[], roots: ProofRoots, db: Db | null, cwd: string, now = Date.now(), pluginRoot?: string): Result {
  const region = regionFilter(argv);
  if (region === -1 || (region !== null && !SMA_REGIONS[region])) return { exitCode: 2, stderr: `no region ${flag(argv, "--region")}; regions: ${SMA_REGIONS.map((name, index) => `${index} ${name}`).join("; ")}` };
  const run = proofRun(argv, roots, db, cwd, now, pluginRoot);
  const json = argv.includes("--json");
  const states = region === null ? run.states : run.states.filter((state) => state.regionIndex === region);
  if (argv.includes("--gaps")) {
    const proofOf = new Map(run.rows.map((row) => [row.id, row.proof] as const));
    const gaps = gapList(states).map((gap) => { const anchor = anchorInfo(proofOf.get(gap.id), roots.lanePilot); return anchor ? { ...gap, anchor } : gap; });
    if (json) return { exitCode: 0, stdout: JSON.stringify({ days: run.days, live: run.live, ...(region !== null ? { region } : {}), count: gaps.length, byRegion: byRegion(gaps), nodes: gaps }, null, 2) };
    return { exitCode: 0, stdout: renderGaps(gaps, run) };
  }
  if (argv.includes("--hollow")) {
    const findings = region === null ? run.findings : run.findings.filter((finding) => finding.mapNodes.some((id) => states.some((state) => state.id === id)));
    if (json) return { exitCode: 0, stdout: JSON.stringify({ days: run.days, live: run.live, factsFrom: run.factsFresh ? "checkout" : `hollow-facts.json ${run.facts.generatedFrom}`, counts: hollowCounts(findings), findings }, null, 2) };
    return { exitCode: 0, stdout: renderHollow(findings, run) };
  }
  const report = stateReport(states, run.live);
  const hollow = hollowCounts(run.findings);
  const proofLinks = smaStateCounts(run.rows, roots);
  if (json) {
    return { exitCode: 0, stdout: JSON.stringify({
      days: run.days, live: run.live, settings: settingsLine(run), provenance: { generatedFrom: SMA_PROVENANCE.generatedFrom, version: SMA_PROVENANCE.version },
      states: { ...report.overall, hollow: hollow.total, hollowOnMap: hollow.onMap, hollowOffMap: hollow.offMap, hollowBySign: hollow.bySign, proofResolved: proofLinks.proofResolved, proofBroken: proofLinks.proofBroken, proofUnjudged: proofLinks.proofUnjudged },
      regions: report.regions,
    }, null, 2) };
  }
  return { exitCode: 0, stdout: renderStates(report, hollow, run, proofLinks) };
}

function settingsLine(run: ProofRun): string {
  if (!run.hub) return "registry defaults (no database: run with --live on the hub for the global and project settings)";
  return `registry defaults + ${run.hub.globalRows} global row(s); active projects (tasks in ${run.days} d, drill sandboxes left out): ${run.hub.projects.map((project) => `${project.projectId} ${project.tasks} task(s)${project.overrides ? `, ${project.overrides} override(s)` : ""}`).join("; ") || "none"}`;
}

const n = (value: number | null) => (value === null ? "—" : String(value));

function renderStates(report: ReturnType<typeof stateReport>, hollow: ReturnType<typeof hollowCounts>, run: ProofRun, links: ReturnType<typeof smaStateCounts>): string {
  const o = report.overall;
  const lines = [
    `SMA map — the four proofs per node (sma-parity-tz.md §4), ${run.live ? `live, last ${run.days} day(s)` : "no database: observed and outcome-verified need --live"}.`,
    `total ${o.total}, available ${o.available}, checked ${o.checked}, mutated ${o.mutated} (stale ${o.mutationStale}), reachable ${o.reachable} / unreachable ${o.unreachable} (undeclared gate ${o.undeclared}; ${o.seededReachable} reachable only through a mechanically seeded entry; ${o.blockedInSomeProject} blocked in an active project), observed ${n(o.observed)} (node-level), outcome-verified ${n(o.outcomeVerified)} (node-level), groupObserved ${n(o.groupObserved)} (group-level, not node evidence).`,
    `hollow ${hollow.total} (on the map ${hollow.onMap} / off the map ${hollow.offMap}; by sign ${Object.entries(hollow.bySign).map(([sign, count]) => `${sign}: ${count}`).join(", ")}), void unreviewed ${o.voidUnreviewed}, exceptions ${Object.entries(o.exceptions).map(([kind, count]) => `${kind} ${count}`).join(", ") || "none"}; closed (all four proofs or an exception) ${o.closed}.`,
    `settings: ${settingsLine(run)}.`,
    `proof links (the weaker ladder): resolved ${links.proofResolved}, broken ${links.proofBroken}, unjudged ${links.proofUnjudged}; change points from provenance.json ${SMA_PROVENANCE.generatedFrom || "(not generated)"} (${SMA_PROVENANCE.version}); hollow facts from ${run.factsFresh ? "this checkout" : `hollow-facts.json ${run.facts.generatedFrom}`}${run.drills === null ? `; no drill receipts here (looked in ${run.drillDir})` : `; ${run.drills} drill receipt(s) in ${run.drillDir}`}.`,
    "", "region                              total checked mutated reach  observed verified closed void?",
  ];
  for (const r of report.regions) lines.push(`${String(r.index).padStart(2)} ${r.region.slice(0, 32).padEnd(32)} ${String(r.total).padStart(5)} ${String(r.checked).padStart(7)} ${String(r.mutated).padStart(7)} ${String(r.reachable).padStart(5)} ${n(r.observed).padStart(9)} ${n(r.outcomeVerified).padStart(8)} ${String(r.closed).padStart(6)} ${String(r.voidUnreviewed).padStart(5)}`);
  return lines.join("\n");
}

function byRegion(gaps: ReadonlyArray<ReturnType<typeof gapList>[number]>) {
  return SMA_REGIONS.map((region, index) => {
    const part = gaps.filter((gap) => gap.region === index);
    const count = (proof: string) => part.filter((gap) => gap.missing.includes(proof as never)).length;
    return { index, region, nodes: part.length, test: count("test"), mutation: count("mutation"), reach: count("reach"), trace: count("trace"), voidReview: count("voidReview") };
  }).filter((row) => row.nodes);
}

type GapRow = ReturnType<typeof gapList>[number] & { anchor?: AnchorInfo };
function renderGaps(gaps: readonly GapRow[], run: ProofRun): string {
  const lines = [`Gaps — per node which of the four proofs is missing (${gaps.length} node(s); ${run.live ? `live ${run.days} d` : "no database: every trace is missing"}).`, "", "region                              nodes  test mutation reach trace void?"];
  for (const row of byRegion(gaps)) lines.push(`${String(row.index).padStart(2)} ${row.region.slice(0, 32).padEnd(32)} ${String(row.nodes).padStart(5)} ${String(row.test).padStart(5)} ${String(row.mutation).padStart(8)} ${String(row.reach).padStart(5)} ${String(row.trace).padStart(5)} ${String(row.voidReview).padStart(5)}`);
  lines.push("");
  for (const gap of gaps) lines.push(`${gap.id.padEnd(6)} ${gap.smaId} [${gap.status}] missing ${gap.missing.join(", ")}${gap.reachWhy ? ` — reach: ${gap.reachWhy}` : ""}${gap.undeclared ? ` — undeclared gate ${gap.undeclared.join(", ")}` : ""}${gap.anchor ? `\n        anchor ${gap.anchor.file}${gap.anchor.symbol ? `#${gap.anchor.symbol}` : ""} (${gap.anchor.lines} lines)${gap.anchor.flag ? ` WARNING: ${gap.anchor.flag}` : ""}` : ""}`);
  return lines.join("\n");
}

function renderHollow(findings: readonly HollowFinding[], run: ProofRun): string {
  const c = hollowCounts(findings);
  const lines = [`Hollow — ${c.total} finding(s): on the map ${c.onMap} (${c.mapNodes} node(s)), off the map ${c.offMap}; by sign ${Object.entries(c.bySign).map(([sign, count]) => `${sign}: ${count}`).join(", ")}${run.live ? `; live ${run.days} d` : "; signs 2 and 6 need --live"}.`, ""];
  for (const finding of findings) lines.push(`[${finding.sign}] ${finding.onMap ? `map ${finding.mapNodes.slice(0, 4).join(",")}${finding.mapNodes.length > 4 ? ",…" : ""}` : `off-map (${finding.guess ?? "?"})`} ${finding.subject.type} ${finding.subject.path}: ${finding.what}`);
  return lines.join("\n");
}
