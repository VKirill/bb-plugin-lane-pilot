// The hollow detector (sma-parity-tz.md §4а): six signs over two subject sets — map nodes, and everything else
// (every node and edge of every workflow graph, functions, settings, stages and gates).
//   1 a graph node with no effect: an action that only copies its input, an agent with no or a stub prompt, a branch
//     that can never be true;
//   2 a node or edge that did not fire in the window and no drill or chain test walks it (live);
//   3 a function on the node's path that returns a constant whatever it is given, or a TODO/shortcut:/ponytail: in it;
//   4 a setting whose effective value turns the node off while the map calls it working (an undeclared gate, a
//     declared need that fails, a graph step its default inputs skip);
//   5 status `have` with no behaviour test naming the card (the proof is a link);
//   6 a stage or gate with ≥ 20 runs in the window and not one rework/block (live), unless a mutation test attests
//     it can refuse (`hollowAttested`).
// Static facts come from hollow-facts.ts; live counts from the plugin database.
import { STAGE_ATTESTED } from "./evidence/stages";
import type { NodeEvidence } from "./evidence/types";
import type { HollowFacts } from "./hollow-facts";
import type { SmaRow } from "./model";
import { failedNeeds, undeclaredGates } from "./reach";
import { SIBLINGS, siblingOf } from "./siblings";
import type { EffectiveSettings } from "./settings-registry";
import type { TraceSource } from "./traces";

export type HollowSubjectType = "map-node" | "workflow" | "workflow-node" | "workflow-edge" | "function" | "setting" | "stage" | "gate";
export type HollowGuess = "new unfinished graph" | "unfinished function" | "duplicate of another node" | "leftover of an old scheme";
export type HollowFinding = { subject: { type: HollowSubjectType; path: string }; sign: 1 | 2 | 3 | 4 | 5 | 6; what: string; onMap: boolean; mapNodes: string[]; guess?: HollowGuess; live?: true };

export type HollowLive = {
  days: number;
  graphRuns: ReadonlyMap<string, number>;
  nodeSteps: ReadonlyMap<string, number>;
  edgeSteps: ReadonlyMap<string, number>;
  /** `graph|source` → runs that left the graph by an edge out of `source` (an `exit` event of a step of `source`; `graph|start` for an entry straight to the end). */
  exits?: ReadonlyMap<string, number>;
  /** `graph|node` → runs whose entry step (no parent) is `node`, in any state (a skipped entry step still came from its start edge). */
  entries?: ReadonlyMap<string, number>;
  /** `graph|source` → branch results that arrived at a join from a step of `source` (a failed branch is not an edge walk). */
  joinArrivals?: ReadonlyMap<string, number>;
  /** What the data really covers (all runs in the journal, not the window): the span a reader must not mistake for an idle graph. */
  span?: DataSpan;
  verdicts: ReadonlyArray<{ type: "stage" | "gate"; id: string; runs: number; refusals: number }>;
};

export type DataSpan = { first: number | null; last: number | null; runs: number; days: number };

/** «data covers 2026-10-30 … 2026-11-14 (15 day(s), 5725 run(s))», and the shortfall against the requested window when there is one. */
export function spanLine(span: DataSpan | undefined, requestedDays: number): string {
  if (!span) return "";
  if (span.first === null || span.last === null) return "the journal holds no workflow run";
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const short = span.days < requestedDays ? ` — a young database: «did not fire in ${requestedDays} days» only means ${span.days}` : "";
  return `data covers ${day(span.first)} … ${day(span.last)} (${span.days} day(s), ${span.runs} workflow run(s)) of the ${requestedDays} requested${short}`;
}

export type HollowContext = {
  rows: readonly SmaRow[];
  evidence: Readonly<Record<string, NodeEvidence>>;
  facts: HollowFacts;
  settings: EffectiveSettings;
  /** Node-level trace readings (judged and fired count) — sign 2 of map nodes. */
  traces?: ReadonlyMap<string, { judged: boolean; n: number }>;
  live?: HollowLive;
};

const traceList = (evidence: NodeEvidence | undefined): TraceSource[] => (evidence?.trace === undefined ? [] : Array.isArray(evidence.trace) ? [...evidence.trace] : [evidence.trace as TraceSource]);
const add = (map: Map<string, string[]>, key: string, id: string) => { const list = map.get(key) ?? []; if (!list.includes(id)) list.push(id); map.set(key, list); };

