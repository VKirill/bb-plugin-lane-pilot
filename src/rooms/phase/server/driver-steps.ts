import { phaseWordItemKey } from "./word-item";
import { cancelAttemptById } from "../../runs/server";
import { taskFamily } from "@lane-pilot/contracts";
import { countOpenDeferrals, noTermDeferralsOf } from "../../deferral/server";
import { listTaskReceipts } from "../../rollback";
import { getRunGoal, goalVerdict } from "../../run-goal";
import { countAttemptsInStates, getRun, getRunSettingsScopes, getRunWriterHost, getTask, getTaskGitBase, listOpenAttempts, loadProjectSettings } from "../../storage";
import { spendReserve } from "../../tasks";
import type { RecheckPlanFact } from "../../platform/server";
import { hostContract } from "../../contracts";
import { runOnHost } from "@lane-pilot/host-calls";
import { bookkeepingSetting } from "@lane-pilot/settings-catalog";
import { sha256Hex, bestEffort } from "@lane-pilot/kit";
import { acceptanceLines, alreadyMetVerdict, blindVerdict, brokenLink, candidateOn, canonical, executionGate, issuable, lessonsNeeded, nextAction, observationOutcome, piecesOfWave, phaseFolder, pieceSha, provenPieces, renderBook, waveCleared, waveLines, wavePackage, wavePieceLines, wavesOf, wordOf } from "../logic";
import { buildsScreens, conclusionText, designPoints, issuedContract, markRoadmap, milestoneOf, nextRoadmapRow, stateText, templateFill, threatClosureGaps, waveTable, piecePlan, uatText } from "../stages";
import { getPhase, listParts, notePoked, savePhase } from "../store";
import { checkProofs, hostGit, phaseProofRecords, renderProofCurrency } from "./proof-currency";
import { candidateBranch } from "./candidate";
import { PhaseRefusal, STAGE_RU, type DriverBase } from "./driver-tools";
import type { Docs } from "./driver-docs";
import type { Methods } from "./driver-methods";
import type { Phase, PhaseCandidate, PhaseRecord } from "../logic";
import { isNotFound, orMiss } from "@lane-pilot/kit";

/**
 * The phase's step execution: what the machine does on its own every pass — issue the plan's waves, weigh the pieces' facts,
 * verify, land the accepted package, write the closing documents, poke the PM, and close out a spent loop. It reads the phase,
 * moves it through its stages and reaches the other rooms only through `tools`.
 */
