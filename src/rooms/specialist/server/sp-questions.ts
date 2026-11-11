import type { LanePilotDatabase } from "../../storage";
import { type BankQuestion, loadMergedQuestions, loadQuestionBank, mergeShadowQuestions } from "../plugin-python";
import { loadSpPolicy } from "../tool-tiers";

export { type BankQuestion, loadMergedQuestions, loadQuestionBank };

function mapModeToContours(mode: string): Set<BankQuestion["contour"]> {
  switch (mode) {
    case "intake":
    case "cold_start":
      return new Set(["intake_cold_start"]);
    case "pre_launch":
    case "pre_flight":
      return new Set(["pre_flight_graph"]);
    case "anomaly":
      return new Set(["anomaly_reactive"]);
    case "ttl_sweep":
      return new Set(["periodic_ttl_sweep"]);
    default:
      return new Set(["anomaly_reactive", "periodic_ttl_sweep", "pre_flight_graph"]);
  }
}

function priorityOf(impactWeight: number, autoResolvable: boolean): "P0" | "P1" | "P2" | "P3" {
  if (impactWeight >= 0.9 && !autoResolvable) return "P0";
  if (impactWeight >= 0.85) return "P1";
  if (impactWeight >= 0.7) return "P2";
  return "P3";
}

function scoreQuestionRelevance(q: BankQuestion, signalTokens: Set<string>, hasActiveDelta: boolean): number {
  let score = q.impact_weight * 0.75;
  const trigWords = q.trigger_situation.toLowerCase().match(/[a-zа-я0-9_]{3,}/g) ?? [];
  let hits = 0;
  for (const w of trigWords) {
    if (signalTokens.has(w)) hits++;
  }
  if (trigWords.length > 0) {
    score += Math.min(0.25, (hits / Math.min(6, trigWords.length)) * 0.25);
  }
  if (hasActiveDelta && q.contour === "anomaly_reactive") score += 0.08;
  return Number(Math.min(1, score).toFixed(4));
}

export interface TriageOutput {
  due_count: number;
  selected_count: number;
  selected_json: string;
  blocking_count: number;
  real_count: number;
  expired_owner_ttl_count: number;
  selected: Array<BankQuestion & { priority: "P0" | "P1" | "P2" | "P3"; score: number }>;
}

