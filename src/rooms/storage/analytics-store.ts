import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import { WF_RUN_TABLE } from "@lane-pilot/workflow-engine";
// The storage room's own tables that answer night and audit questions: the checkers' diff-hidden audit,
// the model rebench record, the errands' episode table, the janitor's log, bench stability marks and daily digests.
import type { LanePilotDatabase } from "./database";

/** One diff-hidden audit row, as the checkers' diff probe records it. */
export type DiffHiddenAuditRow = {
  id: string; runId: string; taskId: string; checker: string;
  withDiffFindings: unknown; diffHiddenFindings: unknown;
  phantom: boolean; blindPass: boolean; diffSensitive: boolean; recordedAt: number;
};

export function saveDiffHiddenRows(db: LanePilotDatabase, rows: readonly DiffHiddenAuditRow[]): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO lane_pilot_diff_hidden_audit
      (id, run_id, task_id, checker, with_diff_json, diff_hidden_json, phantom, blind_pass, diff_sensitive, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.runId,
        row.taskId,
        row.checker,
        JSON.stringify(row.withDiffFindings),
        JSON.stringify(row.diffHiddenFindings),
        row.phantom ? 1 : 0,
        row.blindPass ? 1 : 0,
        row.diffSensitive ? 1 : 0,
        row.recordedAt,
      );
    }
  })();
}

/** The window's diff-hidden audit totals (the checker drill's report). */
export function diffHiddenAuditSummary(db: LanePilotDatabase, sinceMs: number, untilMs: number): {
  candidates: number; total: number; blind_passes: number; phantoms: number; sensitive: number;
} {
  return db.prepare(`
    SELECT
      COUNT(DISTINCT task_id) as candidates,
      COUNT(*) as total,
      COALESCE(SUM(blind_pass), 0) as blind_passes,
      COALESCE(SUM(phantom), 0) as phantoms,
      COALESCE(SUM(diff_sensitive), 0) as sensitive
    FROM lane_pilot_diff_hidden_audit
    WHERE recorded_at >= ? AND recorded_at <= ?
  `).get(sinceMs, untilMs) as { candidates: number; total: number; blind_passes: number; phantoms: number; sensitive: number };
}

/** The episode table's columns on this database (older bases lack the enrichment fields). */
export function errandEpisodeColumns(db: LanePilotDatabase): Set<string> {
  return new Set((db.prepare("PRAGMA table_info(lane_pilot_errand_episode)").all() as Array<{ name: string }>).map((column) => column.name));
}

/** The group's episode facts, one batched read per chunk of run ids; run_id -> row (first version wins). */
export function listErrandEpisodeFacts(db: LanePilotDatabase, runIds: readonly string[], columns: { processKey: boolean; processKeyProposed: boolean; provider: boolean; model: boolean }): Map<string, Record<string, string | null>> {
  const facts = new Map<string, Record<string, string | null>>();
  if (!runIds.length || (!columns.processKey && !columns.processKeyProposed && !columns.provider && !columns.model)) return facts;
  const fields = ["run_id", ...(columns.processKey ? ["process_key"] : []), ...(columns.processKeyProposed ? ["process_key_proposed"] : []), ...(columns.provider ? ["provider_id"] : []), ...(columns.model ? ["model"] : [])];
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    const rows = db.prepare(`SELECT ${fields.join(", ")} FROM lane_pilot_errand_episode WHERE run_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<Record<string, string | null>>;
    for (const row of rows) {
      const runId = row.run_id;
      if (typeof runId !== "string" || facts.has(runId)) continue;
      facts.set(runId, row);
    }
  }
  return facts;
}

/** Trace json of the group's episodes, same chunked read; run_id -> raw trace json. */
export function listErrandEpisodeTraces(db: LanePilotDatabase, runIds: readonly string[]): Map<string, string | null> {
  const traces = new Map<string, string | null>();
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    const rows = db.prepare(`SELECT run_id, trace_json FROM lane_pilot_errand_episode WHERE run_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<{ run_id: string; trace_json: string | null }>;
    for (const row of rows) {
      if (traces.has(row.run_id)) continue;
      traces.set(row.run_id, row.trace_json);
    }
  }
  return traces;
}

