import { randomUUID } from "node:crypto";
import { cancelAttemptById } from "../../runs/server";
import { taskFamily } from "../../runs";
import { getRunGoal } from "../../run-goal";
import { listOpenAttempts } from "../../storage";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import {
  PHASE_STAGES, RETURN_STAGES, acceptanceLines, blindVerdict, contextSignature, designDecision, designGate, discussionGate,
  executionGate, issuable, lessonsNeeded, nextAction, planGate, planSignature, renderBook, sha256, staleAfterReturn,
  type ContextDoc, type Phase, type PhaseRecord, type PhaseStage, type PlanItem, type TaskFact,
} from "../logic";
import { appendPart, getPhase, insertPhase, listParts, listPhases, notePoked, savePhase } from "../store";

/**
 * The phase driver: the machine above the PM (SMA map, Phase graph; Matvey Maslov 2026-10-22: «there is a machine above the orchestrator that
 * drives the route and at the turns switches the orchestrator on»). The PM reports what a stage produced (documents, a plan, a drawing, an
 * audit) with lane_pilot_phase; the driver checks every gate in code (logic.ts), records each decision in the phase book, issues the
 * plan's pieces wave by wave as tasks, runs the blind verification and the acceptance calculation itself, and sends the PM exactly one
 * instruction per turn. Every two minutes it looks at each live phase again.
 */
export class PhaseRefusal extends Error {
  constructor(message: string, readonly why: string[] = []) { super(message); }
}

type Reported = { phaseId: string; by?: string };

