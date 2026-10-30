import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { fingerprint as treeFingerprint, inventory as treeInventory, type Tree } from "@lane-pilot/harness-core";

export type HarnessDb = Pick<Database.Database, "prepare">;

export type HarnessState = "base" | "candidate" | "trial" | "adopted" | "retired";

export type HarnessRow = {
  id: string; projectId: string; area: string; writerKey: string; version: number; parentId: string | null;
  tree: Tree; fingerprint: string; state: HarnessState; createdBy: string; notes: string | null; reason: string | null;
  createdAt: number; trialStartedAt: number | null; decidedAt: number | null;
};

type Raw = {
  id: string; project_id: string; area: string; writer_key: string; version: number; parent_id: string | null; tree_json: string; fingerprint: string;
  state: HarnessState; created_by: string; notes: string | null; reason: string | null; created_at: number; trial_started_at: number | null; decided_at: number | null;
};

/** The writer key a harness is tuned for: `provider/model`, or `*` for every writer of the area. */
export const writerKeyOf = (providerId: string, model: string): string => `${providerId}/${model}`;
export const ANY_WRITER = "*";

export const harnessId = (projectId: string, area: string, writerKey: string, fp: string): string =>
  `hrn_${createHash("sha256").update(`${projectId}\0${area}\0${writerKey}\0${fp}`).digest("hex").slice(0, 16)}`;

const fromRaw = (row: Raw): HarnessRow => ({
  id: row.id, projectId: row.project_id, area: row.area, writerKey: row.writer_key, version: row.version, parentId: row.parent_id,
  tree: parseTree(row.tree_json), fingerprint: row.fingerprint, state: row.state, createdBy: row.created_by, notes: row.notes, reason: row.reason,
  createdAt: row.created_at, trialStartedAt: row.trial_started_at, decidedAt: row.decided_at,
});

function parseTree(json: string): Tree {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Tree;
  } catch { return {}; }
}

export function getHarness(db: HarnessDb, id: string): HarnessRow | null {
  const row = db.prepare("SELECT * FROM lane_pilot_harness WHERE id=?").get(id) as Raw | undefined;
  return row ? fromRaw(row) : null;
}

export function listHarnesses(db: HarnessDb, projectId: string, filter: { area?: string; writerKey?: string; states?: readonly HarnessState[] } = {}): HarnessRow[] {
  const where = ["project_id=?"], args: unknown[] = [projectId];
  if (filter.area !== undefined) { where.push("area=?"); args.push(filter.area); }
  if (filter.writerKey !== undefined) { where.push("writer_key=?"); args.push(filter.writerKey); }
  if (filter.states?.length) { where.push(`state IN (${filter.states.map(() => "?").join(",")})`); args.push(...filter.states); }
  return (db.prepare(`SELECT * FROM lane_pilot_harness WHERE ${where.join(" AND ")} ORDER BY area, writer_key, version DESC, created_at DESC`).all(...args) as Raw[]).map(fromRaw);
}

/**
 * The tree writers of this key run under now: the adopted one, else the base. The base is created on first use as the
 * empty tree: everything a writer gets today (the fixed brief, rules, memory, picked skills) stays, and the harness adds.
 */
export function activeHarness(db: HarnessDb, projectId: string, area: string, writerKey: string, now = Date.now()): HarnessRow {
  const adopted = db.prepare("SELECT * FROM lane_pilot_harness WHERE project_id=? AND area=? AND writer_key=? AND state='adopted' ORDER BY version DESC LIMIT 1")
    .get(projectId, area, writerKey) as Raw | undefined;
  if (adopted) return fromRaw(adopted);
  const base = db.prepare("SELECT * FROM lane_pilot_harness WHERE project_id=? AND area=? AND writer_key=? AND state='base' LIMIT 1")
    .get(projectId, area, writerKey) as Raw | undefined;
  if (base) return fromRaw(base);
  return insertHarness(db, { projectId, area, writerKey, tree: {}, state: "base", createdBy: "system", parentId: null, now });
}