/** Episodes still waiting for enrichment, oldest first (the sweep's work list; the join keeps orphans out of the limit). */
export function listPendingErrandEpisodes(db: LanePilotDatabase, staleBefore: number, limit: number): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT e.run_id, e.project_id, e.status, e.outcome, e.verified, e.thread_id, e.model, e.skills_offered_json,
      e.trace_json, e.trace_stats_json, r.reason AS run_reason, r.inputs_json AS run_inputs
    FROM lane_pilot_errand_episode e JOIN ${WF_RUN_TABLE} r ON r.id=e.run_id
    WHERE (e.enrichment_state='pending' AND (e.enriched_at IS NULL OR e.enriched_at < ?))
      OR (e.enrichment_state='held' AND e.updated_at < ?)
    ORDER BY e.created_at ASC LIMIT ?`).all(staleBefore, staleBefore, limit) as Array<Record<string, unknown>>;
}

/** Process keys with their run's inputs, newest episodes first (the enricher's known processes). */
export function listErrandProcessKeys(db: LanePilotDatabase, limit: number): Array<{ key: string; inputs_json: string | null }> {
  return db.prepare(`SELECT e.process_key AS key, r.inputs_json FROM lane_pilot_errand_episode e JOIN ${WF_RUN_TABLE} r ON r.id=e.run_id
    WHERE e.process_key IS NOT NULL ORDER BY e.created_at DESC LIMIT ?`).all(limit) as Array<{ key: string; inputs_json: string | null }>;
}

/** Episodes of a window with their run's cost and timing (the episode list; the join keeps orphans out of the limit). */
export function listErrandEpisodeRows(db: LanePilotDatabase, since: number, projectId: string | null, limit: number): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT e.*, r.tokens_used, r.cost_micro_usd, r.wait_ms, r.created_at AS run_created_at, r.updated_at AS run_updated_at
    FROM lane_pilot_errand_episode e JOIN ${WF_RUN_TABLE} r ON r.id=e.run_id
    WHERE e.updated_at>=? ${projectId ? "AND e.project_id=?" : ""}
    ORDER BY e.updated_at DESC LIMIT ?`).all(since, ...(projectId ? [projectId] : []), limit) as Array<Record<string, unknown>>;
}

/** Every episode's run_id and status (the missing-episode filter of the outcome backfill). */
export function listErrandEpisodeStates(db: LanePilotDatabase): Array<{ run_id: string; status: string }> {
  return db.prepare("SELECT run_id, status FROM lane_pilot_errand_episode").all() as Array<{ run_id: string; status: string }>;
}

/** Run ids that have an episode row (the diagnosis' routed-errand join). */
export function listErrandEpisodeRunIds(db: LanePilotDatabase): Set<string> {
  return new Set((db.prepare("SELECT run_id FROM lane_pilot_errand_episode").all() as Array<{ run_id: string }>).map((row) => row.run_id));
}

/** The janitor's freed bytes and removals of a window (the morning line). */
export function janitorSums(db: LanePilotDatabase, since: number): { bytes: number | null; removed: number | null } {
  return db.prepare("SELECT sum(freed_bytes + tmp_freed_bytes) AS bytes, sum(removed + tmp_removed) AS removed FROM lane_pilot_janitor WHERE at>=?")
    .get(since) as { bytes: number | null; removed: number | null };
}

/** The janitor's kept copies of a window, up to three, with the total (the morning line). */
export function janitorKeptSample(db: LanePilotDatabase, since: number): Array<{ v: string; total: number }> {
  return db.prepare("SELECT value AS v, (SELECT count(*) FROM lane_pilot_janitor j2, json_each(j2.kept_json) WHERE j2.at>=?) AS total FROM lane_pilot_janitor, json_each(lane_pilot_janitor.kept_json) WHERE at>=? LIMIT 3")
    .all(since, since) as Array<{ v: string; total: number }>;
}

