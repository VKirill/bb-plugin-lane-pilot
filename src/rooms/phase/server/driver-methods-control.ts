import { taskFamily } from "@lane-pilot/contracts";
import { listOpenAttempts } from "../../storage";
import { cancelAttemptById } from "../../runs/server";
import { sendServiceMessage } from "../../relay/server";
import { PHASE_STAGES, RETURN_STAGES, executionGate, planSignature, staleAfterReturn, withdrawProblem } from "../logic";
import { listParts, notePoked, savePhase } from "../store";
import { phaseWordItemPrefix } from "./word-item";
import { PhaseRefusal } from "./driver-tools";
import type { MethodsTools } from "./driver-methods";
import type { Phase, PhaseRecord, PhaseStage } from "../logic";

type Reported = { phaseId: string; by?: string };
export type WithdrawInput = Reported & { pieces: string[]; note: string };
export type ReviseInput = Reported & { goal: string; note: string };
export type CorrectInput = Reported & { note: string; pieces?: string[] };
export type ReturnToInput = Reported & { to: PhaseStage; note: string };
export type SetStateInput = Reported & { state: "pause" | "resume" | "stop" | "close"; words?: string };
export type StopInput = Reported & { words?: string };
export type StopWaveInput = Reported;
export type CancelPieceInput = Reported & { piece: string; note?: string };
export type DecideInput = Reported & { piece: string; choice: "skip" | "retry" | "cancel"; note?: string };
export type InterruptInput = Reported & { words?: string };

/** The phase's course corrections and stops: scope withdrawal and revision, a live correction, returns, the state switch,
 *  stopping the work and the wave, per-piece cancel and decide, and the force-interrupt. */
