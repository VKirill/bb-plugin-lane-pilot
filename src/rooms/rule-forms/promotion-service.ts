import { createHash } from "node:crypto";
import { markMechanized, ruleProposalId, LESSON_SAME_RULE } from "@lane-pilot/run-insights";
import { getActivation, getRun } from "../storage";
import { scheduleIsolated, sendPmNotice } from "../core/server";
import type { ServerCore, Services } from "../core/server";
export type PromotionServiceApi = ReturnType<typeof createPromotionService>;
import { acceptPromotion, dismissPromotion, listPromotions, type PromotionRow } from "./promotion";
import { promotionWeeklyLines } from "./digest";
import type { LanePilotDatabase } from "../storage";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const WEEKLY_CRON = "0 9 * * 1";

const ruleWords = (rule: string) => new Set(rule.toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu) ?? []);
const sameRule = (a: string, b: string): boolean => {
  const left = ruleWords(a), right = ruleWords(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared) >= LESSON_SAME_RULE;
};

/**
 * Cross-project transfer (arXiv memory #19): a rule confirmed in at least two projects is proposed to every other
 * configured project as an ordinary sweep proposal — the same `proposed` state the rules scan writes, so it goes
 * through the normal trial instead of being injected. A project that already holds a like of the rule is skipped.
 * No messages: the weekly log line counts what was proposed.
 */
