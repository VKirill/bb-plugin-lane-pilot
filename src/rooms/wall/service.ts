import { createHash } from "node:crypto";
import type { HeadPart } from "@lane-pilot/contracts";
import { extractModelJson } from "../critique";
import { authorize, type ChangeDescriptor } from "../policy";
import { decideAcceptance, gateRepair, repairChange, type Acceptance, type AcceptanceEvidence, type GateDecision } from "./acceptance";
import { analysisPrompt, hunterPrompt, parseNightReport, repairBrief, taskWallMessage } from "./brief";
import { WALL_CONFIG_KEY, parseWallConfig, type WallConfig } from "./config";
import { classVersions, collectEntries, getClass, listClasses, nightOf, refreshClasses, writeEntries, type WallDb } from "./journal";
import { afterFailedMove, ladderStep } from "./ladder";
import { composeWallMorning } from "./morning";
import { HUNT_ANGLES, buildClassPack, buildTaskPack, judgeHunt, parseFinding, type CheckedFinding, type EvidencePack, type HuntOutcome, type PackFile } from "./pack";
import { executable, headPartsOf, planClassRerun, recordRerun, type RerunPlan, type RerunScope } from "./rerun";
import { selectClasses } from "./select";
import { repairSignature, wallSignature } from "./signature";
import {
  getWall, insertRepair, insertWall, listRepairs, listWalls, nightSpend, openRepairs, recentNights, refreshNightSpend, saveNight, updateClassLadder, updateRepair, updateWall, type RepairRow, type WallRow,
} from "./store";
import { OPEN_REPAIR_STATES, type NightSummary, type WallClass } from "./types";

const DAY = 86_400_000;
const HELD_RELEASE_MS = 7 * DAY;
const QUEUED_STALE_MS = 12 * 3_600_000;

export type Scope = { isReal(projectId: string, taskId: string): boolean; scopeOf(projectId: string): RerunScope };
export type ThreadRun = { text: string | null; tokens: number };
export type RepairView = { threadId: string | null; verdict: string | null; outcome: string | null; branch: string | null; worktreePath: string | null; spawnedAt: number | null };
export type OwnerItem = { key: string; source: string; kind: string; what: string; why: string; projectId?: string; evidence?: Array<{ kind: string; ref: string; label?: string }>; actions?: Array<{ id: string; label: string; cli: string }> };
type Exam = Parameters<typeof authorize>[1];

/** Everything the loop needs from outside its database; the plugin wires the real ones (server/wall.ts), tests pass fakes. */
export type WallPorts = {
  now(): number;
  version: string;
  loadScope(): Promise<Scope>;
  logLines(since: number, until: number): Array<{ message: string; at: number; projectId: string }>;
  /** Source files that emit a failure's wording, as the hunters' evidence (empty when the checkout is out of reach). */
  codeFiles(fragments: readonly string[]): Promise<PackFile[]>;
  /** A read-only reader with no tools (a hunter or the full analysis) in another model's seat. */
  reader(prompt: string, who: "hunter" | "analysis"): Promise<ThreadRun>;
  tellPm(threadId: string, text: string): Promise<boolean>;
  repair: {
    view(signature: string): Promise<RepairView | null>;
    report(threadId: string): Promise<string>;
    tokens(threadId: string): Promise<number | null>;
    busy(threadId: string): Promise<boolean>;
    changedFiles(view: RepairView): Promise<string[] | null>;
    revert(commit: string): Promise<{ ok: boolean; detail: string }>;
  };
  release: {
    drill(): Promise<{ version: string; at: number; ok: boolean } | null>;
    canary(): Promise<{ version: string; tripped: boolean; windowOpen: boolean } | null>;
  };
  bench: {
    available(): Promise<boolean>;
    ensureArm(arm: string): Promise<"done" | "running" | "unavailable">;
    compare(base: string, arm: string): Promise<"pass" | "fail" | "pending" | "unavailable">;
    score(arm: string): Promise<number | null>;
  };
  exam(): Promise<Exam>;
  restart(plan: RerunPlan): Promise<{ ok: boolean; note: string }>;
  deferrals: { open(input: { id: string; what: string; area: string; projectId: string | null }): void; close(id: string, evidence: string): void };
  owner?: { post(item: OwnerItem): Promise<void> };
};

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
export type WallDeps = { db: WallDb; kv: Kv; ports: WallPorts; log(line: string): void; hubDb?: string };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The hash of what a task asks, without its id (a redispatch under «P1.2» is the same ask) and of its plan. */
export function askSha(task: unknown, plan: string): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => key !== "id").sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => [key, sorted(value)]))
    : item;
  return sha(`${JSON.stringify(sorted(task))}\n${plan}`).slice(0, 16);
}
export const taskWallKey = (family: string, runId: string, classKey: string): string => `task:${sha(`${runId}|${family}|${classKey}`).slice(0, 12)}`;
export const classWallKey = (classKey: string): string => `class:${classKey}`;

