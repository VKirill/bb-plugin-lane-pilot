import { currentLogLevel, redactKnown, sha256Hex } from "@lane-pilot/kit";
import { listRunStepFrictionFacts, WF_RUN_TABLE } from "@lane-pilot/workflow-engine";
import type { LanePilotDatabase } from "./database";

export type PilotDaySourceKind = "pilot_run" | "pilot_chat" | "workflow_run";
export type PilotDayCategoryHint = { id: string; label?: { en: string; ru: string } };
export type PilotDayArtifactSkeleton = {
  deliverableClass: string;
  sections: string[];
  matrices: string[];
  qaChecks: string[];
};
export type PilotDayAttemptFact = { id: string; taskId: string; threadId: string | null; state: string; reason: string | null; attemptNo: number };
export type PilotDayStageFact = { taskId: string; stageId: string; state: string; reason: string | null };
export type PilotDayEpisodeFact = { runId: string; threadId: string | null; processKey: string | null; goal: string | null; traps: string[]; skills: string[]; outcome: string | null };
export type PilotDayChildWfFact = { id: string; workflowId: string; threadId: string | null; status: string; reason: string | null; summary: string | null };
export type PilotDayGateFact = { taskId: string; gate: string; status: string; attempt: number; occurredAt: number };
export type PilotDayWfStepFact = { runId: string; workflowId: string | null; nodeId: string; state: string; answerKind: string | null; error: string | null };

export type PilotDayCandidate = {
  digestId: string; dayKey: string; sourceKind: PilotDaySourceKind; sourceId: string;
  projectId: string | null; threadId: string | null; workflowId: string | null;
  state: string; objective: string | null; taskSummaries: string[];
  attempts: PilotDayAttemptFact[]; stageVerdicts: PilotDayStageFact[]; pmSkills: string[];
  episodes?: PilotDayEpisodeFact[]; childRuns?: PilotDayChildWfFact[];
  gateRejections?: PilotDayGateFact[]; wfStepSignals?: PilotDayWfStepFact[];
  wfInputsJson?: string | null; wfOutputJson?: string | null; wfReason?: string | null; updatedAt: number;
};

export type PilotDayDigestRow = {
  digestId: string; dayKey: string; sourceKind: PilotDaySourceKind; sourceId: string;
  projectId: string | null; threadId: string | null; workflowId: string | null;
  outcome: string; processKey: string; categoryHint: PilotDayCategoryHint | null;
  skills: string[]; traps: string[]; maskedGoal: string; maskedLessons: string[];
  taskCount: number; artifactSkeleton: PilotDayArtifactSkeleton | null; archetypeHint: string | null;
  createdAt: number;
};

export type PilotDayDigestInput = Omit<
  PilotDayDigestRow,
  "projectId" | "threadId" | "workflowId" | "categoryHint" | "skills" | "traps" | "maskedLessons" | "taskCount" | "artifactSkeleton" | "archetypeHint" | "createdAt"
> & {
  projectId?: string | null; threadId?: string | null; workflowId?: string | null;
  categoryHint?: PilotDayCategoryHint | null; skills?: string[]; traps?: string[];
  maskedLessons?: string[]; taskCount?: number; artifactSkeleton?: PilotDayArtifactSkeleton | null; archetypeHint?: string | null;
  createdAt?: number;
};

const CHILD_WF_FILTER = `(w.workflow_id IN ('errand','specialist','web-research','research-dossier','browser-step') OR w.workflow_id LIKE 'seo-%' OR w.workflow_id LIKE 'mkt-%' OR w.workflow_id LIKE 'sp.%' OR w.workflow_id LIKE 'sp-%')`;

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

const cleanStrArray = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];