export function crossProjectRuleCandidates(db: LanePilotDatabase, now = Date.now()): number {
  const proven = db.prepare(`SELECT project_id, rule, audience FROM lane_pilot_rule_proposal
    WHERE state='accepted' AND (trial_state='confirmed' OR decided_by='owner')`).all() as Array<{ project_id: string; rule: string; audience: string }>;
  const byRule = new Map<string, { rule: string; audience: string; projects: Set<string> }>();
  for (const row of proven) {
    const key = row.rule.toLowerCase().trim();
    const entry = byRule.get(key) ?? { rule: row.rule, audience: row.audience, projects: new Set<string>() };
    entry.projects.add(row.project_id);
    byRule.set(key, entry);
  }
  const projects = (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_project_settings WHERE binding_id=''").all() as Array<{ project_id: string }>).map((row) => row.project_id);
  let created = 0;
  for (const entry of byRule.values()) {
    if (entry.projects.size < 2) continue;
    const signature = `xproject:${createHash("sha256").update(entry.rule.toLowerCase()).digest("hex").slice(0, 12)}`;
    const id = ruleProposalId(signature);
    const evidence = `proven in ${entry.projects.size} projects: ${[...entry.projects].slice(0, 5).join(", ")}`;
    for (const projectId of projects) {
      if (entry.projects.has(projectId)) continue;
      const live = db.prepare("SELECT rule FROM lane_pilot_rule_proposal WHERE project_id=? AND state IN ('proposed','accepted')").all(projectId) as Array<{ rule: string }>;
      if (live.some((row) => sameRule(row.rule, entry.rule))) continue;
      created += db.prepare(`INSERT INTO lane_pilot_rule_proposal
        (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,memory_id,first_seen_at,last_seen_at,updated_at,decided_at,scope_json,audience)
        VALUES (?,?,?,?,'sweep','proposed',?,?,?, '[]', NULL,?,?,?,NULL,'[]',?)
        ON CONFLICT(project_id,id) DO NOTHING`)
        .run(id, projectId, signature, entry.rule.slice(0, 600), entry.projects.size, entry.projects.size,
          JSON.stringify([evidence]), now, now, now, entry.audience === "pm" || entry.audience === "writer" || entry.audience === "both" ? entry.audience : "both").changes;
    }
  }
  return created;
}

/** One message per project whose promotions wait: the weekly top-10 to its PM chat, or nothing. */
export async function deliverPromotionDigests(bb: Pick<BbPluginApi, "sdk" | "log">, db: LanePilotDatabase): Promise<{ sent: number; skipped: number }> {
  let sent = 0, skipped = 0;
  const projects = (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_rule_promotion").all() as Array<{ project_id: string }>).map((row) => row.project_id);
  for (const projectId of projects) {
    const lines = promotionWeeklyLines(db, projectId);
    if (!lines) { skipped++; continue; }
    const activation = getActivation(db, projectId);
    if (!activation || activation.pm_thread_id.startsWith("pending:")) { skipped++; continue; }
    const run = getRun(db, activation.run_id);
    if (!run || run.closed_at || run.pm_thread_id !== activation.pm_thread_id) { skipped++; continue; }
    try {
      // A cold PM chat is not woken for the digest; the open candidates stay in lane_pilot_learned op:promotion.
      if (await sendPmNotice(bb, activation.pm_thread_id, lines.join("\n"))) sent++; else skipped++;
    } catch (cause) {
      bb.log.warn(`Lane Pilot promotion digest for ${projectId} not sent: ${cause instanceof Error ? cause.message : String(cause)}`);
      skipped++;
    }
  }
  return { sent, skipped };
}

/**
 * Accepting a candidate puts a real task into the project: the same `dispatchWriter` path the PM's own
 * dispatch takes, against the PM's open run. On a refused or failed dispatch the candidate goes back to
 * `proposed` with the reason embedded in its stored contract (`.fail_reason`, no schema change).
 */
export async function dispatchPromotion(
  ctx: Pick<ServerCore, "db" | "bb">,
  services: Pick<Services, "dispatchWriter">,
  input: { projectId: string; ruleId: string; threadId?: string | undefined },
): Promise<{ ok: boolean; row?: PromotionRow; dispatched?: Record<string, unknown>; reason?: string }> {
  const db = ctx.db;
  const row = listPromotions(db, input.projectId).find((row) => row.ruleId === input.ruleId || row.ruleId.startsWith(input.ruleId));
  if (!row || (row.state !== "proposed" && row.state !== "owner_only")) return { ok: false, reason: `no open candidate ${input.ruleId} in ${input.projectId}` };
  const activation = getActivation(db, input.projectId);
  const pmThreadId = input.threadId ?? (activation && !activation.pm_thread_id.startsWith("pending:") ? activation.pm_thread_id : null);
  if (!pmThreadId) return { ok: false, reason: "no open PM run to carry the task; open the project's PM chat first" };
  const accepted = acceptPromotion(db, input.projectId, row.ruleId);
  if (!accepted) return { ok: false, reason: `candidate ${input.ruleId} already left proposed` };
  try {
    const reply = await services.dispatchWriter({ threadId: pmThreadId, projectId: input.projectId, task: row.task, birth: "pm" });
    if (typeof reply === "object" && reply && (reply as { state?: string }).state === "rejected") {
      settlePromotionRow(db, { projectId: input.projectId, ruleId: row.ruleId, state: "proposed", reason: `dispatch_rejected:${(reply as { reason?: string }).reason ?? "unknown"}` });
      return { ok: false, reason: `dispatch rejected: ${(reply as { reason?: string }).reason ?? "unknown"}` };
    }
    return { ok: true, row: accepted, dispatched: reply };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    settlePromotionRow(db, { projectId: input.projectId, ruleId: row.ruleId, state: "proposed", reason: `dispatch_failed:${reason}` });
    return { ok: false, reason: `dispatch failed: ${reason}` };
  }
}

export function dismissPromotionCandidate(db: LanePilotDatabase, projectId: string, ruleId: string): PromotionRow | null {
  return dismissPromotion(db, projectId, ruleId);
}

function settlePromotionRow(db: LanePilotDatabase, input: { projectId: string; ruleId: string; state: "proposed" | "dispatched" | "done" | "dismissed"; reason?: string; now?: number }): void {
  const now = input.now ?? Date.now();
  if (input.reason) {
    db.prepare("UPDATE lane_pilot_rule_promotion SET state=?, task_json=json_set(task_json,'$.fail_reason',?), updated_at=? WHERE rule_id=? AND project_id=?")
      .run(input.state, input.reason, now, input.ruleId, input.projectId);
  } else {
    db.prepare("UPDATE lane_pilot_rule_promotion SET state=?, updated_at=? WHERE rule_id=? AND project_id=?").run(input.state, now, input.ruleId, input.projectId);
  }
}

/**
 * The task a promotion spawned finished: accepted — the rule is held by its mechanism now (`done` + `mechanizedBy`,
 * the text leaves the brief like `rules mechanize` does); failed — back to `proposed` with the reason for the PM.
 * Called from the writer's acceptance and failure paths, so any task whose contract came from a promotion settles it.
 */
export function settlePromotionTask(db: LanePilotDatabase, input: { taskId: string; outcome: "accepted" | "failed"; reason?: string; now?: number }): PromotionRow | null {
  const row = (db.prepare("SELECT rule_id, project_id FROM lane_pilot_rule_promotion WHERE json_extract(task_json,'$.id')=?").get(input.taskId) as { rule_id: string; project_id: string } | undefined);
  if (!row) return null;
  const promotion = listPromotions(db, row.project_id).find((item) => item.ruleId === row.rule_id);
  if (!promotion) return null;
  if (input.outcome === "accepted") {
    settlePromotionRow(db, { projectId: row.project_id, ruleId: row.rule_id, state: "done", now: input.now });
    markMechanized(db, row.project_id, row.rule_id, `promotion:${promotion.mechanism}`, input.now ?? Date.now());
    return { ...promotion, state: "done" };
  }
  settlePromotionRow(db, { projectId: row.project_id, ruleId: row.rule_id, state: "proposed", reason: `task_failed:${input.reason ?? "unknown"}`, now: input.now });
  return { ...promotion, state: "proposed" };
}

/** The weekly pass: every Monday 09:00 hub time, each project with open candidates gets one PM message. */
export function createPromotionService(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  scheduleIsolated(bb, "rule-promotions-weekly", WEEKLY_CRON, async (signal) => {
    void signal;
    const proposed = crossProjectRuleCandidates(db);
    if (proposed) ctx.log(`rule-promotions weekly: ${proposed} cross-project rule candidate(s) proposed`);
    await deliverPromotionDigests(bb, db);
  }, { timeoutMs: 10 * 60_000 });
  return {
    deliverDigests: () => deliverPromotionDigests(bb, db),
    crossProjectCandidates: () => crossProjectRuleCandidates(db),
    dispatch: (input: { projectId: string; ruleId: string; threadId?: string | undefined }) => dispatchPromotion(ctx, services, input),
    dismiss: (projectId: string, ruleId: string) => dismissPromotionCandidate(db, projectId, ruleId),
    settleTask: (input: { taskId: string; outcome: "accepted" | "failed"; reason?: string }) => settlePromotionTask(db, input),
  };
}