/** Which map nodes a graph, a graph node, a function or a stage lies on (their proof or their trace names it). */
export function mapIndex(ctx: Pick<HollowContext, "rows" | "evidence" | "facts">) {
  const graphOf = new Map(ctx.facts.graphs.map((graph) => [graph.file, graph.id] as const));
  const graphs = new Map<string, string[]>(), wfNodes = new Map<string, string[]>(), functions = new Map<string, string[]>(), stages = new Map<string, string[]>();
  for (const row of ctx.rows) {
    const proof = /^(workflows\/[\w.-]+\.json)(?:#(.*))?$/.exec(row.proof ?? "");
    const graph = proof ? graphOf.get(proof[1]!) : undefined;
    if (graph) {
      const node = proof![2] && proof![2] !== "\"entry\"" ? /^"(?:id": ")?([\w.-]+)"$/.exec(proof![2])?.[1] : undefined;
      if (node) add(wfNodes, `${graph}|${node}`, row.id); else add(graphs, graph, row.id);
    }
    for (const source of traceList(ctx.evidence[row.id])) {
      if (source.kind === "wfRun") for (const id of typeof source.workflow === "string" ? [source.workflow] : source.workflow) add(graphs, id, row.id);
      if (source.kind === "wfStep") for (const node of typeof source.node === "string" ? [source.node] : source.node) add(wfNodes, `${source.workflow}|${node}`, row.id);
      if (source.kind === "stage" || source.kind === "receipt") add(stages, `stage:${source.stage}`, row.id);
      if (source.kind === "gate") add(stages, `gate:${source.gate}`, row.id);
    }
    const anchor = ctx.facts.anchors[row.id];
    if (anchor) add(functions, anchor, row.id);
  }
  return { graphs, wfNodes, functions, stages, onNode: (graph: string, node: string) => wfNodes.get(`${graph}|${node}`) ?? graphs.get(graph) ?? [] };
}

const EMERGENCY = /timeout|abort|visits\(|retry|failed|error|!.*\.ok\b|== *'block'|blocked/i;

/** Every finding, map nodes first. */
export function hollowFindings(ctx: HollowContext): HollowFinding[] {
  const out: HollowFinding[] = [];
  const index = mapIndex(ctx);
  const on = (ids: readonly string[]) => ({ onMap: ids.length > 0, mapNodes: [...ids] });
  // ---- map nodes ----
  for (const row of ctx.rows) {
    const subject = { type: "map-node" as const, path: `${row.id} ${row.smaId}` };
    const evidence = ctx.evidence[row.id];
    // A proof in a sibling repository is not «nothing to do here»: the test goes into that repository (docs/sma-evidence.md «Proofs in a sibling repository»).
    const sibling = siblingOf(row.proof);
    if (row.status === "have" && row.contracts.length === 0) out.push({ subject, sign: 5, what: `status have, but no behaviour test names [sma:${row.smaId}]${row.proof ? ` — the proof is a link to ${row.proof}` : ""}${sibling ? `; the test goes into ${SIBLINGS[sibling].repo} on ${SIBLINGS[sibling].proofBranch} (npm run sma:sibling -- setup ${sibling})` : ""}`, ...on([row.id]) });
    if (row.status === "have" || row.status === "partial") {
      const gates = undeclaredGates(ctx.facts.settingReads[row.id] ?? null, evidence?.reach, ctx.settings);
      if (gates.length) out.push({ subject, sign: 4, what: `undeclared gate: its function reads ${gates.map((key) => `${key} (${ctx.settings.get(key) ?? "unset"})`).join(", ")}, off by default, and reach.needs does not declare it`, ...on([row.id]) });
      const failed = failedNeeds(evidence?.reach, ctx.settings);
      if (failed.length) out.push({ subject, sign: 4, what: `the map calls it working, but its declared needs fail under the effective settings: ${failed.join("; ")}`, ...on([row.id]) });
    }
    for (const defect of ctx.facts.anchorDefects[row.id] ?? []) out.push({ subject, sign: 3, what: defect, ...on([row.id]) });
    const reading = ctx.traces?.get(row.id);
    if (ctx.live && reading?.judged && reading.n === 0) out.push({ subject, sign: 2, what: `its node trace did not fire in ${ctx.live.days} day(s) and no drill scene passed through it`, ...on([row.id]), live: true });
  }
  // ---- workflow graphs ----
  for (const defect of ctx.facts.workflowDefects) {
    const ids = defect.node ? index.onNode(defect.graph, defect.node) : defect.edge ? index.onNode(defect.graph, defect.edge[0]) : index.graphs.get(defect.graph) ?? [];
    const subject = defect.edge ? { type: "workflow-edge" as const, path: `${defect.graph}: ${defect.edge[0]} → ${defect.edge[1]}${defect.edge[2] ? ` [${defect.edge[2]}]` : ""}` } : { type: "workflow-node" as const, path: `${defect.graph}.${defect.node}` };
    // A default-off step matters where the map relies on it; elsewhere it is the owner's per-run choice (calibration 2026-11-14).
    if (defect.sign === 4 && !ids.length) continue;
    out.push({ subject, sign: defect.sign, what: defect.what, ...on(ids), ...(ids.length ? {} : { guess: defect.edge ? "leftover of an old scheme" : "unfinished function" }) });
  }
  if (ctx.live) {
    const live = ctx.live;
    for (const graph of ctx.facts.graphs) {
      const covered = new Set(ctx.facts.coverage[graph.id] ?? []);
      const runs = live.graphRuns.get(graph.id) ?? 0;
      const guessGraph: HollowGuess = /legacy|\bold\b|-v1$/.test(graph.id) ? "leftover of an old scheme" : graph.status !== "published" ? "new unfinished graph" : "leftover of an old scheme";
      if (runs === 0) {
        const bare = graph.nodes.filter(([node]) => !covered.has(node)).length + graph.edges.filter(([from, to]) => !covered.has(`${from}>${to}`)).length;
        if (bare === 0) continue;
        const ids = index.graphs.get(graph.id) ?? [];
        out.push({ subject: { type: "workflow", path: graph.id }, sign: 2, what: `the graph did not run in ${live.days} day(s); ${bare} of its ${graph.nodes.length + graph.edges.length} nodes and edges have no chain test that walks them`, ...on(ids), ...(ids.length ? {} : { guess: guessGraph }), live: true });
        continue;
      }
      for (const [node] of graph.nodes) {
        if ((live.nodeSteps.get(`${graph.id}|${node}`) ?? 0) > 0 || covered.has(node)) continue;
        const ids = index.onNode(graph.id, node);
        out.push({ subject: { type: "workflow-node", path: `${graph.id}.${node}` }, sign: 2, what: `the node did not run in ${live.days} day(s) (the graph ran ${runs} time(s)) and no chain test walks it`, ...on(ids), ...(ids.length ? {} : { guess: guessGraph }), live: true });
      }
      const joins = new Set(graph.nodes.filter(([, type]) => type === "join").map(([node]) => node));
      for (const [from, to, when] of graph.edges) {
        if ((live.edgeSteps.get(`${graph.id}|${from}|${to}|${when ?? ""}`) ?? 0) > 0 || covered.has(`${from}>${to}`)) continue;
        const ids = index.onNode(graph.id, from);
        const emergency = EMERGENCY.test(when ?? "");
        const subject = { type: "workflow-edge" as const, path: `${graph.id}: ${from} → ${to}${when ? ` [${when}]` : ""}` };
        // An edge into the end or into a join starts no step, so the journal records its walk elsewhere: an `exit` event of the
        // source's step, a join arrival from the source's step. Neither names the edge, so an edge that shares its source and its kind of target
        // with another is told apart only when the source never left that way at all.
        const kind = from === "start" ? "start" : to === "end" ? "end" : joins.has(to) ? "join" : null;
        const walked = kind === null ? 0
          : kind === "start" ? (live.entries?.get(`${graph.id}|${to}`) ?? 0)
          : ((kind === "end" ? live.exits : live.joinArrivals)?.get(`${graph.id}|${from}`) ?? 0);
        if (walked > 0) {
          const siblings = graph.edges.filter(([other, target]) => other === from && (kind === "start" ? target === to : kind === "end" ? target === "end" : joins.has(target)));
          if (siblings.length === 1) continue;
          const way = kind === "start" ? `from the start to ${to}` : kind === "end" ? `from ${from} to the end` : `from ${from} into a join`;
          out.push({ subject, sign: 2, what: `the journal cannot tell which of the ${siblings.length} edges ${way} took the ${walked} ${kind === "end" ? "exit(s)" : kind === "start" ? "entry(ies)" : "arrival(s)"} in ${live.days} day(s): such an edge records no condition of its own; at least one of them was walked, and no chain test walks this one`, ...on(ids), ...(ids.length ? {} : { guess: guessGraph }), live: true });
          continue;
        }
        out.push({ subject, sign: 2, what: `the edge was not taken in ${live.days} day(s) (the graph ran ${runs} time(s)) and no chain test walks it${emergency ? " — an emergency path (retry, abort, timeout, failure) with no drill or chain test" : ""}`, ...on(ids), ...(ids.length ? {} : { guess: emergency ? "unfinished function" : guessGraph }), live: true });
      }
    }
    for (const verdict of live.verdicts) {
      if (verdict.runs < 20 || verdict.refusals > 0) continue;
      const key = `${verdict.type}:${verdict.id}`;
      const ids = index.stages.get(key) ?? [];
      const attestedBy = ids.filter((id) => ctx.evidence[id]?.hollowAttested);
      if (STAGE_ATTESTED[key] || attestedBy.length) continue;
      out.push({ subject: { type: verdict.type, path: verdict.id }, sign: 6, what: `${verdict.runs} run(s) in ${live.days} day(s) and not one rework or block — no mutation test attests it can refuse (hollowAttested)`, ...on(ids), ...(ids.length ? {} : { guess: "unfinished function" }), live: true });
    }
  }
  // ---- functions ----
  for (const defect of ctx.facts.functionDefects) {
    const ids = index.functions.get(defect.path) ?? [];
    if (ids.length) continue; // a map node's own function is reported on the node (sign 3 above)
    out.push({ subject: { type: "function", path: defect.path }, sign: 3, what: defect.what, onMap: false, mapNodes: [], guess: "unfinished function" });
  }
  return out.sort((a, b) => Number(b.onMap) - Number(a.onMap) || a.sign - b.sign || a.subject.path.localeCompare(b.subject.path, "en", { numeric: true }));
}

type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
const P = "lane_pilot_";
const REFUSALS = "('blocked','failed','rejected','rework','block')";

/** The live counts sign 2 and sign 6 need, over the window that starts at `since` (ms). */
export function readHollowLive(db: Db, since: number, days: number): HollowLive {
  const s = Math.floor(since);
  const graphRuns = new Map((db.prepare(`SELECT workflow_id AS id, COUNT(*) AS n FROM ${P}wf_run WHERE created_at >= ${s} GROUP BY workflow_id`).all() as Array<{ id: string; n: number }>).map((row) => [row.id, row.n] as const));
  const nodeSteps = new Map((db.prepare(`SELECT r.workflow_id AS g, s.node_id AS node, COUNT(*) AS n FROM ${P}wf_step s JOIN ${P}wf_run r ON r.id = s.run_id WHERE s.started_at >= ${s} AND s.state <> 'skipped' GROUP BY 1, 2`).all() as Array<{ g: string; node: string; n: number }>).map((row) => [`${row.g}|${row.node}`, row.n] as const));
  // Edges: the step's incoming edge index in the definition its run was started with (one definition read per version).
  const byIndex = db.prepare(`SELECT r.workflow_id AS g, r.workflow_sha256 AS sha, s.edge_index AS edge, COUNT(*) AS n FROM ${P}wf_step s JOIN ${P}wf_run r ON r.id = s.run_id WHERE s.started_at >= ${s} AND s.edge_index IS NOT NULL AND s.state <> 'skipped' GROUP BY 1, 2, 3`).all() as Array<{ g: string; sha: string; edge: number; n: number }>;
  const definitions = new Map<string, Array<{ from: string; to: string; when: unknown }>>();
  const edgeSteps = new Map<string, number>();
  for (const row of byIndex) {
    if (!definitions.has(row.sha)) {
      const found = db.prepare(`SELECT definition_json AS d FROM ${P}wf_run WHERE workflow_sha256 = '${String(row.sha).replace(/'/g, "''")}' LIMIT 1`).all() as Array<{ d: string }>;
      try { definitions.set(row.sha, (JSON.parse(found[0]?.d ?? "{}") as { edges?: Array<{ from: string; to: string; when: unknown }> }).edges ?? []); } catch { definitions.set(row.sha, []); }
    }
    const edge = definitions.get(row.sha)![row.edge];
    if (!edge) continue;
    const when = edge.when === undefined || edge.when === null || edge.when === "" ? "" : typeof edge.when === "string" ? edge.when : whenObject(edge.when);
    // The definitions name the entry and the exit `$start` / `$end`; the workflow files (and the facts) `start` / `end`.
    const key = `${row.g}|${edge.from.replace(/^\$/, "")}|${edge.to.replace(/^\$/, "")}|${when}`;
    edgeSteps.set(key, (edgeSteps.get(key) ?? 0) + row.n);
  }
  // An edge out of the start makes the run's entry step (no parent); its row, in any state, is the walk of that edge.
  const entries = new Map<string, number>();
  for (const row of db.prepare(`SELECT r.workflow_id AS g, st.node_id AS node, COUNT(*) AS n FROM ${P}wf_step st JOIN ${P}wf_run r ON r.id = st.run_id WHERE st.parent_key IS NULL AND r.created_at >= ${s} GROUP BY 1, 2`).all() as Array<{ g: string; node: string; n: number }>) entries.set(`${row.g}|${row.node}`, row.n);
  // An exit leaves the graph from a step: the `exit` event carries that step (`node#visit[@scope]`); none means entry straight to the end.
  const exits = new Map<string, number>();
  for (const row of db.prepare(`SELECT r.workflow_id AS g, e.step_key AS step, COUNT(*) AS n FROM ${P}wf_event e JOIN ${P}wf_run r ON r.id = e.run_id WHERE e.kind = 'exit' AND e.at >= ${s} GROUP BY 1, 2`).all() as Array<{ g: string; step: string | null; n: number }>) {
    const key = `${row.g}|${row.step === null ? "start" : row.step.split("#")[0]}`;
    exits.set(key, (exits.get(key) ?? 0) + row.n);
  }
  // A branch result arrives at its join from a step; a failed branch arrives too (the join tolerates it) but walked no edge.
  const joinArrivals = new Map<string, number>();
  for (const row of db.prepare(`SELECT r.workflow_id AS g, st.node_id AS src, COUNT(*) AS n FROM ${P}wf_arrival a JOIN ${P}wf_run r ON r.id = a.run_id JOIN ${P}wf_step st ON st.run_id = a.run_id AND st.step_key = a.from_step WHERE a.at >= ${s} AND a.data_json NOT LIKE '%"$failed"%' GROUP BY 1, 2`).all() as Array<{ g: string; src: string; n: number }>) joinArrivals.set(`${row.g}|${row.src}`, row.n);
  const seen = db.prepare(`SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(*) AS n FROM ${P}wf_run`).all() as Array<{ first: number | null; last: number | null; n: number }>;
  const span: DataSpan = { first: seen[0]?.first ?? null, last: seen[0]?.last ?? null, runs: Number(seen[0]?.n ?? 0), days: seen[0]?.first == null ? 0 : Math.max(1, Math.round(((seen[0].last ?? seen[0].first) - seen[0].first) / 86_400_000)) };
  const terminal = "('passed','failed','blocked','rework','block','rejected','accepted','pass')";
  const stages = db.prepare(`SELECT stage_id AS id, SUM(state IN ${terminal}) AS runs, SUM(state IN ${REFUSALS}) AS refusals FROM ${P}stage_event WHERE occurred_at >= ${s} GROUP BY stage_id`).all() as Array<{ id: string; runs: number; refusals: number }>;
  const receipts = new Map((db.prepare(`SELECT stage_id AS id, SUM(COALESCE(json_extract(result_json, '$.status'), json_extract(result_json, '$.verdict'), state) IN ${REFUSALS}) AS refusals FROM ${P}stage_receipt WHERE updated_at >= ${s} GROUP BY stage_id`).all() as Array<{ id: string; refusals: number }>).map((row) => [row.id, row.refusals] as const));
  const gates = db.prepare(`SELECT gate AS id, SUM(status IN ('passed','failed','rejected')) AS runs, SUM(status IN ('failed','rejected')) AS refusals FROM ${P}gate_event WHERE occurred_at >= ${s} GROUP BY gate`).all() as Array<{ id: string; runs: number; refusals: number }>;
  return {
    days, graphRuns, nodeSteps, edgeSteps, entries, exits, joinArrivals, span,
    verdicts: [...stages.map((row) => ({ type: "stage" as const, id: row.id, runs: Number(row.runs ?? 0), refusals: Number(row.refusals ?? 0) + Number(receipts.get(row.id) ?? 0) })), ...gates.map((row) => ({ type: "gate" as const, id: row.id, runs: Number(row.runs ?? 0), refusals: Number(row.refusals ?? 0) }))],
  };
}

/** The text workflow-graphs.ts gives an object condition ({field, op, value}). */
function whenObject(when: unknown): string {
  const w = when as { field?: string; op?: string; value?: unknown };
  return w.field && w.op ? `${w.field} ${w.op === "eq" ? "==" : w.op === "ne" ? "!=" : w.op} ${JSON.stringify(w.value)}` : JSON.stringify(when);
}

/** Totals for --states: on-map / off-map findings and per sign. */
export function hollowCounts(findings: readonly HollowFinding[]) {
  const bySign: Record<string, number> = {};
  for (const finding of findings) bySign[finding.sign] = (bySign[finding.sign] ?? 0) + 1;
  return { total: findings.length, onMap: findings.filter((finding) => finding.onMap).length, offMap: findings.filter((finding) => !finding.onMap).length, mapNodes: new Set(findings.flatMap((finding) => finding.mapNodes)).size, bySign };
}