export function trialHarness(db: HarnessDb, projectId: string, area: string, writerKey: string): HarnessRow | null {
  const row = db.prepare("SELECT * FROM lane_pilot_harness WHERE project_id=? AND area=? AND writer_key=? AND state='trial' ORDER BY trial_started_at DESC LIMIT 1")
    .get(projectId, area, writerKey) as Raw | undefined;
  return row ? fromRaw(row) : null;
}

export function insertHarness(db: HarnessDb, input: {
  projectId: string; area: string; writerKey: string; tree: Tree; state: HarnessState; createdBy: string; parentId: string | null;
  notes?: string | null; reason?: string | null; now?: number;
}): HarnessRow {
  const now = input.now ?? Date.now();
  const fp = treeFingerprint(input.tree);
  const last = db.prepare("SELECT MAX(version) AS v FROM lane_pilot_harness WHERE project_id=? AND area=? AND writer_key=?").get(input.projectId, input.area, input.writerKey) as { v: number | null };
  const version = (last.v ?? 0) + 1;
  const id = harnessId(input.projectId, input.area, input.writerKey, `${fp}:${version}`);
  db.prepare(`INSERT INTO lane_pilot_harness (id,project_id,area,writer_key,version,parent_id,tree_json,fingerprint,state,created_by,notes,reason,created_at,trial_started_at,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
    // C4: the mechanism mix is part of the record — a tree that adds a skill, a check, hooks or memory is an
    // intervention, not another rule text, and the trial row must say so (AHE: the win lives in tools, hooks, memory).
    .run(id, input.projectId, input.area, input.writerKey, version, input.parentId, JSON.stringify(input.tree), fp, input.state, input.createdBy,
      [`mechanisms: ${treeInventory(input.tree)}`, input.notes ?? ""].filter(Boolean).join("\n") || null, input.reason ?? null, now, input.state === "trial" ? now : null);
  return getHarness(db, id)!;
}

export function setHarnessState(db: HarnessDb, id: string, state: HarnessState, reason: string | null, now = Date.now()): void {
  db.prepare("UPDATE lane_pilot_harness SET state=?, reason=COALESCE(?, reason), decided_at=CASE WHEN ? IN ('adopted','retired') THEN ? ELSE decided_at END, trial_started_at=CASE WHEN ?='trial' THEN COALESCE(trial_started_at, ?) ELSE trial_started_at END WHERE id=?")
    .run(state, reason, state, now, state, now, id);
}

/** Which tree and arm an attempt ran under. */
export function assignAttemptHarness(db: HarnessDb, attemptId: string, harnessId: string, arm: "new" | "old" | null): void {
  db.prepare("UPDATE lane_pilot_attempt SET harness_tree_id=?, harness_arm=? WHERE id=?").run(harnessId, arm, attemptId);
}

/** Attempts of a trial since it started: the candidate's own (arm `new`) and the replaced tree's in the same period (arm `old`). */
export type ArmAttempt = { attemptId: string; taskId: string; state: string; attemptNo: number; arm: "new" | "old"; blockingFindings: number; createdAt: number };

export function trialAttempts(db: HarnessDb, trial: Pick<HarnessRow, "id" | "parentId" | "trialStartedAt">): ArmAttempt[] {
  const since = trial.trialStartedAt ?? 0;
  const rows = db.prepare(`SELECT a.id AS attemptId, a.task_id AS taskId, a.state, a.attempt_no AS attemptNo, a.harness_arm AS arm, a.created_at AS createdAt, a.run_id AS runId
    FROM lane_pilot_attempt a WHERE a.created_at>=? AND ((a.harness_tree_id=? AND a.harness_arm='new') OR (a.harness_tree_id=? AND a.harness_arm='old'))
    ORDER BY a.created_at`).all(since, trial.id, trial.parentId ?? "") as Array<{ attemptId: string; taskId: string; state: string; attemptNo: number; arm: "new" | "old"; createdAt: number; runId: string }>;
  const findings = db.prepare("SELECT result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id='code-critique' ORDER BY updated_at DESC LIMIT 1");
  return rows.map((row) => {
    let blocking = 0;
    const receipt = findings.get(row.runId, row.taskId) as { result_json: string | null } | undefined;
    if (receipt?.result_json) {
      try {
        const parsed = JSON.parse(receipt.result_json) as { findings?: Array<{ severity?: unknown }> };
        blocking = (parsed.findings ?? []).filter((f) => f.severity === "blocking" || f.severity === "critical" || f.severity === "high").length;
      } catch { /* an unreadable receipt counts no findings */ }
    }
    return { attemptId: row.attemptId, taskId: row.taskId, state: row.state, attemptNo: row.attemptNo, arm: row.arm, blockingFindings: blocking, createdAt: row.createdAt };
  });
}

export type ExperienceRow = { harnessId: string; editsMd: string; cue: string | null; lesson: string | null; evidence: string | null; confidence: string | null; ruleId: string | null; createdAt: number };

export function saveExperience(db: HarnessDb, row: Omit<ExperienceRow, "createdAt"> & { now?: number }): void {
  db.prepare(`INSERT INTO lane_pilot_harness_experience (harness_id,edits_md,cue,lesson,evidence,confidence,rule_id,created_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(harness_id) DO UPDATE SET edits_md=excluded.edits_md, cue=excluded.cue, lesson=excluded.lesson, evidence=excluded.evidence, confidence=excluded.confidence, rule_id=excluded.rule_id`)
    .run(row.harnessId, row.editsMd, row.cue, row.lesson, row.evidence, row.confidence, row.ruleId, row.now ?? Date.now());
}

export function listExperiences(db: HarnessDb, projectId: string, area: string): Array<ExperienceRow & { harness: HarnessRow }> {
  const rows = db.prepare(`SELECT e.harness_id AS harnessId, e.edits_md AS editsMd, e.cue, e.lesson, e.evidence, e.confidence, e.rule_id AS ruleId, e.created_at AS createdAt
    FROM lane_pilot_harness_experience e JOIN lane_pilot_harness h ON h.id=e.harness_id WHERE h.project_id=? AND h.area=? ORDER BY e.created_at DESC LIMIT 20`)
    .all(projectId, area) as ExperienceRow[];
  return rows.map((row) => ({ ...row, harness: getHarness(db, row.harnessId)! })).filter((row) => row.harness);
}

/** Keys (area, writer) with enough recent attempts, spread over at least `minSpanMs`, to teach an editor something (an area that lived an afternoon repeats nothing), newest activity first. */
export function teachingKeys(db: HarnessDb, projectId: string, since: number, minAttempts: number, minSpanMs = 0): Array<{ area: string; writerKey: string; attempts: number }> {
  const rows = db.prepare(`SELECT COALESCE(json_extract(t.contract_json,'$.area'),'') AS area,
      COALESCE(json_extract(x.trace_json,'$.dispatchContext.writerKey'), '*') AS writerKey, count(*) AS attempts, max(a.created_at) AS last
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_task t ON t.id=a.task_id
    LEFT JOIN lane_pilot_attempt_reasoning x ON x.attempt_id=a.id
    WHERE r.project_id=? AND a.created_at>=? AND a.task_id NOT LIKE 'drill-%' AND a.state IN ('accepted','blocked','validation_failed','empty_output')
    GROUP BY 1,2 HAVING count(*)>=? AND max(a.created_at)-min(a.created_at)>=? ORDER BY last DESC`).all(projectId, since, minAttempts, minSpanMs) as Array<{ area: string; writerKey: string; attempts: number }>;
  return rows.map((row) => ({ area: row.area ?? "", writerKey: row.writerKey ?? "*", attempts: row.attempts }));
}
