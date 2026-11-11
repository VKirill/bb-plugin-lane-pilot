import type { HeadPart } from "@lane-pilot/contracts";
import { bestEffort } from "@lane-pilot/kit";
import { EVIDENCE_WAIT_MS, decideAcceptance, laterReleaseTouches, type Acceptance, type AcceptanceEvidence } from "../acceptance";
import { predictionHeld } from "../brief";
import { nightArm, SEALED_GAP_KEY, type SealedGapRecord } from "../../bench/server";
import { listVersionedAttemptRows } from "../../storage";
import type { WallConfig } from "../config";
import { graphRecurrence, getClass } from "../journal";
import { headPartsOf, planClassRerun, executable, recordRerun } from "../rerun";
import { wallSignature } from "../signature";
import type { ChangeDescriptor } from "../../policy";
import { afterFailedMove } from "../ladder";
import { listRepairs, updateRepair, updateClassLadder, type RepairRow } from "../store";
import type { WallCtx } from "./context";
import { DAY, ROLLBACK_RETRY_MS, ROLLBACK_TRIES, type Rollback } from "./context";
import type { EscalateBacklog } from "./backlog";

export function createReleaseFollow(ctx: WallCtx, escalateBacklog: EscalateBacklog) {
  const { db, kv, ports, log } = ctx;
  const config = ctx.config;

  const classOf = (row: RepairRow) => getClass(db, row.classKey);

  function failMove(row: RepairRow, outcome: string, now: number): void {
    const cls = classOf(row);
    if (!cls) return;
    const next = afterFailedMove({ failedMoves: cls.failedMoves, hunt: cls.hunt, afterHuntFailed: cls.afterHuntFailed });
    updateClassLadder(db, cls.classKey, { failedMoves: next.failedMoves, afterHuntFailed: next.afterHuntFailed }, now);
    log(`wall: round ${row.round} of ${row.classKey} failed (${outcome}); moves ${next.failedMoves}, after the hunt ${next.afterHuntFailed}`);
  }

  /**
   * Whether a merge can be taken back: no revert is stuck, and none gave up in the last week. The constant `true` this replaced hid three reverts that
   * never ran (wr_8462ad860c03, wr_16de9a4704de, wr_662642de0aa6); a rollback that failed and was left is not a rollback path.
   */
  function rollbackPathOk(now: number): boolean {
    return !listRepairs(db).some((row) => {
      const rollback = (row.acceptance as { rollback?: Rollback } | null)?.rollback;
      return row.state === "rollback_pending" || (row.state === "red" && rollback?.gaveUp === true && now - row.updatedAt < 7 * DAY);
    });
  }

  const voidCache = new Map<string, boolean>();
  /** Whether the releases from `shipped` to `later` touched the repair's files or the source files of its class (see `laterReleaseTouches`). Unknown files void. */
  async function laterReleaseVoids(row: RepairRow, shipped: string, later: string): Promise<boolean> {
    const key = `${row.id}:${shipped}:${later}`;
    const known = voidCache.get(key);
    if (known !== undefined) return known;
    const laterFiles = await bestEffort(log, `wall release changes ${shipped}..${later}`, ports.release.changedBetween?.(shipped, later) ?? Promise.resolve(null), null) ?? null;
    const cls = classOf(row);
    const classFiles = laterFiles && cls ? (await bestEffort(log, `wall class files ${cls.classKey}`, ports.codeFiles(cls.reasonNorm.split(/<[a-z]+>/).map((part) => part.trim()).filter((part) => part.length >= 12).slice(0, 3)), [])).map((file) => file.path) : [];
    const repairFiles = ((row.policy as { change?: { files?: string[] } } | null)?.change?.files ?? []);
    const voids = laterReleaseTouches({ repairFiles, classFiles, laterFiles });
    if (laterFiles) voidCache.set(key, voids);
    return voids;
  }

  /**
   * Repairs the old rule set aside («a later release came in») within the evidence wait, judged again once under the rule of `laterReleaseVoids`, when it says the later release
   * did not touch them: put back to `deployed`, so the next `followRelease` measures them on the running version.
   */
  async function rejudgeSuperseded(now: number): Promise<string[]> {
    const notes: string[] = [];
    for (const row of listRepairs(db, { states: ["unproven"] })) {
      const acceptance = (row.acceptance ?? {}) as { rejudgedAt?: number };
      if (acceptance.rejudgedAt || !row.shippedVersion || !/was released after/.test(row.outcome ?? "") || now - row.updatedAt > EVIDENCE_WAIT_MS || ports.version === row.shippedVersion) continue;
      if (await laterReleaseVoids(row, row.shippedVersion, ports.version)) continue;
      updateRepair(db, row.id, { state: "deployed", acceptance: { ...acceptance, rejudgedAt: now }, outcome: null }, now);
      notes.push(`${row.id}: set aside by a later release, judged again`);
    }
    return notes;
  }

  async function followRelease(row: RepairRow, cfg: WallConfig, now: number): Promise<string[]> {
    const acceptance = (row.acceptance ?? {}) as { mergedAtVersion?: string; deployedAt?: number; benchScore?: number; baselineScore?: number; revertedAt?: number };
    const mergedAt = acceptance.mergedAtVersion ?? row.versionBefore;
    const deployed = ports.version !== mergedAt;
    if (!deployed && row.state === "deployed") {
      updateRepair(db, row.id, { state: "rolled_back", outcome: "the plugin runs the version before the repair again: the deploy rolled back", acceptance: { ...acceptance, rolledBack: true } }, now);
      failMove(row, "the deploy rolled back", now);
      return [`${row.id}: rolled back by the deploy`];
    }
    if (!deployed) return [];
    if (row.state === "merged") {
      updateRepair(db, row.id, { state: "deployed", shippedVersion: ports.version, acceptance: { ...acceptance, deployedAt: now } }, now);
      return [`${row.id}: deployed as ${ports.version}`];
    }
    // The repair is judged by the release that carried it, not by whatever runs now: repairs shipped in 0.1.307 were compared with 0.1.328 and the
    // many changes between them were charged to three repairs. A later release means the candidate's own evidence is gone (the canary and the bench
    // arm describe the running version); the experiment is then inconclusive, not decided on the newer one.
    // A later release voids this only when it touched the repair's files or its class's code; otherwise the running version carries on the measuring.
    const shipped = row.shippedVersion ?? ports.version;
    let superseded = ports.version !== shipped ? ports.version : null;
    let evidence = shipped;
    if (superseded && !(await laterReleaseVoids(row, shipped, superseded))) { evidence = superseded; superseded = null; }
    const deployedAt = acceptance.deployedAt ?? now;
    const drill = await bestEffort(log, `wall release drill ${row.id}`, ports.release.drill(), null);
    const canary = await bestEffort(log, `wall release canary ${row.id}`, ports.release.canary(), null);
    const benchOk = cfg.benchSubset > 0 && !superseded && await bestEffort(log, "wall bench available", ports.bench.available(), false);
    let bench: AcceptanceEvidence["bench"] = "unavailable";
    let benchScore: number | undefined, baselineScore: number | undefined;
    let benchCompare: { base: string; arm: string } | undefined;
    if (benchOk && canary && canary.version === evidence && !canary.windowOpen) {
      const base = nightArm(mergedAt), arm = nightArm(evidence);
      // S5: the repair is judged against the release on one base — the same set revision the baseline arm was measured on.
      // When that set is found the shipped arm runs it too; without a measured baseline the newest set is used (the compare is inconclusive).
      const setVersion = await bestEffort(log, `wall bench arm set ${base}`, ports.bench.armSet(base), null);
      const state = await bestEffort(log, `wall bench ensure ${arm}`, ports.bench.ensureArm(arm, setVersion ?? undefined), "unavailable" as const);
      bench = state === "done" ? await bestEffort(log, `wall bench compare ${base} ${arm}`, ports.bench.compare(base, arm, setVersion ?? undefined), "unavailable" as const) : state === "running" ? "pending" : "unavailable";
      if (bench === "pass" || bench === "fail") {
        benchScore = (await bestEffort(log, `wall bench score ${arm}`, ports.bench.score(arm), null)) ?? undefined;
        baselineScore = (await bestEffort(log, `wall bench score ${base}`, ports.bench.score(base), null)) ?? undefined;
        benchCompare = { base, arm };
      }
    }
    const recurrence = recurrenceOn(row.classKey, evidence, deployedAt);
    const requireBench = (row.policy as { requireBench?: boolean } | null)?.requireBench === true;
    const sealedFlag = await kv.get(SEALED_GAP_KEY) as SealedGapRecord | null;
    const sealedGap = Boolean(sealedFlag && typeof sealedFlag.gapPp === "number" && typeof sealedFlag.thresholdPp === "number" && sealedFlag.gapPp > sealedFlag.thresholdPp
      // The flag speaks for the week it was measured in; a stale flag (older than 9 days) no longer holds new fixes.
      && sealedFlag.at !== undefined && now - sealedFlag.at < 9 * 86_400_000);
    const result = decideAcceptance({ merged: true, versionBefore: mergedAt, deployedVersion: evidence, drill, deployedAt, canary, bench, recurrence, deployRolledBack: false, requireBench, supersededBy: superseded, sealedGap, now });
    // C3: the declared prediction is checked against the evidence the same acceptance weighed — a broken one is recorded, never a pass.
    const prediction = (acceptance as { prediction?: { fixes_class: string | null; must_not_move: string[] } }).prediction;
    const predicted = prediction && result.state !== "pending" ? predictionHeld(prediction, { recurred: recurrence ? recurrence.failures > 0 : null, benchScore, baselineScore }) : null;
    if (predicted && !predicted.held) failMove(row, `prediction unmet: ${predicted.notes.join("; ")}`, now);
    return await settleAcceptance(row, result, { ...acceptance, deployedAt, ...(predicted ? { predictionHeld: predicted.held, predictionNotes: predicted.notes } : {}), ...(benchScore !== undefined ? { benchScore } : {}), ...(baselineScore !== undefined ? { baselineScore } : {}), ...(benchCompare ? { benchCompare } : {}) }, now, recurrence);
  }

  /**
   * The class's failures among the attempts of the shipped version, out of the attempts exposed to it: those of the projects the journal saw the class in (plus any
   * attempt that failed in the class). Attempts of other projects say nothing about a class that never ran there; with no journaled project the exposure is unknown.
   */
  function recurrenceOn(classKey: string, version: string, since: number): { failures: number; attempts: number; exposed: boolean } | null {
    const graph = graphRecurrence(db, classKey, version, since);
    if (graph !== undefined) return graph;
    const rows = listVersionedAttemptRows(db as never, version, since);
    const projects = new Set((db.prepare("SELECT DISTINCT project_id FROM lane_pilot_wall_entry WHERE class_key=?").all(classKey) as Array<{ project_id: string }>).map((row) => row.project_id));
    const failed = (row: { state: string; reason: string | null; failure_code: string | null }) => row.state !== "accepted" && wallSignature(row.state, row.reason, row.failure_code).classKey === classKey;
    const scope = projects.size ? rows.filter((row) => projects.has(row.project_id) || failed(row)) : rows;
    if (!scope.length) return null;
    return { attempts: scope.length, failures: scope.filter(failed).length, exposed: projects.size > 0 };
  }

  async function settleAcceptance(row: RepairRow, result: Acceptance, acceptance: Record<string, unknown>, now: number, recurrence: { failures: number; attempts: number; exposed: boolean } | null = null): Promise<string[]> {
    const payload: Record<string, unknown> = { ...acceptance, checks: result.checks, reason: result.reason, recurred: result.recurred };
    if (result.state === "pending") { updateRepair(db, row.id, { acceptance: payload }, now); return []; }
    if (result.state === "accepted") {
      updateRepair(db, row.id, { state: "accepted", acceptance: payload, outcome: result.reason }, now);
      updateClassLadder(db, row.classKey, { fixedIn: row.shippedVersion ?? ports.version }, now);
      if (result.recurred) failMove(row, "the class recurred on the new version", now);
      const planned = await rerunClass(row, now);
      return [`${row.id}: accepted (${result.reason}); ${planned} re-run(s) planned`];
    }
    if (result.state === "inconclusive") {
      // No evidence for the repair and none against it: it is not accepted (no `fixedIn`, no re-runs) and it is not reverted. The ladder moves only
      // when the class kept failing on the shipped version, which is evidence the move did not help.
      updateRepair(db, row.id, { state: "unproven", acceptance: payload, outcome: result.reason.slice(0, 400) }, now);
      if (recurrence && recurrence.failures > 0) failMove(row, "unproven, and the class still failed on the shipped version", now);
      return [`${row.id}: unproven (${result.reason})`];
    }
    let detail = result.reason;
    if (result.action === "revert" && row.mergedCommit && !(acceptance as { revertedAt?: number }).revertedAt) {
      const reverted = await tryRevert(row.mergedCommit);
      if (!reverted.ok) {
        // Red, and the merge is still in the checkout: the repair stays open so the tick tries the revert again. `red` here once ended the repair for good.
        const rollback: Rollback = { attempts: 1, lastError: reverted.detail.slice(0, 300), lastAt: now, reason: result.reason };
        updateRepair(db, row.id, { state: "rollback_pending", acceptance: { ...payload, rollback }, outcome: `${result.reason}; revert failed (try 1 of ${ROLLBACK_TRIES}): ${reverted.detail}`.slice(0, 400) }, now);
        log(`wall: revert of ${row.mergedCommit.slice(0, 12)} for ${row.id} failed, try 1 of ${ROLLBACK_TRIES}: ${reverted.detail}`);
        return [`${row.id}: ${result.state}; revert failed, tried again later (${reverted.detail})`];
      }
      payload.revertedAt = now;
      detail = `${result.reason}; revert committed: ${reverted.detail}`;
    }
    updateRepair(db, row.id, { state: result.state === "rolled_back" ? "rolled_back" : "red", acceptance: payload, outcome: detail.slice(0, 400) }, now);
    failMove(row, detail, now);
    return [`${row.id}: ${result.state} (${detail})`];
  }

  const tryRevert = async (commit: string): Promise<{ ok: boolean; detail: string }> =>
    await ports.repair.revert(commit).catch((cause: unknown) => ({ ok: false, detail: cause instanceof Error ? cause.message : String(cause) }));

  /**
   * A red repair whose revert could not run was left `red` by the first version of this code and never revisited. Those rows (merged commit known,
   * never reverted, outcome says the revert failed, no rollback record) are put back in the retry state once; the revert resolves a short SHA with git.
   */
  function resumeStuckRollbacks(now: number): string[] {
    const notes: string[] = [];
    for (const row of listRepairs(db, { states: ["red"] })) {
      const acceptance = (row.acceptance ?? {}) as { revertedAt?: number; rollback?: Rollback; reason?: string };
      if (!row.mergedCommit || acceptance.revertedAt || acceptance.rollback || !/revert failed/.test(row.outcome ?? "")) continue;
      // Judged red by the bench alone before a comparison could say «inconclusive»: the three October rows rest on 305→328, two paired tasks.
      // That is no proof the repair made things worse, so it is not undone now; it is unproven, and the class's recurrence judges it again.
      if (/bench subset is worse/.test(acceptance.reason ?? "")) {
        const reason = "judged red only by a bench comparison made before inconclusive comparisons existed (too few paired tasks): not reverted, unproven";
        updateRepair(db, row.id, { state: "unproven", acceptance: { ...acceptance, reason }, outcome: reason }, now);
        notes.push(`${row.id}: red rested on an inconclusive bench comparison; left in place as unproven`);
        continue;
      }
      const rollback: Rollback = { attempts: 0, lastError: (row.outcome ?? "").slice(-300), lastAt: 0, reason: acceptance.reason ?? "red acceptance" };
      updateRepair(db, row.id, { state: "rollback_pending", acceptance: { ...acceptance, rollback } }, now);
      notes.push(`${row.id}: revert of ${row.mergedCommit.slice(0, 12)} never ran; tried again`);
    }
    return notes;
  }

  /** A pending revert: tried again every `ROLLBACK_RETRY_MS`; after `ROLLBACK_TRIES` it is given up with its diagnosis in the backlog, not left quiet. */
  async function retryRollback(row: RepairRow, now: number): Promise<string[]> {
    const acceptance = (row.acceptance ?? {}) as Record<string, unknown> & { rollback?: Rollback };
    const rollback = acceptance.rollback;
    if (!rollback || !row.mergedCommit || now - rollback.lastAt < ROLLBACK_RETRY_MS) return [];
    const reverted = await tryRevert(row.mergedCommit);
    const attempts = rollback.attempts + 1;
    if (reverted.ok) {
      const detail = `${rollback.reason}; revert committed on try ${attempts}: ${reverted.detail}`;
      updateRepair(db, row.id, { state: "red", acceptance: { ...acceptance, revertedAt: now, rollback: { ...rollback, attempts, lastError: "", lastAt: now } }, outcome: detail.slice(0, 400) }, now);
      failMove(row, detail, now);
      return [`${row.id}: reverted on try ${attempts}`];
    }
    const next: Rollback = { ...rollback, attempts, lastError: reverted.detail.slice(0, 300), lastAt: now };
    if (attempts < ROLLBACK_TRIES) {
      updateRepair(db, row.id, { acceptance: { ...acceptance, rollback: next }, outcome: `${rollback.reason}; revert failed (try ${attempts} of ${ROLLBACK_TRIES}): ${reverted.detail}`.slice(0, 400) }, now);
      return [`${row.id}: revert failed again (${attempts} of ${ROLLBACK_TRIES}): ${reverted.detail}`];
    }
    const detail = `${rollback.reason}; revert failed ${attempts} times, last: ${reverted.detail}`;
    next.gaveUp = true;
    updateRepair(db, row.id, { state: "red", acceptance: { ...acceptance, rollback: next }, outcome: detail.slice(0, 400) }, now);
    failMove(row, detail, now);
    await escalateBacklog(`rollback:${row.id}`, `the merge ${row.mergedCommit.slice(0, 12)} of repair ${row.id} (${row.classKey}) stays in the checkout: ${detail}`.slice(0, 300), "", `its revert failed ${attempts} times`, now);
    return [`${row.id}: revert given up after ${attempts} tries; in the backlog`];
  }

  // ---------------------------------------------------------------- re-run on the new head (D1-1)
  async function rerunClass(row: RepairRow, now: number): Promise<number> {
    const cfg = await config();
    const scope = await ports.loadScope();
    const policy = row.policy as { change?: ChangeDescriptor } | null;
    const head: HeadPart[] = policy?.change ? headPartsOf(policy.change) : [];
    const plans = planClassRerun(db, { classKey: row.classKey, since: row.createdAt - 7 * DAY, head, scopeOf: scope.scopeOf, limit: 40 });
    let count = 0;
    for (const plan of plans) {
      if (executable(plan, cfg.rerunSandboxOnly)) {
        const result = await ports.restart(plan).catch((cause: unknown) => ({ ok: false, note: cause instanceof Error ? cause.message : String(cause) }));
        if (recordRerun(db, plan, result.ok ? "dispatched" : "skipped", result.note, now)) count += 1;
      } else {
        const why = plan.scope === "real" ? "a real project: listed, re-run only with rerun_sandbox_only off" : `earliest affected stage ${plan.affected.from ?? "none"} needs return-to-stage (not restartable in place)`;
        if (recordRerun(db, plan, "listed", why, now)) count += 1;
      }
    }
    return count;
  }

  return { classOf, failMove, rollbackPathOk, laterReleaseVoids, rejudgeSuperseded, followRelease, recurrenceOn, settleAcceptance, tryRevert, resumeStuckRollbacks, retryRollback, rerunClass };
}
export type ReleaseFollowApi = ReturnType<typeof createReleaseFollow>;