export type StepsTools = DriverBase & Docs & Methods;
export type Steps = ReturnType<typeof installSteps>;
export function installSteps(tools: StepsTools) {
  const { ctx, services, db, bb, now, reactions } = tools;
  const { mustGet, book, move, facts, readFile, readText, writeDocs, writeStateBlock, writeGenerated, commitFiles, pauseHandoff, writeBook, pmCheckoutPath, candidates } = tools;

  /** The candidate tree of a piece's base checkout, made on first need; null (and `off` with the reason, booked once) when it cannot be. */
  async function candidateTree(phase: Phase, candidate: PhaseCandidate, base: string): Promise<import("./candidate").CandidateTree | null | { wait: string }> {
    if (candidate.off) return null;
    if (candidate.trees[base]) return candidate.trees[base]!;
    const made = await candidates(phase)?.ensure(base, phase.id) ?? { off: "the phase's run has no writer host", permanent: false };
    // A passing failure holds the piece: issued into main instead, it would land before the phase's acceptance (SMA p6_merge).
    if ("off" in made && !made.permanent) return { wait: `the phase branch could not be made in ${base}: ${made.off}` };
    // The phase lands as one package or merges piece by piece, never both (SMA audit R-04: a second checkout without a branch of its own
    // switched the whole candidate off after a piece was already on it, and sent its own piece to main before the acceptance).
    if ("off" in made && Object.keys(candidate.trees).length)
      return { wait: `${base} cannot have a phase branch (${made.off}) while the phase's other pieces collect on ${candidate.branch}: the phase lands as one package — plan this piece in a checkout with a .git folder of its own, or return the phase to planning` };
    if ("off" in made) {
      candidate.off = `no phase branch in ${base}: ${made.off}`;
      book(phase, "execution", "candidate_off", `${candidate.off}; the pieces merge into main one by one`);
      return null;
    }
    candidate.trees[base] = made;
    book(phase, "execution", "candidate", `the phase's pieces merge into ${candidate.branch} (worktree ${made.path}, from ${made.startSha.slice(0, 12)}); main gets the branch after the acceptance`);
    return made;
  }

  /** How many lines a file cited by SECURITY.md has in the tree the verdict judged: the candidate's trees while the phase's package is
   *  not landed, the PM's checkout otherwise. A number; or null when no tree could be read (not the same as «the file is not there»,
   *  which is 0 lines: every line cited in it is then past its end). */
  async function judgedTreeLines(phase: Phase, path: string): Promise<number | null> {
    const run = phase.runId ? getRun(db, phase.runId) : null;
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    const roots = candidateOn(phase.record) && !phase.record.candidate!.landedAt ? Object.values(phase.record.candidate!.trees).map((tree) => tree.path) : run?.writer_workspace_path ? [run.writer_workspace_path] : [];
    if (!hostId || !roots.length) return null;
    const host = bb.hosts.experimental_client({ contract: hostContract });
    let unreachable = false;
    for (const root of roots) {
      try {
        const file = await host.call("readBoundedFile", { requestedHostId: hostId, projectCwd: root, relativePath: path, offset: 0, maxLines: 1 }, { hostId, timeoutMs: 15_000 }) as { totalLines?: unknown };
        if (typeof file.totalLines === "number") return file.totalLines;
        unreachable = true;
      } catch (cause) {
        // Not there in this tree (or not a file inside it): try the next tree. Anything else (a host that did not answer) is «not reached».
        if (!/ENOENT|ENOTDIR|escaped_workspace|regular_file|must_be_directory|symlink/i.test(cause instanceof Error ? cause.message : String(cause))) unreachable = true;
      }
    }
    return unreachable ? null : 0;
  }

  /** The candidate's own goal check: the accepted pieces' checks on its trees' heads (the run's goal check reads main). */
  async function candidateGoal(phase: Phase): Promise<PhaseCandidate["goal"] | null> {
    const candidate = phase.record.candidate!;
    if (!phase.runId) return null;
    const trees = Object.values(candidate.trees);
    const result = await bestEffort(ctx.log, "phase regression run", services.regression.run({ projectId: phase.projectId, runId: phase.runId, force: true, mode: "full", basePaths: trees.map((tree) => tree.path) }), null);
    const pass = result?.projects[0];
    if (!pass) return null;
    const ids = Object.values(phase.record.execution?.issued ?? {});
    const verdict = goalVerdict(pass, ids);
    const headSha = await candidates(phase)?.head(trees[0]!.path) ?? null;
    return { runId: phase.runId, projectId: phase.projectId, state: verdict.state, tasks: ids.length, headSha, red: verdict.red, detail: verdict.detail, at: now() };
  }

  async function candidateHeads(phase: Phase): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const kit = candidates(phase);
    for (const [base, tree] of Object.entries(phase.record.candidate?.trees ?? {})) { const sha = await kit?.head(tree.path); if (sha) out[base] = sha; }
    return out;
  }

  /**
   * SMA p6_merge: the accepted package lands, each tree at the commit the verdict saw. A tree that moved is not that package (verified
   * again, p6_stale); one that does not merge with main fails the verdict with its files, so the machine plans the fix.
   */
  async function landCandidate(phase: Phase): Promise<"landed" | "held"> {
    const candidate: PhaseCandidate = { ...phase.record.candidate!, landed: { ...(phase.record.candidate!.landed ?? {}) } };
    const kit = candidates(phase);
    if (!kit) return "held";
    const settings = phase.runId ? loadProjectSettings(db, phase.projectId, getRunSettingsScopes(db, phase.runId)) : {};
    for (const [base, tree] of Object.entries(candidate.trees)) {
      if (base in candidate.landed!) continue;
      const verified = candidate.verified?.[base];
      const out = verified ? await kit.land(base, tree, verified, `phase ${phase.id}: land ${candidate.branch} «${phase.title}» (accepted ${verified.slice(0, 12)})`, bookkeepingSetting(settings), [`${phaseFolder(phase.id)}/**`])
        : { state: "moved" as const, why: "the verdict recorded no head for this tree" };
      if (out.state === "landed") {
        candidate.landed![base] = out.commit;
        book(phase, "acceptance", "landed", `${candidate.branch} at ${verified!.slice(0, 12)} landed on main in ${base}${out.commit ? ` (merge ${out.commit.slice(0, 12)})` : ""}${out.records ? `; main had moved by Lane Pilot's own records only (${out.records.paths.slice(0, 5).join(", ")}): the verified tree is unchanged outside them, landed at ${out.records.head.slice(0, 12)}` : ""}`);
        savePhase(db, phase.id, { record: { ...mustGet(phase.id).record, candidate }, at: now() });
        continue;
      }
      if (out.state === "wait") {
        if (!listParts(db, phase.id).some((part) => part.kind === "landing_wait" && part.text === out.why)) book(phase, "acceptance", "landing_wait", out.why);
        return "held";
      }
      const record: PhaseRecord = { ...mustGet(phase.id).record, candidate: { ...candidate, verified: undefined, goal: undefined }, acceptance: undefined,
        verification: out.state === "conflict" ? { verdict: { state: "failed", detail: `the candidate ${candidate.branch} does not merge with main: ${out.why}`, mainSha: verified ?? null, at: now(), inputSha: sha256Hex(out.why) } } : undefined };
      if (out.state === "conflict") book(phase, "verification", "blind_verdict", `failed: ${out.why} (input ${sha256Hex(out.why).slice(0, 12)})`);
      move(mustGet(phase.id), "verification", record, out.state === "conflict" ? `the landing found a conflict: ${out.why}` : `not the verified package: ${out.why}`);
      return "held";
    }
    for (const [base, tree] of Object.entries(candidate.trees)) await kit.drop(base, tree);
    savePhase(db, phase.id, { record: { ...mustGet(phase.id).record, candidate: { ...candidate, landedAt: now() } }, at: now() });
    return "landed";
  }

  async function issue(phase: Phase): Promise<Phase> {
    const items = phase.record.plan?.items ?? [];
    // A planner's piece may leave out what the machine knows itself: the folder (the PM's checkout) and the objective (the piece's own
    // promise). Without them task-v2 refused every piece and the PM had to return the phase to planning (live ph_86fd9d3fab, 2026-10-27).
    let checkout: string | null | undefined;
    const execution = { issued: { ...(phase.record.execution?.issued ?? {}) }, startedAt: phase.record.execution?.startedAt ?? now(), issueErrors: {} as Record<string, string>,
      issuedSha: { ...(phase.record.execution?.issuedSha ?? {}) } };
    // A piece issued before the contract prints existed: its print is the contract it really went out with (the stored task), compared
    // on what proves the work — acceptance and verification. Taking the plan's current contract instead missed a change the PM made
    // before the first pass of this version (live ph_ae0a8de9db: the reworded acceptance line was never issued).
    for (const item of items) {
      const taskId = execution.issued[item.id];
      if (!taskId || execution.issuedSha[item.id] !== undefined) continue;
      const sent = getTask(db, taskId)?.contract as Record<string, unknown> | undefined;
      const same = !sent || (canonical(sent.acceptance ?? null) === canonical(item.task.acceptance ?? null) && canonical(sent.verification ?? null) === canonical(item.task.verification ?? null));
      execution.issuedSha[item.id] = same ? pieceSha(item) : `issued-with:${taskId}`;
    }
    if (phase.record.plan?.sha !== phase.record.plan?.admittedSha) throw new PhaseRefusal("the plan changed since it was checked: return the phase to planning");
    let runId = phase.runId;
    // Awaits the word «issue»: with owner.words on nothing is issued before the owner says so.
    if (phase.record.ownerWords) {
      const issueYes = wordOf(phase.record, "issue");
      if (issueYes?.decision !== "yes") return phase;
      // The yes signs the plan and the drawing the owner saw (sma as_launchable): re-read now, a change asks anew.
      const stale: string[] = [];
      let filesChanged = false;
      if (issueYes.key && issueYes.key !== phase.record.plan?.sha) stale.push("the plan changed since the owner's yes");
      const designYes = wordOf(phase.record, "design");
      const drawing = phase.record.design?.drawing;
      if (designYes?.decision === "yes" && drawing?.paths.length) {
        // The files are re-read: an edit outside drawing() makes the recorded drawing stale, and a yes on an older
        // drawing signs nothing the owner sees now. A read that fails for another reason than a missing file is
        // unknown, not a change: this pass issues nothing and the next one reads again.
        const hashes: string[] = [];
        for (const path of drawing.paths.slice(0, 30)) {
          const file = await readFile(phase, path).catch((cause: unknown) => /ENOENT|no such file|not found/i.test(cause instanceof Error ? cause.message : String(cause)) ? null : "unknown" as const);
          if (file === "unknown") { ctx.log(`phase ${phase.id}: the drawing file ${path} could not be read; issue waits for the next pass`); return phase; }
          hashes.push(`${path}:${file?.sha256 ?? "missing"}`);
        }
        const currentSha = sha256Hex(hashes.join("\n"));
        if (currentSha !== drawing.sha256) filesChanged = true;
        else if (designYes.key && designYes.key !== drawing.sha256) stale.push("the drawing changed since the owner's yes");
      }
      if (filesChanged) {
        // No word can sign files nobody recorded: the way out is the PM's — back to design, the drawing recorded again,
        // and the design word asked for it. Said once.
        const why = "the drawing's files changed since it was recorded";
        if (!listParts(db, phase.id).some((part) => part.kind === "stale_consent" && part.text.startsWith(why))) {
          book(phase, "execution", "stale_consent", `${why} — nothing issues until the drawing is recorded again`);
          await bestEffort(ctx.log, "phase stale drawing notice", bb.sdk.threads.send({ threadId: phase.pmThreadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
            `[Lane Pilot phase] Phase ${phase.id} «${phase.title}» issues nothing: its drawing files were edited after the drawing was recorded. Return the phase to design (lane_pilot_phase {action:"return", phaseId:"${phase.id}", to:"design", note}), record the drawing again and get the design word for it.` }] } as never), undefined);
        }
        return phase;
      }
      if (stale.length) {
        const why = stale.join("; ");
        // The changed thing is asked again under its own turn: a new yes re-keys it.
        const turn = stale.some((line) => line.startsWith("the drawing")) ? "design" : "issue";
        if (!listParts(db, phase.id).some((part) => part.kind === "stale_consent" && part.text.startsWith(why))) {
          book(phase, "execution", "stale_consent", `${why} — the owner is asked again`);
          reactions.postOwnerItem({ key: phaseWordItemKey(phase.id, turn), source: "phase", kind: "word", projectId: phase.projectId,
            what: turn === "design" ? "После вашего «да» чертёж перерисован — запуск ждёт нового слова" : "После вашего «да» изменился план — запуск ждёт нового слова", why: why.slice(0, 600) });
          void reactions.askPhaseWord(phase, turn, undefined, `${why}: confirm again`);
        }
        return phase;
      }
    }
    const next = issuable(items, execution.issued, facts(phase), (wave) => waveCleared(phase.record, wave), execution.issuedSha);
    // Batch issue capacity and a free seat in the house: at most issueCap pieces a pass, none while the run already has that many at work.
    const atWork = phase.runId ? listOpenAttempts(db).filter((row) => row.run_id === phase.runId).length : 0;
    // Path with or without subagents: off, the pieces go one at a time, inline.
    const seats = Math.max(0, (phase.record.subagents === false ? 1 : phase.record.issueCap ?? 8) - atWork);
    // Wave budget question: the wave's appetites must fit the run's budget reserve, or the PM is asked first.
    const waveTokens = next.reduce((sum, item) => sum + Number((item.task.appetite as { tokens?: number } | undefined)?.tokens ?? 0), 0);
    const budget = phase.runId ? services.runBudgets.get(phase.runId)?.snapshot() : undefined;
    if (waveTokens && budget?.limits.maxTokens) {
      const reserve = spendReserve({ budgetTokens: budget.limits.maxTokens, spentTokens: budget.tokens, openAppetites: [], appetite: waveTokens });
      if (!reserve.ok) { execution.issueErrors.budget = `wave budget question: ${reserve.why}`; savePhase(db, phase.id, { record: { ...phase.record, execution }, at: now() }); return mustGet(phase.id); }
    }
    // The phase candidate is made at the first issue; a phase that issued pieces into main under an older version goes on that way.
    const candidate: PhaseCandidate = phase.record.candidate ? { ...phase.record.candidate, trees: { ...phase.record.candidate.trees } }
      : Object.keys(execution.issued).length ? { branch: candidateBranch(phase.id), trees: {}, off: "the phase issued pieces into main before the phase branch existed" }
      : { branch: candidateBranch(phase.id), trees: {} };
    for (const item of next.slice(0, seats)) {
      const base = typeof item.task.project_cwd === "string" && item.task.project_cwd ? item.task.project_cwd : (checkout ??= await pmCheckoutPath(phase));
      const made = base ? await candidateTree(phase, candidate, base) : null;
      if (made && "wait" in made) { execution.issueErrors[item.id] = made.wait.slice(0, 300); continue; }
      const tree = made;
      // A check named by an absolute folder in the base runs in the same folder of the tree.
      const verification = tree && Array.isArray(item.task.verification) ? (item.task.verification as Array<Record<string, unknown>>).map((check) =>
        typeof check.cwd === "string" && (check.cwd === base || check.cwd.startsWith(`${base}/`)) ? { ...check, cwd: `${tree.path}${check.cwd.slice(base!.length)}` } : check) : undefined;
      // A piece issued before with another contract goes again as a redo of its family (id.N), so its facts follow the new work.
      const redoOf = execution.issued[item.id];
      const issuedTask = issuedContract(phase, item);
      const taskIdForIssue = redoOf ? tools.redoId(item.id, runId) : item.id;
      const reply: Record<string, unknown> = await services.dispatchWriter({ threadId: phase.pmThreadId, projectId: phase.projectId, birth: "phase",
        // Stage above ordinary work: a phase's piece with no priority of its own waits in the stage band, one above the
        // loudest backlog word (SMA pc_priority); a priority the plan set is kept.
        // quality_mode full: the piece goes through every review stage, so its acceptance lines read verdicts, not their absence (SMA p6_l_verdict).
        task: { ...issuedTask.task, id: taskIdForIssue, quality_mode: "full", ...(typeof item.task.priority === "string" && item.task.priority ? { priority: item.task.priority } : {}), ...(phase.record.design?.drawing && buildsScreens(item) ? { drawing: phase.record.design.drawing.paths } : {}),
          ...(tree ? { project_cwd: tree.path, ...(verification ? { verification } : {}) } : typeof item.task.project_cwd === "string" && item.task.project_cwd ? {} : { project_cwd: base ?? undefined }),
          ...(typeof item.task.objective === "string" && item.task.objective.trim() ? {} : { objective: `${item.title}: given ${item.promise.given}, when ${item.promise.when}, then ${item.promise.then}` }) } as never,
        // A redo after a return to execution carries the return's note (SMA px_return_exec): the writer sees why it runs again.
        plan: piecePlan(phase, item) + (redoOf && phase.record.execution?.returnNote ? `\nReturned to execution: ${phase.record.execution.returnNote}` : ""),
        objective: phase.goal }).catch((cause: unknown) => ({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }));
      const taskId = typeof reply.taskId === "string" ? reply.taskId : null;
      if (taskId) {
        execution.issued[item.id] = taskId;
        if (issuedTask.dropped) book(phase, "execution", "qa_dropped", issuedTask.dropped);
        execution.issuedSha[item.id] = pieceSha(item);
        if (redoOf) book(phase, "execution", "reissued", `${item.id}: its contract changed since ${redoOf} — issued again as ${taskId}`);
        if (typeof reply.runId === "string") runId = reply.runId;
        book(phase, "execution", "issued", `${item.id} → task ${taskId} (wave ${item.wave})`);
      } else {
        execution.issueErrors[item.id] = String(reply.reason ?? reply.error ?? "dispatch refused").slice(0, 300);
      }
    }
    // The wave table into the journal: written once per wave, when its first pieces are issued.
    for (const wave of [...new Set(next.map((item) => item.wave))]) {
      if (!next.some((item) => item.wave === wave && execution.issued[item.id])) continue;
      if (listParts(db, phase.id).some((part) => part.kind === "wave_table" && part.text.startsWith(`wave ${wave}:`))) continue;
      book(phase, "execution", "wave_table", waveTable(wave, piecesOfWave(items, wave), execution.issued));
      // SMA k_wp_state: with phase.doc_files on, the wave's mark in STATE.md (the header keys; a person's text stays) — only where
      // planning files already live, like the close's marks.
      if (phase.record.docFiles === true)
        await bestEffort(ctx.log, "phase wave state mark", writeStateBlock(phase, { phase: phase.record.roadmapRow ?? phase.id, stage: "execution", planned: "true", wave: String(wave) }, {}, `phase ${phase.id}: STATE.md, wave ${wave} issued`), null);
    }
    // Phase base at start: the commit the first piece was cut from.
    const firstTask = Object.values(execution.issued)[0];
    const baseSha = phase.record.execution?.baseSha ?? (firstTask ? getTaskGitBase(db, firstTask)?.base_sha ?? null : null);
    // The waves' records stay (they were dropped here before), and a new issue clears the «nothing changed» stop.
    savePhase(db, phase.id, { record: { ...phase.record, candidate, execution: { ...execution, baseSha, acceptedNoted: phase.record.execution?.acceptedNoted ?? [], ...(phase.record.execution?.waves ? { waves: phase.record.execution.waves } : {}),
      ...(phase.record.execution?.unchanged && !next.some((item) => execution.issued[item.id])) ? { unchanged: phase.record.execution.unchanged } : {} } }, runId, at: now() });
    return mustGet(phase.id);
  }

  /**
   * An accepted piece whose plan-fact failed under older rules of the check is weighed again by the current ones, once (recheckPlanFact):
   * a passing receipt changes the wave's package, and the wave is weighed again on the same pass.
   */
  async function recheckStale(phase: Phase): Promise<void> {
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    if (!phase.runId || !hostId) return;
    for (const [pieceId, fact] of facts(phase)) {
      if (fact.state !== "accepted" || fact.planFact !== "failed" || !fact.taskId) continue;
      const state = await services.recheckPlanFact({ projectId: phase.projectId, runId: phase.runId, taskId: fact.taskId, hostId })
        .catch((cause: unknown) => { ctx.log(`phase ${phase.id}: plan-fact of ${fact.taskId} not weighed again: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (state) book(phase, "execution", "plan_fact_recheck", `${pieceId} (task ${fact.taskId}): plan-fact weighed again by the current rules of the check: ${state}`);
    }
  }

  /** One step of a phase. Reconciling after force: every tick reads the pieces' facts afresh, so a phase paused, stopped or edited by hand
   * continues from what the attempts and receipts say now, not from what it last believed. */
  async function drive(phase: Phase): Promise<Phase> {
    // A stop whose writers' stops were not all observed: ask again; the phase does nothing else until it is stopped.
    if (phase.record.stopping && phase.state !== "stopped" && phase.state !== "closed") return (await tools.stop({ phaseId: phase.id })).phase;
    // A force-interrupt whose writers' stops were not all observed: ask again; the phase turns paused only when none is open (SMA px_force).
    if (phase.record.interrupting && phase.state !== "stopped" && phase.state !== "closed") return (await tools.interrupt({ phaseId: phase.id })).phase;
    if (phase.state === "pause_requested") {
      savePhase(db, phase.id, { state: "paused", at: now() });
      await pauseHandoff(mustGet(phase.id)).catch((cause: unknown) => ctx.log(`phase ${phase.id}: pause handoff not written: ${cause instanceof Error ? cause.message : String(cause)}`));
      return mustGet(phase.id);
    }
    if (phase.state !== "active") return phase;
    let current = phase;
    if (current.stage === "execution") {
      current = await issue(current);
      await recheckStale(current);
      const items = current.record.plan?.items ?? [];
      // Plan result onto the phase: each newly accepted piece is one part of the book.
      const f = facts(current);
      const noted = new Set(current.record.execution?.acceptedNoted ?? []);
      const fresh = items.filter((item) => f.get(item.id)?.state === "accepted" && !noted.has(item.id));
      if (fresh.length) {
        for (const item of fresh) book(current, "execution", "accepted", `${item.id} (task ${f.get(item.id)?.taskId}) accepted: ${item.promise.then}`);
        savePhase(db, current.id, { record: { ...current.record, execution: { ...current.record.execution!, acceptedNoted: [...noted, ...fresh.map((item) => item.id)] } }, at: now() });
        current = mustGet(current.id);
      }
      // Verify ready waves: a wave whose pieces are all in gets its package and its lines, once, written to the book.
      const waves = { ...(current.record.execution?.waves ?? {}) };
      let wrote = false;
      for (const wave of wavesOf(items)) {
        const pieces = piecesOfWave(items, wave);
        if (!pieces.every((item) => current.record.execution?.issued[item.id] && f.get(item.id)?.state === "accepted")) continue;
        // A wave whose pieces got new facts (a redo) is weighed again; the same package is not (its review stays).
        if (waves[String(wave)]?.packageSha === wavePackage(pieces, f)) continue;
        const lines = waveLines(pieces, f, current.record.execution?.issuedSha, current.record.liveCheck === true);
        waves[String(wave)] = { packageSha: wavePackage(pieces, f), lines, pieces: wavePieceLines(pieces, f, current.record.execution?.issuedSha, current.record.liveCheck === true), at: now() };
        book(current, "execution", "wave_in", `wave ${wave} in, package ${waves[String(wave)]!.packageSha.slice(0, 12)}: ${lines.map((line) => `${line.ok ? "✓" : "✗"} ${line.id}`).join(", ")}`);
        wrote = true;
      }
      if (wrote) { savePhase(db, current.id, { record: { ...current.record, execution: { ...current.record.execution!, waves } }, at: now() }); current = mustGet(current.id); }
      // Every wave is verified by another model before the phase leaves execution, the last one too (Matvey: «волну проверяет другая
      // модель»); the machine's review of the last wave had no pass to start in before the phase moved on.
      // Only the waves of the plan in force: a wave the replan dropped (the planner then found the goal already met, live ph_d74a94d3b8
      // 2026-11-11) stayed in the record unreviewed, and the phase sat in execution with nothing to issue and nothing said.
      const planWaves = new Set(wavesOf(items).map(String));
      const unreviewed = current.record.waveReview ? Object.entries(current.record.execution?.waves ?? {}).filter(([wave, done]) => planWaves.has(wave) && done.review?.state !== "passed").map(([wave]) => wave) : [];
      if (executionGate(items, current.record.execution?.issued ?? {}, facts(current)).ok && !unreviewed.length) {
        // Nothing changed since a verdict failed on these very facts: verifying again would fail the same way, and its poke is the
        // one the PM was already given — the phase stalled silently (live ph_ae0a8de9db). It waits for new work instead.
        const goal = candidateOn(current.record) ? current.record.candidate!.goal ?? null : current.runId ? getRunGoal(db, current.runId) : null;
        const would = blindVerdict(items, facts(current), goal as never, now());
        const lastFailed = listParts(db, current.id).filter((part) => part.kind === "blind_verdict" && part.text.startsWith("failed")).at(-1);
        if (would.state === "failed" && lastFailed?.text.includes(`(input ${would.inputSha.slice(0, 12)})`)) {
          if (current.record.execution?.unchanged?.inputSha !== would.inputSha) {
            book(current, "execution", "unchanged", `every piece accepted, but the facts are the ones the last verdict failed on: ${would.detail}`);
            savePhase(db, current.id, { record: { ...current.record, execution: { ...current.record.execution!, unchanged: { inputSha: would.inputSha, detail: would.detail } } }, at: now() });
          }
        } else move(current, "verification", current.record, "every piece is issued and accepted");
      }
      current = mustGet(current.id);
    }
    // A plan that found the goal already met built nothing: its verdict is the claim itself, and the goal audit weighs it next.
    if (current.stage === "verification" && !current.record.verification?.verdict && current.record.plan?.alreadyMet) {
      const verdict = alreadyMetVerdict(current.record.plan.alreadyMet, now());
      book(current, "verification", "blind_verdict", `${verdict.state}: ${verdict.detail} (input ${verdict.inputSha.slice(0, 12)})`);
      savePhase(db, current.id, { record: { ...current.record, verification: { ...current.record.verification, verdict } }, at: now() });
      current = mustGet(current.id);
    }
    if (current.stage === "verification" && !current.record.verification?.verdict && current.runId) {
      // SMA k_wv_design: only where the phase was opened with phase.design_points on, the drawing contract's checklist items are read
      // from UI-SPEC.md here and stored; the goal audit judges each, and acceptanceLines holds a line per point. Any other phase
      // reads nothing and stores nothing.
      const specPath = current.record.designPoints === true ? current.record.design?.drawing?.paths.find((path) => /UI-SPEC\.md$/i.test(path)) : undefined;
      if (specPath && !current.record.verification?.points) {
        const text = await readText(current, specPath);
        const found = text ? designPoints(text) : { points: [], total: 0 };
        if (found.points.length) {
          savePhase(db, current.id, { record: { ...current.record, verification: { ...current.record.verification, points: found.points } }, at: now() });
          book(current, "verification", "design_points", `${found.points.length} contract point(s) of ${specPath} become acceptance lines${found.total > found.points.length ? `; the list was cut: ${found.total} checklist items, the first ${found.points.length} are kept` : ""}`);
          current = mustGet(current.id);
        }
      }
      // With a candidate the verdict reads its trees (p6_prepared): their goal check and their heads, the package the acceptance decides on.
      const onCandidate = candidateOn(current.record);
      if (onCandidate && !current.record.candidate!.goal) {
        const goal = await candidateGoal(current);
        if (goal) { savePhase(db, current.id, { record: { ...current.record, candidate: { ...current.record.candidate!, goal } }, at: now() }); current = mustGet(current.id); }
      }
      const runId = current.runId!;
      const goal = onCandidate ? current.record.candidate!.goal ?? null : getRunGoal(db, runId) ?? await bestEffort(ctx.log, "phase goal check", services.runGoal.check(runId), null);
      if (goal) {
        // SMA p5_design: the verdict checks against exactly the confirmed drawing. Its hash is recomputed now; a drawing
        // changed after confirmation fails the verdict, and the confirmed hash and contract path freeze into its input.
        const drawing = current.record.design?.drawing;
        let bound: { sha256: string; contract?: string | null; changed?: string | null } | undefined;
        if (drawing?.paths.length) {
          const contract = drawing.paths.find((path) => /(UI-SPEC|DESIGN)\.md$/i.test(path)) ?? null;
          const actual = await tools.drawingSha(current, drawing.paths).catch((cause: unknown) => `unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
          bound = actual.startsWith("unreadable: ")
            ? { sha256: drawing.sha256, contract, changed: `its files cannot be read now (${actual.slice(0, 200)})` }
            : { sha256: actual, contract, changed: actual === drawing.sha256 ? null : `confirmed ${drawing.sha256.slice(0, 12)}, now ${actual.slice(0, 12)}` };
        }
        let verdict = blindVerdict(current.record.plan?.items ?? [], facts(current), goal as never, now(), bound);
        // The goal check is still running: nothing is frozen, the next pass asks again.
        if (verdict.state === "pending") return current;
        // SMA k_pl_security: where the project switched threat closure on (phase.threat_closure, copied to the record at open) and a
        // security risk was named, a pass is refused while a SECURITY.md threat row lacks a mitigation citing a real file:line. The
        // cited files are read in the tree the verdict judged (the candidate's, when the phase has one), the whole file, not a 2000-line window;
        // a file or line the reader could not reach is «not checked» and said so, never a gap.
        if (verdict.state === "passed" && current.record.threatClosure === true) {
          const risk = current.record.context?.risks?.security?.trim();
          const secPath = (current.record.context?.docs ?? []).find((doc) => /SECURITY\.md$/i.test(doc.path))?.path;
          if (risk && !/^(none|нет|no)\b/i.test(risk) && secPath) {
            const security = await readText(current, secPath);
            if (security) {
              const lines: Record<string, number | null> = {};
              for (const cite of security.matchAll(/([^\s`"'()]+\.[a-z0-9]+):(\d{1,6})\b/gi)) if (!(cite[1]! in lines)) lines[cite[1]!] = await judgedTreeLines(current, cite[1]!);
              const closure = threatClosureGaps(security, (path, line) => { const total = lines[path]; return total === undefined || total === null ? null : total >= line; });
              if (closure.gaps.length) verdict = { ...verdict, state: "failed", detail: `threats not closed: ${closure.gaps.join("; ")}${closure.unchecked.length ? `; not checked: ${closure.unchecked.join("; ")}` : ""}`.slice(0, 1000) };
              else if (closure.unchecked.length) verdict = { ...verdict, detail: `${verdict.detail}; threat citations not checked (the file could not be reached): ${closure.unchecked.join("; ")}`.slice(0, 1000) };
            }
          }
        }
        book(current, "verification", "blind_verdict", `${verdict.state}: ${verdict.detail} (input ${verdict.inputSha.slice(0, 12)})`);
        const verified = onCandidate ? await candidateHeads(current) : undefined;
        savePhase(db, current.id, { record: { ...current.record, ...(verified ? { candidate: { ...current.record.candidate!, verified } } : {}), verification: { ...current.record.verification, verdict } }, at: now() });
        current = mustGet(current.id);
        // SMA k_t_template: with phase.doc_files on, the verdict is stored as VERIFICATION.md — each piece's checks with its latest result.
        if (current.record.docFiles === true) {
          await bestEffort(ctx.log, "phase verification doc", writeGenerated(current, `${phaseFolder(current.id)}/VERIFICATION.md`, templateFill("VERIFICATION", current, facts(current)), `phase ${current.id}: VERIFICATION.md`), null);
          current = mustGet(current.id);
        }
      }
    }
    if (current.stage === "verification" && current.record.verification?.verdict?.state === "passed" && current.record.verification.model) {
      if (current.record.verification.model.state === "met") move(current, "acceptance", current.record, "the blind verdict passed and the goal audit says met");
      else {
        const record = { ...current.record, verification: { verdict: { ...current.record.verification.verdict, state: "failed" as const, detail: `goal audit: ${current.record.verification.model.summary}` } } };
        savePhase(db, current.id, { record, at: now() });
      }
      current = mustGet(current.id);
    }
    // The UAT session opens only once the candidate's heads are frozen (SMA p5_uat_stage): the owner tests the verified package.
    // Its lines live in the record, numbered from 1 (SMA p5_uat_line); the document lands on main only after the phase itself
    // is in main (SMA p5_record_after) — before that the answers are the record's, not a file's.
    if (current.stage === "acceptance" && current.record.ownerWords && !current.record.uat && (!candidateOn(current.record) || !!current.record.candidate?.verified)) {
      const path = `${phaseFolder(current.id)}/UAT.md`;
      const lines = (current.record.plan?.items ?? []).map((item, index) => ({ n: index + 1, pieceId: item.id, state: "open" as const }));
      const record: PhaseRecord = { ...current.record, uat: { path, sha256: "", at: now(), lines } };
      savePhase(db, current.id, { record, at: now() });
      current = mustGet(current.id);
    }
    if (current.stage === "acceptance" && current.record.uat && !current.record.uat.sha256 && (!candidateOn(current.record) || !!current.record.candidate?.landedAt)) {
      const path = current.record.uat.path;
      const content = uatText(current);
      const out = await bestEffort(ctx.log, "phase UAT doc", writeDocs(current, [{ path, content }], `phase ${current.id}: UAT.md for the owner`), { written: [] as string[], commit: null, shas: {} as Record<string, string> });
      if (out.written.includes(path)) {
        book(current, "acceptance", "uat_written", `${path}: ${(current.record.uat.lines ?? []).length} line(s) for the owner`);
        savePhase(db, current.id, { record: { ...mustGet(current.id).record, uat: { ...mustGet(current.id).record.uat!, sha256: sha256Hex(content) } }, at: now() });
        current = mustGet(current.id);
      }
    }
    if (current.stage === "acceptance") {
      // Book closed before «accepted» (SMA ta_book_close): BOOK.md is written up to the last part and re-read before the lines.
      await writeBook(current);
      current = mustGet(current.id);
      const partsNow = listParts(db, current.id);
      const bookBack = current.runId ? await readFile(current, `${phaseFolder(current.id)}/BOOK.md`).then((file) => file.sha256, () => null) : null;
      const onCandidate = candidateOn(current.record);
      const lastGoal = current.runId ? getRunGoal(db, current.runId) : null;
      const firstTree = onCandidate ? Object.values(current.record.candidate!.trees)[0]! : null;
      const headNow = firstTree ? await candidates(current)?.head(firstTree.path) ?? null : lastGoal?.headSha ?? null;
      const openDeferrals = countOpenDeferrals(db, current.projectId);
      const lines = acceptanceLines(current, facts(current), { mainSha: headNow, openDeferrals, noTerm: noTermDeferralsOf(db, current.projectId), bookBroken: brokenLink(partsNow), book: { lastSeq: partsNow.at(-1)?.seq ?? null, readSha: bookBack } });
      // Main moved — a new word: the verdict saw another main; verify again on the main that is there now.
      if (lines.find((line) => line.id === "main_unmoved")?.ok === false) {
        // A candidate's goal check and heads belong to that verdict: the new one checks the trees again (SMA audit of C-03).
        const record: PhaseRecord = { ...current.record, verification: undefined, acceptance: undefined,
          ...(current.record.candidate ? { candidate: { ...current.record.candidate, goal: undefined, verified: undefined } } : {}) };
        move(current, "verification", record, "main moved since the verdict: verified again");
        return mustGet(current.id);
      }
      const accepted = lines.every((line) => line.ok);
      const before = JSON.stringify(current.record.acceptance?.lines ?? []);
      const record: PhaseRecord = { ...current.record, acceptance: { lines, at: now(), accepted } };
      if (JSON.stringify(lines) !== before) book(current, "acceptance", accepted ? "accepted" : "held", lines.map((line) => `${line.ok ? "✓" : "✗"} ${line.id}: ${line.detail}`).join("; "));
      // p6_authorized → p6_merge: the accepted package lands on main first; a landing that holds keeps the phase at acceptance.
      if (accepted && onCandidate && !current.record.candidate!.landedAt) {
        savePhase(db, current.id, { record, at: now() });
        if (await landCandidate(mustGet(current.id)) !== "landed") return mustGet(current.id);
        Object.assign(record, { candidate: mustGet(current.id).record.candidate });
      }
      if (accepted) {
        const returns = listParts(db, current.id).filter((part) => part.kind === "return").length;
        const failedAttempts = current.runId ? countAttemptsInStates(db, current.runId, ["validation_failed","blocked","provider_error","timeout","empty_output"]) : 0;
        const verdictFailures = listParts(db, current.id).filter((part) => part.kind === "blind_verdict" && part.text.startsWith("failed")).length;
        record.lessons = lessonsNeeded({ returns, failedAttempts, verdictFailures });
        move(current, record.lessons.needed ? "lessons" : "closed", record, "every acceptance line holds");
        // State «closed» comes only after finishClosed writes the closing documents and reads them back intact (SMA ta_closed).
        if (!record.lessons.needed) book(current, "lessons", "none", record.lessons.why);
      } else savePhase(db, current.id, { record, at: now() });
      current = mustGet(current.id);
    }
    return current;
  }

  /**
   * A closed phase finishes its paperwork once (SMA: The daemon writes the conclusion, Phase closed in the roadmap, Marks in STATE and roadmap,
   * Phase or milestone branch, transition / autonomous): SUMMARY.md, the roadmap row's [x], STATE's phase and stage, all committed; the marker
   * branch phase/<id> when phase.branch is on; and with phase.autonomous on, the next open roadmap row is opened as the next phase.
   */
  async function finishClosed(phase: Phase): Promise<Phase> {
    if (phase.stage !== "closed" || phase.record.closedDocs) return phase;
    // Work file closed (SMA ta_closed): the book is written and read back — only then «closed». A failed write or a
    // read-back mismatch keeps the phase unclosed and pokes the PM.
    await writeBook(phase);
    phase = mustGet(phase.id);
    const summaryPath = `${phaseFolder(phase.id)}/SUMMARY.md`;
    const files: Array<{ path: string; content: string }> = [{ path: summaryPath, content: conclusionText(phase, listParts(db, phase.id), facts(phase)) }];
    const roadmap = await readText(phase, ".agents/planning/ROADMAP.md");
    if (roadmap !== null && phase.record.roadmapRow) {
      const marked = markRoadmap(roadmap, phase.record.roadmapRow);
      if (marked !== roadmap) files.push({ path: ".agents/planning/ROADMAP.md", content: marked });
    }
    const stateNow = await readText(phase, ".agents/planning/STATE.md");
    if (stateNow !== null || roadmap !== null) files.push({ path: ".agents/planning/STATE.md", content: stateText(stateNow, { phase: phase.record.roadmapRow ?? phase.id, stage: "closed", last_phase: phase.id }) });
    const out = await writeDocs(phase, files, `phase ${phase.id}: closed — summary, roadmap and state`).catch((cause: unknown) => { ctx.log(`phase ${phase.id}: closing documents not written: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
    if (!out) return phase;
    // A run that has no writer workspace or host has nowhere to write: its book lives on the hub only, like a phase without a run.
    if (phase.runId && getRun(db, phase.runId)?.writer_workspace_path && getRunWriterHost(db, phase.runId)) {
      const bookPath = `${phaseFolder(phase.id)}/BOOK.md`;
      // SUMMARY.md is compared with the text sent: a pass that finds the file already as it should be writes nothing and returns no hash.
      const expected: Array<[string, string | null]> = [[summaryPath, out.shas[summaryPath] ?? sha256Hex(files[0]!.content)], [bookPath, mustGet(phase.id).record.bookWritten?.sha256 ?? null]];
      const missed: string[] = [];
      for (const [path, sha] of expected) {
        const back = sha ? await readFile(phase, path).then((file) => file.sha256 === sha, () => false) : false;
        if (!back) missed.push(path);
      }
      if (missed.length) {
        // Said once a day: the pass retries every tick, and a book part and a PM message per tick would bury both.
        const lastSaid = [...listParts(db, phase.id)].reverse().find((part) => part.kind === "closing_docs_unconfirmed")?.at ?? 0;
        if (now() - lastSaid < 24 * 3_600_000) return mustGet(phase.id);
        book(phase, "lessons", "closing_docs_unconfirmed", `closing docs not confirmed: ${missed.join(", ")} did not read back as written`);
        await bestEffort(ctx.log, "phase closing docs notice", bb.sdk.threads.send({ threadId: phase.pmThreadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
          `[Lane Pilot phase] Phase ${phase.id} «${phase.title}» could not be closed: its closing documents did not read back intact (SUMMARY.md / BOOK.md). Check the writer workspace; the next pass tries again.` }] } as never), undefined);
        return mustGet(phase.id);
      }
    }
    book(phase, "lessons", "concluded", `SUMMARY.md written${out.written.length > 1 ? `, ${out.written.slice(1).join(", ")} marked` : ""}${out.commit ? ` (commit ${out.commit.slice(0, 12)})` : ""}`);
    if ((phase.record.branch === "phase" || phase.record.branch === "milestone") && phase.runId) {
      const run = getRun(db, phase.runId);
      const hostId = getRunWriterHost(db, phase.runId);
      if (run?.writer_workspace_path && hostId) {
        // SMA k_we_branch: the marker branch is phase/<id>, or milestone/<slug> of the roadmap section the phase's row sits under.
        const stateMilestone = /^milestone:\s*"?([^"\n]+)"?/m.exec(stateNow?.split("\n---\n")[0] ?? "")?.[1]?.trim();
        const slug = phase.record.branch === "milestone"
          ? (phase.record.roadmapRow && roadmap !== null ? milestoneOf(roadmap, phase.record.roadmapRow) : null) ?? (stateMilestone ? stateMilestone.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "") : null) ?? phase.id
          : null;
        const name = phase.record.branch === "phase" ? `phase/${phase.id}` : `milestone/${slug}`;
        const host = bb.hosts.experimental_client({ contract: hostContract });
        const made = await bestEffort(ctx.log, "phase marker branch", runOnHost(host, { hostId, cwd: run.writer_workspace_path, command: `git branch -f ${name} HEAD`, timeoutSec: 30 }), null);
        book(phase, "decisions", "branch", made && made.exitCode === 0 ? `marker branch ${name} at the accepted main` : "the marker branch could not be made");
      }
    }
    savePhase(db, phase.id, { record: { ...phase.record, closedDocs: { at: now(), commit: out.commit } }, state: "closed", at: now() });
    const next = roadmap !== null ? nextRoadmapRow(phase.record.roadmapRow ? markRoadmap(roadmap, phase.record.roadmapRow) : roadmap) : null;
    if (next && phase.record.autonomous) {
      // Autonomous mode: the next roadmap row becomes the next phase, and its discussion starts at once.
      const opened = await tools.open({ projectId: phase.projectId, pmThreadId: phase.pmThreadId, title: next.name, goal: next.goal || next.name, roadmapRow: next.n });
      book(phase, "decisions", "transition", `autonomous: the next phase ${opened.id} «${next.name}» (roadmap ${next.n}) is open`);
    } else if (next) {
      await bestEffort(ctx.log, "phase next-roadmap notice", bb.sdk.threads.send({ threadId: phase.pmThreadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
        `[Lane Pilot phase] Phase ${phase.id} «${phase.title}» is closed. Next on the roadmap: ${next.n} «${next.name}»${next.goal ? ` — ${next.goal}` : ""}. Open it with lane_pilot_phase {action:"open", title, goal, roadmapRow:"${next.n}"} when it is time.` }] } as never), undefined);
    }
    return mustGet(phase.id);  }

  /** Sends the PM the one instruction the phase needs now, once per instruction key. */
  async function poke(phase: Phase & { pokedKey?: string | null }): Promise<void> {
    const action = nextAction(phase, facts(phase), await tools.planningHome(phase));
    // Call about a waiting decision: a turn that needs the owner's word is also a row on «Ждут владельца» (and its Telegram digest).
    const wordTurn = action.key.match(/:word:([a-z]+)(?::(\d+))?(?::(?:v[\w-]+|[0-9a-f]+))?$/);
    if (wordTurn) reactions.postOwnerItem({ key: phaseWordItemKey(phase.id, wordTurn[1]!, wordTurn[2]), source: "phase", kind: "word", projectId: phase.projectId,
      what: `Этап «${phase.title}» ждёт вашего слова: ${STAGE_RU[wordTurn[1]!] ?? wordTurn[1]}${wordTurn[2] ? ` (заход ${wordTurn[2]})` : ""}`, why: action.text.slice(0, 600) });
    // The lead's journal: the same question, with the prediction written before the owner's word (src/rooms/lead).
    if (wordTurn) void reactions.askPhaseWord(phase, wordTurn[1]!, wordTurn[2] ? Number(wordTurn[2]) : undefined, action.text);
    // Aging said once a day; a stalled phase named in the book only: no part for three days (or twelve hours at execution with pieces at work). The PM is not
    // woken with it: it already got the step once (pokedKey), and a daily repeat to an idle chat rewrote its whole context for nothing
    // (live ph_26f65b142d, 2026-10-27..29: three wake-ups for a step the PM had declined).
    const parts = listParts(db, phase.id);
    // SMA dt_aging: the age is derived fresh every pass from real movement — the driver's own aging note is not movement, and
    // the once-a-day throttle is read from that note's time, so nothing stored on the record can skew the signal.
    const lastPart = [...parts].reverse().find((part) => part.kind !== "aging")?.at ?? phase.createdAt;
    const quiet = now() - lastPart;
    const stalled = phase.stage === "execution" ? quiet > 12 * 3_600_000 : quiet > 72 * 3_600_000;
    const lastAging = [...parts].reverse().find((part) => part.kind === "aging")?.at ?? 0;
    if (stalled && phase.state !== "closed" && now() - lastAging > 86_400_000) {
      const days = Math.round(quiet / 86_400_000 * 10) / 10;
      book(phase, "decisions", "aging", `no movement for ${days} day(s) at ${phase.stage}`);
    }
    const last = getPhase(db, phase.id)?.pokedKey ?? null;
    if (!action.waitsForPm || action.key === last) return;
    // A busy PM is not queued a step: by the time it is delivered the phase may have moved (live ph_9ed0f7f04b, 2026-10-24: the
    // discussion's step arrived after the phase was closed). The next pass, two minutes on, pokes it once it is idle.
    const thread = await orMiss(bb.sdk.threads.get({ threadId: phase.pmThreadId }), null, isNotFound) as { status?: unknown } | null;
    if (thread?.status !== "idle") return;
    await bestEffort(ctx.log, "phase poke notice", bb.sdk.threads.send({ threadId: phase.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text: `[Lane Pilot phase] ${action.text}`, mentions: [] }] } as never), undefined);
    notePoked(db, phase.id, action.key, now());
  }

  /** What git says of each proof the run recorded with a commit (accepted merges, the verdicts): still about the code, or stale; for the goal audit. */
  async function proofCurrency(phase: Phase): Promise<string | null> {
    if (!phase.runId) return null;
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return null;
    const records = phaseProofRecords(db, phase, getRunGoal(db, phase.runId));
    if (!records.length) return null;
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const tree = candidateOn(phase.record) && !phase.record.candidate!.landedAt ? Object.values(phase.record.candidate!.trees)[0]!.path : run.writer_workspace_path!;
    const git = hostGit((command) => runOnHost(host, { hostId, cwd: tree, command, timeoutSec: 60 }));
    return renderProofCurrency(await checkProofs(records, git)) || null;
  }

  /**
   * The machine's one outcome when a loop of tries is spent (`loop_exhausted`, src/rooms/wall; Maslov: «at the ceiling: escalation, scope cut
   * or stop»). The phase always STOPS, partial: the pieces that are proved stay accepted (their work is merged), the pieces that are not are
   * withdrawn with their reasons (scope_withdrawn), and the acceptance lines that do not hold are listed as the unmet obligations. `closed`
   * as a successful end is the normal acceptance path alone (acceptanceLines, the same predicate): a spent budget proves nothing. Then the
   * wall takes the subject: three read-only hunters, the backlog item with the analysis and the next step, one line on the owner's morning
   * list. Nothing is handed back to the PM.
   */
  async function exhaust(phase0: Phase, input: { kind: "stage" | "replan"; stage: string; why: string }): Promise<void> {
    const phase = mustGet(phase0.id);
    const plan = phase.record.plan;
    const issued = phase.record.execution?.issued ?? {};
    const f = facts(phase);
    const { proven, unproven } = provenPieces(plan?.items ?? [], f, phase.record.waveReview ? phase.record.execution?.waves ?? {} : undefined);
    const canceled: string[] = [];
    for (const { item } of unproven) {
      const family = issued[item.id] ? taskFamily(issued[item.id]!) : null;
      if (!family) continue;
      for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && taskFamily(row.task_id) === family)) {
        if ((await cancelAttemptById(ctx, attempt.id, services.rollback, `canceled: phase ${phase.id} stopped, its try loop was spent (${input.why})`, "stuck")).ok) canceled.push(attempt.task_id);
      }
    }
    const verdict = phase.record.verification?.model?.state === "unmet" ? `the goal audit: ${phase.record.verification.model.summary}` : phase.record.verification?.verdict?.state === "failed" ? `the verification: ${phase.record.verification.verdict.detail}` : "";
    // The obligations the acceptance does not hold: the same lines the normal path reads (the owner's decisions are not a machine obligation).
    const lastGoal = phase.runId ? getRunGoal(db, phase.runId) : null;
    const openDeferrals = countOpenDeferrals(db, phase.projectId);
    const noTerm = noTermDeferralsOf(db, phase.projectId);
    const partsExhaust = listParts(db, phase.id);
    const unmet = acceptanceLines(phase, f, { mainSha: lastGoal?.headSha ?? null, openDeferrals, noTerm, bookBroken: brokenLink(partsExhaust), book: { lastSeq: partsExhaust.at(-1)?.seq ?? null, readSha: phase.record.bookWritten?.sha256 ?? null } })
      .filter((line) => !line.ok && line.id !== "result_useful" && (line.id !== "limits_acknowledged" || noTerm.length > 0)).map((line) => `${line.id}: ${line.detail}`.slice(0, 300));
    const cut = unproven.length ? `${unproven.map(({ item }) => item.id).join(", ")} withdrawn (${unproven.map(({ why }) => why).join(" | ").slice(0, 600)})` : "no piece to withdraw";
    const outcome = proven.length ? `the phase stops, partial: ${candidateOn(phase.record) && !phase.record.candidate!.landedAt ? `nothing lands on main (a stopped phase is not accepted); ` : ""}its ${proven.length} proved piece(s) stay accepted${candidateOn(phase.record) && !phase.record.candidate!.landedAt ? ` on branch ${phase.record.candidate!.branch}` : ""} (${proven.map((item) => item.id).join(", ")}), the goal is not met` : "no piece is proved, so the phase stops (empty scope)";
    const done = `${input.stage} ran out of tries (${input.why.slice(0, 300)}). Scope cut: ${cut}${canceled.length ? `; canceled: ${canceled.join(", ")}` : ""}${verdict ? `; not proved: ${verdict.slice(0, 500)}` : ""}${unmet.length ? `; unmet: ${unmet.join(" | ").slice(0, 700)}` : ""}; ${outcome}.`;
    book(phase, "decisions", "scope_withdrawn", `${unproven.length ? unproven.map(({ item }) => item.id).join(", ") : "nothing"} withdrawn by Lane Pilot (loop exhausted at ${input.stage}): ${done}`.slice(0, 1800));
    const scope = { revisions: phase.record.scope?.revisions ?? 0, withdrawn: [...(phase.record.scope?.withdrawn ?? []), ...unproven.map(({ item }) => item.id)] };
    const partial = { at: now(), kept: proven.map((item) => item.id), unproven: unproven.map(({ item, why }) => ({ id: item.id, why: why.slice(0, 300) })), unmet };
    book(phase, "decisions", proven.length ? "exhausted_partial" : "exhausted_stop", outcome);
    // A stopped unlanded phase keeps nothing: the candidate's trees go now, not at the next janitor pass (WT2 A2).
    if (candidateOn(phase.record) && !phase.record.candidate!.landedAt) { const kit = candidates(phase); if (kit) for (const [base, tree] of Object.entries(phase.record.candidate!.trees)) await bestEffort(ctx.log, "phase candidate drop", kit.drop(base, tree), undefined); }
    savePhase(db, phase.id, { state: "stopped", at: now(), record: { ...phase.record, scope, auto: undefined, partial, closing: { by: "Lane Pilot (loop exhausted)", words: done.slice(0, 1000), at: now() },
      lessons: { needed: true, why: "the loop ran out of tries; the phase stopped without its goal met, the analysis of the cut is in the backlog" } } });
    await services.wall?.loopExhausted({
      kind: input.kind, id: `${phase.id}:${input.stage}`, title: `этап «${phase.title}»: ${STAGE_RU[input.stage] ?? input.stage} не сошлось за отведённые попытки`, projectId: phase.projectId, runId: phase.runId,
      taskIds: Object.values(issued), facts: [`goal: ${phase.goal}`, `why the loop ended: ${input.why}`, `what the machine did: ${done}`, ...(verdict ? [verdict] : [])],
      texts: [{ path: "PHASE-BOOK", text: renderBook(mustGet(phase.id), listParts(db, phase.id)).slice(-18_000) }],
      done, pmThreadId: phase.pmThreadId,
      // No notice to the PM chat: an informational message wakes an idle chat for nothing; the book and the owner's morning list carry it.
    });
  }

  /**
   * The seven-day rollback watch (SMA p6_observe): a phase closed within the window has its history read for rollbacks of its
   * pieces — Lane Pilot revert receipts and «This reverts commit» on main — and the observation is recorded on the phase and
   * in the book. The acceptance and the state are never touched.
   */
  async function observe(phase: Phase & { closedAt?: number | null }): Promise<void> {
    const closedAt = phase.closedAt ?? phase.updatedAt;
    const record = mustGet(phase.id).record;
    const issued = record.execution?.issued ?? {};
    const reverted: string[] = [];
    const merges = new Set<string>();
    for (const [pieceId, taskId] of Object.entries(issued)) {
      for (const receipt of listTaskReceipts(db, taskId)) if (receipt.changeSha) merges.add(receipt.changeSha);
      const receipt = listTaskReceipts(db, taskId, "revert").find((row) => row.state === "merged");
      if (receipt) reverted.push(`${pieceId} (task ${taskId}, reverted in ${receipt.resultCommit?.slice(0, 12) ?? "main"})`);
    }
    let logText: string | null = null;
    const run = phase.runId ? getRun(db, phase.runId) : null;
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    if (run?.writer_workspace_path && hostId && merges.size) {
      const host = bb.hosts.experimental_client({ contract: hostContract });
      const out = await bestEffort(ctx.log, "phase rollback watch", runOnHost(host, { hostId, cwd: run.writer_workspace_path, command: `git log --format=%B --grep="This reverts commit" -n 400`, timeoutSec: 60 }), null);
      if (out && out.exitCode === 0) logText = out.stdout;
    }
    if (logText) for (const sha of merges) if (logText.includes(`This reverts commit ${sha}`)) reverted.push(`${sha.slice(0, 12)} (revert commit on main)`);
    // Nothing to read: no merge commits of the phase's work exist to look for in history.
    const found = { reverted, readable: merges.size > 0 || logText !== null };
    const outcome = observationOutcome(closedAt, now(), found);
    if (JSON.stringify(record.observation) === JSON.stringify(outcome)) return;
    savePhase(db, phase.id, { record: { ...record, observation: outcome }, at: now() });
    book(phase, "acceptance", "observation", `rollback watch: ${outcome.outcome}${outcome.reverted.length ? ` — ${outcome.reverted.join(", ")}` : ""} (watched until ${new Date(outcome.until).toISOString().slice(0, 10)}); the acceptance is unchanged`);
  }

  return { issue, candidateTree, candidateGoal, candidateHeads, landCandidate, recheckStale, drive, finishClosed, poke, proofCurrency, exhaust, observe };
}