/** Stability marks of a bench set: upserts the given marks, drops the given tasks. */
export function saveBenchStabilityMarks(db: LanePilotDatabase, input: { setId: string; marks: ReadonlyMap<string, string>; dropIds: readonly string[]; detail: unknown; now?: number }): void {
  const now = input.now ?? Date.now();
  const detail = JSON.stringify(input.detail ?? {});
  const upsert = db.prepare("INSERT INTO lane_pilot_bench_mark(set_id,task_id,mark,detail_json,marked_at) VALUES(?,?,?,?,?) ON CONFLICT(set_id,task_id) DO UPDATE SET mark=excluded.mark, detail_json=excluded.detail_json, marked_at=excluded.marked_at");
  for (const [taskId, mark] of input.marks) upsert.run(input.setId, taskId, mark, detail, now);
  const drop = db.prepare("DELETE FROM lane_pilot_bench_mark WHERE set_id=? AND task_id=?");
  for (const taskId of input.dropIds) drop.run(input.setId, taskId);
}

/** Stability marks of a bench set, task_id -> mark. */
export function listBenchStabilityMarks(db: LanePilotDatabase, setId: string): Map<string, string> {
  const rows = db.prepare("SELECT task_id, mark FROM lane_pilot_bench_mark WHERE set_id=?").all(setId) as Array<{ task_id: string; mark: string }>;
  return new Map(rows.map((row) => [row.task_id, row.mark]));
}

/** The newest extractor's episode row per run id (the diagnosis' episode fields). */
export function latestErrandEpisodeRows(db: LanePilotDatabase, runIds: readonly string[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    if (!chunk.length) break;
    const rows = db.prepare(`SELECT * FROM lane_pilot_errand_episode e WHERE e.run_id IN (${chunk.map(() => "?").join(",")})
      AND e.extractor_version = (SELECT MAX(e2.extractor_version) FROM lane_pilot_errand_episode e2 WHERE e2.run_id = e.run_id)`).all(...chunk) as Array<Record<string, unknown>>;
    for (const row of rows) map.set(String(row.run_id), row);
  }
  return map;
}

export type PilotDaySourceKind = "pilot_run" | "pilot_chat" | "workflow_run";
export type PilotDayCategoryHint = { id: string; label?: { en: string; ru: string } };
export type PilotDayAttemptFact = { id: string; taskId: string; threadId: string | null; state: string; reason: string | null; attemptNo: number };
export type PilotDayStageFact = { taskId: string; stageId: string; state: string; reason: string | null };
export type PilotDayEpisodeFact = { runId: string; threadId: string | null; processKey: string | null; goal: string | null; traps: string[]; skills: string[]; outcome: string | null };
export type PilotDayChildWfFact = { id: string; workflowId: string; threadId: string | null; status: string; reason: string | null; summary: string | null };

export type PilotDayCandidate = {
  digestId: string; dayKey: string; sourceKind: PilotDaySourceKind; sourceId: string;
  projectId: string | null; threadId: string | null; workflowId: string | null;
  state: string; objective: string | null; taskSummaries: string[];
  attempts: PilotDayAttemptFact[]; stageVerdicts: PilotDayStageFact[]; pmSkills: string[];
  episodes?: PilotDayEpisodeFact[]; childRuns?: PilotDayChildWfFact[];
  wfInputsJson?: string | null; wfOutputJson?: string | null; wfReason?: string | null; updatedAt: number;
};

export type PilotDayDigestRow = {
  digestId: string; dayKey: string; sourceKind: PilotDaySourceKind; sourceId: string;
  projectId: string | null; threadId: string | null; workflowId: string | null;
  outcome: string; processKey: string; categoryHint: PilotDayCategoryHint | null;
  skills: string[]; traps: string[]; maskedGoal: string; maskedLessons: string[];
  taskCount: number; createdAt: number;
};

export type PilotDayDigestInput = Omit<
  PilotDayDigestRow,
  "projectId" | "threadId" | "workflowId" | "categoryHint" | "skills" | "traps" | "maskedLessons" | "taskCount" | "createdAt"
> & {
  projectId?: string | null; threadId?: string | null; workflowId?: string | null;
  categoryHint?: PilotDayCategoryHint | null; skills?: string[]; traps?: string[];
  maskedLessons?: string[]; taskCount?: number; createdAt?: number;
};

