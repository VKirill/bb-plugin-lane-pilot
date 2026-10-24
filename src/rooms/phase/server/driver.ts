import { randomUUID } from "node:crypto";
import { cancelAttemptById } from "../../runs/server";
import { taskFamily } from "../../runs";
import { getRunGoal } from "../../run-goal";
import { getRun, getRunSettingsScopes, getRunWriterHost, listOpenAttempts, storeMemoryRecords } from "../../storage";
import { hostContract } from "../../contracts";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import {
  PHASE_STAGES, RETURN_STAGES, RISK_KINDS, acceptanceLines, blindVerdict, contextSignature, openQuestions, phaseFolder, planGate as planGateOf, wordOf, designDecision, designGate, discussionGate,
  executionGate, issuable, lessonsNeeded, nextAction, planGate, planSignature, renderBook, sha256, staleAfterReturn,
  type ContextDoc, type Phase, type PhaseRecord, type PhaseStage, type PlanItem, type RiskKind, type TaskFact, type WordTurn,
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
    const receipts = db.prepare("SELECT task_id, stage_id, state FROM lane_pilot_stage_receipt WHERE run_id=? AND stage_id IN ('plan-fact','verification','code-critique','browser-qa')").all(phase.runId) as Array<{ task_id: string; stage_id: string; state: string }>;
    for (const [pieceId, taskId] of Object.entries(issued)) {
      const family = taskFamily(taskId);
      const mine = attempts.filter((row) => taskFamily(row.task_id) === family);
      const latestTask = mine.at(-1)?.task_id ?? taskId;
      const stage = (id: string) => (receipts.find((row) => row.task_id === latestTask && row.stage_id === id)?.state ?? null) as never;
      out.set(pieceId, { taskId: latestTask, state: mine.at(-1)?.state ?? null, planFact: stage("plan-fact"), verification: stage("verification"), codeCritique: stage("code-critique"), browserQa: stage("browser-qa") });
    }
    return out;
  }

  // ------------------------------------------------------------ what the PM reports

  async function open(input: { projectId: string; pmThreadId: string; title: string; goal: string; legacy?: boolean }): Promise<Phase> {
    const id = `ph_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const runId = (db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? ORDER BY created_at DESC LIMIT 1").get(input.pmThreadId) as { id: string } | undefined)?.id ?? null;
    insertPhase(db, { id, projectId: input.projectId, pmThreadId: input.pmThreadId, runId, title: input.title.slice(0, 200), goal: input.goal.slice(0, 4000), at: now() });
    const settings = await ctx.effectiveProjectSettings(input.projectId).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
    const ownerWords = String(settings["owner.words"] ?? "off") === "on";
    let phase = mustGet(id);
    book(phase, "goal", "opened", `phase opened: ${input.title}${ownerWords ? " (the owner's word is asked at the turns: owner.words on)" : ""}`);
    const record: PhaseRecord = { ownerWords, scope: { revisions: 0, withdrawn: [] } };
    if (input.legacy) {
      // Legacy mode without signature: a plan written before the phase existed is admitted on its own; the book says so.
      record.context = { docs: [], sha: sha256(`legacy:${id}`), signedAt: now(), legacy: true };
      move(phase, "planning", record, "legacy mode: the plan exists already, there is no signed discussion");
    } else savePhase(db, phase.id, { record, at: now() });
    phase = mustGet(id);
    return phase;
  }

  async function context(input: Reported & { docs: string[]; risks?: Partial<Record<RiskKind, string>> }): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "discussion") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: return it to discussion first to change its context`);
    const docs: ContextDoc[] = [];
    for (const path of [...new Set(input.docs)].slice(0, 20)) {
      const file = await readFile(phase, path);
      docs.push({ path, sha256: file.sha256, bytes: file.sizeBytes });
    }
    const risks = Object.fromEntries(RISK_KINDS.map((kind) => [kind, input.risks?.[kind]?.trim() ?? ""]).filter(([, text]) => text)) as Partial<Record<RiskKind, string>>;
    const record: PhaseRecord = { ...phase.record, context: { docs, sha: contextSignature(docs), signedAt: now(), risks } };
    const check = discussionGate(record);
    if (!check.ok) { savePhase(db, phase.id, { record, at: now() }); throw new PhaseRefusal("the discussion is not complete", check.why); }
    book(phase, "discussion", "signed", `context signed ${record.context!.sha.slice(0, 12)}: ${docs.map((doc) => `${doc.path} (${doc.bytes} B)`).join(", ")}; risks — ${RISK_KINDS.map((kind) => `${kind}: ${risks[kind]}`).join("; ")}`);
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

  async function planCheck(input: Reported & { decision: "approve" | "changes_requested"; by: string; summary?: string }): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "planning" || !phase.record.plan) throw new PhaseRefusal("no plan at planning to check");
    // Context files unchanged: the documents the plan stands on are read again; an edit after the signature sends the phase back.
    for (const doc of phase.record.context?.docs ?? []) {
      const file = await readFile(phase, doc.path);
      if (file.sha256 !== doc.sha256) {
        book(phase, "discussion", "context_changed", `${doc.path} changed after the signature`);
        throw new PhaseRefusal(`${doc.path} changed after the context was signed: return the phase to discussion and sign it again`);
      }
    }
    const record: PhaseRecord = { ...phase.record, plan: { ...phase.record.plan, critique: { decision: input.decision, by: input.by, ...(input.summary ? { summary: input.summary } : {}) } } };
    book(phase, "plan", "checked", `${input.by}: ${input.decision}${input.summary ? ` — ${input.summary}` : ""}`);
    savePhase(db, phase.id, { record, at: now() });
    const check = planGate(record);
    if (!check.ok) {
      const waitsForWord = record.ownerWords && check.why.length === 1 && check.why[0]!.includes("owner's word");
      if (waitsForWord) return mustGet(phase.id);
      throw new PhaseRefusal("the plan is not admitted", check.why);
    }
    return admitIfReady(mustGet(phase.id));
  }

  async function drawing(input: Reported & { paths: string[]; designer: string; feasible: boolean; contradiction?: string; reviewer?: string }): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "design") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not design`);
    const folder = `${phaseFolder(phase.id)}/design/`;
    const outside = input.paths.filter((path) => !path.startsWith(folder) || path.includes(".."));
    if (outside.length) throw new PhaseRefusal(`the drawing lives in its own folder ${folder}`, outside.map((path) => `${path} is outside it`));
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
    if (!check.ok) {
      savePhase(db, phase.id, { record, at: now() });
      if (record.ownerWords && check.why.length === 1 && check.why[0]!.includes("owner's word")) return mustGet(phase.id);
      throw new PhaseRefusal("the drawing is not confirmed", check.why);
    }
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

  function lessons(input: Reported & { analysis: string; author: string; reviewer: string; reviewedHash: string }): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "lessons") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not lessons`);
    if (!input.reviewer.trim() || input.reviewer.trim() === input.author.trim()) throw new PhaseRefusal("the lessons need a reviewer other than their author");
    // Reviewer saw these bytes: the review names the hash of the book's last part it read; a book that grew since is read again.
    const head = listParts(db, phase.id).at(-1)?.hash ?? "";
    if (input.reviewedHash !== head) throw new PhaseRefusal(`the reviewer read another book: its last part is ${head.slice(0, 12)}, the review names ${input.reviewedHash.slice(0, 12)}`);
    const record: PhaseRecord = { ...phase.record, lessons: { ...(phase.record.lessons ?? { needed: true, why: "" }), analysis: input.analysis.slice(0, 4000), author: input.author, reviewer: input.reviewer, reviewedHash: head, at: now() } };
    book(phase, "lessons", "analysis", `${input.analysis} (by ${input.author}, reviewed by ${input.reviewer})`);
    // Lesson written by the pipeline: the analysis goes through the memory door as a note of the project (refused text stays only in the book).
    try {
      storeMemoryRecords(db, { projectId: phase.projectId, audience: "subagent", sourceSha256: sha256(`${phase.id}:${head}`), origin: "phase-lessons",
        scope: phase.runId ? getRunSettingsScopes(db, phase.runId) : [], coreBudget: 3072, noteBudget: 200_000, indexBudget: 65536,
        entries: [{ kind: "note", content: `Phase «${phase.title}» lessons: ${input.analysis}`.slice(0, 2000), concepts: ["phase", "lessons"] }] });
    } catch (cause) {
      book(phase, "lessons", "memory_refused", `the memory door refused the lesson: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    move(phase, "closed", record, "the lessons are written and reviewed");
    savePhase(db, phase.id, { state: "closed", at: now() });
    return mustGet(phase.id);
  }

  function question(input: Reported & { text: string; blocking: boolean }): Phase {
    const phase = mustGet(input.phaseId);
    const id = `q${(phase.record.questions?.length ?? 0) + 1}`;
    const record: PhaseRecord = { ...phase.record, questions: [...(phase.record.questions ?? []), { id, stage: phase.stage, text: input.text.slice(0, 1000), blocking: input.blocking, askedAt: now() }] };
    book(phase, phase.stage === "planning" ? "plan" : "decisions", "question", `${id}${input.blocking ? " (blocking)" : ""}: ${input.text}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  function answer(input: Reported & { questionId: string; answer: string }): Phase {
    const phase = mustGet(input.phaseId);
    const questions = phase.record.questions ?? [];
    if (!questions.some((row) => row.id === input.questionId)) throw new PhaseRefusal(`no question ${input.questionId}`);
    const record: PhaseRecord = { ...phase.record, questions: questions.map((row) => row.id === input.questionId ? { ...row, answer: input.answer.slice(0, 2000), answeredBy: input.by ?? "pm", answeredAt: now() } : row) };
    book(phase, "decisions", "answer", `${input.questionId}: ${input.answer}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  /** The owner's word at a turn (owner.words on). «no» sends the phase back: from planning or design to planning, from acceptance to execution. */
  function word(input: Reported & { turn: WordTurn; decision: "yes" | "no"; text: string }): Phase {
    const phase = mustGet(input.phaseId);
    const record: PhaseRecord = { ...phase.record, words: [...(phase.record.words ?? []), { turn: input.turn, decision: input.decision, by: input.by ?? "owner", text: input.text.slice(0, 2000), at: now() }] };
    book(phase, "decisions", `word_${input.turn}`, `${input.by ?? "owner"}: ${input.decision} — ${input.text}`);
    savePhase(db, phase.id, { record, at: now() });
    if (input.decision === "no") {
      const to: PhaseStage = input.turn === "acceptance" || input.turn === "uat" ? "execution" : "planning";
      if (PHASE_STAGES.indexOf(to) < PHASE_STAGES.indexOf(phase.stage)) return returnTo({ phaseId: phase.id, to, note: `the owner said no at ${input.turn}: ${input.text}`, by: input.by ?? "owner" });
    }
    if (input.decision === "yes" && phase.stage === "planning" && input.turn === "planning") return admitIfReady(mustGet(phase.id));
    return mustGet(phase.id);
  }

  /** Scope withdrawal agreed: pieces not yet issued leave the plan with a note; the plan is admitted again as it now is. */
  function withdraw(input: Reported & { pieces: string[]; note: string }): Phase {
    const phase = mustGet(input.phaseId);
    const plan = phase.record.plan;
    if (!plan) throw new PhaseRefusal("no plan to withdraw from");
    const issued = phase.record.execution?.issued ?? {};
    const refused = input.pieces.filter((id) => issued[id]);
    if (refused.length) throw new PhaseRefusal("issued pieces are canceled, not withdrawn", refused.map((id) => `${id} is issued: lane_pilot_cancel_task, then withdraw`));
    const items = plan.items.filter((item) => !input.pieces.includes(item.id));
    if (!items.length) throw new PhaseRefusal("withdrawing every piece closes the phase: use close with the words why");
    const sha = planSignature(items, plan.contextSha);
    const record: PhaseRecord = { ...phase.record, plan: { ...plan, items, sha, ...(plan.admittedSha ? { admittedSha: sha } : {}) }, scope: { revisions: phase.record.scope?.revisions ?? 0, withdrawn: [...(phase.record.scope?.withdrawn ?? []), ...input.pieces] } };
    book(phase, "decisions", "scope_withdrawn", `${input.pieces.join(", ")} withdrawn by ${input.by ?? "pm"}: ${input.note}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  /** Phase scope revision: the goal changes in discussion or planning; the plan built on the old goal is checked again. */
  function revise(input: Reported & { goal: string; note: string }): Phase {
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
  async function correct(input: Reported & { note: string; pieces?: string[] }): Promise<{ phase: Phase; sent: string[] }> {
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

  /** Admits the plan when its gate holds (after the checker's approval, or after the owner's word when owner.words is on). */
  function admitIfReady(phase: Phase): Phase {
    const record: PhaseRecord = { ...phase.record };
    const check = planGateOf(record);
    if (!check.ok || !record.plan) return phase;
    record.plan = { ...record.plan, admittedSha: record.plan.sha, admittedAt: now() };
    record.design = record.design?.decision === "needed" ? record.design : designDecision(record.plan.items);
    book(phase, "plan", "admitted", `plan ${record.plan.sha.slice(0, 12)} admitted; drawing ${record.design.decision === "needed" ? "needed" : "not needed"}: ${record.design.why}`);
    move(phase, record.design.decision === "needed" ? "design" : "execution", record, "the plan is admitted");
    return mustGet(phase.id);
  }

  /** Writes the phase book to the project (.agents/phases/<id>/BOOK.md) when it grew; a phase without a run binding keeps it on the hub only. */
  async function writeBook(phase: Phase): Promise<void> {
    const parts = listParts(db, phase.id);
    const last = parts.at(-1);
    if (!last || phase.record.bookWritten?.seq === last.seq || !phase.runId) return;
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return;
    const path = `${phaseFolder(phase.id)}/BOOK.md`;
    const content = renderBook(phase, parts);
    const edits = [{ path, expectedSha256: phase.record.bookWritten?.sha256 ?? null, content }];
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const result = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, previewSha256: sha256(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
    const written = result.writes.find((row) => row.path === path);
    if (result.status === "applied" && written?.afterSha256) savePhase(db, phase.id, { record: { ...phase.record, bookWritten: { seq: last.seq, sha256: written.afterSha256, at: now() } }, at: now() });
    else if (result.status === "conflict") savePhase(db, phase.id, { record: { ...phase.record, bookWritten: { seq: last.seq, sha256: written?.beforeSha256 ?? "", at: now() } }, at: now() });
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
      const reply: Record<string, unknown> = await services.dispatchWriter({ threadId: phase.pmThreadId, projectId: phase.projectId, birth: "phase",
        // Stage above ordinary work: a phase's pieces start before the run's ordinary tasks when writers are scarce.
        task: { ...item.task, priority: (item.task.priority as string | undefined) ?? "high", ...(phase.record.design?.drawing ? { drawing: phase.record.design.drawing.paths } : {}) } as never,
        plan: `Phase ${phase.id} «${phase.title}», wave ${item.wave}, piece ${item.id}. Promise — given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}.${phase.record.design?.drawing ? ` The phase drawing: ${phase.record.design.drawing.paths.join(", ")} — the screens follow it.` : ""}`,
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
    // Phase base at start: the commit the first piece was cut from.
    const firstTask = Object.values(execution.issued)[0];
    const baseSha = phase.record.execution?.baseSha ?? (firstTask ? (db.prepare("SELECT base_sha FROM lane_pilot_task_git_base WHERE task_id=? LIMIT 1").get(firstTask) as { base_sha?: string } | undefined)?.base_sha ?? null : null);
    savePhase(db, phase.id, { record: { ...phase.record, execution: { ...execution, baseSha, acceptedNoted: phase.record.execution?.acceptedNoted ?? [] } }, runId, at: now() });
    return mustGet(phase.id);
  }

  /** One step of a phase. Reconciling after force: every tick reads the pieces' facts afresh, so a phase paused, stopped or edited by hand
   * continues from what the attempts and receipts say now, not from what it last believed. */
  async function drive(phase: Phase): Promise<Phase> {
    if (phase.state === "pause_requested") { savePhase(db, phase.id, { state: "paused", at: now() }); return mustGet(phase.id); }
    if (phase.state !== "active") return phase;
    let current = phase;
    if (current.stage === "execution") {
      current = await issue(current);
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
      // Main moved — a new word: the verdict saw another main; verify again on the main that is there now.
      if (lines.find((line) => line.id === "main_unmoved")?.ok === false) {
        const record: PhaseRecord = { ...current.record, verification: undefined, acceptance: undefined };
        move(current, "verification", record, "main moved since the verdict: verified again");
        return mustGet(current.id);
      }
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
        await writeBook(mustGet(after.id)).catch((cause: unknown) => ctx.log(`phase ${phase.id}: book not written: ${cause instanceof Error ? cause.message : String(cause)}`));
      } catch (cause) {
        ctx.log(`phase ${phase.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return moved;
  }

  function status(phaseId: string) {
    const phase = mustGet(phaseId);
    const parts = listParts(db, phase.id);
    return { phase, next: nextAction(phase, facts(phase)), gates: { discussion: discussionGate(phase.record), plan: planGate(phase.record), design: designGate(phase.record) }, book: renderBook(phase, parts), bookHead: parts.at(-1)?.hash ?? null, openQuestions: openQuestions(phase.record, phase.stage), ownerWord: { asked: !!phase.record.ownerWords, planning: wordOf(phase.record, "planning") ?? null, design: wordOf(phase.record, "design") ?? null, acceptance: wordOf(phase.record, "acceptance") ?? null }, facts: Object.fromEntries(facts(phase)) };
  }

  /** Did the plan stay the admitted one (Plan unchanged since checking). */
  const planUnchanged = (phase: Phase) => !!phase.record.plan?.admittedSha && phase.record.plan.admittedSha === planSignature(phase.record.plan.items, phase.record.plan.contextSha);

  return { phases: { open, context, plan, planCheck, drawing, goalAudit, lessons, question, answer, word, withdraw, revise, correct, returnTo, setState, stopWave, compensate, tick, drive, status, facts, planUnchanged, writeBook,
    list: (filter: Parameters<typeof listPhases>[1]) => listPhases(db, filter) } };
}
export type PhaseApi = ReturnType<typeof createPhaseDriver>["phases"];

export function mountPhaseDriver(ctx: ServerCore, api: PhaseApi): void {
  scheduleIsolated(ctx.bb, "phase-drive", "*/2 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.tick(signal).catch((cause: unknown) => ctx.log(`phase drive failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 30 * 60_000 });
}
