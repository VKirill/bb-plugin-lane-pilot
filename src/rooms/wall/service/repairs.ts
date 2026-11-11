import { bestEffort } from "@lane-pilot/kit";
import type { ChangeDescriptor } from "../../policy";
import { repairChange, gateRepair, closeExpiredRepair, type GateDecision } from "../acceptance";
import { parseNightReport, parsePrediction, PREDICTION_METRICS } from "../brief";
import { nightOf } from "../journal";
import { executable, headPartsOf, planClassRerun, recordRerun, type RerunPlan } from "../rerun";
import { listRepairs, updateRepair, refreshNightSpend, type RepairRow } from "../store";
import { OPEN_REPAIR_STATES } from "../types";
import type { HeadPart } from "@lane-pilot/contracts";
import type { WallCtx } from "./context";
import { DAY, QUEUED_STALE_MS } from "./context";
import type { TaskWallsApi } from "./task-walls";
import type { ReleaseFollowApi } from "./release-follow";

export function createRepairs(ctx: WallCtx, tasks: TaskWallsApi, follow: ReleaseFollowApi) {
  const { db, ports, log } = ctx;
  const config = ctx.config;
  const { advanceTaskWalls, advanceLoopWalls } = tasks;
  const { classOf, failMove, rollbackPathOk, rejudgeSuperseded, followRelease, resumeStuckRollbacks, retryRollback } = follow;

  /** The self-repair watcher asks before it merges a fixed night repair. The answer is stored once per repair; a hold is released after a week. */
  async function mergeGate(signature: string, info: { threadId: string }): Promise<"merge" | "hold" | "release"> {
    const row = listRepairs(db, { states: OPEN_REPAIR_STATES }).filter((item) => item.signature === signature).at(-1);
    if (!row) return "hold";
    const now = ports.now();
    // A decision taken once stands; a «hold» from before 0.1.297 is decided again under the rule that nothing waits for the owner.
    const stored = row.policy as { decision?: GateDecision["decision"] | "hold" } | null;
    if (stored?.decision === "merge") return "merge";
    if (stored?.decision === "reject") return "release";
    const view = await ports.repair.view(signature);
    const files = view ? await bestEffort(log, `wall repair files ${signature}`, ports.repair.changedFiles(view), null) : null;
    // Unreadable files are asked again on the next watch pass; nothing is stored, so no decision is taken on no evidence.
    if (!files) return "hold";
    const cfg = await config();
    const benchOk = cfg.benchSubset > 0 && await bestEffort(log, "wall bench available", ports.bench.available(), false);
    const change: ChangeDescriptor = repairChange(files, { benchAvailable: benchOk, rollbackOk: rollbackPathOk(now) });
    const decision = gateRepair(change);
    // `requireBench`: a merge on the strict path is accepted later only on a passed bench subset of the shipped version (acceptance.ts).
    updateRepair(db, row.id, { state: "fixed", verdict: "fixed", policy: { ...decision, change, benchEnforcedAfterDeploy: benchOk, requireBench: decision.provisional === true } }, now);
    if (decision.decision === "reject") log(`wall: repair ${row.id} of ${row.classKey} is rejected by the policy (${decision.tier}): ${decision.reason}`);
    void info;
    return decision.decision === "merge" ? "merge" : "release";
  }

  function settled(signature: string, info: { outcome: string; verdict: string | null; commit: string | null }): void {
    const now = ports.now();
    const row = listRepairs(db, { states: OPEN_REPAIR_STATES }).filter((item) => item.signature === signature).at(-1);
    if (!row) return;
    if (info.commit) {
      updateRepair(db, row.id, { state: "merged", mergedCommit: info.commit, outcome: info.outcome, acceptance: { mergedAtVersion: ports.version, mergedAt: now } }, now);
    } else if (row.state === "held" || (row.policy as { decision?: string } | null)?.decision === "hold") {
      updateRepair(db, row.id, { state: "released", outcome: info.outcome }, now);
    } else {
      updateRepair(db, row.id, { state: info.verdict === "already-fixed" ? "accepted" : "failed", outcome: info.outcome, verdict: info.verdict ?? undefined }, now);
      if (info.verdict !== "already-fixed") failMove(row, info.outcome || `verdict ${info.verdict ?? "none"}`, now);
    }
  }

  function started(id: string, info: { threadId: string; branch: string; at: number }): void {
    updateRepair(db, id, { state: "running", threadId: info.threadId, branch: info.branch }, info.at);
  }
  function startFailed(id: string, reason: string): void {
    const now = ports.now();
    const row = listRepairs(db).find((item) => item.id === id);
    updateRepair(db, id, { state: "failed", outcome: `did not start: ${reason}`.slice(0, 300) }, now);
    log(`wall: repair ${id} did not start: ${reason}`);
  }
  function nextAssignment() {
    const row = listRepairs(db, { states: ["queued"] })[0];
    if (!row) return null;
    const brief = row.brief as { text?: string; samples?: Array<{ id: string; state: string; reason: string; project: string; version: string; at: number }>; selection?: { providerId: string; model: string; reasoningLevel: string } | null };
    const cls = classOf(row);
    return {
      id: row.id, signature: row.signature, brief: brief.text ?? "", ...(brief.selection ? { selection: brief.selection } : {}),
      samples: (brief.samples ?? []).map((sample) => ({ signature: row.signature, kind: "night" as const, projectId: sample.project, runId: "-", taskId: "-", attemptId: sample.id, pmThreadId: null, writerThreadId: null,
        reason: `[${cls?.failureClass ?? "?"}] ${sample.reason}`, at: sample.at, version: sample.version || null })),
    };
  }

  /** Reads the verdicts of running repairs, the deploy's trace for merged ones, and moves each along. Cheap; runs every few minutes. */
  async function advance(now: number = ports.now()): Promise<string[]> {
    const notes: string[] = [];
    const cfg = await config();
    notes.push(...resumeStuckRollbacks(now));
    notes.push(...await rejudgeSuperseded(now));
    for (const row of listRepairs(db, { states: OPEN_REPAIR_STATES })) {
      if (row.state === "running" || row.state === "fixed" || row.state === "held" || row.state === "merged") {
        const expired = closeExpiredRepair({ state: row.state, createdAt: row.createdAt, now });
        if (expired.close) {
          updateRepair(db, row.id, { state: expired.state, outcome: expired.reason.slice(0, 400) }, now);
          notes.push(`${row.id}: ${expired.reason}`);
          continue;
        }
      }
      if (row.state === "queued" && now - row.createdAt > QUEUED_STALE_MS) {
        updateRepair(db, row.id, { state: "failed", outcome: "never started within 12 hours" }, now);
        notes.push(`${row.id}: never started`);
        continue;
      }
      if (row.threadId) {
        const used = await bestEffort(log, `wall repair tokens ${row.threadId}`, ports.repair.tokens(row.threadId), null);
        if (used !== null && used !== row.tokensUsed) updateRepair(db, row.id, { tokensUsed: used }, now);
      }
      if (row.state === "running" && row.threadId) {
        const view = await ports.repair.view(row.signature);
        if (view?.verdict && !(await ports.repair.busy(row.threadId))) {
          const report = await bestEffort(log, `wall repair report ${row.threadId}`, ports.repair.report(row.threadId), "");
          const night = parseNightReport(report);
          const prediction = parsePrediction(report);
          const prior = row.acceptance as Record<string, unknown> | null;
          // One retry when the prediction names nothing checkable: the metric must come from the list.
          if (prediction && !prediction.fixes_class && !prediction.must_not_move.length && prediction.unknown.length && !prior?.predictionRetried && row.threadId) {
            const names = PREDICTION_METRICS.join(", ");
            await bestEffort(log, `wall prediction retry ${row.threadId}`, ports.tellPm(row.threadId, `Your prediction names no checkable metric (${prediction.unknown.join(", ") ?? "none"}); name a metric from the list: ${names} — one retry.`), false);
            updateRepair(db, row.id, { acceptance: { ...(prior ?? {}), prediction, predictionRetried: true, predictionUnknown: prediction.unknown } }, now);
            continue;
          }
          updateRepair(db, row.id, { verdict: view.verdict, outcome: `${view.verdict}; ${night.sites} sites listed${night.sitesOpen ? `, ${night.sitesOpen} left open` : ""}${night.test ? `; test ${night.test}` : "; no regression test named"}`,
            ...(prediction ? { acceptance: { ...(prior ?? {}), prediction, ...(prediction.unknown.length ? { predictionUnknown: prediction.unknown } : {}) } } : {}) }, now);
          if (view.verdict !== "fixed") {
            // The watcher releases the worktree and calls `settled`; a verdict that is not «fixed» is a failed move for the ladder.
            notes.push(`${row.id}: verdict ${view.verdict}`);
          }
        }
      }
      if (row.state === "merged" || row.state === "deployed") notes.push(...await followRelease(row, cfg, now));
      if (row.state === "rollback_pending") notes.push(...await retryRollback(row, now));
    }
    notes.push(...await advanceTaskWalls(cfg, now));
    notes.push(...await advanceLoopWalls(cfg, now));
    const night = nightOf(now), from = Date.parse(`${night}T00:00:00Z`);
    refreshNightSpend(db, night, { from, to: from + DAY });
    return notes;
  }

  /** `wall rerun <class>`: plan (and run, where allowed) the re-runs of a class by hand, with an optional head description. */
  async function rerun(classKey: string, input: { head?: HeadPart[]; dryRun?: boolean } = {}): Promise<RerunPlan[]> {
    const cfg = await config();
    const scope = await ports.loadScope();
    const now = ports.now();
    const plans = planClassRerun(db, { classKey, since: now - 7 * DAY, head: input.head ?? [], scopeOf: scope.scopeOf, limit: 40 });
    if (input.dryRun) return plans;
    for (const plan of plans) {
      if (executable(plan, cfg.rerunSandboxOnly)) {
        const result = await ports.restart(plan).catch((cause: unknown) => ({ ok: false, note: cause instanceof Error ? cause.message : String(cause) }));
        recordRerun(db, plan, result.ok ? "dispatched" : "skipped", result.note, now);
      } else recordRerun(db, plan, "listed", plan.scope === "real" ? "a real project: the morning list" : "needs return-to-stage", now);
    }
    return plans;
  }

  return { mergeGate, settled, started, startFailed, nextAssignment, advance, rerun };
}
export type RepairsApi = ReturnType<typeof createRepairs>;
