import { createHash } from "node:crypto";
import type { HeadPart } from "@lane-pilot/contracts";
import { extractModelJson } from "../critique";
import type { ChangeDescriptor } from "../policy";
import { EVIDENCE_WAIT_MS, closeExpiredRepair, decideAcceptance, gateRepair, laterReleaseTouches, repairChange, type Acceptance, type AcceptanceEvidence, type GateDecision, type RepairFile } from "./acceptance";
import { analysisPrompt, hunterPrompt, parseNightReport, parsePrediction, predictionHeld, repairBrief, taskWallMessage, PREDICTION_METRICS } from "./brief";
import { nightArm } from "../bench/server";
import { statsEpochMs, statsEpochLine, STATS_EPOCH_SETTING } from "../storage";
import { loadProjectSettings } from "../storage";
import { hubFields, writeHubFields } from "../improvement";
import { postOwnerItem } from "../owner-waiting";
import { WALL_CONFIG_KEY, parseWallConfig, type WallConfig } from "./config";
import { classVersions, collectEntries, getClass, graphRecurrence, listClasses, nightOf, refreshClasses, writeEntries, type WallDb } from "./journal";
import { afterFailedMove, ladderStep } from "./ladder";
import { composeWallMorning } from "./morning";
import { promotionMorningLine } from "../rule-forms";
import { watchMorningLine } from "@lane-pilot/jev";
import { HUNT_ANGLES, buildClassPack, buildLoopPack, buildTaskPack, judgeHunt, parseFinding, type CheckedFinding, type EvidencePack, type HuntOutcome, type LoopEvidence, type PackFile } from "./pack";
import { executable, headPartsOf, planClassRerun, recordRerun, type RerunPlan, type RerunScope } from "./rerun";
import { cycleScoresOf, selectClasses } from "./select";
import { repairSignature, wallSignature } from "./signature";
import {
  getWall, insertRepair, insertWall, listRepairs, listWalls, nightSpend, openRepairs, recentNights, refreshNightSpend, saveNight, updateClassLadder, updateRepair, updateWall, type RepairRow, type WallRow,
} from "./store";
import { OPEN_REPAIR_STATES, type NightSummary, type WallClass } from "./types";
import { jev, type Jev, type JevSettings } from "@lane-pilot/jev";
import { wallFilterJudgment, type WallFilterDecision, type WallFilterInput } from "./wall-filter-judgment";

/** The graph that runs the hunters and the analysis of a wall. */
export const WALL_HUNT_WORKFLOW = "lp.wall-hunt";
const DAY = 86_400_000;
const QUEUED_STALE_MS = 12 * 3_600_000;
/** A revert that did not go through is tried again at most this often and this many times; then the diagnosis goes to the backlog. */
const ROLLBACK_RETRY_MS = 10 * 60_000;
export const ROLLBACK_TRIES = 6;
type Rollback = { attempts: number; lastError: string; lastAt: number; reason: string; gaveUp?: boolean };