const parseCategoryHint = (raw: string | null | undefined): PilotDayCategoryHint | null => {
  const value = parseJsonSafe<unknown>(raw, null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as { id?: unknown; label?: { en?: unknown; ru?: unknown } };
  if (typeof rec.id !== "string" || !rec.id) return null;
  const label = rec.label && typeof rec.label === "object" && typeof rec.label.en === "string" && typeof rec.label.ru === "string"
    ? { en: rec.label.en, ru: rec.label.ru } : undefined;
  return label ? { id: rec.id, label } : { id: rec.id };
};

/** Safely parses a stored `artifact_skeleton_json` column, returning `null` if malformed or incomplete. */
export function parseArtifactSkeleton(raw: string | null | undefined): PilotDayArtifactSkeleton | null {
  const value = parseJsonSafe<unknown>(raw, null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const deliverableClass = typeof rec.deliverableClass === "string" ? rec.deliverableClass.trim() : "";
  const sections = cleanStrArray(rec.sections);
  if (!deliverableClass || sections.length === 0) return null;
  return {
    deliverableClass,
    sections,
    matrices: cleanStrArray(rec.matrices),
    qaChecks: cleanStrArray(rec.qaChecks),
  };
}

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
  taskCount: Number(raw.task_count ?? 0),
  artifactSkeleton: parseArtifactSkeleton(raw.artifact_skeleton_json as string | null | undefined),
  archetypeHint: typeof raw.archetype_hint === "string" && raw.archetype_hint.trim() ? raw.archetype_hint.trim() : null,
  createdAt: Number(raw.created_at),
});

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
  const pilotRunIds = selected.filter((c) => c.sourceKind === "pilot_run").map((c) => c.sourceId);
  const gatesByRun = new Map<string, PilotDayGateFact[]>();
  if (pilotRunIds.length) {
    const gateRows = db.prepare(`SELECT run_id, task_id, gate, status, attempt, occurred_at FROM lane_pilot_gate_event
      WHERE run_id IN (${pilotRunIds.map(() => "?").join(",")}) AND gate = 'owns-paths' AND status IN ('rejected','failed')
      ORDER BY occurred_at DESC LIMIT 100`).all(...pilotRunIds) as Array<{ run_id: string; task_id: string; gate: string; status: string; attempt: number; occurred_at: number }>;
    for (const g of gateRows) {
      const list = gatesByRun.get(g.run_id) ?? [];
      list.push({ taskId: g.task_id, gate: g.gate, status: g.status, attempt: Number(g.attempt), occurredAt: Number(g.occurred_at) });
      gatesByRun.set(g.run_id, list);
    }
  }
  const wfIdByRun = new Map<string, string | null>();
  for (const c of selected) if (c.sourceKind === "workflow_run") wfIdByRun.set(c.sourceId, c.workflowId);
  for (const r of childRuns) wfIdByRun.set(r.fact.id, r.fact.workflowId);
  const stepsByRun = new Map<string, PilotDayWfStepFact[]>();
  for (const s of listRunStepFrictionFacts(db, [...wfIdByRun.keys()])) {
    const list = stepsByRun.get(s.runId) ?? [];
    list.push({ runId: s.runId, workflowId: wfIdByRun.get(s.runId) ?? null, nodeId: s.nodeId, state: s.state, answerKind: s.answerKind, error: s.error });
    stepsByRun.set(s.runId, list);
  }
  return selected.map((c) => {
    const matchedChildren = childRuns.filter((r) => (c.projectId && r.projectId === c.projectId) || (c.threadId && r.parentThreads.includes(c.threadId))).slice(0, 16).map((r) => r.fact);
    const wfRunIds = [...(c.sourceKind === "workflow_run" ? [c.sourceId] : []), ...matchedChildren.map((r) => r.id)];
    return {
      ...c,
      episodes: episodes.filter((e) => (c.projectId && e.projectId === c.projectId) || (c.threadId && e.fact.threadId === c.threadId)).slice(0, 20).map((e) => e.fact),
      childRuns: matchedChildren,
      gateRejections: c.sourceKind === "pilot_run" ? (gatesByRun.get(c.sourceId) ?? []) : [],
      wfStepSignals: wfRunIds.flatMap((id) => stepsByRun.get(id) ?? []).slice(0, 20),
    };
  });
}

export type DirectOwnerChatCandidate = {
  threadId: string;
  projectId: string | null;
  title?: string | null;
  updatedAt: number;
};

