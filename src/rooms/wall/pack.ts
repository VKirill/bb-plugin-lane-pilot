import { z } from "zod";
import type { WallDb } from "./journal";

/**
 * The evidence of a wall, and the code check on what the hunters say about it (atlas delta 3.1, after critique/citations.ts: a reviewer's
 * opinion stays an opinion, its citation is checked). The pack is assembled by code, the hunters see only the pack, so every citation can
 * be held against it: a finding whose citation does not hold is lowered to `unknown` and never reaches the PM or the engineer.
 */
export type PackFile = { path: string; lines: number; text?: string };
export type PackReceipt = { runId: string; taskId: string; stage: string; state: string; reason: string };
export type PackQuery = { id: string; sql: string; rows: unknown[] };
export type PackAttempt = { id: string; state: string; reason: string; project: string; version: string; at: number };

export type EvidencePack = {
  kind: "class" | "task";
  subject: string;
  facts: string[];
  attempts: PackAttempt[];
  receipts: PackReceipt[];
  files: PackFile[];
  checkOutputs: string[];
  queries: PackQuery[];
  /** Plain facts the code needs again later (run id, PM thread, hashes of the contract and the plan); hunters do not cite them. */
  meta?: Record<string, string>;
};

export const HUNT_ANGLES = ["task", "system", "big_picture"] as const;
export type HuntAngle = (typeof HUNT_ANGLES)[number];
export const VERDICTS = ["contract_wrong", "impossible_as_stated", "env_fault", "lp_fault", "approach_wrong", "split_needed", "unknown"] as const;
export const ACTIONS = ["update_contract", "split", "reassign", "self_repair", "owner_decision", "none"] as const;
export const CITATION_KINDS = ["file", "receipt", "sql", "check_output"] as const;

export const findingSchema = z.object({
  angle: z.enum(HUNT_ANGLES),
  verdict: z.enum(VERDICTS),
  summary: z.string().max(2000),
  evidence: z.array(z.object({
    kind: z.enum(CITATION_KINDS),
    /** file: the path; receipt: `<run>/<task>/<stage>`; sql: the query id of the pack; check_output: any label. */
    ref: z.string().max(400),
    line: z.number().int().positive().optional(),
    quote: z.string().max(1000),
  }).strict()).max(12),
  action: z.enum(ACTIONS),
}).strict();
export type Finding = z.infer<typeof findingSchema>;
export type CheckedFinding = Finding & { held: number; failed: string[]; demoted: boolean };

