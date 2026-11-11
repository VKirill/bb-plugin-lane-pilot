import { bestEffort } from "@lane-pilot/kit";
import type { LoopSubject } from "../../contracts";
import { acceptedAttemptCiting, acceptedFamilyAttemptId } from "../../storage";
import { taskWallMessage } from "../brief";
import { buildTaskPack, buildLoopPack, type CheckedFinding, type EvidencePack } from "../pack";
import { getWall, insertWall, updateWall, listWalls, type WallRow } from "../store";
import { wallSignature } from "../signature";
import type { WallConfig } from "../config";
import { askSha, taskWallKey, loopWallKey, LOOP_PREFIX, type WallCtx } from "./context";
import type { HuntApi } from "./hunt";
import type { EscalateBacklog } from "./backlog";

export function createTaskWalls(ctx: WallCtx, hunting: HuntApi, escalateBacklog: EscalateBacklog) {
  const { db, ports, log } = ctx;
  const { hunt, recordHuntOutcome, huntBudgetLeft } = hunting;

  /**
   * Called when a task family was stopped by `repeated_failure:` (two attempts failing the same way = the two normal moves). First sight opens
   * the wall (the hunt follows); the same wall stopped again after the hunters' message means the informed move failed too: the backlog.
   */
  async function noteTaskStop(input: { projectId: string; runId: string; taskId: string; family: string; reason: string; state: string; failureCode?: string | null; pmThreadId: string | null; task: unknown; plan: string }): Promise<{ key: string; step: string }> {
    const now = ports.now();
    const sig = wallSignature(input.state, input.reason, input.failureCode);
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
      const acceptedId = family && pack?.meta?.runId ? acceptedFamilyAttemptId(db as never, pack.meta.runId, family, wall.createdAt) : null;
      const accepted = acceptedId ? { id: acceptedId } : undefined;
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
      const sent = pm ? await bestEffort(log, `wall pm notice ${pm}`, ports.tellPm(pm, text), false) : false;
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
      const sent = await bestEffort(log, `wall loop notice ${input.pmThreadId}`, ports.tellPm(input.pmThreadId, input.notice), false);
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
      const acceptedId = acceptedAttemptCiting(db as never, runId, wall.createdAt, wall.key);
      if (!acceptedId) continue;
      updateWall(db, wall.key, { state: "closed", closedAt: now, closedBy: `accepted attempt ${acceptedId} of the new try that cites it` }, now);
      notes.push(`closed ${wall.key} by ${acceptedId}`);
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

  return { noteTaskStop, advanceTaskWalls, dispatchGuard, loopExhausted, advanceLoopWalls, loopTopics };
}
export type TaskWallsApi = ReturnType<typeof createTaskWalls>;