export function createWall(deps: WallDeps) {
  const { db, kv, ports, log } = deps;

  async function config(): Promise<WallConfig> {
    return parseWallConfig(await kv.get(WALL_CONFIG_KEY).catch(() => null));
  }
  async function setConfig(patch: Partial<WallConfig>): Promise<WallConfig> {
    const next = parseWallConfig({ ...(await config()), ...patch });
    await kv.set(WALL_CONFIG_KEY, next as never);
    return next;
  }

  /** The class's cycle history for `shouldStopCycle`: the bench score before the first repair, then after each repair that was judged. */
  function cycleScores(): number[] {
    const rows = listRepairs(db).filter((row) => row.acceptance && typeof (row.acceptance as { benchScore?: unknown }).benchScore === "number");
    if (!rows.length) return [];
    const first = rows[0]!.acceptance as { baselineScore?: number };
    return [first.baselineScore ?? 0, ...rows.map((row) => (row.acceptance as { benchScore: number }).benchScore)];
  }

  // ---------------------------------------------------------------- the hunt
  function recordHuntOutcome(outcome: HuntOutcome): unknown {
    return { state: outcome.state, demoted: outcome.demoted, findings: outcome.findings };
  }

  /** Three read-only hunters from other sides over one pack; their citations are held against it by code. The tokens are the wall's spend. */
  async function hunt(pack: EvidencePack, cfg: WallConfig): Promise<{ outcome: HuntOutcome; tokens: number }> {
    const angles = HUNT_ANGLES.slice(0, cfg.hunters);
    const runs = await Promise.all(angles.map(async (angle) => {
      const run = await ports.reader(hunterPrompt(angle, pack), "hunter").catch(() => ({ text: null, tokens: 0 } as ThreadRun));
      let finding = null;
      try { finding = run.text ? parseFinding(extractModelJson(run.text), angle) : null; } catch { finding = null; }
      return { finding, tokens: run.tokens };
    }));
    return { outcome: judgeHunt(pack, runs.map((row) => row.finding)), tokens: runs.reduce((sum, row) => sum + row.tokens, 0) };
  }

  const huntBudgetLeft = (cfg: WallConfig, now: number): number => {
    const dayStart = Date.parse(`${nightOf(now)}T00:00:00Z`);
    const spent = (db.prepare("SELECT COALESCE(SUM(tokens_used),0) AS n FROM lane_pilot_wall WHERE updated_at>=? AND hunt_state<>'none'").get(dayStart) as { n: number }).n;
    return Math.max(0, Math.floor(cfg.nightTokenCap * cfg.huntShare) - spent);
  };

  async function huntClass(cls: WallClass, cfg: WallConfig, now: number): Promise<{ state: "usable" | "unknown" | "skipped"; tokens: number }> {
    if (huntBudgetLeft(cfg, now) <= 0) return { state: "skipped", tokens: 0 };
    const key = classWallKey(cls.classKey);
    insertWall(db, { key, kind: "class", subject: cls.classKey, projectId: "", state: "hunting", moves: cls.failedMoves, now });
    updateClassLadder(db, cls.classKey, { hunt: "running" }, now);
    const files = await ports.codeFiles(cls.reasonNorm.split(/<[a-z]+>/).map((part) => part.trim()).filter((part) => part.length >= 12).slice(0, 3)).catch(() => []);
    const pack = buildClassPack(db, cls.classKey, { files, facts: [`moves spent: ${cls.failedMoves}; the engineer's rounds did not end the class`] });
    const { outcome, tokens } = await hunt(pack, cfg);
    updateWall(db, key, { state: "hunted", hunt: outcome.state, pack, findings: recordHuntOutcome(outcome), tokensUsed: tokens }, ports.now());
    updateClassLadder(db, cls.classKey, { hunt: outcome.state, stage: outcome.state === "usable" ? "informed" : "backlog" }, ports.now());
    log(`wall: hunt of ${cls.classKey}: ${outcome.state} (${outcome.usable.length} usable of ${outcome.findings.length}, ${outcome.demoted} lowered), ${tokens} tokens`);
    return { state: outcome.state, tokens };
  }

  // ---------------------------------------------------------------- the backlog
  async function escalateBacklog(key: string, subject: string, projectId: string, why: string, now: number, extra: { classKey?: string } = {}): Promise<string> {
    const cfg = await config();
    const existing = getWall(db, key);
    if (existing?.deferralId) return existing.deferralId;
    const id = `dfr_wall_${sha(key).slice(0, 10)}`;
    ports.deferrals.open({ id, what: `Wall in the backlog: ${subject.slice(0, 300)} (${why.slice(0, 160)}); the full analysis is in bb lane-pilot wall show ${key}`, area: "wall", projectId: projectId || null });
    insertWall(db, { key, kind: key.startsWith("class:") ? "class" : "task", subject, projectId, state: "backlog", moves: 0, now });
    updateWall(db, key, { state: "backlog", deferralId: id }, now);
    if (extra.classKey) updateClassLadder(db, extra.classKey, { stage: "backlog" }, now);
    // The full analysis: a strong reader, the night's budget; written into the wall so a person starts from it.
    const wall = getWall(db, key)!;
    if (!wall.analysis && huntBudgetLeft(cfg, now) > 0) {
      const pack = (wall.pack as EvidencePack | null) ?? (extra.classKey ? buildClassPack(db, extra.classKey) : null);
      if (pack) {
        const history = [`wall ${key}`, ...listRepairs(db, extra.classKey ? { classKey: extra.classKey } : {}).map((row) => `round ${row.round} (${row.role}) ${row.state}: ${row.outcome ?? ""}`)];
        const run = await ports.reader(analysisPrompt({ subject, pack, findings: ((wall.findings as { findings?: CheckedFinding[] } | null)?.findings) ?? [], history }), "analysis").catch(() => ({ text: null, tokens: 0 } as ThreadRun));
        updateWall(db, key, { analysis: { text: run.text, at: ports.now() }, tokensUsed: (wall.tokensUsed ?? 0) + run.tokens }, ports.now());
      }
    }
    await ports.owner?.post({ key: `wall:${key}`, source: "wall", kind: "backlog", what: `Стена в беклоге: ${subject.slice(0, 200)}`, why: `Ступени пройдены (${why}); дальше решает человек.`, projectId: projectId || undefined,
      actions: [{ id: "show", label: "Разбор стены", cli: `bb lane-pilot wall show ${key}` }] }).catch(() => undefined);
    log(`wall: ${subject} went to the backlog (${why}) as ${id}`);
    return id;
  }

  // ---------------------------------------------------------------- task walls (the same ladder for ordinary tasks)
  /**
   * Called when a task family was stopped by `repeated_failure:` (two attempts failing the same way = the two normal moves). First sight opens
   * the wall (the hunt follows); the same wall stopped again after the hunters' message means the informed move failed too: the backlog.
   */
  async function noteTaskStop(input: { projectId: string; runId: string; taskId: string; family: string; reason: string; state: string; pmThreadId: string | null; task: unknown; plan: string }): Promise<{ key: string; step: string }> {
    const now = ports.now();
    const sig = wallSignature(input.state, input.reason);
    const key = taskWallKey(input.family, input.runId, sig.classKey);
    const wall = getWall(db, key);
    if (!wall) {
      insertWall(db, { key, kind: "task", subject: `${input.family}: ${sig.reasonNorm}`.slice(0, 300), projectId: input.projectId, state: "stopped", moves: 2, now });
      const pack = buildTaskPack(db, { runId: input.runId, taskId: input.taskId, family: input.family, fingerprintLike: sig.reasonNorm.split("<")[0]!.trim().slice(0, 40) || undefined, now });
      pack.meta = { runId: input.runId, family: input.family, taskId: input.taskId, pmThreadId: input.pmThreadId ?? "", askSha: askSha(input.task, input.plan), classKey: sig.classKey };
      updateWall(db, key, { pack }, now);
      return { key, step: "hunt" };
    }
    if (wall.state === "hunted" && wall.hunt === "usable") {
      await escalateBacklog(key, wall.subject, wall.projectId, "the move after the hunters' message failed the same way", now);
      return { key, step: "backlog" };
    }
    return { key, step: wall.state };
  }

  /** The hunts of stopped task walls, the message to the PM, the backlog for walls the hunt could not read; walls closed by an accepted attempt. */
  async function advanceTaskWalls(cfg: WallConfig, now: number): Promise<string[]> {
    const notes: string[] = [];
    for (const wall of listWalls(db, { kind: "task", states: ["stopped", "hunted", "backlog"] })) {
      const pack = wall.pack as EvidencePack | null;
      const family = pack?.meta?.family;
      const accepted = family && pack?.meta?.runId ? (db.prepare("SELECT id FROM lane_pilot_attempt WHERE run_id=? AND (task_id=? OR task_id LIKE ?) AND state='accepted' AND updated_at>? LIMIT 1")
        .get(pack.meta.runId, family, `${family}.%`, wall.createdAt) as { id: string } | undefined) : undefined;
      if (accepted) {
        updateWall(db, wall.key, { state: "closed", closedAt: now, closedBy: `accepted attempt ${accepted.id}` }, now);
        if (wall.deferralId) { try { ports.deferrals.close(wall.deferralId, `an attempt of the family was accepted: ${accepted.id}`); } catch { /* already closed */ } }
        notes.push(`closed ${wall.key} by ${accepted.id}`);
        continue;
      }
      if (wall.state !== "stopped" || !pack) continue;
      if (huntBudgetLeft(cfg, now) <= 0) { notes.push(`hunt of ${wall.key} waits: the hunt budget is spent`); continue; }
      updateWall(db, wall.key, { state: "hunting", hunt: "running" }, now);
      const { outcome, tokens } = await hunt(pack, cfg);
      updateWall(db, wall.key, { state: "hunted", hunt: outcome.state, findings: recordHuntOutcome(outcome), tokensUsed: tokens }, ports.now());
      if (outcome.state === "unknown") { await escalateBacklog(wall.key, wall.subject, wall.projectId, "every hunter ended unknown or without a citation that holds", now); notes.push(`${wall.key}: backlog`); continue; }
      const pm = pack.meta?.pmThreadId;
      const text = taskWallMessage({ family: family ?? wall.subject, findings: outcome.usable, budgetNote: `Hunt cost: ${tokens.toLocaleString("en-US")} tokens.` });
      const sent = pm ? await ports.tellPm(pm, text).catch(() => false) : false;
      if (sent) updateWall(db, wall.key, { messageSentAt: ports.now() }, ports.now());
      notes.push(`${wall.key}: hunted, ${outcome.usable.length} usable${sent ? ", the PM was told" : ""}`);
    }
    return notes;
  }

  /**
   * At dispatch: a family in the backlog is not sent again; a family whose hunters said the ask itself is wrong is not sent again unchanged.
   * Returns the refusal text or null.
   */
  function dispatchGuard(input: { runId: string; family: string; task: unknown; plan: string }): string | null {
    for (const wall of listWalls(db, { kind: "task", states: ["stopped", "hunted", "backlog"] })) {
      const meta = (wall.pack as EvidencePack | null)?.meta;
      if (!meta || meta.family !== input.family || meta.runId !== input.runId) continue;
      if (wall.state === "backlog") return `wall_backlog: ${input.family} failed the same way after the normal moves and the hunters' message; it is in the backlog (${wall.deferralId ?? wall.key}) and waits for a person. See bb lane-pilot wall show ${wall.key}.`;
      const findings = ((wall.findings as { findings?: CheckedFinding[] } | null)?.findings ?? []).filter((row) => ["contract_wrong", "impossible_as_stated", "approach_wrong", "split_needed"].includes(row.verdict));
      if (wall.state === "hunted" && findings.length && meta.askSha === askSha(input.task, input.plan)) {
        return `wall_unchanged_ask: ${input.family} stopped after two identical failures and the hunters found the ask itself wrong (${findings.map((row) => row.verdict).join(", ")}). Dispatch it again only with a changed contract or plan (their findings were sent to you).`;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- the night
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
    const benchOk = cfg.benchSubset > 0 && await ports.bench.available().catch(() => false);
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
    if (benchOk && selection.picked.length) await ports.bench.ensureArm(`night-${ports.version}`).catch(() => undefined);
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
    return summary;
  }

  // ---------------------------------------------------------------- following the repairs
  const classOf = (row: RepairRow) => getClass(db, row.classKey);

  function failMove(row: RepairRow, outcome: string, now: number): void {
    const cls = classOf(row);
    if (!cls) return;
    const next = afterFailedMove({ failedMoves: cls.failedMoves, hunt: cls.hunt, afterHuntFailed: cls.afterHuntFailed });
    updateClassLadder(db, cls.classKey, { failedMoves: next.failedMoves, afterHuntFailed: next.afterHuntFailed }, now);
    log(`wall: round ${row.round} of ${row.classKey} failed (${outcome}); moves ${next.failedMoves}, after the hunt ${next.afterHuntFailed}`);
  }

  /** The self-repair watcher asks before it merges a fixed night repair. The answer is stored once per repair; a hold is released after a week. */
  async function mergeGate(signature: string, info: { threadId: string }): Promise<"merge" | "hold" | "release"> {
    const row = listRepairs(db, { states: OPEN_REPAIR_STATES }).filter((item) => item.signature === signature).at(-1);
    if (!row) return "hold";
    const now = ports.now();
    const stored = row.policy as { decision?: GateDecision["decision"] } | null;
    if (stored?.decision === "merge") return "merge";
    if (stored?.decision === "hold") return now - row.updatedAt > HELD_RELEASE_MS && row.state === "held" ? "release" : "hold";
    const view = await ports.repair.view(signature);
    const files = view ? await ports.repair.changedFiles(view).catch(() => null) : null;
    if (!files) { updateRepair(db, row.id, { policy: { decision: "hold", reason: "the branch's changed files could not be read" } }, now); return "hold"; }
    const cfg = await config();
    const benchOk = cfg.benchSubset > 0 && await ports.bench.available().catch(() => false);
    const change: ChangeDescriptor = repairChange(files, { benchSubset: benchOk, revertible: true });
    const decision = gateRepair(change, await ports.exam());
    updateRepair(db, row.id, { state: decision.decision === "merge" ? "fixed" : "held", verdict: "fixed", policy: { ...decision, change, benchEnforcedAfterDeploy: benchOk } }, now);
    if (decision.decision === "hold") {
      log(`wall: repair ${row.id} of ${row.classKey} is held by the policy (${decision.tier}): ${decision.reason}`);
      await ports.owner?.post({ key: `wall-repair:${row.id}`, source: "night", kind: "repair_proposal", what: `Ночной ремонт класса ${row.classKey} ждёт решения`, why: `Политика ночи: ${decision.tier}${decision.degraded ? " (экзамен политики не сдан)" : ""}; ${decision.reason}`.slice(0, 400),
        evidence: [{ kind: "text", ref: `branch ${view?.branch ?? "?"}`, label: (files.slice(0, 8).join(", ")) }],
        actions: [{ id: "show", label: "Показать ремонт", cli: `bb lane-pilot wall show ${row.classKey}` }] }).catch(() => undefined);
    }
    void info;
    return decision.decision;
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

  /** Reads the verdicts of running repairs, the release train's trace for merged ones, and moves each along. Cheap; runs every few minutes. */
  async function advance(now: number = ports.now()): Promise<string[]> {
    const notes: string[] = [];
    const cfg = await config();
    for (const row of listRepairs(db, { states: OPEN_REPAIR_STATES })) {
      if (row.state === "queued" && now - row.createdAt > QUEUED_STALE_MS) {
        updateRepair(db, row.id, { state: "failed", outcome: "never started within 12 hours" }, now);
        notes.push(`${row.id}: never started`);
        continue;
      }
      if (row.threadId) {
        const used = await ports.repair.tokens(row.threadId).catch(() => null);
        if (used !== null && used !== row.tokensUsed) updateRepair(db, row.id, { tokensUsed: used }, now);
      }
      if (row.state === "running" && row.threadId) {
        const view = await ports.repair.view(row.signature);
        if (view?.verdict && !(await ports.repair.busy(row.threadId))) {
          const report = await ports.repair.report(row.threadId).catch(() => "");
          const night = parseNightReport(report);
          updateRepair(db, row.id, { verdict: view.verdict, outcome: `${view.verdict}; ${night.sites} sites listed${night.sitesOpen ? `, ${night.sitesOpen} left open` : ""}${night.test ? `; test ${night.test}` : "; no regression test named"}` }, now);
          if (view.verdict !== "fixed") {
            // The watcher releases the worktree and calls `settled`; a verdict that is not «fixed» is a failed move for the ladder.
            notes.push(`${row.id}: verdict ${view.verdict}`);
          }
        }
      }
      if (row.state === "merged" || row.state === "deployed") notes.push(...await followRelease(row, cfg, now));
    }
    notes.push(...await advanceTaskWalls(cfg, now));
    const night = nightOf(now), from = Date.parse(`${night}T00:00:00Z`);
    refreshNightSpend(db, night, { from, to: from + DAY });
    return notes;
  }

  async function followRelease(row: RepairRow, cfg: WallConfig, now: number): Promise<string[]> {
    const acceptance = (row.acceptance ?? {}) as { mergedAtVersion?: string; deployedAt?: number; benchScore?: number; baselineScore?: number; revertedAt?: number };
    const mergedAt = acceptance.mergedAtVersion ?? row.versionBefore;
    const deployed = ports.version !== mergedAt;
    if (!deployed && row.state === "deployed") {
      updateRepair(db, row.id, { state: "rolled_back", outcome: "the plugin runs the version before the repair again: the release train rolled back", acceptance: { ...acceptance, rolledBack: true } }, now);
      failMove(row, "the train rolled back", now);
      return [`${row.id}: rolled back by the train`];
    }
    if (!deployed) return [];
    if (row.state === "merged") {
      updateRepair(db, row.id, { state: "deployed", shippedVersion: ports.version, acceptance: { ...acceptance, deployedAt: now } }, now);
      return [`${row.id}: deployed as ${ports.version}`];
    }
    const deployedAt = acceptance.deployedAt ?? now;
    const drill = await ports.release.drill().catch(() => null);
    const canary = await ports.release.canary().catch(() => null);
    const benchOk = cfg.benchSubset > 0 && await ports.bench.available().catch(() => false);
    let bench: AcceptanceEvidence["bench"] = "unavailable";
    let benchScore: number | undefined, baselineScore: number | undefined;
    if (benchOk && canary && !canary.windowOpen) {
      const base = `night-${mergedAt}`, arm = `night-${ports.version}`;
      const state = await ports.bench.ensureArm(arm).catch(() => "unavailable" as const);
      bench = state === "done" ? await ports.bench.compare(base, arm).catch(() => "unavailable" as const) : state === "running" ? "pending" : "unavailable";
      if (bench === "pass" || bench === "fail") {
        benchScore = (await ports.bench.score(arm).catch(() => null)) ?? undefined;
        baselineScore = (await ports.bench.score(base).catch(() => null)) ?? undefined;
      }
    }
    const recurrence = recurrenceOn(row.classKey, ports.version, deployedAt);
    const result = decideAcceptance({ merged: true, versionBefore: mergedAt, deployedVersion: ports.version, drill, deployedAt, canary, bench, recurrence, trainRolledBack: false });
    return await settleAcceptance(row, result, { ...acceptance, deployedAt, ...(benchScore !== undefined ? { benchScore } : {}), ...(baselineScore !== undefined ? { baselineScore } : {}) }, now);
  }

  function recurrenceOn(classKey: string, version: string, since: number): { failures: number; attempts: number } | null {
    const attempts = db.prepare(`SELECT a.state, a.reason FROM lane_pilot_attempt a WHERE a.harness_version=? AND a.created_at>=? AND a.state NOT IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested','canceled')`)
      .all(version, since) as Array<{ state: string; reason: string | null }>;
    if (!attempts.length) return null;
    return { attempts: attempts.length, failures: attempts.filter((row) => row.state !== "accepted" && wallSignature(row.state, row.reason).classKey === classKey).length };
  }

  async function settleAcceptance(row: RepairRow, result: Acceptance, acceptance: Record<string, unknown>, now: number): Promise<string[]> {
    const payload: Record<string, unknown> = { ...acceptance, checks: result.checks, reason: result.reason, recurred: result.recurred };
    if (result.state === "pending") { updateRepair(db, row.id, { acceptance: payload }, now); return []; }
    if (result.state === "accepted") {
      updateRepair(db, row.id, { state: "accepted", acceptance: payload, outcome: result.reason }, now);
      updateClassLadder(db, row.classKey, { fixedIn: row.shippedVersion ?? ports.version }, now);
      if (result.recurred) failMove(row, "the class recurred on the new version", now);
      const planned = await rerunClass(row, now);
      return [`${row.id}: accepted (${result.reason}); ${planned} re-run(s) planned`];
    }
    let detail = result.reason;
    if (result.action === "revert" && row.mergedCommit && !(acceptance as { revertedAt?: number }).revertedAt) {
      const reverted = await ports.repair.revert(row.mergedCommit).catch((cause: unknown) => ({ ok: false, detail: cause instanceof Error ? cause.message : String(cause) }));
      payload.revertedAt = reverted.ok ? now : undefined;
      detail = `${result.reason}; revert ${reverted.ok ? "committed" : "failed"}: ${reverted.detail}`;
    }
    updateRepair(db, row.id, { state: result.state === "rolled_back" ? "rolled_back" : "red", acceptance: payload, outcome: detail.slice(0, 400) }, now);
    failMove(row, detail, now);
    return [`${row.id}: ${result.state} (${detail})`];
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
        const why = plan.scope === "real" ? "a real project: the owner's morning list" : `earliest affected stage ${plan.affected.from ?? "none"} needs return-to-stage (not restartable in place)`;
        if (recordRerun(db, plan, "listed", why, now)) count += 1;
      }
    }
    return count;
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

  // ---------------------------------------------------------------- reads
  function status() {
    const classes = listClasses(db);
    return {
      classes: classes.filter((row) => row.recur7 > 0 || row.state === "open").slice(0, 60),
      open: classes.filter((row) => row.state === "open").length,
      repairs: listRepairs(db, { since: ports.now() - 14 * DAY }),
      walls: listWalls(db, { states: ["stopped", "hunting", "hunted", "backlog"] }).map((row) => ({ key: row.key, kind: row.kind, subject: row.subject, state: row.state, hunt: row.hunt, deferralId: row.deferralId })),
      nights: recentNights(db),
      morning: composeWallMorning(db, ports.now()),
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

  return { config, setConfig, runNight, advance, mergeGate, settled, started, startFailed, nextAssignment, noteTaskStop, dispatchGuard, rerun, status, show, close,
    morning: (now?: number) => composeWallMorning(db, now ?? ports.now()), classes: () => listClasses(db) };
}

export type WallApi = ReturnType<typeof createWall>;