const norm = (path: string) => path.trim().replace(/^\.\//, "");
const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Whether one citation holds against the pack: the thing it names exists and its quote is really in it. */
export function citationHolds(pack: EvidencePack, cite: Finding["evidence"][number]): string | null {
  const quote = flat(cite.quote);
  if (quote.length < 6) return `${cite.kind} ${cite.ref}: no quote to check`;
  if (cite.kind === "file") {
    const file = pack.files.find((row) => norm(row.path) === norm(cite.ref));
    if (!file) return `file ${cite.ref}: not in the pack`;
    if (cite.line !== undefined && cite.line > file.lines) return `file ${cite.ref}: no line ${cite.line} (${file.lines} lines)`;
    if (file.text !== undefined && !flat(file.text).includes(quote)) return `file ${cite.ref}: the quote is not in it`;
    return null;
  }
  if (cite.kind === "receipt") {
    const receipt = pack.receipts.find((row) => `${row.runId}/${row.taskId}/${row.stage}` === cite.ref.trim());
    if (!receipt) return `receipt ${cite.ref}: not in the pack`;
    return flat(`${receipt.state} ${receipt.reason}`).includes(quote) ? null : `receipt ${cite.ref}: the quote is not in it`;
  }
  if (cite.kind === "sql") {
    const query = pack.queries.find((row) => row.id === cite.ref.trim());
    if (!query) return `sql ${cite.ref}: no such query in the pack`;
    return flat(JSON.stringify(query.rows)).includes(quote) ? null : `sql ${cite.ref}: the quote is not in its rows`;
  }
  const hit = [...pack.checkOutputs, ...pack.attempts.map((row) => row.reason)].some((text) => flat(text).includes(quote));
  return hit ? null : `check_output: the quote is in no check output of the pack`;
}

/** A finding that claims anything needs at least one citation and every citation must hold; otherwise it is `unknown` with no action. */
export function checkFinding(pack: EvidencePack, finding: Finding): CheckedFinding {
  const failed = finding.evidence.map((cite) => citationHolds(pack, cite)).filter((problem): problem is string => problem !== null);
  const held = finding.evidence.length - failed.length;
  if (finding.verdict === "unknown") return { ...finding, action: "none", held, failed, demoted: false };
  if (finding.evidence.length === 0 || failed.length > 0) {
    return { ...finding, verdict: "unknown", action: "none", summary: `${finding.summary} [lowered to unknown: ${finding.evidence.length === 0 ? "no citation" : failed[0]}]`.slice(0, 2000), held, failed, demoted: true };
  }
  return { ...finding, held, failed, demoted: false };
}

export type HuntOutcome = { state: "usable" | "unknown"; findings: CheckedFinding[]; usable: CheckedFinding[]; demoted: number };

/** The hunt as a whole: usable when at least one hunter named something and every citation of that finding holds. */
export function judgeHunt(pack: EvidencePack, raw: ReadonlyArray<Finding | null>): HuntOutcome {
  const findings = raw.filter((row): row is Finding => row !== null).map((row) => checkFinding(pack, row));
  const usable = findings.filter((row) => row.verdict !== "unknown");
  return { state: usable.length ? "usable" : "unknown", findings, usable, demoted: findings.filter((row) => row.demoted).length };
}

/** A hunter's reply as a finding; text that is not the shape is no finding (the hunter counts as unknown). */
export function parseFinding(raw: unknown, angle: HuntAngle): Finding | null {
  const parsed = findingSchema.safeParse(raw && typeof raw === "object" ? { ...(raw as object), angle } : null);
  return parsed.success ? parsed.data : null;
}

export type AttemptRow = { id: string; run_id: string; task_id: string; state: string; reason: string | null; updated_at: number; harness_version: string | null; project_id: string };

export const attemptView = (row: AttemptRow): PackAttempt => ({ id: row.id, state: row.state, reason: (row.reason ?? "").slice(0, 1200), project: row.project_id, version: row.harness_version ?? "", at: row.updated_at });

export function receiptsOf(db: WallDb, attempts: readonly AttemptRow[]): PackReceipt[] {
  const stmt = db.prepare("SELECT stage_id, state, reason FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND state IN ('failed','blocked')");
  const out: PackReceipt[] = [];
  const seen = new Set<string>();
  for (const row of attempts) {
    const key = `${row.run_id}/${row.task_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const receipt of stmt.all(row.run_id, row.task_id) as Array<{ stage_id: string; state: string; reason: string | null }>) {
      out.push({ runId: row.run_id, taskId: row.task_id, stage: receipt.stage_id, state: receipt.state, reason: (receipt.reason ?? "").slice(0, 800) });
    }
  }
  return out.slice(0, 40);
}

/** The pack of a class: sample attempts from the journal, the receipts that failed in their tasks, the version and night distributions as queries. */
export function buildClassPack(db: WallDb, classKey: string, extra: { files?: PackFile[]; facts?: string[] } = {}): EvidencePack {
  const cls = db.prepare("SELECT failure_class, reason_norm, origin FROM lane_pilot_wall_class WHERE class_key=?").get(classKey) as { failure_class: string; reason_norm: string; origin: string } | undefined;
  const ids = new Set<string>();
  for (const row of db.prepare("SELECT samples_json FROM lane_pilot_wall_entry WHERE class_key=? ORDER BY night DESC LIMIT 12").all(classKey) as Array<{ samples_json: string }>) {
    try { for (const id of JSON.parse(row.samples_json) as string[]) if (!id.startsWith("log:")) ids.add(id); } catch { /* skip */ }
  }
  const stmt = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, a.harness_version, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.id=?`);
  const attempts = [...ids].slice(0, 8).map((id) => stmt.get(id) as AttemptRow | undefined).filter((row): row is AttemptRow => Boolean(row));
  const queries: PackQuery[] = [
    { id: "by_night", sql: "SELECT night, sum(n) AS n FROM lane_pilot_wall_entry WHERE class_key=? GROUP BY night ORDER BY night DESC LIMIT 14", rows: db.prepare("SELECT night, sum(n) AS n FROM lane_pilot_wall_entry WHERE class_key=? GROUP BY night ORDER BY night DESC LIMIT 14").all(classKey) },
    { id: "by_version", sql: "SELECT lp_version, sum(n) AS n FROM lane_pilot_wall_entry WHERE class_key=? GROUP BY lp_version ORDER BY lp_version DESC LIMIT 10", rows: db.prepare("SELECT lp_version, sum(n) AS n FROM lane_pilot_wall_entry WHERE class_key=? GROUP BY lp_version ORDER BY lp_version DESC LIMIT 10").all(classKey) },
    { id: "by_project", sql: "SELECT project_id, sum(n) AS n FROM lane_pilot_wall_entry WHERE class_key=? GROUP BY project_id ORDER BY n DESC LIMIT 10", rows: db.prepare("SELECT project_id, sum(n) AS n FROM lane_pilot_wall_entry WHERE class_key=? GROUP BY project_id ORDER BY n DESC LIMIT 10").all(classKey) },
  ];
  return {
    kind: "class", subject: classKey,
    facts: [`class ${classKey}: ${cls?.failure_class ?? "?"} / ${cls?.reason_norm ?? "?"} (origin ${cls?.origin ?? "?"})`, ...(extra.facts ?? [])],
    attempts: attempts.map(attemptView), receipts: receiptsOf(db, attempts), files: extra.files ?? [], checkOutputs: attempts.map((row) => row.reason ?? ""), queries,
  };
}

/** The pack of a task wall: the contract and plan, every attempt of the family, its failed receipts, the same fingerprint elsewhere in 14 days. */
export function buildTaskPack(db: WallDb, input: { runId: string; taskId: string; family: string; fingerprintLike?: string; now: number }): EvidencePack {
  const attempts = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, a.harness_version, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.run_id=? AND (a.task_id=? OR a.task_id LIKE ?) ORDER BY a.created_at`).all(input.runId, input.family, `${input.family}.%`) as AttemptRow[];
  const task = db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=? AND run_id=?").get(input.taskId, input.runId) as { contract_json: string } | undefined;
  const plan = db.prepare("SELECT plan FROM lane_pilot_task_plan WHERE task_id=?").get(input.taskId) as { plan: string } | undefined;
  const files: PackFile[] = [];
  if (task) files.push({ path: "TASK", lines: task.contract_json.split("\n").length, text: task.contract_json.slice(0, 20_000) });
  if (plan) files.push({ path: "PLAN", lines: plan.plan.split("\n").length, text: plan.plan.slice(0, 20_000) });
  const queries: PackQuery[] = [];
  if (input.fingerprintLike) {
    const sql = "SELECT task_id, state, substr(reason,1,160) AS reason FROM lane_pilot_attempt WHERE updated_at>? AND reason LIKE ? ORDER BY updated_at DESC LIMIT 20";
    queries.push({ id: "same_fingerprint_14d", sql, rows: db.prepare(sql).all(input.now - 14 * 86_400_000, `%${input.fingerprintLike}%`) });
  }
  return {
    kind: "task", subject: `${input.runId}/${input.family}`, facts: [`task family ${input.family} in run ${input.runId}: ${attempts.length} attempts, the last ones failed the same way`],
    attempts: attempts.map(attemptView), receipts: receiptsOf(db, attempts), files, checkOutputs: attempts.map((row) => row.reason ?? ""), queries,
  };
}

/** What a loop that ran out of tries is made of: the attempts of the tasks that tried, the facts the caller knows, and texts the hunters may cite (the phase book, the verdict). */
export type LoopEvidence = {
  subject: string;
  runId?: string | null;
  /** Task ids or families (`P1` also reads `P1.2`): their attempts, failed receipts and contracts are the evidence. */
  taskIds?: readonly string[];
  facts: readonly string[];
  texts?: ReadonlyArray<{ path: string; text: string }>;
};

/** The pack of an exhausted loop (a phase stage, the replans of a failed verification, a topic of a run). */
export function buildLoopPack(db: WallDb, input: LoopEvidence): EvidencePack {
  const attempts: AttemptRow[] = [];
  const files: PackFile[] = [];
  if (input.runId) {
    const byFamily = db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, a.updated_at, a.harness_version, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
      WHERE a.run_id=? AND (a.task_id=? OR a.task_id LIKE ?) ORDER BY a.created_at`);
    const contract = db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=? AND run_id=?");
    for (const id of [...new Set(input.taskIds ?? [])].slice(0, 12)) {
      const rows = byFamily.all(input.runId, id, `${id}.%`) as AttemptRow[];
      attempts.push(...rows.slice(-6));
      const latest = rows.at(-1)?.task_id ?? id;
      const task = contract.get(latest, input.runId) as { contract_json: string } | undefined;
      if (task) files.push({ path: `TASK:${latest}`, lines: task.contract_json.split("\n").length, text: task.contract_json.slice(0, 8_000) });
    }
  }
  for (const text of input.texts ?? []) files.push({ path: text.path, lines: text.text.split("\n").length, text: text.text.slice(0, 20_000) });
  const kept = attempts.slice(-30);
  return {
    kind: "task", subject: input.subject, facts: [...input.facts], attempts: kept.map(attemptView), receipts: receiptsOf(db, kept), files: files.slice(0, 14),
    checkOutputs: kept.map((row) => row.reason ?? ""), queries: [],
  };
}
