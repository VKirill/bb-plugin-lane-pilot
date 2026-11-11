import { bestEffort } from "@lane-pilot/kit";
import { repairBrief } from "../brief";
import { buildClassPack, type CheckedFinding, type EvidencePack } from "../pack";
import { nightArm } from "../../bench/server";
import { loadProjectSettings } from "../../storage";
import { repairSignature } from "../signature";
import { collectEntries, writeEntries, refreshClasses, classVersions, getClass, listClasses, nightOf } from "../journal";
import { ladderStep } from "../ladder";
import { selectClasses } from "../select";
import { getWall, insertRepair, listRepairs, openRepairs, nightSpend, saveNight } from "../store";
import type { NightSummary, WallClass } from "../types";
import { classWallKey, DAY, type WallCtx } from "./context";
import type { HuntApi } from "./hunt";
import type { EscalateBacklog } from "./backlog";
import type { TaskWallsApi } from "./task-walls";

export function createNight(ctx: WallCtx, hunting: HuntApi, escalateBacklog: EscalateBacklog, tasks: TaskWallsApi) {
  const { db, ports, log, deps } = ctx;
  const config = ctx.config;
  const { huntClass } = hunting;
  const { advanceTaskWalls } = tasks;
  const cycleScores = ctx.cycleScores;

  const roundsTonight = (night: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const row of listRepairs(db)) if (row.night === night) map.set(row.classKey, Math.max(map.get(row.classKey) ?? 0, row.round));
    return map;
  };

  type NightOptions = { dryRun?: boolean; now?: number };
  async function runNight(options: NightOptions = {}): Promise<NightSummary & { plan?: unknown }> {
    const cfg = await config();
    const now = options.now ?? ports.now();
    const night = nightOf(now);
    const scope = await ports.loadScope();
    const logLines = ports.logLines(now - DAY, now);
    const benchOk = cfg.benchSubset > 0 && await bestEffort(log, "wall bench available", ports.bench.available(), false);
    const summary: NightSummary = { night, startedAt: now, dryRun: Boolean(options.dryRun), classesSeen: 0, picked: [], morning: [], hunts: [], backlog: [], spendTokens: 0, capTokens: cfg.nightTokenCap, stoppedBy: null };
    if (!cfg.enabled) return { ...summary, stoppedBy: "the night loop is off (wall.enabled)" };

    const journal = () => {
      writeEntries(db, collectEntries(db, { since: now - DAY, until: now, isReal: scope.isReal, logLines, now }), now);
      return refreshClasses(db, { now, isReal: scope.isReal });
    };
    const select = (classes: readonly WallClass[]) => {
      const open = new Set(openRepairs(db).map((row) => row.classKey));
      const spent = nightSpend(db, night, { from: Date.parse(`${night}T00:00:00Z`), to: Date.parse(`${night}T00:00:00Z`) + DAY });
      return selectClasses({ classes, max: cfg.maxClassesPerNight, walks: cfg.walks, recurrenceFloor: cfg.recurrenceFloor, openRepair: open, roundsTonight: roundsTonight(night),
        roundsPerNight: cfg.roundsPerNight, cycleScores: cycleScores(), tokensLeft: Math.max(0, cfg.nightTokenCap - spent), roundCost: cfg.assumedRepairTokens,
        runningVersion: ports.version, seenVersions: classVersions(db, now - DAY) });
    };

    if (options.dryRun) {
      // The dry run writes nothing that stays: it works inside a savepoint that is rolled back, and calls no model.
      db.prepare("SAVEPOINT wall_dry").run();
      try {
        const classes = journal();
        summary.classesSeen = classes.filter((row) => row.recur1 > 0).length;
        const selection = select(classes);
        summary.picked = selection.picked;
        summary.morning = selection.morning;
        summary.stoppedBy = selection.stoppedBy;
        for (const cls of classes) {
          const step = ladderStep({ failedMoves: cls.failedMoves, hunt: cls.hunt, afterHuntFailed: cls.afterHuntFailed }, cfg.walks);
          if (step.step === "hunt" && cls.recur1 > 0) summary.hunts.push(cls.classKey);
          if (step.step === "backlog" && cls.stage !== "backlog" && cls.recur1 > 0) summary.backlog.push(cls.classKey);
        }
        return { ...summary, plan: { benchRunnable: benchOk, classes: classes.filter((row) => row.recur1 > 0).slice(0, 30) } };
      } finally {
        db.prepare("ROLLBACK TO wall_dry").run();
        db.prepare("RELEASE wall_dry").run();
      }
    }

    saveNight(db, summary, now, false);
    let classes = journal();
    summary.classesSeen = classes.filter((row) => row.recur1 > 0).length;
    // The ladder first: classes whose normal moves are spent are hunted, classes the hunt could not help go to the backlog.
    for (const cls of classes) {
      if (cls.recur1 === 0) continue;
      const step = ladderStep({ failedMoves: cls.failedMoves, hunt: cls.hunt, afterHuntFailed: cls.afterHuntFailed }, cfg.walks);
      if (step.step === "hunt") {
        const result = await huntClass(cls, cfg, now);
        if (result.state !== "skipped") summary.hunts.push(cls.classKey);
      } else if (step.step === "backlog" && cls.stage !== "backlog") {
        await escalateBacklog(classWallKey(cls.classKey), `${cls.failureClass}: ${cls.reasonNorm}`, "", step.why, now, { classKey: cls.classKey });
        summary.backlog.push(cls.classKey);
      }
    }
    for (const note of await advanceTaskWalls(cfg, now)) log(`wall: ${note}`);
    classes = listClasses(db);
    const selection = select(classes);
    summary.stoppedBy = selection.stoppedBy;
    summary.morning = selection.morning;
    if (benchOk && selection.picked.length) await bestEffort(log, `wall bench arm ${ports.version}`, ports.bench.ensureArm(nightArm(ports.version)), undefined);
    for (const pick of selection.picked) {
      const cls = getClass(db, pick.classKey)!;
      const pack = buildClassPack(db, cls.classKey);
      const wall = getWall(db, classWallKey(cls.classKey));
      const findings = pick.role === "informed" ? (((wall?.findings as { findings?: CheckedFinding[] } | null)?.findings) ?? []).filter((row) => row.verdict !== "unknown") : [];
      const prior = listRepairs(db, { classKey: cls.classKey }).map((row) => ({ round: row.round, outcome: `${row.night} ${row.role}: ${row.state}${row.outcome ? `: ${row.outcome}` : ""}` }));
      const brief = repairBrief({ cls, round: pick.round, roundsPerNight: cfg.roundsPerNight, role: pick.role, tokenBudget: cfg.assumedRepairTokens, samples: pack.attempts, findings, priorRounds: prior, hubDb: deps.hubDb ?? "the hub database" });
      const signature = repairSignature(cls);
      insertRepair(db, { classKey: cls.classKey, signature, night, round: pick.round, role: pick.role, versionBefore: ports.version, tokensEst: cfg.assumedRepairTokens, now,
        brief: { text: brief, samples: pack.attempts, findings, selection: pick.role === "informed" ? { providerId: cfg.hunterProviderId, model: cfg.hunterModel, reasoningLevel: cfg.hunterReasoningLevel } : null, benchRunnable: benchOk } });
      summary.picked.push(pick);
    }
    summary.spendTokens = nightSpend(db, night, { from: Date.parse(`${night}T00:00:00Z`), to: Date.parse(`${night}T00:00:00Z`) + DAY });
    saveNight(db, summary, ports.now(), true);
    log(`wall: night ${night}: ${summary.classesSeen} classes with a failure today, ${summary.picked.length} repairs queued, ${summary.hunts.length} hunts, ${summary.backlog.length} to the backlog, ~${summary.spendTokens} of ${summary.capTokens} tokens`);
    if (!options.dryRun && deps.diffHiddenAudit) {
      const projectSettings = loadProjectSettings(db as never, "*");
      const rawLimit = projectSettings["checkers.diff_hidden_limit"] ?? (deps.settings ? (await bestEffort(log, "wall diff-hidden settings", deps.settings(), {} as Record<string, unknown>))["checkers.diff_hidden_limit"] : undefined);
      const diffHiddenLimit = typeof rawLimit === "number" ? rawLimit : (rawLimit !== undefined && rawLimit !== null && rawLimit !== "" && !isNaN(Number(rawLimit)) ? Number(rawLimit) : 3);
      if (diffHiddenLimit > 0) {
        await deps.diffHiddenAudit(diffHiddenLimit).catch((cause: unknown) => {
          log(`wall: diff-hidden audit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      }
    }
    return summary;
  }

  return { runNight };
}