export function installControlMethods(tools: MethodsTools) {
  const { ctx, services, db, bb, now, reactions } = tools;
  const { mustGet, book, facts } = tools;

  /** Scope withdrawal agreed: pieces not yet issued leave the plan with a note; the plan is admitted again as it now is. */
  function withdraw(input: WithdrawInput): Phase & { notice: string } {
    const phase = mustGet(input.phaseId);
    // Refused before anything changes: a closed or early phase, an unknown piece id and an issued piece leave the plan, the words and the admitted print as they were.
    const problem = withdrawProblem(phase, input.pieces);
    if (problem) {
      const issued = phase.record.execution?.issued ?? {};
      throw new PhaseRefusal(problem, input.pieces.filter((id) => issued[id]).map((id) => `${id} is issued: lane_pilot_cancel_task, then withdraw`));
    }
    const plan = phase.record.plan!;
    const items = plan.items.filter((item) => !input.pieces.includes(item.id));
    if (!items.length) throw new PhaseRefusal("withdrawing every piece closes the phase: use close with the words why");
    const sha = planSignature(items, plan.contextSha);
    // A trimmed scope revokes the earlier permission to issue (SMA bi_revise): the new scope asks for a new «issue» word.
    const revoked = (phase.record.words ?? []).some((word) => word.turn === "issue" || word.turn === "wave");
    const record: PhaseRecord = { ...phase.record, plan: { ...plan, items, sha, ...(plan.admittedSha ? { admittedSha: sha } : {}) }, scope: { revisions: phase.record.scope?.revisions ?? 0, withdrawn: [...(phase.record.scope?.withdrawn ?? []), ...input.pieces] },
      ...(revoked ? { words: (phase.record.words ?? []).filter((word) => word.turn !== "issue" && word.turn !== "wave") } : {}) };
    book(phase, "decisions", "scope_withdrawn", `${input.pieces.join(", ")} withdrawn by ${input.by ?? "pm"}: ${input.note}${revoked ? "; issue permission revoked" : ""}`);
    savePhase(db, phase.id, { record, at: now() });
    // What the owner does next: the permission to issue was tied to the old scope, so the trimmed plan waits for a new «issue» word.
    const notice = `${input.pieces.join(", ")}: убрано из плана, план принят заново. ${revoked ? "Прежнее разрешение «выдать» отозвано: чтобы работа пошла дальше, дайте новое слово «выдать»." : "Когда будете готовы, дайте слово «выдать»: разрешение относится к новому плану."}`;
    return { ...mustGet(phase.id), notice };
  }

  /** Phase scope revision: the goal changes in discussion or planning; the plan built on the old goal is checked again. */
  function revise(input: ReviseInput): Phase {
    const phase = mustGet(input.phaseId);
    if (!["discussion", "planning"].includes(phase.stage)) throw new PhaseRefusal("the goal is revised in discussion or planning: return the phase there first");
    db.prepare("UPDATE lane_pilot_phase SET goal=? WHERE id=?").run(input.goal.slice(0, 4000), phase.id);
    const record = staleAfterReturn("planning", phase.record);
    record.scope = { revisions: (phase.record.scope?.revisions ?? 0) + 1, withdrawn: phase.record.scope?.withdrawn ?? [] };
    book(phase, "goal", "revised", `${input.goal} — ${input.note}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  /** Correct a live stage: the note goes to the writers of the pieces at work as their next turn (the same thread continues). */
  async function correct(input: CorrectInput): Promise<{ phase: Phase; sent: string[] }> {
    const phase = mustGet(input.phaseId);
    const issued = phase.record.execution?.issued ?? {};
    const wanted = new Set((input.pieces?.length ? input.pieces : Object.keys(issued)).map((id) => taskFamily(issued[id] ?? id)));
    const sent: string[] = [];
    for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && wanted.has(taskFamily(row.task_id)) && row.state === "running" && row.thread_id)) {
      await bb.sdk.threads.send({ threadId: attempt.thread_id!, mode: "queue-if-active", input: [{ type: "text", text: `[Lane Pilot phase ${phase.id}] Correction from the PM: ${input.note}`, mentions: [] }] } as never).then(() => sent.push(attempt.task_id), () => undefined);
    }
    book(phase, "execution", "correction", `${input.note} → ${sent.join(", ") || "no writer at work"}`);
    return { phase: mustGet(phase.id), sent };
  }

  function returnTo(input: ReturnToInput): Phase {
    // The question of the turn being left is obsolete: its row goes (the new turn posts its own; Gemini F-006.1 remainder).
    reactions.closeOwnerItemsByPrefix(phaseWordItemPrefix(input.phaseId), "janitor:phase returned");
    const phase = mustGet(input.phaseId);
    // No replanning of a closed phase (SMA k_wp_closed): new work is a new phase, never an edit of the old one.
    if (phase.stage === "closed" || phase.state === "closed") throw new PhaseRefusal(`phase ${phase.id} is closed: open a new phase for new work`);
    if (!RETURN_STAGES.includes(input.to)) throw new PhaseRefusal(`a phase returns to ${RETURN_STAGES.join(", ")}`);
    if (PHASE_STAGES.indexOf(input.to) >= PHASE_STAGES.indexOf(phase.stage)) throw new PhaseRefusal(`a return goes to an earlier stage: the phase is at ${phase.stage}`);
    if (!input.note.trim()) throw new PhaseRefusal("a return carries a note: what changed and why");
    // Only a prepared phase returns to execution (SMA px_return_exec): acceptance holds a frozen verdict of the package; before
    // it there is nothing prepared to send back. Without this the owner's «no» met the same verdict on the same work.
    if (input.to === "execution" && (phase.stage !== "acceptance" || !phase.record.verification?.verdict))
      throw new PhaseRefusal("a return to execution is allowed only from acceptance, on a frozen verdict — the preparation (verdict, candidate heads, acceptance) is withdrawn and execution queues one attempt higher");
    const record = staleAfterReturn(input.to, phase.record);
    // The return's note rides into each redo's plan (the writer sees why the work runs again).
    if (input.to === "execution" && record.execution) record.execution = { ...record.execution, returnNote: input.note.slice(0, 1000) };
    book(phase, "decisions", "return", `${phase.stage} → ${input.to} by ${input.by ?? "pm"}: ${input.note}`);
    savePhase(db, phase.id, { stage: input.to, record, state: phase.state, at: now() });
    return mustGet(phase.id);
  }

  function setState(input: SetStateInput): Phase {
    const phase = mustGet(input.phaseId);
    // A closed phase is never resumed or paused: new work is a new phase (SMA k_wp_closed).
    if ((input.state === "pause" || input.state === "resume") && (phase.stage === "closed" || phase.state === "closed"))
      throw new PhaseRefusal(`phase ${phase.id} is closed: open a new phase for new work`);
    const next = input.state === "pause" ? "paused" : input.state === "resume" ? "active" : input.state === "stop" ? "stopped" : "closed";
    if (input.state === "close" && !input.words?.trim()) throw new PhaseRefusal("closing in words carries the words: why the phase ends here");
    // The machine chose the road (SMA: the machinist cannot drive where there are no rails): a phase the rails opened ends by its gates
    // or by the owner's word, not because the PM finds the request small (live ph_9ed0f7f04b, 2026-10-24, closed at discussion).
    // Work that is all in is not that: every planned piece accepted, the PM closes with its words (live ph_26f65b142d: the work shipped, the
    // phase stood on a stale verdict, and the PM told the owner only his word could end it).
    const allIn = (phase.record.plan?.items ?? []).length > 0 && executionGate(phase.record.plan!.items, phase.record.execution?.issued ?? {}, facts(phase)).ok;
    if (input.state === "close" && phase.record.rails && (input.by ?? "pm") === "pm" && !allIn && !["acceptance", "lessons", "closed"].includes(phase.stage))
      throw new PhaseRefusal(`phase ${phase.id} was opened by the rails for the owner's heavy request: it ends by its gates or by the owner's word, not by the PM. If the work is in fact small, plan it as one or two pieces — the stages pass quickly then.`);
    const record: PhaseRecord = input.state === "close" ? { ...phase.record, closing: { by: input.by ?? "pm", words: input.words!, at: now() } } : phase.record;
    book(phase, "decisions", input.state, `${input.by ?? "pm"}${input.words ? `: ${input.words}` : ""}`);
    savePhase(db, phase.id, { state: next, record, ...(input.state === "close" ? { stage: "closed" as const } : {}), at: now() });
    const after = mustGet(phase.id);
    // Pausing leaves a handoff (SMA k_c_pause): HANDOFF.json for the machine, PAUSE.md for the person, best effort.
    if (input.state === "pause") void tools.pauseHandoff(after).catch((cause: unknown) => ctx.log(`phase ${phase.id}: pause handoff not written: ${cause instanceof Error ? cause.message : String(cause)}`));
    return after;
  }

  /**
   * Stop (SMA px_stop): the phase's work is stopped first, then the phase. Every open attempt of its pieces is canceled (the writer
   * stopped and its stop observed, cancelAttemptById) and its stage workflow ended; a writer whose stop was not observed is named in
   * the book and in the answer, never counted as stopped. Before 2026-10-29 the stop only wrote the state: a running piece went on.
   * The phase turns stopped only once every stop is observed (SMA audit N-01: a failed stop published a stopped phase over a live
   * writer); until then it keeps `stopping`, issues nothing, and each pass asks for the open stops again.
   */
  /** Cancels every open attempt of the phase's pieces (stop()'s loop, shared with the force-interrupt): each canceled task is
   *  named, each stop not yet observed comes back unconfirmed, never counted as stopped. */
  async function cancelPhaseWork(phase: Phase, reason: string): Promise<{ canceled: string[]; unconfirmed: string[]; canceledPieces: string[] }> {
    const families = new Set(Object.values(phase.record.execution?.issued ?? {}).map(taskFamily));
    const canceled: string[] = [];
    const unconfirmed: string[] = [];
    const canceledPieces = new Set<string>();
    for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && families.has(taskFamily(row.task_id)))) {
      const result = await cancelAttemptById(ctx, attempt.id, services.rollback, reason, "superseded")
        .catch((cause: unknown) => ({ ok: false, state: "error", reason: cause instanceof Error ? cause.message : String(cause) }));
      if (result.ok) { canceled.push(attempt.task_id); canceledPieces.add(taskFamily(attempt.task_id)); }
      else unconfirmed.push(`${attempt.task_id} (${result.reason ?? result.state})`);
    }
    return { canceled, unconfirmed, canceledPieces: [...canceledPieces] };
  }

  async function stop(input: StopInput): Promise<{ phase: Phase; canceled: string[]; unconfirmed: string[] }> {
    const phase = mustGet(input.phaseId);
    const { canceled, unconfirmed } = await cancelPhaseWork(phase, `canceled: phase ${phase.id} stopped by ${input.by ?? "pm"}${input.words ? `: ${input.words}` : ""}`);
    const auto = phase.record.auto;
    if (auto) {
      // cancel answers false for a finished or unknown run (nothing to end); a throw is no answer: the run may go on, the phase keeps it
      // and asks again (SMA audit R-01: the reference was dropped and the phase stopped over a live stage workflow).
      let ended = true;
      try { services.workflowEngine.cancel(auto.wfRunId, `phase ${phase.id} stopped`); }
      catch (cause) { ended = false; unconfirmed.push(`stage workflow ${auto.wfRunId} (${cause instanceof Error ? cause.message : String(cause)})`); }
      if (ended) savePhase(db, phase.id, { record: { ...mustGet(phase.id).record, auto: undefined }, at: now() });
    }
    const asked = phase.record.stopping;
    const line = [canceled.length ? `canceled: ${canceled.join(", ")}` : "no piece at work",
      ...(auto && !unconfirmed.some((line) => line.startsWith(`stage workflow ${auto.wfRunId}`)) ? [`stage workflow ${auto.wfRunId} ended`] : []), ...(unconfirmed.length ? [`stop not observed yet: ${unconfirmed.join(", ")}`] : [])].join("; ");
    if (!asked || canceled.length || line !== listParts(db, phase.id).filter((part) => part.kind === "work_stopped").at(-1)?.text) book(phase, "execution", "work_stopped", line);
    const by = asked?.by ?? input.by ?? "pm";
    const words = asked?.words ?? input.words;
    if (unconfirmed.length) {
      savePhase(db, phase.id, { record: { ...mustGet(phase.id).record, stopping: { by, ...(words ? { words } : {}), at: asked?.at ?? now(), unconfirmed } }, at: now() });
      return { phase: mustGet(phase.id), canceled, unconfirmed };
    }
    if (asked) savePhase(db, phase.id, { record: { ...mustGet(phase.id).record, stopping: undefined }, at: now() });
    return { phase: setState({ ...input, by, ...(words ? { words } : {}), state: "stop" }), canceled, unconfirmed };
  }

  /**
   * Stops the current wave: the pieces issued but not started are canceled, and each running writer is told after its current
   * turn (SMA dt_park_waves: queue-if-active, so it does not keep building a stopped wave).
   */
  async function stopWave(input: StopWaveInput): Promise<{ phase: Phase; canceled: string[] }> {
    const phase = mustGet(input.phaseId);
    const issued = new Set(Object.values(phase.record.execution?.issued ?? {}).map(taskFamily));
    const canceled: string[] = [];
    for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && issued.has(taskFamily(row.task_id)) && row.state === "queued")) {
      const result = await cancelAttemptById(ctx, attempt.id, services.rollback, `canceled: phase ${phase.id} stopped the queued wave`, "superseded");
      if (result.ok) canceled.push(attempt.task_id);
    }
    book(phase, "execution", "wave_stopped", canceled.length ? `queued pieces canceled: ${canceled.join(", ")}` : "nothing queued to cancel");
    const corrected: string[] = [];
    for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && issued.has(taskFamily(row.task_id)) && row.state === "running" && row.thread_id)) {
      await sendServiceMessage(bb as never, { threadId: attempt.thread_id!, mode: "queue-if-active", senderThreadId: phase.pmThreadId, text: `[Lane Pilot phase ${phase.id}] The wave is stopped: finish the current step, leave the work ready for review, and start nothing new.` })
        .then(() => corrected.push(attempt.task_id), () => undefined);
    }
    if (corrected.length) book(phase, "execution", "wave_live_corrected", `the wave's live writers are corrected after their current turn: ${corrected.join(", ")}`);
    savePhase(db, phase.id, { state: "paused", at: now() });
    return { phase: mustGet(phase.id), canceled };
  }

  /** One piece at work is stopped by the owner from the card (SMA d_batch_decide): its attempt is canceled and the book says who did it. Decide does not cover a running piece. */
  async function cancelPiece(input: CancelPieceInput): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (!phase.record.plan?.items.some((row) => row.id === input.piece)) throw new PhaseRefusal(`no piece ${input.piece} in the plan of phase ${phase.id}`);
    const fact = facts(phase).get(input.piece);
    if (!fact?.attemptId || !["queued", "running", "checking"].includes(fact.state ?? "")) throw new PhaseRefusal(`piece ${input.piece} is not at work (it is ${fact?.state ?? (phase.record.execution?.issued[input.piece] ? "issued" : "not issued")}): nothing to cancel`);
    const result = await cancelAttemptById(ctx, fact.attemptId, services.rollback, `Остановлено владельцем: ${input.note?.trim().slice(0, 380) || "по кнопке на карточке фазы"}`, "unknown")
      .catch((cause: unknown) => ({ ok: false, state: "error", reason: cause instanceof Error ? cause.message : String(cause) }));
    book(phase, "execution", "cancel", `${input.piece} (${fact.taskId}) canceled by ${input.by ?? "pm"}: ${input.note?.trim() || "cancel"}${result.ok ? "" : `; the stop was not observed: ${result.reason ?? result.state}`}`);
    if (!result.ok) throw new PhaseRefusal(`the stop of ${fact.taskId} was not observed: ${result.reason ?? result.state}`);
    return mustGet(phase.id);
  }

  /** The only way out of a stopped piece (SMA bi_decide): skip, retry or cancel — there is no fourth. */
  async function decide(input: DecideInput): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    const plan = phase.record.plan;
    const item = plan?.items.find((row) => row.id === input.piece);
    if (!item) throw new PhaseRefusal(`no piece ${input.piece} in the plan of phase ${phase.id}`);
    const broken = ["blocked", "canceled"].includes(facts(phase).get(input.piece)?.state ?? "") || input.piece in (phase.record.execution?.issueErrors ?? {});
    if (!broken) throw new PhaseRefusal(`piece ${input.piece} is not stopped (it is ${facts(phase).get(input.piece)?.state ?? (phase.record.execution?.issued[input.piece] ? "at work" : "not issued")}): decide is for a blocked or canceled piece, or one that failed to issue`);
    if (input.choice === "cancel") return (await stop({ phaseId: phase.id, words: input.note ?? `piece ${input.piece}: cancel`, by: input.by })).phase;
    if (input.choice === "skip") {
      const items = plan!.items.filter((row) => row.id !== input.piece);
      if (!items.length) throw new PhaseRefusal("skipping the last piece closes the phase: decide with cancel");
      const sha = planSignature(items, plan!.contextSha);
      const execution = phase.record.execution ? { ...phase.record.execution } : undefined;
      if (execution) { delete execution.issued[input.piece]; delete execution.issuedSha?.[input.piece]; delete execution.issueErrors?.[input.piece]; }
      const revoked = (phase.record.words ?? []).some((word) => word.turn === "issue" || word.turn === "wave");
      const record: PhaseRecord = { ...phase.record, plan: { ...plan!, items, sha, ...(plan!.admittedSha ? { admittedSha: sha } : {}) }, ...(execution ? { execution } : {}),
        scope: { revisions: phase.record.scope?.revisions ?? 0, withdrawn: [...(phase.record.scope?.withdrawn ?? []), input.piece] },
        ...(revoked ? { words: (phase.record.words ?? []).filter((word) => word.turn !== "issue" && word.turn !== "wave") } : {}) };
      book(phase, "decisions", "scope_withdrawn", `${input.piece} skipped by ${input.by ?? "pm"}: ${input.note ?? "decide skip"}${revoked ? "; issue permission revoked" : ""}`);
      savePhase(db, phase.id, { record, at: now() });
      return mustGet(phase.id);
    }
    // retry: the piece's contract print is withdrawn, so issue() sends it again as the next redo of its family.
    const execution = phase.record.execution!;
    const record: PhaseRecord = { ...phase.record, execution: { ...execution, issuedSha: { ...(execution.issuedSha ?? {}), [input.piece]: "retry" },
      issueErrors: Object.fromEntries(Object.entries(execution.issueErrors ?? {}).filter(([piece]) => piece !== input.piece)) } };
    book(phase, "execution", "retry", `${input.piece} is issued again as a redo by ${input.by ?? "pm"}: ${input.note ?? "decide retry"}`);
    savePhase(db, phase.id, { record, at: now() });
    // A retry that fails to issue the same way gives the same step key; the PM must hear it again (live ph_f359c7ba19, 2026-11-11:
    // the lint refused the same contract after the retry and the phase stood 18 minutes without a word).
    notePoked(db, phase.id, "", now());
    return mustGet(phase.id);
  }
  /**
   * Force-interrupt (SMA px_force): a person interrupts the phase's running work by an explicit choice, and only while that work
   * is not proven stopped. The phase turns paused once every stop is observed; until then it keeps `interrupting` and each pass
   * asks for the open stops again. On resume the interrupted pieces are issued again as redos of their families.
   */
  async function interrupt(input: InterruptInput): Promise<{ phase: Phase; canceled: string[]; unconfirmed: string[] }> {
    const phase = mustGet(input.phaseId);
    if (phase.state !== "pause_requested" && phase.state !== "paused")
      throw new PhaseRefusal(`phase ${phase.id} is ${phase.state}: an interrupt is for a pausing or paused phase — pause it first`);
    const families = new Set(Object.values(phase.record.execution?.issued ?? {}).map(taskFamily));
    const running = listOpenAttempts(db).filter((row) => row.run_id === phase.runId && families.has(taskFamily(row.task_id)));
    if (!running.length && !phase.record.interrupting) throw new PhaseRefusal(`phase ${phase.id} has no running work to interrupt: it is already still`);
    const { canceled, unconfirmed, canceledPieces } = await cancelPhaseWork(phase, `canceled: phase ${phase.id} interrupted by ${input.by ?? "pm"}${input.words ? `: ${input.words}` : ""}`);
    const line = [canceled.length ? `canceled: ${canceled.join(", ")}` : "no piece at work", ...(unconfirmed.length ? [`stop not observed yet: ${unconfirmed.join(", ")}`] : [])].join("; ");
    const record = mustGet(phase.id).record;
    // The interrupted pieces go again as redos on resume: their issued contract prints are withdrawn.
    const issuedSha = { ...(record.execution?.issuedSha ?? {}) };
    for (const piece of canceledPieces) issuedSha[piece] = "interrupted";
    if (unconfirmed.length) {
      book(phase, "execution", "interrupting", `${line}; the phase turns paused when every stop is observed`);
      savePhase(db, phase.id, { state: "pause_requested", record: { ...record, execution: record.execution ? { ...record.execution, issuedSha } : record.execution, interrupting: { by: phase.record.interrupting?.by ?? input.by ?? "pm", at: phase.record.interrupting?.at ?? now(), unconfirmed } }, at: now() });
      return { phase: mustGet(phase.id), canceled, unconfirmed };
    }
    book(phase, "execution", "interrupted", `${line}; every stop observed, the phase is paused`);
    savePhase(db, phase.id, { state: "paused", record: { ...record, execution: record.execution ? { ...record.execution, issuedSha } : record.execution, interrupting: undefined }, at: now() });
    return { phase: mustGet(phase.id), canceled, unconfirmed };
  }

  return { withdraw, revise, correct, returnTo, setState, stop, stopWave, cancelPiece, decide, interrupt };
}