export function triageQuestions(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    mode?: string;
    graphFilter?: string;
    deltas?: unknown;
    context?: Record<string, unknown>;
    checkoutPath?: string | null;
    shadowRawJson?: string | null;
    maxPerJudgment?: number;
    top?: number;
    realP?: number;
    nowMs?: number;
  },
): TriageOutput {
  const now = input.nowMs ?? Date.now();
  const policy = loadSpPolicy().questions;
  const all =
    input.shadowRawJson !== undefined
      ? mergeShadowQuestions(loadQuestionBank().questions, input.shadowRawJson, policy.max_shadow_ext_questions)
      : loadMergedQuestions(input.checkoutPath, input.domain);
  const contours = mapModeToContours(input.mode || "every_tick");

  const stateRows = db
    .prepare("SELECT * FROM lane_pilot_sp_question_state WHERE project_id = ?")
    .all(input.projectId) as Array<{
    question_id: string;
    status: string;
    cooldown_until: number | null;
    ttl_expires_at: number | null;
  }>;
  const byId = new Map(stateRows.map((r) => [r.question_id, r]));

  let expiredOwnerTtlCount = 0;
  for (const st of stateRows) {
    if (st.status === "answered" && st.ttl_expires_at !== null && st.ttl_expires_at <= now) {
      expiredOwnerTtlCount++;
      db.prepare("UPDATE lane_pilot_sp_question_state SET status = 'expired' WHERE project_id = ? AND question_id = ?").run(
        input.projectId,
        st.question_id,
      );
    }
  }

  const rawText = JSON.stringify({ deltas: input.deltas ?? null, context: input.context ?? null }).toLowerCase();
  const signalTokens = new Set<string>(rawText.match(/[a-zа-я0-9_]{3,}/g) ?? []);
  const hasActiveDelta = signalTokens.size > 4 && !rawText.includes('"anomalies":[]');

  const candidates = all.filter((q) => {
    if (input.domain !== "all" && q.domain !== input.domain && q.domain !== "specialist_os") return false;
    if (input.graphFilter && !q.target_graphs.includes(input.graphFilter)) return false;
    const st = byId.get(q.question_id);
    if (st && st.cooldown_until !== null && st.cooldown_until > now && st.status !== "expired") return false;
    if (st && st.status === "answered" && (st.ttl_expires_at === null || st.ttl_expires_at > now)) return false;
    if (st?.status === "expired") return true;
    return contours.has(q.contour);
  });

  const cap = Math.min(input.maxPerJudgment ?? 48, 48);
  const pool = candidates.slice(0, cap);
  const topN = input.top ?? 6;
  const realThreshold = input.realP ?? 0.7;

  const scored = pool
    .map((q) => {
      const score = scoreQuestionRelevance(q, signalTokens, hasActiveDelta);
      const priority = priorityOf(q.impact_weight, q.auto_resolvable_via_mcp);
      return { ...q, score, priority };
    })
    .sort((a, b) => b.score - a.score || a.question_id.localeCompare(b.question_id));

  const selected: Array<BankQuestion & { priority: "P0" | "P1" | "P2" | "P3"; score: number }> = [];
  let ownerPicked = 0;
  for (const item of scored) {
    if (selected.length >= topN) break;
    if (!item.auto_resolvable_via_mcp) {
      if (ownerPicked >= policy.max_owner_questions_per_tick) continue;
      ownerPicked++;
    }
    selected.push(item);
  }

  const cooldownMs = policy.default_cooldown_hours * 3_600_000;
  const upsertStmt = db.prepare(
    `INSERT INTO lane_pilot_sp_question_state
      (project_id, question_id, domain, contour, status, priority, asked_at, cooldown_until, ttl_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, question_id) DO UPDATE SET
      status = excluded.status,
      priority = excluded.priority,
      asked_at = excluded.asked_at,
      cooldown_until = excluded.cooldown_until`,
  );
  for (const s of selected) {
    const nextStatus = s.auto_resolvable_via_mcp ? "auto_resolved" : "open";
    const ttlExp = now + s.ttl_days * 86_400_000;
    upsertStmt.run(input.projectId, s.question_id, s.domain, s.contour, nextStatus, s.priority, now, now + cooldownMs, ttlExp);
  }

  const blockingCount = selected.filter((q) => (q.priority === "P0" || q.priority === "P1") && !q.auto_resolvable_via_mcp).length;
  const realCount = scored.filter((q) => q.score >= realThreshold).length;

  return {
    due_count: candidates.length,
    selected_count: selected.length,
    selected_json: JSON.stringify(selected),
    blocking_count: blockingCount,
    real_count: realCount,
    expired_owner_ttl_count: expiredOwnerTtlCount,
    selected,
  };
}

export function recordQuestionAnswer(
  db: LanePilotDatabase,
  input: { projectId: string; questionId: string; domain: string; contour?: string; answerText: string; ttlDays?: number; nowMs?: number },
): void {
  const now = input.nowMs ?? Date.now();
  const ttlExp = now + (input.ttlDays ?? 30) * 86_400_000;
  db.prepare(
    `INSERT INTO lane_pilot_sp_question_state
      (project_id, question_id, domain, contour, status, answer_text, priority, asked_at, answered_at, cooldown_until, ttl_expires_at)
     VALUES (?, ?, ?, ?, 'answered', ?, 'P2', ?, ?, ?, ?)
     ON CONFLICT(project_id, question_id) DO UPDATE SET
      status = 'answered',
      answer_text = excluded.answer_text,
      answered_at = excluded.answered_at,
      ttl_expires_at = excluded.ttl_expires_at`,
  ).run(input.projectId, input.questionId, input.domain, input.contour ?? "intake_cold_start", input.answerText, now, now, ttlExp, ttlExp);
}
