import { createHash } from "node:crypto";
import { markMechanized, ruleProposalId, LESSON_SAME_RULE , insertSweepProposal, listLiveRuleTexts, listPromotionProjectIds, listProvenRules, promotionForTaskId, setPromotionRowState} from "@lane-pilot/run-insights";
import { getActivation , listProjectsWithGlobalSettings } from "../storage";
import { scheduleIsolated } from "../platform/server";

import type { ServerCore } from "../contracts/server";

import type { DispatchWriter } from "../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  dispatchWriter: DispatchWriter;
}
export type PromotionServiceApi = ReturnType<typeof createPromotionService>;
import { acceptPromotion, dismissPromotion, listPromotions, type PromotionRow } from "./promotion";
import type { LanePilotDatabase } from "../storage";

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
  const proven = listProvenRules(db);
  const byRule = new Map<string, { rule: string; audience: string; projects: Set<string> }>();
  for (const row of proven) {
    const key = row.rule.toLowerCase().trim();
    const entry = byRule.get(key) ?? { rule: row.rule, audience: row.audience, projects: new Set<string>() };
    entry.projects.add(row.project_id);
    byRule.set(key, entry);
  }
  const projects = (listProjectsWithGlobalSettings(db as never).map((project_id) => ({ project_id })) as Array<{ project_id: string }>).map((row) => row.project_id);
  let created = 0;
  for (const entry of byRule.values()) {
    if (entry.projects.size < 2) continue;
    const signature = `xproject:${createHash("sha256").update(entry.rule.toLowerCase()).digest("hex").slice(0, 12)}`;
    const id = ruleProposalId(signature);
    const evidence = `proven in ${entry.projects.size} projects: ${[...entry.projects].slice(0, 5).join(", ")}`;
    for (const projectId of projects) {
      if (entry.projects.has(projectId)) continue;
      const live = listLiveRuleTexts(db, projectId);
      if (live.some((rule) => sameRule(rule, entry.rule))) continue;
      created += insertSweepProposal(db, { id, projectId, signature, rule: entry.rule.slice(0, 600), occurrences: entry.projects.size, taskCount: entry.projects.size,
        examplesJson: JSON.stringify([evidence]), evidenceJson: "", audience: entry.audience === "pm" || entry.audience === "writer" || entry.audience === "both" ? entry.audience : "both", now });
    }
  }
  return created;
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
  setPromotionRowState(db, { projectId: input.projectId, ruleId: input.ruleId, state: input.state, ...(input.reason ? { reason: input.reason } : {}), now: input.now ?? Date.now() });
}

/**
 * The task a promotion spawned finished: accepted — the rule is held by its mechanism now (`done` + `mechanizedBy`,
 * the text leaves the brief like `rules mechanize` does); failed — back to `proposed` with the reason for the PM.
 * Called from the writer's acceptance and failure paths, so any task whose contract came from a promotion settles it.
 */
export function settlePromotionTask(db: LanePilotDatabase, input: { taskId: string; outcome: "accepted" | "failed"; reason?: string; now?: number }): PromotionRow | null {
  const row = promotionForTaskId(db, input.taskId);
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

/**
 * The weekly pass: every Monday 09:00 hub time the cross-project candidates are proposed. No message to any PM chat (the weekly top-10
 * went there until 2026-10-31; the owner wants no event of the plugin's own in a PM chat): the open candidates are the morning line's
 * count and `bb lane-pilot rules promote`.
 */
export function createPromotionService(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  scheduleIsolated(bb, "rule-promotions-weekly", WEEKLY_CRON, async (signal) => {
    void signal;
    const proposed = crossProjectRuleCandidates(db);
    if (proposed) ctx.log(`rule-promotions weekly: ${proposed} cross-project rule candidate(s) proposed`);
  }, { timeoutMs: 10 * 60_000 });
  return {
    crossProjectCandidates: () => crossProjectRuleCandidates(db),
    dispatch: (input: { projectId: string; ruleId: string; threadId?: string | undefined }) => dispatchPromotion(ctx, services, input),
    dismiss: (projectId: string, ruleId: string) => dismissPromotionCandidate(db, projectId, ruleId),
    settleTask: (input: { taskId: string; outcome: "accepted" | "failed"; reason?: string }) => settlePromotionTask(db, input),
  };
}