export function createPhaseDriver(ctx: ServerCore, services: Services) {
  const { db, bb } = ctx;
  const now = () => Date.now();

  function mustGet(id: string) {
    const phase = getPhase(db, id);
    if (!phase) throw new PhaseRefusal(`no phase ${id}`);
    return phase;
  }

  /** A file of the project as the PM's run sees it (its frozen writer workspace), for the signature of a stage's documents. */
  async function readFile(phase: Phase, path: string): Promise<{ sha256: string; sizeBytes: number }> {
    try {
      return await services.readWriterWorkspaceFile({ threadId: phase.pmThreadId, projectId: phase.projectId, path, offset: 0, maxLines: 2000 }) as { sha256: string; sizeBytes: number };
    } catch (cause) {
      throw new PhaseRefusal(`cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function book(phase: Pick<Phase, "id">, section: Parameters<typeof appendPart>[2]["section"], kind: string, text: string) {
    appendPart(db, phase.id, { section, kind, text, at: now() });
  }

  function move(phase: Phase, stage: PhaseStage, record: PhaseRecord, why: string) {
    savePhase(db, phase.id, { stage, record, at: now() });
    book(phase, "decisions", "stage", `${phase.stage} → ${stage}: ${why}`);
  }

  /** The facts of each piece: the latest attempt of its task family in the phase's run and the receipts of its stages. */
  function facts(phase: Phase): Map<string, TaskFact> {
    const out = new Map<string, TaskFact>();
    const issued = phase.record.execution?.issued ?? {};
    if (!phase.runId) return out;
    const attempts = db.prepare("SELECT task_id, state FROM lane_pilot_attempt WHERE run_id=? ORDER BY created_at, attempt_no").all(phase.runId) as Array<{ task_id: string; state: string }>;
    const receipts = db.prepare("SELECT task_id, stage_id, state FROM lane_pilot_stage_receipt WHERE run_id=? AND stage_id IN ('plan-fact','verification','code-critique')").all(phase.runId) as Array<{ task_id: string; stage_id: string; state: string }>;
    for (const [pieceId, taskId] of Object.entries(issued)) {
      const family = taskFamily(taskId);
      const mine = attempts.filter((row) => taskFamily(row.task_id) === family);
      const latestTask = mine.at(-1)?.task_id ?? taskId;
      const stage = (id: string) => (receipts.find((row) => row.task_id === latestTask && row.stage_id === id)?.state ?? null) as never;
      out.set(pieceId, { taskId: latestTask, state: mine.at(-1)?.state ?? null, planFact: stage("plan-fact"), verification: stage("verification"), codeCritique: stage("code-critique") });
    }
    return out;
  }

  // ------------------------------------------------------------ what the PM reports

  function open(input: { projectId: string; pmThreadId: string; title: string; goal: string }): Phase {
    const id = `ph_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const runId = (db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? ORDER BY created_at DESC LIMIT 1").get(input.pmThreadId) as { id: string } | undefined)?.id ?? null;
    insertPhase(db, { id, projectId: input.projectId, pmThreadId: input.pmThreadId, runId, title: input.title.slice(0, 200), goal: input.goal.slice(0, 4000), at: now() });
    const phase = mustGet(id);
    book(phase, "goal", "opened", `phase opened: ${input.title}`);
    return phase;
  }

  async function context(input: Reported & { docs: string[] }): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "discussion") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: return it to discussion first to change its context`);
    const docs: ContextDoc[] = [];
    for (const path of [...new Set(input.docs)].slice(0, 20)) {
      const file = await readFile(phase, path);
      docs.push({ path, sha256: file.sha256, bytes: file.sizeBytes });
    }
    const record: PhaseRecord = { ...phase.record, context: { docs, sha: contextSignature(docs), signedAt: now() } };
    const check = discussionGate(record);
    if (!check.ok) { savePhase(db, phase.id, { record, at: now() }); throw new PhaseRefusal("the discussion is not complete", check.why); }
    book(phase, "discussion", "signed", `context signed ${record.context!.sha.slice(0, 12)}: ${docs.map((doc) => `${doc.path} (${doc.bytes} B)`).join(", ")}`);
    move(phase, "planning", record, "the context documents exist, none is empty, and they are signed");
    return mustGet(phase.id);
  }

  function plan(input: Reported & { items: PlanItem[]; design?: boolean }): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "planning") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: a plan is submitted at planning (return the phase there first)`);
    if (!phase.record.context) throw new PhaseRefusal("the phase has no signed context");
    const items = input.items.map((item) => ({ ...item, task: { ...item.task, id: item.id } }));
    const contextSha = phase.record.context.sha;
    const record: PhaseRecord = { ...phase.record, plan: { items, contextSha, sha: planSignature(items, contextSha) } };
    if (input.design) record.design = { decision: "needed", why: "the PM asked for a drawing" };
    savePhase(db, phase.id, { record, at: now() });
    book(phase, "plan", "submitted", `plan ${record.plan!.sha.slice(0, 12)}: ${items.length} piece(s) in ${new Set(items.map((item) => item.wave)).size} wave(s) — ${items.map((item) => `${item.id} (w${item.wave}): ${item.promise.then}`).join("; ")}`);
    return mustGet(phase.id);
  }

  function planCheck(input: Reported & { decision: "approve" | "changes_requested"; by: string; summary?: string }): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "planning" || !phase.record.plan) throw new PhaseRefusal("no plan at planning to check");
    const record: PhaseRecord = { ...phase.record, plan: { ...phase.record.plan, critique: { decision: input.decision, by: input.by, ...(input.summary ? { summary: input.summary } : {}) } } };
    book(phase, "plan", "checked", `${input.by}: ${input.decision}${input.summary ? ` — ${input.summary}` : ""}`);
    const check = planGate(record);
    if (!check.ok) { savePhase(db, phase.id, { record, at: now() }); throw new PhaseRefusal("the plan is not admitted", check.why); }
    record.plan = { ...record.plan!, admittedSha: record.plan!.sha, admittedAt: now() };
    record.design = record.design?.decision === "needed" ? record.design : designDecision(record.plan.items);
    book(phase, "plan", "admitted", `plan ${record.plan.sha.slice(0, 12)} admitted; drawing ${record.design.decision === "needed" ? "needed" : "not needed"}: ${record.design.why}`);
    move(phase, record.design.decision === "needed" ? "design" : "execution", record, "the plan is admitted");
    return mustGet(phase.id);
  }

  async function drawing(input: Reported & { paths: string[]; designer: string; feasible: boolean; contradiction?: string; reviewer?: string }): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "design") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not design`);
    const hashes: string[] = [];
    for (const path of input.paths.slice(0, 30)) {
      const file = await readFile(phase, path);
      hashes.push(`${path}:${file.sha256}`);
    }
    const record: PhaseRecord = { ...phase.record, design: { ...(phase.record.design ?? { decision: "needed", why: "" }),
      drawing: { paths: input.paths, sha256: sha256(hashes.join("\n")), designer: input.designer, feasible: input.feasible, ...(input.contradiction ? { contradiction: input.contradiction } : {}), ...(input.reviewer ? { reviewer: input.reviewer } : {}) } } };
    book(phase, "design", "drawing", `${input.paths.join(", ")} by ${input.designer}; ${input.feasible ? "feasible" : `contradiction: ${input.contradiction ?? "?"}`}${input.reviewer ? `; reviewed by ${input.reviewer}` : ""}`);
    if (!input.feasible) {
      savePhase(db, phase.id, { record, at: now() });
      return returnTo({ phaseId: phase.id, to: "planning", note: `the drawing contradicts the plan: ${input.contradiction ?? "no reason given"}`, by: input.designer });
    }
    const check = designGate(record);
    if (!check.ok) { savePhase(db, phase.id, { record, at: now() }); throw new PhaseRefusal("the drawing is not confirmed", check.why); }
    record.design = { ...record.design!, confirmedAt: now() };
    move(phase, "execution", record, "the drawing is feasible and reviewed by a separate role");
    return mustGet(phase.id);
  }

  function goalAudit(input: Reported & { state: "met" | "unmet"; by: string; summary: string }): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "verification" || !phase.record.verification?.verdict) throw new PhaseRefusal("no blind verdict to audit yet");
    const record: PhaseRecord = { ...phase.record, verification: { ...phase.record.verification, model: { state: input.state, by: input.by, summary: input.summary.slice(0, 2000), at: now() } } };
    book(phase, "verification", "goal_audit", `${input.by}: ${input.state} — ${input.summary}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  function lessons(input: Reported & { analysis: string; reviewer: string }): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "lessons") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not lessons`);
    if (!input.reviewer.trim()) throw new PhaseRefusal("the lessons need a reviewer other than their author");
    const record: PhaseRecord = { ...phase.record, lessons: { ...(phase.record.lessons ?? { needed: true, why: "" }), analysis: input.analysis.slice(0, 4000), reviewer: input.reviewer, at: now() } };
    book(phase, "lessons", "analysis", `${input.analysis} (reviewed by ${input.reviewer})`);
    move(phase, "closed", record, "the lessons are written and reviewed");
    savePhase(db, phase.id, { state: "closed", at: now() });
    return mustGet(phase.id);
  }

  // ------------------------------------------------------------ controls

  function returnTo(input: Reported & { to: PhaseStage; note: string }): Phase {
    const phase = mustGet(input.phaseId);
    if (!RETURN_STAGES.includes(input.to)) throw new PhaseRefusal(`a phase returns to ${RETURN_STAGES.join(", ")}`);
    if (PHASE_STAGES.indexOf(input.to) >= PHASE_STAGES.indexOf(phase.stage)) throw new PhaseRefusal(`a return goes to an earlier stage: the phase is at ${phase.stage}`);
    if (!input.note.trim()) throw new PhaseRefusal("a return carries a note: what changed and why");
    const record = staleAfterReturn(input.to, phase.record);
    book(phase, "decisions", "return", `${phase.stage} → ${input.to} by ${input.by ?? "pm"}: ${input.note}`);
    savePhase(db, phase.id, { stage: input.to, record, state: phase.state === "closed" ? "active" : phase.state, at: now() });
    return mustGet(phase.id);
  }

  function setState(input: Reported & { state: "pause" | "resume" | "stop" | "close"; words?: string }): Phase {
    const phase = mustGet(input.phaseId);
    const next = input.state === "pause" ? "paused" : input.state === "resume" ? "active" : input.state === "stop" ? "stopped" : "closed";
    if (input.state === "close" && !input.words?.trim()) throw new PhaseRefusal("closing in words carries the words: why the phase ends here");
    const record: PhaseRecord = input.state === "close" ? { ...phase.record, closing: { by: input.by ?? "pm", words: input.words!, at: now() } } : phase.record;
    book(phase, "decisions", input.state, `${input.by ?? "pm"}${input.words ? `: ${input.words}` : ""}`);
    savePhase(db, phase.id, { state: next, record, ...(input.state === "close" ? { stage: "closed" as const } : {}), at: now() });
    return mustGet(phase.id);
  }

  /** Stops the current wave: the pieces issued but not started are canceled; running writers finish their current stage. */
  async function stopWave(input: Reported): Promise<{ phase: Phase; canceled: string[] }> {
    const phase = mustGet(input.phaseId);
    const issued = new Set(Object.values(phase.record.execution?.issued ?? {}).map(taskFamily));
    const canceled: string[] = [];
    for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && issued.has(taskFamily(row.task_id)) && row.state === "queued")) {
      const result = await cancelAttemptById(ctx, attempt.id, services.rollback);
      if (result.ok) canceled.push(attempt.task_id);
    }
    book(phase, "execution", "wave_stopped", canceled.length ? `queued pieces canceled: ${canceled.join(", ")}` : "nothing queued to cancel");
    savePhase(db, phase.id, { state: "paused", at: now() });
    return { phase: mustGet(phase.id), canceled };
  }

  /** Compensates the phase's own effects: each accepted piece is reverted (git revert through the merge lock), newest first. */
  async function compensate(input: Reported & { note: string }): Promise<{ phase: Phase; results: Array<{ taskId: string; state: string; detail?: string }> }> {
    const phase = mustGet(input.phaseId);
    const f = facts(phase);
    const accepted = [...f.values()].filter((fact) => fact.state === "accepted").reverse();
    const results: Array<{ taskId: string; state: string; detail?: string }> = [];
    for (const fact of accepted) {
      const outcome = await services.rollback.revert(fact.taskId).catch((cause: unknown) => ({ state: "error", detail: cause instanceof Error ? cause.message : String(cause) }) as never);
      const state = String((outcome as { state?: unknown }).state ?? "unknown");
      results.push({ taskId: fact.taskId, state, ...((outcome as { detail?: string }).detail ? { detail: (outcome as { detail?: string }).detail } : {}) });
    }
    book(phase, "decisions", "compensated", `${input.note}: ${results.map((row) => `${row.taskId} ${row.state}`).join(", ") || "nothing accepted to revert"}`);
    return { phase: mustGet(phase.id), results };
  }

  // ------------------------------------------------------------ the drive

  async function issue(phase: Phase): Promise<Phase> {
    const items = phase.record.plan?.items ?? [];
    const execution = { issued: { ...(phase.record.execution?.issued ?? {}) }, startedAt: phase.record.execution?.startedAt ?? now(), issueErrors: {} as Record<string, string> };
    if (phase.record.plan?.sha !== phase.record.plan?.admittedSha) throw new PhaseRefusal("the plan changed since it was checked: return the phase to planning");
    let runId = phase.runId;
    for (const item of issuable(items, execution.issued, facts(phase))) {
      const reply: Record<string, unknown> = await services.dispatchWriter({ threadId: phase.pmThreadId, projectId: phase.projectId, task: item.task as never,
        plan: `Phase ${phase.id} «${phase.title}», wave ${item.wave}, piece ${item.id}. Promise — given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}.`,
        objective: phase.goal }).catch((cause: unknown) => ({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }));
      const taskId = typeof reply.taskId === "string" ? reply.taskId : null;
      if (taskId) {
        execution.issued[item.id] = taskId;
        if (typeof reply.runId === "string") runId = reply.runId;
        book(phase, "execution", "issued", `${item.id} → task ${taskId} (wave ${item.wave})`);
      } else {
        execution.issueErrors[item.id] = String(reply.reason ?? reply.error ?? "dispatch refused").slice(0, 300);
      }
    }
    savePhase(db, phase.id, { record: { ...phase.record, execution }, runId, at: now() });
    return mustGet(phase.id);
  }

  async function drive(phase: Phase): Promise<Phase> {
    if (phase.state === "pause_requested") { savePhase(db, phase.id, { state: "paused", at: now() }); return mustGet(phase.id); }
    if (phase.state !== "active") return phase;
    let current = phase;
    if (current.stage === "execution") {
      current = await issue(current);
      const items = current.record.plan?.items ?? [];
      if (executionGate(items, current.record.execution?.issued ?? {}, facts(current)).ok) move(current, "verification", current.record, "every piece is issued and accepted");
      current = mustGet(current.id);
    }
    if (current.stage === "verification" && !current.record.verification?.verdict && current.runId) {
      const goal = getRunGoal(db, current.runId) ?? await services.runGoal.check(current.runId).catch(() => null);
      if (goal) {
        const verdict = blindVerdict(current.record.plan?.items ?? [], facts(current), goal, now());
        book(current, "verification", "blind_verdict", `${verdict.state}: ${verdict.detail} (input ${verdict.inputSha.slice(0, 12)})`);
        savePhase(db, current.id, { record: { ...current.record, verification: { ...current.record.verification, verdict } }, at: now() });
        current = mustGet(current.id);
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
    if (current.stage === "acceptance") {
      const lastGoal = current.runId ? getRunGoal(db, current.runId) : null;
      const openDeferrals = (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_deferral WHERE project_id=? AND closed_at IS NULL").get(current.projectId) as { n: number } | undefined)?.n ?? 0;
      const lines = acceptanceLines(current, facts(current), { mainSha: lastGoal?.headSha ?? null, openDeferrals });
      const accepted = lines.every((line) => line.ok);
      const before = JSON.stringify(current.record.acceptance?.lines ?? []);
      const record: PhaseRecord = { ...current.record, acceptance: { lines, at: now(), accepted } };
      if (JSON.stringify(lines) !== before) book(current, "acceptance", accepted ? "accepted" : "held", lines.map((line) => `${line.ok ? "✓" : "✗"} ${line.id}: ${line.detail}`).join("; "));
      if (accepted) {
        const returns = listParts(db, current.id).filter((part) => part.kind === "return").length;
        const failedAttempts = current.runId ? ((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt WHERE run_id=? AND state IN ('validation_failed','blocked','provider_error','timeout','empty_output')").get(current.runId) as { n: number }).n) : 0;
        const verdictFailures = listParts(db, current.id).filter((part) => part.kind === "blind_verdict" && part.text.startsWith("failed")).length;
        record.lessons = lessonsNeeded({ returns, failedAttempts, verdictFailures });
        move(current, record.lessons.needed ? "lessons" : "closed", record, "every acceptance line holds");
        if (!record.lessons.needed) { book(current, "lessons", "none", record.lessons.why); savePhase(db, current.id, { state: "closed", at: now() }); }
      } else savePhase(db, current.id, { record, at: now() });
      current = mustGet(current.id);
    }
    return current;
  }

  /** Sends the PM the one instruction the phase needs now, once per instruction key. */
  async function poke(phase: Phase & { pokedKey?: string | null }): Promise<void> {
    const action = nextAction(phase, facts(phase));
    const last = getPhase(db, phase.id)?.pokedKey ?? null;
    if (!action.waitsForPm || action.key === last) return;
    await bb.sdk.threads.send({ threadId: phase.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text: `[Lane Pilot phase] ${action.text}`, mentions: [] }] } as never).catch(() => undefined);
    notePoked(db, phase.id, action.key, now());
  }

  async function tick(signal?: AbortSignal): Promise<number> {
    let moved = 0;
    for (const phase of listPhases(db, { live: true, limit: 100 })) {
      if (signal?.aborted || ctx.isDisposed()) break;
      try {
        const after = await drive(phase);
        if (after.stage !== phase.stage || after.state !== phase.state) moved += 1;
        await poke(after);
      } catch (cause) {
        ctx.log(`phase ${phase.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return moved;
  }

  function status(phaseId: string) {
    const phase = mustGet(phaseId);
    const parts = listParts(db, phase.id);
    return { phase, next: nextAction(phase, facts(phase)), gates: { discussion: discussionGate(phase.record), plan: planGate(phase.record), design: designGate(phase.record) }, book: renderBook(phase, parts), facts: Object.fromEntries(facts(phase)) };
  }

  /** Did the plan stay the admitted one (Plan unchanged since checking). */
  const planUnchanged = (phase: Phase) => !!phase.record.plan?.admittedSha && phase.record.plan.admittedSha === planSignature(phase.record.plan.items, phase.record.plan.contextSha);

  return { phases: { open, context, plan, planCheck, drawing, goalAudit, lessons, returnTo, setState, stopWave, compensate, tick, drive, status, facts, planUnchanged,
    list: (filter: Parameters<typeof listPhases>[1]) => listPhases(db, filter) } };
}
export type PhaseApi = ReturnType<typeof createPhaseDriver>["phases"];

export function mountPhaseDriver(ctx: ServerCore, api: PhaseApi): void {
  scheduleIsolated(ctx.bb, "phase-drive", "*/2 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.tick(signal).catch((cause: unknown) => ctx.log(`phase drive failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 30 * 60_000 });
}