/** Collects undigested daily Pilot runs, Pilot-activated chats, direct owner BB chats, and finished user workflow runs in [sinceMs, untilMs]. */
export function listPilotDayCandidates(
  db: LanePilotDatabase,
  sinceMs: number,
  untilMs: number,
  limit = 20,
  options?: { projectId?: string | null; directChats?: readonly DirectOwnerChatCandidate[] },
): PilotDayCandidate[] {
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
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_day_digest d WHERE d.source_kind = 'pilot_chat' AND d.source_id = chats.pm_thread_id AND (d.day_key = ? OR d.created_at >= chats.activity_at))
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
      AND w.workflow_id NOT IN ('errand','specialist','lead-tick','agent-routine') AND w.workflow_id NOT LIKE 'draft-test.%' AND w.workflow_id NOT LIKE 'lp.%' AND w.workflow_id NOT LIKE 'lp-%' AND w.workflow_id NOT LIKE 'sp.%' AND w.workflow_id NOT LIKE 'sp-%'
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_day_digest d WHERE d.source_kind = 'workflow_run' AND d.source_id = w.id AND (d.day_key = ? OR d.outcome != 'in_progress'))
    ORDER BY w.updated_at DESC LIMIT ?`).all(sinceMs, untilMs, ...pArgs, dayKey, safeLimit) as Array<{
    id: string; workflow_id: string; project_id: string | null; status: string; reason: string | null; inputs_json: string; output_json: string | null; updated_at: number;
  }>;
  const isChildWf = (id: string) => id === "web-research" || id === "research-dossier" || id === "browser-step" || id.startsWith("seo-") || id.startsWith("mkt-");
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

  const directCandidates: PilotDayCandidate[] = [];
  if (options?.directChats?.length) {
    const allRunThreads = new Set(
      (db.prepare("SELECT DISTINCT pm_thread_id AS t FROM lane_pilot_run WHERE pm_thread_id IS NOT NULL").all() as Array<{ t: string }>).map((r) => r.t),
    );
    const seenThreads = new Set([
      ...allRunThreads,
      ...chatCandidates.map((c) => c.sourceId),
      ...wfCandidates.map((c) => c.threadId).filter((t): t is string => Boolean(t)),
    ]);
    const hasRecentDigest = db.prepare(
      "SELECT 1 FROM lane_pilot_day_digest d WHERE ((d.source_kind = 'pilot_chat' AND d.source_id = ?) OR d.thread_id = ?) AND (d.day_key = ? OR d.created_at >= ?) LIMIT 1",
    );
    for (const dc of options.directChats) {
      const tid = dc.threadId?.trim();
      if (!tid || seenThreads.has(tid)) continue;
      if (pid && dc.projectId !== pid) continue;
      if (dc.updatedAt < sinceMs || dc.updatedAt > untilMs) continue;
      if (hasRecentDigest.get(tid, tid, dayKey, dc.updatedAt)) continue;
      seenThreads.add(tid);
      directCandidates.push({
        digestId: dayDigestId(dayKey, "pilot_chat", tid), dayKey, sourceKind: "pilot_chat", sourceId: tid,
        projectId: dc.projectId ?? null, threadId: tid, workflowId: null, state: "active",
        objective: dc.title?.trim() || null, taskSummaries: [], attempts: [], stageVerdicts: [],
        pmSkills: pmSkillsForThread(db, tid, sinceMs), updatedAt: Number(dc.updatedAt),
      });
    }
  }

  const combined = [...runCandidates, ...chatCandidates, ...wfCandidates, ...directCandidates];
  const existing = existingDigestIds(db, combined.map((c) => c.digestId));
  const selected = combined.filter((c) => !existing.has(c.digestId)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, safeLimit);
  return attachTrajectoryFacts(db, selected, sinceMs, untilMs, pid);
}

/** Idempotently persists a daily Pilot digest row by `digest_id` and returns the stored row. */
export function savePilotDayDigest(db: LanePilotDatabase, input: PilotDayDigestInput, options?: { log?: (message: string) => void }): { saved: boolean; row: PilotDayDigestRow } {
  const createdAt = input.createdAt ?? Date.now();
  const res = db.prepare(`INSERT OR IGNORE INTO lane_pilot_day_digest
    (digest_id, day_key, source_kind, source_id, project_id, thread_id, workflow_id, outcome, process_key, category_hint_json, skills_json, traps_json, masked_goal, masked_lessons_json, task_count, artifact_skeleton_json, archetype_hint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.digestId, input.dayKey, input.sourceKind, input.sourceId, input.projectId ?? null, input.threadId ?? null, input.workflowId ?? null,
    input.outcome, input.processKey, input.categoryHint ? JSON.stringify(input.categoryHint) : null,
    JSON.stringify(input.skills ?? []), JSON.stringify(input.traps ?? []), input.maskedGoal, JSON.stringify(input.maskedLessons ?? []),
    input.taskCount ?? 0,
    input.artifactSkeleton ? JSON.stringify(input.artifactSkeleton) : null,
    input.archetypeHint ?? null,
    createdAt,
  );
  const stored = db.prepare("SELECT * FROM lane_pilot_day_digest WHERE digest_id = ?").get(input.digestId) as Record<string, unknown>;
  const row = toDayDigestRow(stored);
  if (res.changes > 0) {
    options?.log?.(`INFO [storage.dayDigest] saved ${redactKnown(JSON.stringify({ digestId: row.digestId, sourceKind: row.sourceKind, processKey: row.processKey, outcome: row.outcome }))}`);
  } else if (currentLogLevel("debug") !== "silent") {
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
