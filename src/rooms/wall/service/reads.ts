import { watchMorningLine } from "@lane-pilot/jev";
import { diffHiddenMorningLine } from "../../checkers/server";
import { errandsDiagnosisMorningLine } from "../../errands";
import { profileCheckMorningLine } from "../../native-agent";
import { modelRebenchMorningLine } from "../../night-graphs";
import { promotionMorningLine } from "../../rule-forms";
import { statsEpochLine } from "../../storage";
import { composeWallMorning, cancelParetoLine } from "../morning";
import { getClass, listClasses } from "../journal";
import { getWall, listRepairs, listWalls, recentNights, updateWall, updateClassLadder, type WallRow } from "../store";
import { classWallKey, statsEpoch, DAY, type WallCtx } from "./context";

export function createReads(ctx: WallCtx) {
  const { db, ports, deps } = ctx;

  function status() {
    const classes = listClasses(db);
    return {
      classes: classes.filter((row) => row.recur7 > 0 || row.state === "open").slice(0, 60),
      open: classes.filter((row) => row.state === "open").length,
      repairs: listRepairs(db, { since: ports.now() - 14 * DAY }),
      walls: listWalls(db, { states: ["stopped", "hunting", "hunted", "backlog"] }).map((row) => ({ key: row.key, kind: row.kind, subject: row.subject, state: row.state, hunt: row.hunt, deferralId: row.deferralId })),
      nights: recentNights(db),
      morning: [
        `${statsEpochLine(statsEpoch(db))}.`,
        ...composeWallMorning(db, ports.now()),
        watchMorningLine(db, ports.now()),
        ...(cancelParetoLine(db, ports.now()) ? [cancelParetoLine(db, ports.now())!] : []),
        ...(promotionMorningLine(db) ? [promotionMorningLine(db)!] : []),
        ...(diffHiddenMorningLine(db as never, ports.now()) ? [diffHiddenMorningLine(db as never, ports.now())!] : []),
        ...(modelRebenchMorningLine(db as never, ports.now()) ? [modelRebenchMorningLine(db as never, ports.now())!] : []),
        ...(deps.skillSwitchMorningLine(db, ports.now()) ? [deps.skillSwitchMorningLine(db, ports.now())!] : []),
        ...(errandsDiagnosisMorningLine(db as never) ? [errandsDiagnosisMorningLine(db as never)!] : []),
        ...(profileCheckMorningLine(db as never) ? [profileCheckMorningLine(db as never)!] : []),
      ],
    };
  }
  function show(key: string) {
    const cls = getClass(db, key) ?? getClass(db, key.replace(/^class:/, ""));
    const wall = getWall(db, key) ?? getWall(db, classWallKey(key));
    return { class: cls, wall, repairs: cls ? listRepairs(db, { classKey: cls.classKey }) : [], reruns: db.prepare("SELECT * FROM lane_pilot_wall_rerun WHERE class_key=? ORDER BY created_at DESC LIMIT 50").all(cls?.classKey ?? key) };
  }
  function close(key: string, evidence: string): WallRow {
    const wall = getWall(db, key);
    if (!wall) throw new Error(`no wall ${key}`);
    if (evidence.trim().length < 8) throw new Error("--evidence must say what closes it: an accepted attempt, a commit, the owner's decision");
    const now = ports.now();
    updateWall(db, key, { state: "closed", closedAt: now, closedBy: evidence.trim().slice(0, 500) }, now);
    if (wall.deferralId) { try { ports.deferrals.close(wall.deferralId, evidence.trim()); } catch { /* closed already */ } }
    if (wall.kind === "class") updateClassLadder(db, wall.subject, { failedMoves: 0, hunt: "none", afterHuntFailed: 0, stage: "moves" }, now);
    return getWall(db, key)!;
  }

  const morning = (now?: number) => [
      `${statsEpochLine(statsEpoch(db))}.`,
      ...composeWallMorning(db, now ?? ports.now()),
      watchMorningLine(db, now ?? ports.now()),
      ...(cancelParetoLine(db, now ?? ports.now()) ? [cancelParetoLine(db, now ?? ports.now())!] : []),
      ...(promotionMorningLine(db) ? [promotionMorningLine(db)!] : []),
      ...(diffHiddenMorningLine(db as never, now ?? ports.now()) ? [diffHiddenMorningLine(db as never, now ?? ports.now())!] : []),
      ...(modelRebenchMorningLine(db as never, now ?? ports.now()) ? [modelRebenchMorningLine(db as never, now ?? ports.now())!] : []),
      ...(deps.skillSwitchMorningLine(db, now ?? ports.now()) ? [deps.skillSwitchMorningLine(db, now ?? ports.now())!] : []),
      ...(errandsDiagnosisMorningLine(db as never) ? [errandsDiagnosisMorningLine(db as never)!] : []),
      ...(profileCheckMorningLine(db as never) ? [profileCheckMorningLine(db as never)!] : []),
    ];

  return { status, show, close, morning };
}