/** stats.epoch: walls, reruns and repairs count only records after it (default 2026-10-31); older rows stay but are not counted. */
const statsEpoch = (db: WallDb): number =>
  statsEpochMs((db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND key=?").get("*", STATS_EPOCH_SETTING) as { value:string } | undefined)?.value);

export type Scope = { isReal(projectId: string, taskId: string): boolean; scopeOf(projectId: string): RerunScope };
export type ThreadRun = { text: string | null; tokens: number };
export type RepairView = { threadId: string | null; verdict: string | null; outcome: string | null; branch: string | null; worktreePath: string | null; spawnedAt: number | null };

/** Everything the loop needs from outside its database; the plugin wires the real ones (server/wall.ts), tests pass fakes. */
export type WallPorts = {
  now(): number;
  version: string;
  loadScope(): Promise<Scope>;
  logLines(since: number, until: number): Array<{ message: string; at: number; projectId: string }>;
  /** Source files that emit a failure's wording, as the hunters' evidence (empty when the checkout is out of reach). */
  codeFiles(fragments: readonly string[]): Promise<PackFile[]>;
  /** A read-only reader with no tools (a hunter or the full analysis) in another model's seat. Used when `graph` is not set (the tests' fakes). */
  reader?(prompt: string, who: "hunter" | "analysis"): Promise<ThreadRun>;
  /**
   * The model work as a graph run (`lp.wall-hunt`, night-graphs/server/wall-hunt-graph.ts): the hunters side by side, or the analysis, as a run of that
   * graph that records its result in the wall row. When set it replaces `reader`; a run that fails gives null and the hunt reads as «unknown».
   */
  graph?: {
    hunt(input: { wallKey: string; pack: EvidencePack; angles: readonly string[] }): Promise<{ outcome: HuntOutcome; tokens: number } | null>;
    analysis(input: { wallKey: string; prompt: string }): Promise<ThreadRun | null>;
  };
  /** The hidden thread of one reader of the graph, tied to the step that asks (its spawn id and metadata); returns the thread's id. */
  spawnReader?(input: { who: "hunter" | "analysis"; prompt: string; graph: { spawnId: string; metadata: Record<string, unknown> } }): Promise<string>;
  tellPm(threadId: string, text: string): Promise<boolean>;
  repair: {
    view(signature: string): Promise<RepairView | null>;
    report(threadId: string): Promise<string>;
    tokens(threadId: string): Promise<number | null>;
    busy(threadId: string): Promise<boolean>;
    changedFiles(view: RepairView): Promise<RepairFile[] | null>;
    revert(commit: string): Promise<{ ok: boolean; detail: string }>;
  };
  release: {
    drill(): Promise<{ version: string; at: number; ok: boolean } | null>;
    canary(): Promise<{ version: string; tripped: boolean; windowOpen: boolean } | null>;
    /** The repository files changed from one released version to a later one; null when unknown (the release tags are not there). Absent in fakes: then a later release voids. */
    changedBetween?(from: string, to: string): Promise<string[] | null>;
  };
  bench: {
    available(): Promise<boolean>;
    /** The newest set version that has a `done` run of this arm; null when the arm was never measured. */
    armSet(arm: string): Promise<string | null>;
    ensureArm(arm: string, setVersion?: string): Promise<"done" | "running" | "unavailable">;
    compare(base: string, arm: string, setVersion?: string): Promise<"pass" | "fail" | "inconclusive" | "pending" | "unavailable">;
    score(arm: string): Promise<number | null>;
  };
  restart(plan: RerunPlan): Promise<{ ok: boolean; note: string }>;
  deferrals: { open(input: { id: string; what: string; area: string; projectId: string | null }): void; close(id: string, evidence: string): void };
};

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
export type WallDeps = {
  db: WallDb;
  kv: Kv;
  ports: WallPorts;
  log(line: string): void;
  hubDb?: string;
  jev?: () => Jev | null;
  settings?: () => Promise<JevSettings>;
};

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

/** Loop walls (a phase stage, a failed verification, a topic) are walls of kind task whose key starts with this. */
export const LOOP_PREFIX = "loop:";
export const loopWallKey = (kind: LoopSubject["kind"], id: string): string => `${LOOP_PREFIX}${kind}:${sha(id).slice(0, 12)}`;

/** A loop of tries that ended (see `loopExhausted`). */
export type LoopSubject = Omit<LoopEvidence, "subject"> & {
  /** A phase stage's workflow that failed, the machine's replans after a failed verification, or a topic of a run the stopper refused. */
  kind: "stage" | "replan" | "topic";
  /** Names the subject within its kind; one id, one wall, one hunt, one backlog item. */
  id: string;
  title: string;
  projectId: string;
  /** What the caller already did about it (a scope cut, a stop), for the morning-list line and the backlog item. */
  done: string;
  /** The topic stopper's key (a file or a test), read back by `loopTopics`. */
  topic?: string;
  pmThreadId?: string | null;
  /** The one notice for the PM chat, sent at once; omitted when the caller's own answer already is that notice. */
  notice?: string;
};

export function createWall(deps: WallDeps) {
  const { db, kv, ports, log } = deps;

  /** The settings of the global level (`wall.*`) over what the old key-value store holds: a field with no row reads the old value. */
  async function config(): Promise<WallConfig> {
    const old = await kv.get(WALL_CONFIG_KEY).catch(() => null);
    return parseWallConfig({ ...(old && typeof old === "object" ? old : {}), ...hubFields(db, "wall") });
  }
  async function setConfig(patch: Partial<WallConfig>): Promise<WallConfig> {
    const next = parseWallConfig({ ...(await config()), ...patch });
    // Only the fields the caller named become settings rows, with the value the parser settled on (the clamped one).
    writeHubFields(db, "wall", Object.fromEntries(Object.keys(patch).map((field) => [field, (next as Record<string, unknown>)[field]])));
    return next;
  }

  /** The class's cycle history for `shouldStopCycle`: the bench score before the first repair, then after each repair that was judged. */
  const cycleScores = (): number[] => cycleScoresOf(listRepairs(db));

  // ---------------------------------------------------------------- the hunt
  function recordHuntOutcome(outcome: HuntOutcome): unknown {
    return { state: outcome.state, demoted: outcome.demoted, findings: outcome.findings };
  }

  /** The findings of the hunters' texts, held against the pack by code: a text that is not a finding counts as «unknown». */
  function judgeRuns(pack: EvidencePack, runs: ReadonlyArray<{ angle: (typeof HUNT_ANGLES)[number]; text: string | null; tokens: number }>): { outcome: HuntOutcome; tokens: number } {
    const findings = runs.map((run) => {
      try { return run.text ? parseFinding(extractModelJson(run.text), run.angle) : null; } catch { return null; }
    });
    return { outcome: judgeHunt(pack, findings), tokens: runs.reduce((sum, row) => sum + row.tokens, 0) };
  }

  /**
   * Evaluates the wall failure signature with Jev before spending tokens on 3 hunters.
   * If Jev in active mode is confident that the failure is purely infrastructure noise
   * (rate limit, provider outage, network reset, full disk) or duplicate fingerprint,
   * the expensive hunt is skipped. In shadow mode (the default), the decision is logged
   * to receipts while hunters run normally.
   */
  async function checkHuntFilter(pack: EvidencePack, wallKey: string): Promise<WallFilterDecision> {
    const getJev = deps.jev ?? jev;
    const instance = getJev();
    const fallback = wallFilterJudgment.fallback({ wallKey, subject: pack.subject, kind: pack.kind, facts: [], reasons: [] });
    if (!instance) return fallback;
    try {
      const settings = deps.settings ? await deps.settings().catch(() => ({} as JevSettings)) : ((await config().catch(() => ({}))) as JevSettings);
      if (!instance.enabled(settings)) return fallback;
      const reasons = [
        ...pack.attempts.map((a) => a.reason),
        ...pack.receipts.map((r) => r.reason),
      ].filter((r): r is string => Boolean(r));
      const input: WallFilterInput = {
        wallKey,
        subject: pack.subject,
        kind: pack.kind,
        facts: pack.facts,
        reasons,
        checkOutputs: pack.checkOutputs,
      };
      const verdict = await instance.judge(wallFilterJudgment, input, {
        projectId: pack.meta?.projectId ?? "",
        runId: pack.meta?.runId ?? null,
        subject: wallKey,
        settings,
      });
      return verdict.by === "jev" ? verdict.decision : fallback;
    } catch (cause) {
      log(`wall: hunt filter failed (${cause instanceof Error ? cause.message : String(cause)}); falling back to hunt`);
      return fallback;
    }
  }

  /**
   * Three read-only hunters from other sides over one pack; their citations are held against it by code. The tokens are the wall's spend.
   * In the plugin this is a run of the graph `lp.wall-hunt` (named by the wall's key); a run that fails reads as hunters that found nothing.
   */
  async function hunt(pack: EvidencePack, cfg: WallConfig, wallKey: string): Promise<{ outcome: HuntOutcome; tokens: number }> {
    const filterDecision = await checkHuntFilter(pack, wallKey);
    if (filterDecision.action === "skip") {
      log(`wall: hunt of ${wallKey} skipped by Jev filter (${filterDecision.category}): ${filterDecision.reason}`);
      const skippedOutcome: HuntOutcome = {
        state: "unknown",
        findings: [],
        usable: [],
        demoted: 0,
      };
      return { outcome: skippedOutcome, tokens: 0 };
    }
    const angles = HUNT_ANGLES.slice(0, cfg.hunters);
    if (ports.graph) {
      const ran = await ports.graph.hunt({ wallKey, pack, angles }).catch((cause: unknown) => { log(`wall: the hunt graph of ${wallKey} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      return ran ?? judgeRuns(pack, angles.map((angle) => ({ angle, text: null, tokens: 0 })));
    }
    const runs = await Promise.all(angles.map(async (angle) => {
      const run = await ports.reader!(hunterPrompt(angle, pack), "hunter").catch(() => ({ text: null, tokens: 0 } as ThreadRun));
      return { angle, text: run.text, tokens: run.tokens };
    }));
    return judgeRuns(pack, runs);
  }

  /** The code steps of the graph `lp.wall-hunt`: the hunter's prompt, the judgment of the hunters' answers (recorded in the wall row), the analysis's record. */
  const graphSteps = {
    angles: (hunters: number) => HUNT_ANGLES.slice(0, hunters) as readonly string[],
    hunterPrompt: (angle: string, pack: EvidencePack): string => hunterPrompt(angle as (typeof HUNT_ANGLES)[number], pack),
    judge(wallKey: string, pack: EvidencePack, runs: ReadonlyArray<{ angle: string; text: string | null; tokens: number }>): { outcome: HuntOutcome; tokens: number } {
      const judged = judgeRuns(pack, runs.map((run) => ({ ...run, angle: run.angle as (typeof HUNT_ANGLES)[number] })));
      // The findings are on record the moment they are judged, so a reload before the caller goes on loses nothing; the caller sets the wall's state.
      updateWall(db, wallKey, { hunt: judged.outcome.state, findings: recordHuntOutcome(judged.outcome), tokensUsed: judged.tokens }, ports.now());
      return judged;
    },
    spawnReader: (input: Parameters<NonNullable<WallPorts["spawnReader"]>>[0]): Promise<string> => {
      if (!ports.spawnReader) throw new Error("this wall has no reader threads");
      return ports.spawnReader(input);
    },
    recordAnalysis(wallKey: string, text: string): void { updateWall(db, wallKey, { analysis: { text, at: ports.now() } }, ports.now()); },
  };

  /** The full analysis: a strong reader in the wall's night budget (a graph run in the plugin). */
  async function readAnalysis(wallKey: string, prompt: string): Promise<ThreadRun> {
    if (ports.graph) return await ports.graph.analysis({ wallKey, prompt }).catch(() => null) ?? { text: null, tokens: 0 };
    return await ports.reader!(prompt, "analysis").catch(() => ({ text: null, tokens: 0 } as ThreadRun));
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
    const { outcome, tokens } = await hunt(pack, cfg, key);
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
    // The backlog item is the wall row (state backlog, `id` kept as its handle) and the owner's morning line below; no deferral is opened for it:
    // a term nobody sets would turn red by itself in a list nobody reads (Fable's recheck, E8).
    insertWall(db, { key, kind: key.startsWith("class:") ? "class" : "task", subject, projectId, state: "backlog", moves: 0, now });
    updateWall(db, key, { state: "backlog", deferralId: id }, now);
    if (extra.classKey) updateClassLadder(db, extra.classKey, { stage: "backlog" }, now);
    // The full analysis: a strong reader, the night's budget; written into the wall so a person starts from it.
    const wall = getWall(db, key)!;
    if (!wall.analysis && huntBudgetLeft(cfg, now) > 0) {
      const pack = (wall.pack as EvidencePack | null) ?? (extra.classKey ? buildClassPack(db, extra.classKey) : null);
      if (pack) {
        const history = [`wall ${key}`, ...listRepairs(db, extra.classKey ? { classKey: extra.classKey } : {}).map((row) => `round ${row.round} (${row.role}) ${row.state}: ${row.outcome ?? ""}`)];
        const run = await readAnalysis(key, analysisPrompt({ subject, pack, findings: ((wall.findings as { findings?: CheckedFinding[] } | null)?.findings) ?? [], history }));
        updateWall(db, key, { analysis: { text: run.text, at: ports.now() }, tokensUsed: (wall.tokensUsed ?? 0) + run.tokens }, ports.now());
      }
    }
    // One line on the morning list per subject that reached the backlog: what the machine did and where the analysis is. It informs; nothing waits for the owner.
    const done = getWall(db, key)!;
    const verdicts = ((done.findings as { findings?: CheckedFinding[] } | null)?.findings ?? []).filter((row) => row.verdict !== "unknown").map((row) => `${row.angle}: ${row.verdict} -> ${row.action}`);
    const ran = Boolean(done.findings);
    postOwnerItem(db, { key: `wall:${key}`, source: "wall", kind: "loop_exhausted", projectId: projectId || null, wake: false,
      what: `Машина закончила петлю: ${subject.slice(0, 240)}`,
      why: [(done.pack as EvidencePack | null)?.meta?.done, why.slice(0, 160) + ".",
        ran ? (verdicts.length ? `Охотники (три угла): ${verdicts.join("; ")}.` : "Охотники не нашли ничего, что держится на цитатах.") : "Охотники не запускались.",
        `Разбор и предложенный шаг в беклоге: ${id}, bb lane-pilot wall show ${key}. Ничего не ждёт тебя; решай, только если нужен другой объём.`].filter(Boolean).join(" ") }, now);
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
      if (wall.key.startsWith(LOOP_PREFIX)) continue;
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
      const { outcome, tokens } = await hunt(pack, cfg, wall.key);
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
      if (wall.state === "backlog") return `wall_backlog: ${input.family} failed the same way after the normal moves and the hunters' message; it is in the backlog (${wall.deferralId ?? wall.key}) with the hunters' analysis; the machine ended this loop and does not send the family again. See bb lane-pilot wall show ${wall.key}.`;
      const findings = ((wall.findings as { findings?: CheckedFinding[] } | null)?.findings ?? []).filter((row) => ["contract_wrong", "impossible_as_stated", "approach_wrong", "split_needed"].includes(row.verdict));
      if (wall.state === "hunted" && findings.length && meta.askSha === askSha(input.task, input.plan)) {
        return `wall_unchanged_ask: ${input.family} stopped after two identical failures and the hunters found the ask itself wrong (${findings.map((row) => row.verdict).join(", ")}). Dispatch it again only with a changed contract or plan (their findings were sent to you).`;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- the exhausted loop (one machine outcome for every place a loop of tries ends)
  /**
   * `loop_exhausted` (Maslov: «3 ходки; не помогло - меняется перспектива, подключаются охотники; не помогло - беклог, дальше по полной»; at the
   * ceiling: escalation, scope cut or stop). A phase stage, the replans of a failed verification and a topic of a run end here instead of
   * in the PM chat: the subject becomes ONE wall (idempotent on its id), the same three read-only hunters read it on the next pass of
   * `advance`, and a backlog item with the full analysis, the morning-list line and the register entry follow. The caller does what only it can
   * (a phase cuts its scope), says it in `done`, and a PM that must know gets one notice.
   */
  async function loopExhausted(input: LoopSubject): Promise<{ key: string; created: boolean }> {
    const key = loopWallKey(input.kind, input.id);
    if (getWall(db, key)) return { key, created: false };
    const now = ports.now();
    insertWall(db, { key, kind: "task", subject: input.title.slice(0, 300), projectId: input.projectId, state: "stopped", moves: 0, now });
    const pack = buildLoopPack(db, { subject: `${input.kind} ${input.id}`, runId: input.runId ?? null, taskIds: input.taskIds ?? [], facts: input.facts, texts: input.texts ?? [] });
    pack.meta = { loop: input.kind, subjectId: input.id, runId: input.runId ?? "", pmThreadId: input.pmThreadId ?? "", done: input.done.slice(0, 600), ...(input.topic ? { topic: input.topic } : {}) };
    updateWall(db, key, { pack }, now);
    if (input.notice && input.pmThreadId) {
      const sent = await ports.tellPm(input.pmThreadId, input.notice).catch(() => false);
      if (sent) updateWall(db, key, { messageSentAt: ports.now() }, ports.now());
    }
    log(`wall: loop ${key} exhausted (${input.kind} ${input.id}); the hunters read it on the next pass`);
    return { key, created: true };
  }

  /** The hunt, then the backlog item with the analysis, of every loop wall that waits for it. A spent hunt budget does not hold the item back: it says so. */
  async function advanceLoopWalls(cfg: WallConfig, now: number): Promise<string[]> {
    const notes: string[] = [];
    // The only thing that closes a topic's backlog item: an accepted attempt of the one new try that cites the incident (its checks went green).
    for (const wall of listWalls(db, { kind: "task", states: ["backlog"] })) {
      const runId = (wall.pack as EvidencePack | null)?.meta?.runId;
      if (!wall.key.startsWith(`${LOOP_PREFIX}topic:`) || !runId) continue;
      const accepted = db.prepare("SELECT a.id FROM lane_pilot_attempt a JOIN lane_pilot_task t ON t.id=a.task_id WHERE t.run_id=? AND a.state='accepted' AND a.updated_at>? AND instr(t.contract_json, ?)>0 LIMIT 1")
        .get(runId, wall.createdAt, wall.key) as { id: string } | undefined;
      if (!accepted) continue;
      updateWall(db, wall.key, { state: "closed", closedAt: now, closedBy: `accepted attempt ${accepted.id} of the new try that cites it` }, now);
      notes.push(`closed ${wall.key} by ${accepted.id}`);
    }
    for (const wall of listWalls(db, { kind: "task", states: ["stopped"] })) {
      const pack = wall.pack as EvidencePack | null;
      if (!wall.key.startsWith(LOOP_PREFIX) || !pack) continue;
      if (huntBudgetLeft(cfg, now) <= 0) {
        await escalateBacklog(wall.key, wall.subject, wall.projectId, "the hunt budget of the day is spent, so no hunters read it", now);
        notes.push(`${wall.key}: backlog without a hunt (budget)`);
        continue;
      }
      updateWall(db, wall.key, { state: "hunting", hunt: "running" }, now);
      const { outcome, tokens } = await hunt(pack, cfg, wall.key);
      updateWall(db, wall.key, { state: "hunted", hunt: outcome.state, findings: recordHuntOutcome(outcome), tokensUsed: tokens }, ports.now());
      await escalateBacklog(wall.key, wall.subject, wall.projectId, outcome.state === "usable" ? `${outcome.usable.length} hunter finding(s) held` : "every hunter ended unknown or without a citation that holds", now);
      notes.push(`${wall.key}: hunted (${outcome.state}), backlog`);
    }
    return notes;
  }

  /**
   * The loop walls of a run's topics: the stopper keeps a topic closed while its wall is open (hunting or in the backlog) and counts a closed
   * wall as the end of the chase. A backlog wall is closed by an accepted attempt of the one new try that cited it (the stopper's `topicHold`).
   */
  function loopTopics(runId: string): Array<{ key: string; topic: string; state: WallRow["state"]; hunt: WallRow["hunt"]; createdAt: number; updatedAt: number }> {
    return listWalls(db, { kind: "task" }).filter((wall) => wall.key.startsWith(`${LOOP_PREFIX}topic:`) && (wall.pack as EvidencePack | null)?.meta?.runId === runId)
      .map((wall) => ({ key: wall.key, topic: (wall.pack as EvidencePack).meta?.topic ?? "", state: wall.state, hunt: wall.hunt, createdAt: wall.createdAt, updatedAt: wall.updatedAt }));
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
    if (benchOk && selection.picked.length) await ports.bench.ensureArm(nightArm(ports.version)).catch(() => undefined);
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
    const files = view ? await ports.repair.changedFiles(view).catch(() => null) : null;
    // Unreadable files are asked again on the next watch pass; nothing is stored, so no decision is taken on no evidence.
    if (!files) return "hold";
    const cfg = await config();
    const benchOk = cfg.benchSubset > 0 && await ports.bench.available().catch(() => false);
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

  /** Reads the verdicts of running repairs, the release train's trace for merged ones, and moves each along. Cheap; runs every few minutes. */
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
        const used = await ports.repair.tokens(row.threadId).catch(() => null);
        if (used !== null && used !== row.tokensUsed) updateRepair(db, row.id, { tokensUsed: used }, now);
      }
      if (row.state === "running" && row.threadId) {
        const view = await ports.repair.view(row.signature);
        if (view?.verdict && !(await ports.repair.busy(row.threadId))) {
          const report = await ports.repair.report(row.threadId).catch(() => "");
          const night = parseNightReport(report);
          const prediction = parsePrediction(report);
          const prior = row.acceptance as Record<string, unknown> | null;
          // One retry when the prediction names nothing checkable: the metric must come from the list.
          if (prediction && !prediction.fixes_class && !prediction.must_not_move.length && prediction.unknown.length && !prior?.predictionRetried && row.threadId) {
            const names = PREDICTION_METRICS.join(", ");
            await ports.tellPm(row.threadId, `Your prediction names no checkable metric (${prediction.unknown.join(", ") ?? "none"}); name a metric from the list: ${names} — one retry.`).catch(() => false);
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

  const voidCache = new Map<string, boolean>();
  /** Whether the releases from `shipped` to `later` touched the repair's files or the source files of its class (see `laterReleaseTouches`). Unknown files void. */
  async function laterReleaseVoids(row: RepairRow, shipped: string, later: string): Promise<boolean> {
    const key = `${row.id}:${shipped}:${later}`;
    const known = voidCache.get(key);
    if (known !== undefined) return known;
    const laterFiles = await ports.release.changedBetween?.(shipped, later).catch(() => null) ?? null;
    const cls = classOf(row);
    const classFiles = laterFiles && cls ? (await ports.codeFiles(cls.reasonNorm.split(/<[a-z]+>/).map((part) => part.trim()).filter((part) => part.length >= 12).slice(0, 3)).catch(() => [])).map((file) => file.path) : [];
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
      updateRepair(db, row.id, { state: "rolled_back", outcome: "the plugin runs the version before the repair again: the release train rolled back", acceptance: { ...acceptance, rolledBack: true } }, now);
      failMove(row, "the train rolled back", now);
      return [`${row.id}: rolled back by the train`];
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
    const drill = await ports.release.drill().catch(() => null);
    const canary = await ports.release.canary().catch(() => null);
    const benchOk = cfg.benchSubset > 0 && !superseded && await ports.bench.available().catch(() => false);
    let bench: AcceptanceEvidence["bench"] = "unavailable";
    let benchScore: number | undefined, baselineScore: number | undefined;
    let benchCompare: { base: string; arm: string } | undefined;
    if (benchOk && canary && canary.version === evidence && !canary.windowOpen) {
      const base = nightArm(mergedAt), arm = nightArm(evidence);
      // S5: the repair is judged against the release on one base — the same set revision the baseline arm was measured on.
      // When that set is found the shipped arm runs it too; without a measured baseline the newest set is used (the compare is inconclusive).
      const setVersion = await ports.bench.armSet(base).catch(() => null);
      const state = await ports.bench.ensureArm(arm, setVersion ?? undefined).catch(() => "unavailable" as const);
      bench = state === "done" ? await ports.bench.compare(base, arm, setVersion ?? undefined).catch(() => "unavailable" as const) : state === "running" ? "pending" : "unavailable";
      if (bench === "pass" || bench === "fail") {
        benchScore = (await ports.bench.score(arm).catch(() => null)) ?? undefined;
        baselineScore = (await ports.bench.score(base).catch(() => null)) ?? undefined;
        benchCompare = { base, arm };
      }
    }
    const recurrence = recurrenceOn(row.classKey, evidence, deployedAt);
    const requireBench = (row.policy as { requireBench?: boolean } | null)?.requireBench === true;
    const sealedFlag = await kv.get("bench:sealed_gap").catch(() => null) as { gapPp?: number; thresholdPp?: number; at?: number } | null;
    const sealedGap = Boolean(sealedFlag && typeof sealedFlag.gapPp === "number" && typeof sealedFlag.thresholdPp === "number" && sealedFlag.gapPp > sealedFlag.thresholdPp
      // The flag speaks for the week it was measured in; a stale flag (older than 9 days) no longer holds new fixes.
      && sealedFlag.at !== undefined && now - sealedFlag.at < 9 * 86_400_000);
    const result = decideAcceptance({ merged: true, versionBefore: mergedAt, deployedVersion: evidence, drill, deployedAt, canary, bench, recurrence, trainRolledBack: false, requireBench, supersededBy: superseded, sealedGap, now });
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
    const rows = db.prepare(`SELECT a.state, a.reason, r.project_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.harness_version=? AND a.created_at>=? AND a.state NOT IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested','canceled')`)
      .all(version, since) as Array<{ state: string; reason: string | null; project_id: string }>;
    const projects = new Set((db.prepare("SELECT DISTINCT project_id FROM lane_pilot_wall_entry WHERE class_key=?").all(classKey) as Array<{ project_id: string }>).map((row) => row.project_id));
    const failed = (row: { state: string; reason: string | null }) => row.state !== "accepted" && wallSignature(row.state, row.reason).classKey === classKey;
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
      morning: [`${statsEpochLine(statsEpoch(db))}.`, ...composeWallMorning(db, ports.now()), watchMorningLine(db, ports.now()), ...(promotionMorningLine(db) ? [promotionMorningLine(db)!] : [])],
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

  return { graph: graphSteps, config, setConfig, runNight, advance, mergeGate, settled, started, startFailed, nextAssignment, noteTaskStop, dispatchGuard, loopExhausted, loopTopics, rerun, status, show, close,
    morning: (now?: number) => [`${statsEpochLine(statsEpoch(db))}.`, ...composeWallMorning(db, now ?? ports.now()), watchMorningLine(db, now ?? ports.now()), ...(promotionMorningLine(db) ? [promotionMorningLine(db)!] : [])], classes: () => listClasses(db), huntClass };
}

export type WallApi = ReturnType<typeof createWall>;
