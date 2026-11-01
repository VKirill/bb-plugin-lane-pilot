import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

/**
 * The road tree of the lead («Штурман», .agents/plans/2026-11-01-lead-agent-roadmap.md §2.1, §3.2): directions (where we are going,
 * per project or above projects) and options under them (what to do next, with a reason and evidence). A rejected branch is never
 * deleted — the reason stays in `why` and the tree can show it as history — so the roadmap remembers why a road was abandoned and
 * the lead never proposes it twice. State machine: open → proposed → accepted | later | rejected; done is set when a branch landed.
 */
export type RoadDb = Pick<Database.Database, "prepare" | "transaction">;
export type RoadKind = "direction" | "option";
export type RoadSource = "owner" | "lead" | "pm" | "wall" | "bench";
export type RoadState = "open" | "proposed" | "accepted" | "later" | "rejected" | "done";
export type RoadEvidence = { kind: "run" | "task" | "file" | "note" | "url" | "metric"; ref: string; label?: string };
export type RoadRow = {
  id: string; parent_id: string | null; project_id: string | null; title: string; kind: RoadKind; source: RoadSource; why: string;
  evidence_json: string; cost_estimate: string | null; class: string | null; state: RoadState;
  proposed_at: number | null; decided_at: number | null; decision_id: string | null; created_at: number; updated_at: number;
  /** What the branch carries to act with (a schedule proposal's schedule); JSON or null. */
  payload_json: string | null;
};
export type RoadNode = { row: RoadRow; evidence: RoadEvidence[]; children: RoadNode[] };

const MARKS: Record<RoadState, string> = { open: "·", proposed: "?", accepted: "✓", later: "…", rejected: "✗", done: "■" };

const newId = () => `road_${randomBytes(5).toString("hex")}`;

function checkEvidence(evidence: readonly RoadEvidence[] | undefined): string {
  if (evidence === undefined) return "[]";
  if (!Array.isArray(evidence) || evidence.length > 12) throw new Error("evidence is an array of at most 12 items");
  for (const item of evidence) {
    if (!item || typeof item.ref !== "string" || !item.ref.trim() || item.ref.length > 500) throw new Error("every evidence item needs a ref of at most 500 chars");
  }
  return JSON.stringify(evidence);
}

const parseEvidence = (row: RoadRow): RoadEvidence[] => { try { return JSON.parse(row.evidence_json) as RoadEvidence[]; } catch { return []; } };