const dayDigestId = (dayKey: string, sourceKind: PilotDaySourceKind, sourceId: string): string =>
  `pdigest_${sha256Hex(`${dayKey}|${sourceKind}|${sourceId}`).slice(0, 24)}`;

const parseJsonSafe = <T,>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

const parseStrList = (raw: string | null | undefined): string[] => {
  const parsed = parseJsonSafe<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
};

const parseCategoryHint = (raw: string | null | undefined): PilotDayCategoryHint | null => {
  const value = parseJsonSafe<unknown>(raw, null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as { id?: unknown; label?: { en?: unknown; ru?: unknown } };
  if (typeof rec.id !== "string" || !rec.id) return null;
  const label = rec.label && typeof rec.label === "object" && typeof rec.label.en === "string" && typeof rec.label.ru === "string"
    ? { en: rec.label.en, ru: rec.label.ru } : undefined;
  return label ? { id: rec.id, label } : { id: rec.id };
};

const pmSkillsForThread = (db: LanePilotDatabase, threadId: string | null, sinceMs: number): string[] => {
  if (!threadId) return [];
  return (db.prepare("SELECT skill FROM lane_pilot_pm_skill_use WHERE thread_id=? AND used_at>=? GROUP BY skill ORDER BY MIN(used_at) ASC")
    .all(threadId, sinceMs) as Array<{ skill: string }>).map((r) => r.skill);
};

const existingDigestIds = (db: LanePilotDatabase, ids: readonly string[]): Set<string> => {
  const found = new Set<string>();
  for (let at = 0; at < ids.length; at += 400) {
    const chunk = ids.slice(at, at + 400);
    if (!chunk.length) break;
    const rows = db.prepare(`SELECT digest_id FROM lane_pilot_day_digest WHERE digest_id IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk) as Array<{ digest_id: string }>;
    for (const row of rows) found.add(row.digest_id);
  }
  return found;
};

const toDayDigestRow = (raw: Record<string, unknown>): PilotDayDigestRow => ({
  digestId: String(raw.digest_id), dayKey: String(raw.day_key),
  sourceKind: String(raw.source_kind) as PilotDaySourceKind, sourceId: String(raw.source_id),
  projectId: (raw.project_id as string | null) ?? null, threadId: (raw.thread_id as string | null) ?? null,
  workflowId: (raw.workflow_id as string | null) ?? null, outcome: String(raw.outcome), processKey: String(raw.process_key),
  categoryHint: parseCategoryHint(raw.category_hint_json as string | null),
  skills: parseStrList(raw.skills_json as string | null), traps: parseStrList(raw.traps_json as string | null),
  maskedGoal: String(raw.masked_goal ?? ""), maskedLessons: parseStrList(raw.masked_lessons_json as string | null),
  taskCount: Number(raw.task_count ?? 0), createdAt: Number(raw.created_at),
});

const CHILD_WF_FILTER = `(w.workflow_id IN ('errand','specialist','web-research','research-dossier','browser-step') OR w.workflow_id LIKE 'seo-%' OR w.workflow_id LIKE 'sp.%' OR w.workflow_id LIKE 'sp-%')`;

const strAt = (obj: Record<string, unknown> | null, keys: readonly string[]): string | null => {
  for (const k of keys) if (typeof obj?.[k] === "string" && (obj[k] as string).trim()) return (obj[k] as string).trim();
  return null;
};

function attachTrajectoryFacts(db: LanePilotDatabase, selected: PilotDayCandidate[], sinceMs: number, untilMs: number, pid: string | null): PilotDayCandidate[] {
  if (!selected.length) return selected;
  const pArgs = pid ? [pid] : [];
  const epRows = db.prepare(`SELECT run_id, project_id, thread_id, outcome, process_key, process_key_proposed, summary_json FROM lane_pilot_errand_episode
    WHERE enrichment_state = 'enriched' AND updated_at >= ? AND updated_at <= ?${pid ? " AND project_id = ?" : ""} ORDER BY extractor_version DESC, updated_at DESC LIMIT 400`)
    .all(sinceMs, untilMs, ...pArgs) as Array<Record<string, unknown>>;
  const seenRuns = new Set<string>();
  const episodes: Array<{ projectId: string | null; fact: PilotDayEpisodeFact }> = [];
  for (const e of epRows) {
    const runId = String(e.run_id ?? "");
    if (!runId || seenRuns.has(runId)) continue;
    seenRuns.add(runId);
    const s = parseJsonSafe<Record<string, unknown> | null>(e.summary_json as string | null, null);
    const traps = (Array.isArray(s?.traps) ? s.traps : []).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    const skills = (Array.isArray(s?.skills) ? s.skills : []).flatMap((x) => {
      const r = x && typeof x === "object" ? x as { name?: unknown; read?: unknown; used?: unknown } : null;
      return r && (r.read === true || r.used === true) && typeof r.name === "string" && r.name.trim() ? [r.name.trim()] : [];
    });
    episodes.push({
      projectId: typeof e.project_id === "string" && e.project_id ? e.project_id : null,
      fact: {
        runId, threadId: typeof e.thread_id === "string" && e.thread_id ? e.thread_id : null,
        processKey: (typeof e.process_key === "string" && e.process_key.trim()) || (typeof e.process_key_proposed === "string" && e.process_key_proposed.trim()) || null,
        goal: strAt(s, ["goal"]), traps, skills, outcome: typeof e.outcome === "string" ? e.outcome : null,
      },
    });
  }
  const wfRows = db.prepare(`SELECT w.id, w.workflow_id, w.project_id, w.status, w.reason, w.inputs_json, w.output_json FROM ${WF_RUN_TABLE} w
    WHERE w.status IN ('succeeded','failed','canceled','timed_out','blocked','not_verified','interrupted') AND w.updated_at >= ? AND w.updated_at <= ? AND ${CHILD_WF_FILTER}${pid ? " AND w.project_id = ?" : ""}
    ORDER BY w.updated_at DESC LIMIT 400`).all(sinceMs, untilMs, ...pArgs) as Array<Record<string, unknown>>;
  const childRuns = wfRows.map((w) => {
    const inputs = parseJsonSafe<Record<string, unknown> | null>(w.inputs_json as string | null, null);
    const output = parseJsonSafe<Record<string, unknown> | null>(w.output_json as string | null, null);
    const parentThreads = [inputs?.pmThreadId, inputs?.threadId, inputs?.parentThreadId].filter((v): v is string => typeof v === "string" && v.length > 0);
    const rawOut = typeof w.output_json === "string" && w.output_json.trim() && w.output_json.trim() !== "{}" ? w.output_json.trim() : null;
    const summary = (strAt(output, ["summary", "text", "result", "goal"]) ?? strAt(inputs, ["goal", "prompt", "topic", "task", "title"]) ?? rawOut)?.slice(0, 300) ?? null;
    return {
      projectId: typeof w.project_id === "string" && w.project_id ? w.project_id : null, parentThreads,
      fact: { id: String(w.id), workflowId: String(w.workflow_id), threadId: strAt(output, ["threadId", "childThreadId"]) ?? strAt(inputs, ["childThreadId", "threadId", "pmThreadId"]), status: String(w.status), reason: typeof w.reason === "string" && w.reason ? w.reason.slice(0, 300) : null, summary } satisfies PilotDayChildWfFact,
    };
  });
  return selected.map((c) => ({
    ...c,
    episodes: episodes.filter((e) => (c.projectId && e.projectId === c.projectId) || (c.threadId && e.fact.threadId === c.threadId)).slice(0, 20).map((e) => e.fact),
    childRuns: childRuns.filter((r) => (c.projectId && r.projectId === c.projectId) || (c.threadId && r.parentThreads.includes(c.threadId))).slice(0, 16).map((r) => r.fact),
  }));
}

/** Collects undigested daily Pilot runs, Pilot-activated chats, and finished user workflow runs in [sinceMs, untilMs]. */
export function listPilotDayCandidates(db: LanePilotDatabase, sinceMs: number, untilMs: number, limit = 20, options?: { projectId?: string | null }): PilotDayCandidate[] {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  const pid = options?.projectId?.trim() || null;
  const dayKey = new Date(Math.max(0, untilMs - 1)).toISOString().slice(0, 10);
  const runWindow = `((r.updated_at >= ? AND r.updated_at <= ?) OR (r.closed_at IS NOT NULL AND r.closed_at >= ? AND r.closed_at <= ?)
    OR EXISTS(SELECT 1 FROM lane_pilot_attempt a WHERE a.run_id = r.id AND a.updated_at >= ? AND a.updated_at <= ?))`;
  const runThreadsInWindow = new Set(
    (db.prepare(`SELECT DISTINCT r.pm_thread_id AS t FROM lane_pilot_run r WHERE r.pm_thread_id IS NOT NULL AND ${runWindow}${pid ? " AND r.project_id = ?" : ""}`)
      .all(sinceMs, untilMs, sinceMs, untilMs, sinceMs, untilMs, ...(pid ? [pid] : [])) as Array<{ t: string }>).map((r) => r.t),
  );
  const runRows = db.prepare(`SELECT r.id, r.project_id, r.pm_thread_id, r.state, r.objective,
      MAX(r.updated_at, COALESCE(r.closed_at, 0), COALESCE((SELECT MAX(a.updated_at) FROM lane_pilot_attempt a WHERE a.run_id = r.id), 0)) AS activity_at
    FROM lane_pilot_run r WHERE ${runWindow}${pid ? " AND r.project_id = ?" : ""}
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_day_digest d WHERE d.source_kind = 'pilot_run' AND d.source_id = r.id AND (d.day_key = ? OR d.outcome != 'in_progress'))
    ORDER BY activity_at DESC LIMIT ?`).all(sinceMs, untilMs, sinceMs, untilMs, sinceMs, untilMs, ...(pid ? [pid] : []), dayKey, safeLimit) as Array<{
    id: string; project_id: string; pm_thread_id: string | null; state: string; objective: string | null; activity_at: number;
  }>;

  const taskStmt = db.prepare("SELECT id, contract_json FROM lane_pilot_task WHERE run_id = ? ORDER BY created_at ASC LIMIT 12");
  const attemptStmt = db.prepare("SELECT id, task_id, thread_id, state, reason, attempt_no FROM lane_pilot_attempt WHERE run_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 12");
  const stageStmt = db.prepare("SELECT task_id, stage_id, state, reason FROM lane_pilot_stage_receipt WHERE run_id = ? ORDER BY updated_at DESC LIMIT 16");
  const runCandidates: PilotDayCandidate[] = runRows.map((run) => {
    const tasks = taskStmt.all(run.id) as Array<{ id: string; contract_json: string }>;
    const attempts = attemptStmt.all(run.id) as Array<{ id: string; task_id: string; thread_id: string | null; state: string; reason: string | null; attempt_no: number }>;
    const stages = stageStmt.all(run.id) as Array<{ task_id: string; stage_id: string; state: string; reason: string | null }>;
    return {
      digestId: dayDigestId(dayKey, "pilot_run", run.id), dayKey, sourceKind: "pilot_run", sourceId: run.id,
      projectId: run.project_id ?? null, threadId: run.pm_thread_id ?? null, workflowId: null, state: run.state, objective: run.objective ?? null,
      taskSummaries: tasks.map((t) => {
        const c = parseJsonSafe<Record<string, unknown> | null>(t.contract_json, null);
        return typeof c?.title === "string" && c.title.trim() ? c.title.trim() : typeof c?.goal === "string" && c.goal.trim() ? c.goal.trim() : t.id;
      }),
      attempts: attempts.map((a) => ({ id: a.id, taskId: a.task_id, threadId: a.thread_id ?? null, state: a.state, reason: a.reason ? a.reason.slice(0, 400) : null, attemptNo: Number(a.attempt_no) })),
      stageVerdicts: stages.map((s) => ({ taskId: s.task_id, stageId: s.stage_id, state: s.state, reason: s.reason ? s.reason.slice(0, 300) : null })),
      pmSkills: pmSkillsForThread(db, run.pm_thread_id, sinceMs), updatedAt: Number(run.activity_at),
    };
  });

  const pArgs = pid ? [pid] : [];
  const chatRows = db.prepare(`SELECT pm_thread_id, MAX(project_id) AS project_id, MAX(activity_at) AS activity_at FROM (
      SELECT pm_thread_id, project_id, claimed_at AS activity_at FROM lane_pilot_activation WHERE claimed_at >= ? AND claimed_at <= ?${pid ? " AND project_id = ?" : ""}
      UNION ALL
      SELECT n.pm_thread_id, r.project_id, n.sent_at AS activity_at FROM lane_pilot_pm_notice n
        LEFT JOIN lane_pilot_attempt a ON a.id = n.attempt_id LEFT JOIN lane_pilot_run r ON r.id = a.run_id
        WHERE n.sent_at >= ? AND n.sent_at <= ?${pid ? " AND r.project_id = ?" : ""}
      UNION ALL
      SELECT CASE WHEN json_valid(w.inputs_json) THEN COALESCE(json_extract(w.inputs_json, '$.pmThreadId'), json_extract(w.inputs_json, '$.threadId')) ELSE NULL END AS pm_thread_id,
        w.project_id, w.updated_at AS activity_at FROM ${WF_RUN_TABLE} w
        WHERE w.updated_at >= ? AND w.updated_at <= ? AND ${CHILD_WF_FILTER}${pid ? " AND w.project_id = ?" : ""}
    ) chats WHERE pm_thread_id IS NOT NULL AND pm_thread_id != ''
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_day_digest d WHERE d.source_kind = 'pilot_chat' AND d.source_id = chats.pm_thread_id AND d.day_key = ?)
    GROUP BY pm_thread_id ORDER BY activity_at DESC LIMIT ?`).all(sinceMs, untilMs, ...pArgs, sinceMs, untilMs, ...pArgs, sinceMs, untilMs, ...pArgs, dayKey, safeLimit + runThreadsInWindow.size) as Array<{
    pm_thread_id: string; project_id: string | null; activity_at: number;
  }>;
  const chatCandidates: PilotDayCandidate[] = chatRows
    .filter((row) => !runThreadsInWindow.has(row.pm_thread_id)).slice(0, safeLimit)
    .map((row) => ({
      digestId: dayDigestId(dayKey, "pilot_chat", row.pm_thread_id), dayKey, sourceKind: "pilot_chat", sourceId: row.pm_thread_id,
      projectId: row.project_id ?? null, threadId: row.pm_thread_id, workflowId: null, state: "active", objective: null,
      taskSummaries: [], attempts: [], stageVerdicts: [], pmSkills: pmSkillsForThread(db, row.pm_thread_id, sinceMs), updatedAt: Number(row.activity_at),
    }));

  const coveredThreads = new Set([...runThreadsInWindow, ...chatCandidates.map((c) => c.threadId).filter((t): t is string => Boolean(t))]);
  const wfRows = db.prepare(`SELECT id, workflow_id, project_id, status, reason, inputs_json, output_json, updated_at FROM ${WF_RUN_TABLE} w
    WHERE w.status IN ('succeeded','failed','canceled','timed_out','blocked','not_verified') AND w.updated_at >= ? AND w.updated_at <= ?${pid ? " AND w.project_id = ?" : ""}
      AND w.workflow_id NOT IN ('errand','specialist') AND w.workflow_id NOT LIKE 'lp.%' AND w.workflow_id NOT LIKE 'lp-%' AND w.workflow_id NOT LIKE 'sp.%' AND w.workflow_id NOT LIKE 'sp-%'
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_day_digest d WHERE d.source_kind = 'workflow_run' AND d.source_id = w.id AND (d.day_key = ? OR d.outcome != 'in_progress'))
    ORDER BY w.updated_at DESC LIMIT ?`).all(sinceMs, untilMs, ...pArgs, dayKey, safeLimit) as Array<{
    id: string; workflow_id: string; project_id: string | null; status: string; reason: string | null; inputs_json: string; output_json: string | null; updated_at: number;
  }>;
  const isChildWf = (id: string) => id === "web-research" || id === "research-dossier" || id === "browser-step" || id.startsWith("seo-");
  const wfCandidates: PilotDayCandidate[] = wfRows.flatMap((w) => {
    const inputs = parseJsonSafe<Record<string, unknown> | null>(w.inputs_json, null);
    const threadId = typeof inputs?.threadId === "string" ? inputs.threadId : typeof inputs?.pmThreadId === "string" ? inputs.pmThreadId : null;
    if (threadId && coveredThreads.has(threadId) && isChildWf(w.workflow_id)) return [];
    return [{
      digestId: dayDigestId(dayKey, "workflow_run", w.id), dayKey, sourceKind: "workflow_run", sourceId: w.id,
      projectId: w.project_id ?? null, threadId, workflowId: w.workflow_id, state: w.status, objective: null,
      taskSummaries: [], attempts: [], stageVerdicts: [], pmSkills: [],
      wfInputsJson: w.inputs_json ?? null, wfOutputJson: w.output_json ?? null, wfReason: w.reason ?? null, updatedAt: Number(w.updated_at),
    }];
  });

  const combined = [...runCandidates, ...chatCandidates, ...wfCandidates];
  const existing = existingDigestIds(db, combined.map((c) => c.digestId));
  const selected = combined.filter((c) => !existing.has(c.digestId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, safeLimit);
  return attachTrajectoryFacts(db, selected, sinceMs, untilMs, pid);
}

/** Idempotently persists a daily Pilot digest row by `digest_id` and returns the stored row. */
export function savePilotDayDigest(db: LanePilotDatabase, input: PilotDayDigestInput, options?: { log?: (message: string) => void }): { saved: boolean; row: PilotDayDigestRow } {
  const createdAt = input.createdAt ?? Date.now();
  const res = db.prepare(`INSERT OR IGNORE INTO lane_pilot_day_digest
    (digest_id, day_key, source_kind, source_id, project_id, thread_id, workflow_id, outcome, process_key, category_hint_json, skills_json, traps_json, masked_goal, masked_lessons_json, task_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.digestId, input.dayKey, input.sourceKind, input.sourceId, input.projectId ?? null, input.threadId ?? null, input.workflowId ?? null,
    input.outcome, input.processKey, input.categoryHint ? JSON.stringify(input.categoryHint) : null,
    JSON.stringify(input.skills ?? []), JSON.stringify(input.traps ?? []), input.maskedGoal, JSON.stringify(input.maskedLessons ?? []),
    input.taskCount ?? 0, createdAt,
  );
  const stored = db.prepare("SELECT * FROM lane_pilot_day_digest WHERE digest_id = ?").get(input.digestId) as Record<string, unknown>;
  const row = toDayDigestRow(stored);
  if (res.changes > 0) {
    options?.log?.(`INFO [storage.dayDigest] saved ${redactKnown(JSON.stringify({ digestId: row.digestId, sourceKind: row.sourceKind, processKey: row.processKey, outcome: row.outcome }))}`);
  } else if (process.env.LOG_LEVEL !== "silent") {
    options?.log?.(`DEBUG [storage.dayDigest] duplicate ${redactKnown(JSON.stringify({ digestId: row.digestId, sourceKind: row.sourceKind }))}`);
  }
  return { saved: res.changes > 0, row };
}

/** Lists stored daily Pilot digests since `sinceMs`, newest first. */
export function listPilotDayDigests(db: LanePilotDatabase, sinceMs: number, limit = 200, projectId?: string | null): PilotDayDigestRow[] {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  const pid = projectId?.trim() || null;
  const rows = db.prepare(`SELECT * FROM lane_pilot_day_digest WHERE created_at >= ?${pid ? " AND project_id = ?" : ""} ORDER BY created_at DESC, digest_id ASC LIMIT ?`)
    .all(sinceMs, ...(pid ? [pid] : []), safeLimit) as Array<Record<string, unknown>>;
  return rows.map(toDayDigestRow);
}
