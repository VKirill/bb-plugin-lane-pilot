import { bestEffort, sha256Hex } from "@lane-pilot/kit";
import { extractModelJson } from "@lane-pilot/workflow-engine";
import { jev, type JevSettings } from "@lane-pilot/jev";
import { hunterPrompt } from "../brief";
import { judgeHunt, parseFinding, buildClassPack, HUNT_ANGLES, type EvidencePack, type HuntOutcome } from "../pack";
import type { WallConfig } from "../config";
import { nightOf } from "../journal";
import { insertWall, updateWall, updateClassLadder } from "../store";
import type { WallClass } from "../types";
import { wallFilterJudgment, type WallFilterDecision, type WallFilterInput } from "../wall-filter-judgment";
import type { ThreadRun, WallPorts } from "../service";
import { classWallKey, type WallCtx } from "./context";

export function createHunt(ctx: WallCtx) {
  const { db, ports, log, deps } = ctx;
  const config = ctx.config;

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
      const settings = deps.settings ? await deps.settings() : (await config()) as JevSettings;
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

  // The pack of a hunt or an analysis is inlined while it fits the wall-hunter budget. A bigger one goes to a file
  // under .bb/ (gitignored) only when the reader's provider opens files natively — a wall-hunter thread has no file
  // tools otherwise — and the file is removed once the step that used it ends. The graph's steps get the pack
  // serialized, so the file is looked up by content hash.
  const packPathBySha = new Map<string, string>();
  const packSha = (pack: EvidencePack): string => sha256Hex(JSON.stringify(pack));
  const packPathOf = (pack: EvidencePack): string | undefined => packPathBySha.get(packSha(pack)) || undefined;
  const WALL_PACK_INLINE_CAP = 9_000;
  const packFileFor = async (pack: EvidencePack, name: string): Promise<string | undefined> => {
    const key = packSha(pack);
    if (packPathBySha.has(key)) return packPathOf(pack);
    const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 80);
    const path = await bestEffort(log, `wall pack file ${safe}`, ports.writeText?.(`.bb/wall/${safe}-${key.slice(0, 8)}.json`, JSON.stringify(pack)) ?? Promise.resolve(null), null);
    packPathBySha.set(key, path ?? "");
    return path ?? undefined;
  };
  /** The pack path a step needs, or undefined for an inline pack: over the cap, only a file-reading provider gets one. */
  const packPathFor = async (pack: EvidencePack, name: string, who: "hunter" | "analysis"): Promise<string | undefined> => {
    if (JSON.stringify(pack).length <= WALL_PACK_INLINE_CAP) return undefined;
    if (!(await bestEffort(log, `wall reader files ${who}`, ports.readerReadsFiles?.(who) ?? Promise.resolve(false), false))) return undefined;
    return packFileFor(pack, name);
  };
  /** The material file of a finished step goes away, and the next step over the same pack writes its own. */
  const dropPackFile = async (pack: EvidencePack): Promise<void> => {
    const key = packSha(pack);
    const path = packPathBySha.get(key);
    packPathBySha.delete(key);
    if (path) await bestEffort(log, `wall pack cleanup ${path}`, ports.deleteText?.(path) ?? Promise.resolve(undefined), undefined);
  };

  /**
   * Three read-only hunters from other sides over one pack; their citations are held against it by code. The tokens are the wall's spend.
   * In the plugin this is a run of the graph `lp.wall-hunt` (named by the wall's key); a run that fails reads as hunters that found nothing.
   */
  async function hunt(pack: EvidencePack, cfg: WallConfig, wallKey: string): Promise<{ outcome: HuntOutcome; tokens: number }> {
    const packPath = await packPathFor(pack, `hunt-${wallKey}`, "hunter");
    const filterDecision = await checkHuntFilter(pack, wallKey);
    if (filterDecision.action === "skip") {
      log(`wall: hunt of ${wallKey} skipped by Jev filter (${filterDecision.category}): ${filterDecision.reason}`);
      const skippedOutcome: HuntOutcome = {
        state: "unknown",
        findings: [],
        usable: [],
        demoted: 0,
      };
      await dropPackFile(pack);
      return { outcome: skippedOutcome, tokens: 0 };
    }
    const angles = HUNT_ANGLES.slice(0, cfg.hunters);
    if (ports.graph) {
      const ran = await ports.graph.hunt({ wallKey, pack, angles }).catch((cause: unknown) => { log(`wall: the hunt graph of ${wallKey} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      await dropPackFile(pack);
      return ran ?? judgeRuns(pack, angles.map((angle) => ({ angle, text: null, tokens: 0 })));
    }
    const runs = await Promise.all(angles.map(async (angle) => {
      const run = await bestEffort(log, `wall hunter ${angle} ${wallKey}`, ports.reader!(hunterPrompt(angle, pack, packPath), "hunter"), { text: null, tokens: 0 } as ThreadRun);
      return { angle, text: run.text, tokens: run.tokens };
    }));
    await dropPackFile(pack);
    return judgeRuns(pack, runs);
  }

  /** The code steps of the graph `lp.wall-hunt`: the hunter's prompt, the judgment of the hunters' answers (recorded in the wall row), the analysis's record. */
  const graphSteps = {
    angles: (hunters: number) => HUNT_ANGLES.slice(0, hunters) as readonly string[],
    hunterPrompt: (angle: string, pack: EvidencePack): string => hunterPrompt(angle as (typeof HUNT_ANGLES)[number], pack, packPathOf(pack)),
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
    if (ports.graph) return await bestEffort(log, `wall analysis graph ${wallKey}`, ports.graph.analysis({ wallKey, prompt }), null) ?? { text: null, tokens: 0 };
    return await bestEffort(log, `wall analysis ${wallKey}`, ports.reader!(prompt, "analysis"), { text: null, tokens: 0 } as ThreadRun);
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
    const files = await bestEffort(log, `wall code files ${cls.classKey}`, ports.codeFiles(cls.reasonNorm.split(/<[a-z]+>/).map((part) => part.trim()).filter((part) => part.length >= 12).slice(0, 3)), []);
    const pack = buildClassPack(db, cls.classKey, { files, facts: [`moves spent: ${cls.failedMoves}; the engineer's rounds did not end the class`] });
    const { outcome, tokens } = await hunt(pack, cfg, key);
    updateWall(db, key, { state: "hunted", hunt: outcome.state, pack, findings: recordHuntOutcome(outcome), tokensUsed: tokens }, ports.now());
    updateClassLadder(db, cls.classKey, { hunt: outcome.state, stage: outcome.state === "usable" ? "informed" : "backlog" }, ports.now());
    log(`wall: hunt of ${cls.classKey}: ${outcome.state} (${outcome.usable.length} usable of ${outcome.findings.length}, ${outcome.demoted} lowered), ${tokens} tokens`);
    return { state: outcome.state, tokens };
  }

  return { recordHuntOutcome, judgeRuns, checkHuntFilter, packPathOf, packPathFor, dropPackFile, hunt, graphSteps, readAnalysis, huntBudgetLeft, huntClass };
}
export type HuntApi = ReturnType<typeof createHunt>;