export function addRoad(db: RoadDb, input: {
  id?: string; parentId?: string | null; projectId?: string | null; title: string; kind: RoadKind; source: RoadSource;
  why: string; evidence?: RoadEvidence[]; costEstimate?: string | null; class?: string | null; payload?: unknown;
}, now: number = Date.now()): RoadRow {
  const title = input.title.trim();
  const why = input.why.trim();
  if (!title || title.length > 300) throw new Error("title must be 1..300 chars");
  if (!why || why.length > 2000) throw new Error("why must be 1..2000 chars");
  const parentId = input.parentId ?? null;
  if (input.kind === "option") {
    if (!parentId) throw new Error("an option needs a parent direction");
    if (!getRoad(db, parentId)) throw new Error(`unknown parent ${parentId}`);
  }
  const row: RoadRow = {
    id: input.id ?? newId(), parent_id: parentId, project_id: input.projectId ?? null, title, kind: input.kind, source: input.source,
    why, evidence_json: checkEvidence(input.evidence), cost_estimate: input.costEstimate ?? null, class: input.class ?? null,
    state: "open", proposed_at: null, decided_at: null, decision_id: null, created_at: now, updated_at: now,
    payload_json: input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
  };
  db.prepare(`INSERT INTO lane_pilot_lead_road(id,parent_id,project_id,title,kind,source,why,evidence_json,cost_estimate,class,state,created_at,updated_at,payload_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.parent_id, row.project_id, row.title, row.kind, row.source, row.why, row.evidence_json, row.cost_estimate, row.class, row.state, row.created_at, row.updated_at, row.payload_json);
  return row;
}

/**
 * A proposal on an existing branch (one born in `branches` without a class, or one the owner said «потом» to) makes the branch say what
 * the proposal says: class, reason, evidence, price, a project it lacked, a schedule payload. The owner's «да» and the act step both
 * execute the branch row, so the two must not drift apart (Astra F-003: a branch accepted, then skipped for `class null`).
 */
export function syncRoadProposal(db: RoadDb, id: string, input: { class: string; why: string; evidence?: readonly RoadEvidence[]; costEstimate: string; projectId: string | null; payload?: unknown }, now: number = Date.now()): boolean {
  const row = getRoad(db, id);
  if (!row) return false;
  const payload = input.payload === undefined ? row.payload_json : input.payload === null ? null : JSON.stringify(input.payload);
  return db.prepare("UPDATE lane_pilot_lead_road SET class=?, why=?, evidence_json=?, cost_estimate=?, project_id=?, payload_json=?, updated_at=? WHERE id=?")
    .run(input.class, input.why, input.evidence?.length ? checkEvidence(input.evidence) : row.evidence_json, input.costEstimate, row.project_id ?? input.projectId, payload, now, id).changes > 0;
}

/** A proposal on an existing open branch may bring the payload the branch lacked (a schedule for a `schedule` branch). */
export function setRoadPayload(db: RoadDb, id: string, payload: unknown, now: number = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_lead_road SET payload_json=?, updated_at=? WHERE id=?").run(payload === undefined || payload === null ? null : JSON.stringify(payload), now, id).changes > 0;
}

export const roadPayload = (row: Pick<RoadRow, "payload_json">): unknown => { try { return row.payload_json ? JSON.parse(row.payload_json) : null; } catch { return null; } };

export const getRoad = (db: RoadDb, id: string): RoadRow | undefined =>
  db.prepare("SELECT * FROM lane_pilot_lead_road WHERE id=?").get(id) as RoadRow | undefined;

/** A state change plus an appended note on `why`; shared by reject/done/decide so the reason is never lost. */
function settle(db: RoadDb, id: string, from: RoadState[], to: RoadState, whyAppend: string | null, now: number): boolean {
  const row = getRoad(db, id);
  if (!row || !from.includes(row.state)) return false;
  db.prepare("UPDATE lane_pilot_lead_road SET state=?, decided_at=?, updated_at=?, why=? WHERE id=?")
    .run(to, now, now, whyAppend === null ? row.why : `${row.why}${whyAppend}`, id);
  return true;
}

export function rejectRoad(db: RoadDb, id: string, why: string, by: string, now: number = Date.now()): boolean {
  const reason = why.trim();
  if (reason.length < 10) throw new Error("a rejection needs a reason of at least 10 chars");
  return settle(db, id, ["open", "proposed", "later"], "rejected", `\n\nrejected by ${by}: ${reason}`, now);
}

export function doneRoad(db: RoadDb, id: string, note?: string, now: number = Date.now()): boolean {
  return settle(db, id, ["open", "proposed", "accepted", "later"], "done", note ? `\n\ndone: ${note}` : null, now);
}

export function proposeRoad(db: RoadDb, id: string, decisionId: string, now: number = Date.now()): boolean {
  const row = getRoad(db, id);
  if (!row || (row.state !== "open" && row.state !== "later")) return false;
  db.prepare("UPDATE lane_pilot_lead_road SET state='proposed', proposed_at=?, decision_id=?, updated_at=? WHERE id=?").run(now, decisionId, now, id);
  return true;
}

export function decideRoad(db: RoadDb, id: string, decision: "yes" | "later" | "no", text?: string, now: number = Date.now()): boolean {
  const to: RoadState = decision === "yes" ? "accepted" : decision === "no" ? "rejected" : "later";
  const append = decision === "no" ? `\n\nowner: no${text ? ` ${text}` : ""}` : null;
  return settle(db, id, ["proposed"], to, append, now);
}

export function listRoad(db: RoadDb, filter: { projectId?: string | null; state?: RoadState | RoadState[]; kind?: RoadKind; parentId?: string | null; limit?: number } = {}): RoadRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if ("projectId" in filter) { where.push(filter.projectId === null ? "project_id IS NULL" : "project_id=?"); if (filter.projectId !== null) args.push(filter.projectId); }
  if (filter.state !== undefined) { const states = Array.isArray(filter.state) ? filter.state : [filter.state]; where.push(`state IN (${states.map(() => "?").join(",")})`); args.push(...states); }
  if (filter.kind !== undefined) { where.push("kind=?"); args.push(filter.kind); }
  if ("parentId" in filter) { where.push(filter.parentId === null ? "parent_id IS NULL" : "parent_id=?"); if (filter.parentId !== null) args.push(filter.parentId); }
  const sql = `SELECT * FROM lane_pilot_lead_road${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC${filter.limit ? ` LIMIT ${Math.max(0, filter.limit | 0)}` : ""}`;
  return db.prepare(sql).all(...args) as RoadRow[];
}

export function roadTree(db: RoadDb, options: { projectId?: string | null; history?: boolean } = {}): RoadNode[] {
  const rows = listRoad(db, "projectId" in options ? { projectId: options.projectId } : {}).sort((a, b) => a.created_at - b.created_at);
  const hide = new Set<RoadState>(options.history ? [] : ["rejected", "done"]);
  const visible = rows.filter((row) => !hide.has(row.state));
  const byParent = new Map<string | null, RoadRow[]>();
  for (const row of visible) {
    const list = byParent.get(row.parent_id) ?? [];
    list.push(row);
    byParent.set(row.parent_id, list);
  }
  // Visited guard: a cyclic parent_id in hand-edited data must not loop the tree.
  const visited = new Set<string>();
  const build = (row: RoadRow): RoadNode | null => {
    if (visited.has(row.id)) return null;
    visited.add(row.id);
    const children = (byParent.get(row.id) ?? []).map(build).filter((node): node is RoadNode => node !== null);
    return { row, evidence: parseEvidence(row), children };
  };
  return (byParent.get(null) ?? []).map(build).filter((node): node is RoadNode => node !== null);
}

export function renderRoadTree(nodes: RoadNode[]): string {
  const lines: string[] = [];
  const walk = (node: RoadNode, depth: number) => {
    const pad = "  ".repeat(depth);
    const { row } = node;
    lines.push(`${pad}${MARKS[row.state]} ${row.title} [${row.kind}/${row.state}, ${row.source}] ${row.id}`);
    lines.push(`${pad}  why: ${row.why.slice(0, 160)}`);
    if (node.evidence.length) lines.push(`${pad}  evidence: ${node.evidence.map((item) => item.ref).join(", ")}`);
    node.children.forEach((child) => walk(child, depth + 1));
  };
  nodes.forEach((node) => walk(node, 0));
  return lines.join("\n");
}

export function roadMarkdown(db: RoadDb, now: number = Date.now()): string {
  const counts = roadCounts(db);
  const projects = new Set((listRoad(db).map((row) => row.project_id)));
  const treeFor = (projectId: string | null, history: boolean) => roadTree(db, { projectId, history });
  const list = (nodes: RoadNode[], depth: number): string[] => nodes.flatMap((node) => [
    `${"  ".repeat(depth)}- **${node.row.title}** (${node.row.kind}/${node.row.state}, ${node.row.source}) — ${node.row.why.slice(0, 160)}`,
    ...list(node.children, depth + 1),
  ]);
  const out: string[] = [
    "---",
    'title: "ROAD"',
    `generated: "${new Date(now).toISOString()}"`,
    `counts: { open: ${counts.open}, proposed: ${counts.proposed}, accepted: ${counts.accepted}, later: ${counts.later}, rejected: ${counts.rejected}, done: ${counts.done} }`,
    "---",
    "",
  ];
  const sections = [...projects].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  for (const projectId of sections) {
    out.push(`## ${projectId ?? "Above projects"}`, "", ...list(treeFor(projectId, false), 0), "");
  }
  // History keeps only the branches that ended: rejected and done nodes anywhere in each project's tree, flattened.
  const ended = (nodes: RoadNode[]): RoadRow[] => nodes.flatMap((node) => [
    ...(node.row.state === "rejected" || node.row.state === "done" ? [node.row] : []),
    ...ended(node.children),
  ]);
  const historyLines = sections.flatMap((projectId) => ended(treeFor(projectId, true)).map((row) => `- **${row.title}** (${row.kind}/${row.state}, ${row.source}) — ${row.why.slice(0, 160)}`));
  out.push("## History", "", ...(historyLines.length ? historyLines : ["- none"]), "");
  return out.join("\n");
}

export function roadCounts(db: RoadDb): Record<RoadState, number> {
  const counts: Record<RoadState, number> = { open: 0, proposed: 0, accepted: 0, later: 0, rejected: 0, done: 0 };
  for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM lane_pilot_lead_road GROUP BY state").all() as Array<{ state: RoadState; n: number }>) counts[row.state] = row.n;
  return counts;
}
