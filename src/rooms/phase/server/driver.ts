import { randomUUID } from "node:crypto";
import { cancelAttemptById, isRunHalted, isRunPaused } from "../../runs/server";
import { taskFamily } from "../../runs";
import { noTermDeferralsOf } from "../../deferral/server";
import { getRunGoal } from "../../run-goal";
import { getRun, getRunSettingsScopes, getRunWriterHost, getTask, listOpenAttempts, storeMemoryRecords } from "../../storage";
import { postOwnerItem, closeOwnerItem } from "../../owner-waiting";
import { isWholeConsent, ownerWordsOn, spendReserve } from "../../tasks";
import { hostContract } from "../../contracts";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import {
  PHASE_STAGES, RETURN_STAGES, RISK_KINDS, acceptanceKey, acceptanceLines, alreadyMetVerdict, blindVerdict, canonical, pieceSha, contextSignature, openQuestions, phaseFolder, planGate as planGateOf, piecesOfWave, waveCleared, waveLines, wavePackage, wavesOf, wordOf, designDecision, designGate, discussionGate,
  executionGate, issuable, lessonsNeeded, nextAction, planGate, planSignature, provenPieces, renderBook, sha256, staleAfterReturn,
  type ContextDoc, type Phase, type PhaseRecord, type PhaseStage, type PlanItem, type RiskKey, type TaskFact, type WordTurn,
} from "../logic";
import { appendPart, getPhase, insertPhase, listParts, listPhases, notePoked, savePhase } from "../store";
import { archiveDrawing, binaryFileCommand, binaryFileFingerprint, conclusionText, markRoadmap, nextRoadmapRow, stateText, uatState, uatText, waveTable } from "../stages";
import { runOnHost } from "@lane-pilot/host-calls";
import { createPhaseIntake } from "./intake";
import { createAutoStages, recoverStopped } from "./auto-stages";
import { checkProofs, hostGit, phaseProofRecords, renderProofCurrency } from "./proof-currency";
import { builtinWorkflow } from "../../workflow";
import { architectStarter } from "../../workflow/server";
import { recheckPlanFact } from "../../writer/server";
import { critiqueProblems, roleLine, type DesignJournalLine, type DrawingCritique } from "../../design-eval";

export const DESIGN_JOURNAL = "lp.design.journal";
export const ROLE_LINES = "lp.role.lines";

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
      // A binary file the stage itself produced (the drawing's PNG): the text reader refuses it, so its hash and size come from the host.
      if (cause instanceof Error && cause.message.includes("lane_pilot_read_binary_rejected")) {
        const fingerprint = await binaryFingerprint(phase, path);
        if (fingerprint) return fingerprint;
      }
      throw new PhaseRefusal(`cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function binaryFingerprint(phase: Phase, path: string): Promise<{ sha256: string; sizeBytes: number } | null> {
    const command = binaryFileCommand(path);
    const run = phase.runId ? getRun(db, phase.runId) : null;
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    if (!command || !run?.writer_workspace_path || !hostId) return null;
    const ran = await runOnHost(bb.hosts.experimental_client({ contract: hostContract }), { hostId, cwd: run.writer_workspace_path, command, timeoutSec: 30 }).catch(() => null);
    return ran && ran.exitCode === 0 ? binaryFileFingerprint(ran.stdout) : null;
  }

  /** The design measurement journal (src/rooms/design-eval/training.ts) and the designer's role lines, in the plugin's store. */
  async function journalDrawing(line: DesignJournalLine): Promise<void> {
    const lines = ((await bb.storage.kv.get(DESIGN_JOURNAL).catch(() => null)) as DesignJournalLine[] | null) ?? [];
    await bb.storage.kv.set(DESIGN_JOURNAL, [...lines, line].slice(-2000) as never);
  }
  async function noteDesignWord(phaseId: string, decision: "yes" | "no"): Promise<void> {
    const lines = ((await bb.storage.kv.get(DESIGN_JOURNAL).catch(() => null)) as DesignJournalLine[] | null) ?? [];
    const last = [...lines].reverse().find((line) => line.phaseId === phaseId);
    if (!last) return;
    last.ownerWord = decision;
    if (decision === "no") last.firstPass = false;
    await bb.storage.kv.set(DESIGN_JOURNAL, lines as never);
  }
  async function addRoleLine(projectId: string, role: string, line: string): Promise<void> {
    const key = `${ROLE_LINES}:${projectId}:${role}`;
    const lines = ((await bb.storage.kv.get(key).catch(() => null)) as string[] | null) ?? [];
    if (!lines.includes(line)) await bb.storage.kv.set(key, [...lines, line].slice(-30) as never);
  }

  /** A file's text in the PM's workspace, or null when it does not exist. */
  async function readText(phase: Phase, path: string): Promise<string | null> {
    try {
      const file = await services.readWriterWorkspaceFile({ threadId: phase.pmThreadId, projectId: phase.projectId, path, offset: 0, maxLines: 2000 }) as { content?: string };
      return typeof file.content === "string" ? file.content : null;
    } catch { return null; }
  }

  /** Writes phase documents and planning marks into the project, then commits exactly those files (SMA: Commit the plans / drawing / REVIEW / STATE). */
  async function writeDocs(phase: Phase, files: Array<{ path: string; content: string }>, message: string): Promise<{ written: string[]; commit: string | null }> {
    if (!phase.runId || !files.length) return { written: [], commit: null };
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return { written: [], commit: null };
    const edits = [];
    for (const file of files) {
      const current = await readText(phase, file.path);
      edits.push({ path: file.path, expectedSha256: current === null ? null : sha256(current), content: file.content });
    }
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const result = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, previewSha256: sha256(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
    const written = result.writes.filter((row) => row.status === "applied").map((row) => row.path);
    if (!written.length) return { written, commit: null };
    const committed = await host.call("gitCommitDocs", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, paths: written, message }, { hostId, timeoutMs: 60_000 }).catch(() => null);
    return { written, commit: committed?.commit ?? null };
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

  async function open(input: { projectId: string; pmThreadId: string; title: string; goal: string; legacy?: boolean; roadmapRow?: string; rails?: boolean }): Promise<Phase> {
    const id = `ph_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const runId = (db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? ORDER BY created_at DESC LIMIT 1").get(input.pmThreadId) as { id: string } | undefined)?.id ?? null;
    insertPhase(db, { id, projectId: input.projectId, pmThreadId: input.pmThreadId, runId, title: input.title.slice(0, 200), goal: input.goal.slice(0, 4000), at: now() });
    const settings = await ctx.effectiveProjectSettings(input.projectId).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
    const ownerWords = ownerWordsOn(settings);
    const waveReview = String(settings["phase.wave_review"] ?? "on") !== "off";
    const capSetting = Number(settings["phase.issue_cap"] ?? 8);
    const issueCap = Number.isInteger(capSetting) && capSetting >= 1 && capSetting <= 50 ? capSetting : 8;
    let phase = mustGet(id);
    book(phase, "goal", "opened", `phase opened: ${input.title}${ownerWords ? " (the owner's word is asked at the turns: owner.words on)" : ""}`);
    const record: PhaseRecord = { ownerWords, waveReview, issueCap, scope: { revisions: 0, withdrawn: [] },
      autonomous: String(settings["phase.autonomous"] ?? "off") === "on", subagents: String(settings["phase.subagents"] ?? "on") !== "off",
      branch: String(settings["phase.branch"] ?? "none") === "phase" ? "phase" : "none", ...(input.roadmapRow ? { roadmapRow: input.roadmapRow } : {}), ...(input.rails ? { rails: true } : {}),
      ...(String(settings["phase.train"] ?? "on") === "off" ? { train: false } : {}) };
    if (input.legacy) {
      // Legacy mode without signature: a plan written before the phase existed is admitted on its own; the book says so.
      record.context = { docs: [], sha: sha256(`legacy:${id}`), signedAt: now(), legacy: true };
      move(phase, "planning", record, "legacy mode: the plan exists already, there is no signed discussion");
    } else savePhase(db, phase.id, { record, at: now() });
    phase = mustGet(id);
    return phase;
  }

  async function context(input: Reported & { docs: string[]; risks?: Partial<Record<RiskKey, string>>; requirements?: string[]; decisions?: string[]; appetite?: string; noGos?: string[] }): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "discussion") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: return it to discussion first to change its context`);
    const docs: ContextDoc[] = [];
    for (const path of [...new Set(input.docs)].slice(0, 20)) {
      const file = await readFile(phase, path);
      docs.push({ path, sha256: file.sha256, bytes: file.sizeBytes });
    }
    const risks = Object.fromEntries([...RISK_KINDS, "security" as const].map((kind) => [kind, input.risks?.[kind]?.trim() ?? ""]).filter(([, text]) => text)) as Partial<Record<RiskKey, string>>;
    const noGos = (input.noGos ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 30);
    const record: PhaseRecord = { ...phase.record, context: { docs, sha: contextSignature(docs), signedAt: now(), risks,
      ...(input.appetite?.trim() ? { appetite: input.appetite.trim().slice(0, 600) } : {}), ...(noGos.length ? { noGos } : {}),
      ...(input.requirements?.length ? { requirements: [...new Set(input.requirements)] } : {}), ...(input.decisions?.length ? { decisions: [...new Set(input.decisions)] } : {}) } };
    const check = discussionGate(record);
    if (!check.ok) { savePhase(db, phase.id, { record, at: now() }); throw new PhaseRefusal("the discussion is not complete", check.why); }
    book(phase, "discussion", "signed", `context signed ${record.context!.sha.slice(0, 12)}: ${docs.map((doc) => `${doc.path} (${doc.bytes} B)`).join(", ")}; appetite — ${record.context!.appetite ?? "—"}; no-gos — ${noGos.join("; ") || "—"}; risks — ${[...RISK_KINDS, "security" as const].filter((kind) => risks[kind]).map((kind) => `${kind}: ${risks[kind]}`).join("; ")}`);
    // Context signature (SMA p1_confirm): the author is a person. With owner.words on the machine's signature waits for his word «context».
    if (record.ownerWords) {
      savePhase(db, phase.id, { record, at: now() });
      book(phase, "discussion", "awaits_signature", "the context is complete and awaits the owner's signature (his word «context»)");
      return mustGet(phase.id);
    }
    move(phase, "planning", record, "the context documents exist, none is empty, and they are signed");
    return mustGet(phase.id);
  }

  function plan(input: Reported & { items: PlanItem[]; design?: boolean; alreadyMet?: string }): Phase {
    const phase = mustGet(input.phaseId);
    // No replanning of a closed phase: its book is final; a new goal is a new phase.
    if (phase.stage === "closed" || phase.state === "closed") throw new PhaseRefusal(`phase ${phase.id} is closed: open a new phase for new work`);
    if (phase.stage !== "planning") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: a plan is submitted at planning (return the phase there first)`);
    if (!phase.record.context) throw new PhaseRefusal("the phase has no signed context");
    const items = input.items.map((item) => ({ ...item, task: { ...item.task, id: item.id } }));
    const contextSha = phase.record.context.sha;
    // `alreadyMet`: the planner found the repository already doing what the goal asks, a plan with no pieces that the plan gate admits as such.
    const record: PhaseRecord = { ...phase.record, plan: { items, contextSha, sha: planSignature(items, contextSha), rounds: phase.record.plan?.rounds ?? 0, ...(input.alreadyMet ? { alreadyMet: { evidence: input.alreadyMet.slice(0, 1000) } } : {}) } };
    if (input.design) record.design = { decision: "needed", why: "the PM asked for a drawing" };
    savePhase(db, phase.id, { record, at: now() });
    if (input.alreadyMet) book(phase, "plan", "already_met", `the planner found the goal already met, no pieces to build: ${input.alreadyMet.slice(0, 1000)}`);
    else book(phase, "plan", "submitted", `plan ${record.plan!.sha.slice(0, 12)}: ${items.length} piece(s) in ${new Set(items.map((item) => item.wave)).size} wave(s) — ${items.map((item) => `${item.id} (w${item.wave}): ${item.promise.then}`).join("; ")}`);
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
    const rounds = (phase.record.plan.rounds ?? 0) + (input.decision === "changes_requested" ? 1 : 0);
    const record: PhaseRecord = { ...phase.record, plan: { ...phase.record.plan, rounds, critique: { decision: input.decision, by: input.by, ...(input.summary ? { summary: input.summary } : {}) } } };
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

  async function drawing(input: Reported & { paths: string[]; designer: string; feasible: boolean; contradiction?: string; reviewer?: string; critique?: DrawingCritique; lesson?: string }): Promise<Phase> {
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
    const drawn = { paths: input.paths, sha256: sha256(hashes.join("\n")), designer: input.designer, feasible: input.feasible, ...(input.contradiction ? { contradiction: input.contradiction } : {}), ...(input.reviewer ? { reviewer: input.reviewer } : {}) };
    // The previous contract to the archive: a replaced drawing stays in the record with its hash.
    const archived = archiveDrawing(phase.record, drawn);
    if (archived.length > (phase.record.design?.archived?.length ?? 0)) book(phase, "design", "archived", `previous drawing ${phase.record.design!.drawing!.sha256.slice(0, 12)} (${phase.record.design!.drawing!.paths.join(", ")}) archived`);
    const record: PhaseRecord = { ...phase.record, design: { ...(phase.record.design ?? { decision: "needed", why: "" }), drawing: drawn, archived } };
    if (input.critique) {
      const why = critiqueProblems(input.critique);
      if (why.length) throw new PhaseRefusal("the drawing critique form is not filled", why);
    }
    // The design measurement journal: one line per drawing; first pass = the first drawing of the phase, feasible, and passed by its critic.
    await journalDrawing({ at: now(), projectId: phase.projectId, phaseId: phase.id, designer: input.designer, reviewer: input.reviewer ?? null, drawingSha: drawn.sha256,
      firstPass: archived.length === 0 && input.feasible && (input.critique ? input.critique.verdict === "pass" : true), critique: input.critique ?? null, codeScore: null, ownerWord: null });
    if (input.lesson?.trim()) await addRoleLine(phase.projectId, "design-lead", roleLine(input.lesson));
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
    // Reviewer saw these bytes (SMA p7_saw_bytes): the review names the sha256 of exactly the analysis it read, not of the book around it
    // (2026-10-29 audit: a new analysis with the book's hash was accepted with no read of its own bytes).
    const analysis = input.analysis.slice(0, 4000);
    if (input.reviewedHash !== sha256(analysis)) throw new PhaseRefusal(`the reviewer read other bytes: the analysis hashes to ${sha256(analysis).slice(0, 12)}, the review names ${input.reviewedHash.slice(0, 12)}`);
    const text = `Phase «${phase.title}» lessons: ${analysis}`.slice(0, 2000);
    const record: PhaseRecord = { ...phase.record, lessons: { ...(phase.record.lessons ?? { needed: true, why: "" }), analysis, author: input.author, reviewer: input.reviewer, reviewedHash: input.reviewedHash, at: now(),
      ...(phase.record.ownerWords ? { draft: { text, stagedAt: now(), state: "staged" as const } } : {}) } };
    book(phase, "lessons", "analysis", `${analysis} (by ${input.author}, reviewed by ${input.reviewer}, bytes ${input.reviewedHash.slice(0, 12)})`);
    if (phase.record.ownerWords) {
      // Lesson is a draft (SMA p7_staged): it waits for the person's word in drafts; the phase does not wait for it.
      book(phase, "lessons", "staged", "the lesson waits as a draft for the owner's word «lesson»");
      postOwnerItem(db as never, { key: `phase-word:${phase.id}:lesson`, source: "phase", kind: "word", projectId: phase.projectId,
        what: `Phase «${phase.title}»: the lesson draft — apply it to memory?`, why: text.slice(0, 600) });
    } else writeLesson(phase, text);
    move(phase, "closed", record, "the lessons are written and reviewed");
    savePhase(db, phase.id, { state: "closed", at: now() });
    return mustGet(phase.id);
  }

  /** Lesson written by the pipeline: the analysis goes through the memory door as a note of the project (refused text stays only in the book). */
  function writeLesson(phase: Phase, text: string): string | null {
    try {
      storeMemoryRecords(db, { projectId: phase.projectId, audience: "subagent", sourceSha256: sha256(`${phase.id}:${text}`), origin: "phase-lessons",
        scope: phase.runId ? getRunSettingsScopes(db, phase.runId) : [], coreBudget: 3072, noteBudget: 200_000, indexBudget: 65536,
        entries: [{ kind: "note", content: text, concepts: ["phase", "lessons"] }] });
      return null;
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      book(phase, "lessons", "memory_refused", `the memory door refused the lesson: ${why}`);
      return why;
    }
  }

  /** The owner's word on the lesson draft: yes applies it to memory (SMA m_apply), no declines it; a write that did not land is tried again on a later pass. */
  function settleLesson(phase: Phase, decision: "yes" | "no"): void {
    const draft = phase.record.lessons?.draft;
    if (!draft || draft.state !== "staged") throw new PhaseRefusal(`phase ${phase.id} has no lesson draft waiting`);
    const error = decision === "yes" ? writeLesson(phase, draft.text) : null;
    const next = decision === "no" ? { ...draft, state: "declined" as const, at: now() } : error ? { ...draft, error, at: now() } : { ...draft, state: "applied" as const, at: now(), error: undefined };
    if (!error) book(phase, "lessons", decision === "yes" ? "lesson_applied" : "lesson_declined", decision === "yes" ? "the owner applied the lesson draft: it is in memory" : "the owner declined the lesson draft");
    savePhase(db, phase.id, { record: { ...phase.record, lessons: { ...phase.record.lessons!, draft: next } }, at: now() });
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
  async function word(input: Reported & { turn: WordTurn; decision: "yes" | "no"; text: string; wave?: number; useful?: boolean; limits?: boolean }): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    // Keyed decision on the phase (SMA p6_decide): two decisions under the key of the shown package.
    if (input.turn === "acceptance" && input.decision === "yes" && !(input.useful === true && input.limits === true))
      throw new PhaseRefusal("the acceptance is two decisions: the result is clear and useful (useful:true) and the remaining limits and recovery are acknowledged (limits:true); a «no» to either is decision no with the words why");
    // Consent is the whole message: «да» alone is consent; «да, но …» is a new word that goes back as words, not as yes.
    if (input.decision === "yes" && !isWholeConsent(input.text) && !/^owner via (screen|cli)$/.test(input.by ?? "")) throw new PhaseRefusal("the owner's message is not a whole consent: «да, но …» is a new word — record it as decision no with his words, or ask again");
    if (input.turn === "uat" && input.decision === "yes") {
      // Session complete: the owner's yes on UAT counts only when every line of UAT.md is marked passed.
      const path = phase.record.uat?.path;
      const text = path ? await readText(phase, path) : null;
      const state = text ? uatState(text) : null;
      if (!state || !state.lines || state.open.length || state.failed.length) throw new PhaseRefusal(`UAT is not complete: ${!state ? "no UAT.md" : `${state.open.length} open, ${state.failed.length} failed of ${state.lines}`} — the owner marks each line in ${path ?? "UAT.md"} first`);
    }
    const record: PhaseRecord = { ...phase.record, words: [...(phase.record.words ?? []), { turn: input.turn, decision: input.decision, by: input.by ?? "owner", text: input.text.slice(0, 2000), at: now(), ...(input.wave !== undefined ? { wave: input.wave } : {}),
      ...(input.turn === "acceptance" ? { useful: input.useful === true, limits: input.limits === true, key: acceptanceKey(phase.record) } : {}) }] };
    closeOwnerItem(db as never, `phase-word:${phase.id}:${input.turn}${input.wave !== undefined ? `:${input.wave}` : ""}`, input.by ?? "owner");
    book(phase, "decisions", `word_${input.turn}`, `${input.by ?? "owner"}: ${input.decision} — ${input.text}`);
    if (input.turn === "design") await noteDesignWord(phase.id, input.decision);
    savePhase(db, phase.id, { record, at: now() });
    if (input.turn === "lesson") { settleLesson(mustGet(phase.id), input.decision); return mustGet(phase.id); }
    if (input.turn === "context") {
      if (phase.stage !== "discussion" || !record.context) return mustGet(phase.id);
      // The owner signs the context, or says no: then it is unsigned and the discussion goes on with his words in the book.
      if (input.decision === "no") { savePhase(db, phase.id, { record: { ...record, context: undefined }, at: now() }); return mustGet(phase.id); }
      if (discussionGate(record).ok) move(phase, "planning", record, "the owner signed the context");
      return mustGet(phase.id);
    }
    if (input.decision === "no") {
      const to: PhaseStage = input.turn === "acceptance" || input.turn === "uat" ? "execution" : "planning";
      if (PHASE_STAGES.indexOf(to) < PHASE_STAGES.indexOf(phase.stage)) return returnTo({ phaseId: phase.id, to, note: `the owner said no at ${input.turn}: ${input.text}`, by: input.by ?? "owner" });
    }
    if (input.decision === "yes" && phase.stage === "planning" && input.turn === "planning") return admitIfReady(mustGet(phase.id));
    return mustGet(phase.id);
  }

  /** Wave verified by another model: the PM reports the review of a finished wave; a failed one returns the phase to execution's fixes. */
  function waveReview(input: Reported & { wave: number; state: "passed" | "failed"; by: string; summary: string }): Phase {
    const phase = mustGet(input.phaseId);
    const waves = { ...(phase.record.execution?.waves ?? {}) };
    const done = waves[String(input.wave)];
    if (!done) throw new PhaseRefusal(`wave ${input.wave} is not finished yet`);
    waves[String(input.wave)] = { ...done, review: { state: input.state, by: input.by, summary: input.summary.slice(0, 2000), at: now() } };
    book(phase, "execution", `wave_${input.state}`, `wave ${input.wave} reviewed by ${input.by}: ${input.state} — ${input.summary}`);
    savePhase(db, phase.id, { record: { ...phase.record, execution: { ...phase.record.execution!, waves } }, at: now() });
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
    return mustGet(phase.id);
  }

  /**
   * Stop (SMA px_stop): the phase's work is stopped first, then the phase. Every open attempt of its pieces is canceled (the writer
   * stopped and its stop observed, cancelAttemptById) and its stage workflow ended; a writer whose stop was not observed is named in
   * the book and in the answer, never counted as stopped. Before 2026-10-29 the stop only wrote the state: a running piece went on.
   */
  async function stop(input: Reported & { words?: string }): Promise<{ phase: Phase; canceled: string[]; unconfirmed: string[] }> {
    const phase = mustGet(input.phaseId);
    const families = new Set(Object.values(phase.record.execution?.issued ?? {}).map(taskFamily));
    const canceled: string[] = [];
    const unconfirmed: string[] = [];
    for (const attempt of listOpenAttempts(db).filter((row) => row.run_id === phase.runId && families.has(taskFamily(row.task_id)))) {
      const result = await cancelAttemptById(ctx, attempt.id, services.rollback)
        .catch((cause: unknown) => ({ ok: false, state: "error", reason: cause instanceof Error ? cause.message : String(cause) }));
      if (result.ok) canceled.push(attempt.task_id);
      else unconfirmed.push(`${attempt.task_id} (${result.reason ?? result.state})`);
    }
    const auto = phase.record.auto;
    if (auto) {
      try { services.workflowEngine.cancel(auto.wfRunId, `phase ${phase.id} stopped`); } catch { /* a finished or unknown run: nothing to end */ }
      savePhase(db, phase.id, { record: { ...phase.record, auto: undefined }, at: now() });
    }
    book(phase, "execution", "work_stopped", [canceled.length ? `canceled: ${canceled.join(", ")}` : "no piece at work",
      ...(auto ? [`stage workflow ${auto.wfRunId} ended`] : []), ...(unconfirmed.length ? [`stop not observed yet: ${unconfirmed.join(", ")}`] : [])].join("; "));
    return { phase: setState({ ...input, state: "stop" }), canceled, unconfirmed };
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

  /** The next free redo id of a piece's family in the run: piece.2, piece.3, … */
  function redoId(pieceId: string, runId: string | null): string {
    const taken = runId ? (db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string }>).map((row) => row.id).filter((id) => taskFamily(id) === pieceId) : [];
    let n = 2;
    while (taken.includes(`${pieceId}.${n}`)) n += 1;
    return `${pieceId}.${n}`;
  }

  /** The PM chat's checkout: the folder a piece runs in when the planner left its task's project_cwd out. */
  async function pmCheckoutPath(phase: Phase): Promise<string | null> {
    const pm = await bb.sdk.threads.get({ threadId: phase.pmThreadId }).catch(() => null) as { environmentId?: string } | null;
    const env = pm?.environmentId ? await bb.sdk.environments.get({ environmentId: pm.environmentId }).catch(() => null) as { path?: string } | null : null;
    return typeof env?.path === "string" && env.path ? env.path : null;
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
    if (phase.record.ownerWords && wordOf(phase.record, "issue")?.decision !== "yes") return phase;
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
    for (const item of next.slice(0, seats)) {
      // A piece issued before with another contract goes again as a redo of its family (id.N), so its facts follow the new work.
      const redoOf = execution.issued[item.id];
      const taskIdForIssue = redoOf ? redoId(item.id, runId) : item.id;
      const reply: Record<string, unknown> = await services.dispatchWriter({ threadId: phase.pmThreadId, projectId: phase.projectId, birth: "phase",
        // Stage above ordinary work: a phase's pieces start before the run's ordinary tasks when writers are scarce.
        task: { ...item.task, id: taskIdForIssue, priority: (item.task.priority as string | undefined) ?? "high", ...(phase.record.design?.drawing ? { drawing: phase.record.design.drawing.paths } : {}),
          ...(typeof item.task.project_cwd === "string" && item.task.project_cwd ? {} : { project_cwd: (checkout ??= await pmCheckoutPath(phase)) ?? undefined }),
          ...(typeof item.task.objective === "string" && item.task.objective.trim() ? {} : { objective: `${item.title}: given ${item.promise.given}, when ${item.promise.when}, then ${item.promise.then}` }) } as never,
        plan: `Phase ${phase.id} «${phase.title}», wave ${item.wave}, piece ${item.id}. Promise — given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}.${phase.record.design?.drawing ? ` The phase drawing: ${phase.record.design.drawing.paths.join(", ")} — the screens follow it.` : ""}`,
        objective: phase.goal }).catch((cause: unknown) => ({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }));
      const taskId = typeof reply.taskId === "string" ? reply.taskId : null;
      if (taskId) {
        execution.issued[item.id] = taskId;
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
    }
    // Phase base at start: the commit the first piece was cut from.
    const firstTask = Object.values(execution.issued)[0];
    const baseSha = phase.record.execution?.baseSha ?? (firstTask ? (db.prepare("SELECT base_sha FROM lane_pilot_task_git_base WHERE task_id=? LIMIT 1").get(firstTask) as { base_sha?: string } | undefined)?.base_sha ?? null : null);
    // The waves' records stay (they were dropped here before), and a new issue clears the «nothing changed» stop.
    savePhase(db, phase.id, { record: { ...phase.record, execution: { ...execution, baseSha, acceptedNoted: phase.record.execution?.acceptedNoted ?? [], ...(phase.record.execution?.waves ? { waves: phase.record.execution.waves } : {}),
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
      const state = await recheckPlanFact(ctx, { projectId: phase.projectId, runId: phase.runId, taskId: fact.taskId, hostId })
        .catch((cause: unknown) => { ctx.log(`phase ${phase.id}: plan-fact of ${fact.taskId} not weighed again: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (state) book(phase, "execution", "plan_fact_recheck", `${pieceId} (task ${fact.taskId}): plan-fact weighed again by the current rules of the check: ${state}`);
    }
  }

  /** One step of a phase. Reconciling after force: every tick reads the pieces' facts afresh, so a phase paused, stopped or edited by hand
   * continues from what the attempts and receipts say now, not from what it last believed. */
  async function drive(phase: Phase): Promise<Phase> {
    if (phase.state === "pause_requested") { savePhase(db, phase.id, { state: "paused", at: now() }); return mustGet(phase.id); }
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
        const lines = waveLines(pieces, f);
        waves[String(wave)] = { packageSha: wavePackage(pieces, f), lines, at: now() };
        book(current, "execution", "wave_in", `wave ${wave} in, package ${waves[String(wave)]!.packageSha.slice(0, 12)}: ${lines.map((line) => `${line.ok ? "✓" : "✗"} ${line.id}`).join(", ")}`);
        wrote = true;
      }
      if (wrote) { savePhase(db, current.id, { record: { ...current.record, execution: { ...current.record.execution!, waves } }, at: now() }); current = mustGet(current.id); }
      // Every wave is verified by another model before the phase leaves execution, the last one too (Matvey: «волну проверяет другая
      // модель»); the machine's review of the last wave had no pass to start in before the phase moved on.
      const unreviewed = current.record.waveReview ? Object.entries(current.record.execution?.waves ?? {}).filter(([, done]) => done.review?.state !== "passed").map(([wave]) => wave) : [];
      if (executionGate(items, current.record.execution?.issued ?? {}, facts(current)).ok && !unreviewed.length) {
        // Nothing changed since a verdict failed on these very facts: verifying again would fail the same way, and its poke is the
        // one the PM was already given — the phase stalled silently (live ph_ae0a8de9db). It waits for new work instead.
        const goal = current.runId ? getRunGoal(db, current.runId) : null;
        const would = blindVerdict(items, facts(current), goal, now());
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
      const goal = getRunGoal(db, current.runId) ?? await services.runGoal.check(current.runId).catch(() => null);
      if (goal) {
        const verdict = blindVerdict(current.record.plan?.items ?? [], facts(current), goal, now());
        // The goal check is still running: nothing is frozen, the next pass asks again.
        if (verdict.state === "pending") return current;
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
    if (current.stage === "acceptance" && current.record.ownerWords && !current.record.uat) {
      // Create UAT.md: with owner.words on, the plan's promises become the lines the owner tests and answers.
      const path = `${phaseFolder(current.id)}/UAT.md`;
      const content = uatText(current);
      const out = await writeDocs(current, [{ path, content }], `phase ${current.id}: UAT.md for the owner`).catch(() => ({ written: [] as string[], commit: null }));
      if (out.written.includes(path)) {
        book(current, "acceptance", "uat_written", `${path}: ${(current.record.plan?.items ?? []).length} line(s) for the owner`);
        savePhase(db, current.id, { record: { ...current.record, uat: { path, sha256: sha256(content), at: now() } }, at: now() });
        current = mustGet(current.id);
      }
    }
    if (current.stage === "acceptance") {
      const lastGoal = current.runId ? getRunGoal(db, current.runId) : null;
      const openDeferrals = (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_deferral WHERE project_id=? AND closed_at IS NULL").get(current.projectId) as { n: number } | undefined)?.n ?? 0;
      const lines = acceptanceLines(current, facts(current), { mainSha: lastGoal?.headSha ?? null, openDeferrals, noTerm: noTermDeferralsOf(db, current.projectId) });
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

  /**
   * A closed phase finishes its paperwork once (SMA: The daemon writes the conclusion, Phase closed in the roadmap, Marks in STATE and roadmap,
   * Phase or milestone branch, transition / autonomous): SUMMARY.md, the roadmap row's [x], STATE's phase and stage, all committed; the marker
   * branch phase/<id> when phase.branch is on; and with phase.autonomous on, the next open roadmap row is opened as the next phase.
   */
  async function finishClosed(phase: Phase): Promise<Phase> {
    if (phase.stage !== "closed" || phase.record.closedDocs) return phase;
    const files: Array<{ path: string; content: string }> = [{ path: `${phaseFolder(phase.id)}/SUMMARY.md`, content: conclusionText(phase, listParts(db, phase.id), facts(phase)) }];
    const roadmap = await readText(phase, ".agents/planning/ROADMAP.md");
    if (roadmap !== null && phase.record.roadmapRow) {
      const marked = markRoadmap(roadmap, phase.record.roadmapRow);
      if (marked !== roadmap) files.push({ path: ".agents/planning/ROADMAP.md", content: marked });
    }
    const stateNow = await readText(phase, ".agents/planning/STATE.md");
    if (stateNow !== null || roadmap !== null) files.push({ path: ".agents/planning/STATE.md", content: stateText(stateNow, { phase: phase.record.roadmapRow ?? phase.id, stage: "closed", last_phase: phase.id }) });
    const out = await writeDocs(phase, files, `phase ${phase.id}: closed — summary, roadmap and state`).catch((cause: unknown) => { ctx.log(`phase ${phase.id}: closing documents not written: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
    if (!out) return phase;
    book(phase, "lessons", "concluded", `SUMMARY.md written${out.written.length > 1 ? `, ${out.written.slice(1).join(", ")} marked` : ""}${out.commit ? ` (commit ${out.commit.slice(0, 12)})` : ""}`);
    if (phase.record.branch === "phase" && phase.runId) {
      const run = getRun(db, phase.runId);
      const hostId = getRunWriterHost(db, phase.runId);
      if (run?.writer_workspace_path && hostId) {
        const host = bb.hosts.experimental_client({ contract: hostContract });
        const made = await runOnHost(host, { hostId, cwd: run.writer_workspace_path, command: `git branch -f phase/${phase.id} HEAD`, timeoutSec: 30 }).catch(() => null);
        book(phase, "decisions", "branch", made && made.exitCode === 0 ? `marker branch phase/${phase.id} at the accepted main` : "the marker branch could not be made");
      }
    }
    savePhase(db, phase.id, { record: { ...phase.record, closedDocs: { at: now(), commit: out.commit } }, at: now() });
    const next = roadmap !== null ? nextRoadmapRow(phase.record.roadmapRow ? markRoadmap(roadmap, phase.record.roadmapRow) : roadmap) : null;
    if (next && phase.record.autonomous) {
      // Autonomous mode: the next roadmap row becomes the next phase, and its discussion starts at once.
      const opened = await open({ projectId: phase.projectId, pmThreadId: phase.pmThreadId, title: next.name, goal: next.goal || next.name, roadmapRow: next.n });
      book(phase, "decisions", "transition", `autonomous: the next phase ${opened.id} «${next.name}» (roadmap ${next.n}) is open`);
    } else if (next) {
      await bb.sdk.threads.send({ threadId: phase.pmThreadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
        `[Lane Pilot phase] Phase ${phase.id} «${phase.title}» is closed. Next on the roadmap: ${next.n} «${next.name}»${next.goal ? ` — ${next.goal}` : ""}. Open it with lane_pilot_phase {action:"open", title, goal, roadmapRow:"${next.n}"} when it is time.` }] } as never).catch(() => undefined);
    }
    return mustGet(phase.id);
  }

  /** Sends the PM the one instruction the phase needs now, once per instruction key. */
  async function poke(phase: Phase & { pokedKey?: string | null }): Promise<void> {
    const action = nextAction(phase, facts(phase));
    // Call about a waiting decision: a turn that needs the owner's word is also a row on «Ждут владельца» (and its Telegram digest).
    const wordTurn = action.key.match(/:word:([a-z]+)(?::(\d+))?(?::[0-9a-f]+)?$/);
    if (wordTurn) postOwnerItem(db as never, { key: `phase-word:${phase.id}:${wordTurn[1]}${wordTurn[2] ? `:${wordTurn[2]}` : ""}`, source: "phase", kind: "word", projectId: phase.projectId,
      what: `Phase «${phase.title}»: your word at ${wordTurn[1]}${wordTurn[2] ? ` (wave ${wordTurn[2]})` : ""}`, why: action.text.slice(0, 600) });
    // Aging said once a day; a stalled phase named in the book only: no part for three days (or twelve hours at execution with pieces at work). The PM is not
    // woken with it: it already got the step once (pokedKey), and a daily repeat to an idle chat rewrote its whole context for nothing
    // (live ph_26f65b142d, 2026-10-27..29: three wake-ups for a step the PM had declined).
    const lastPart = listParts(db, phase.id).at(-1)?.at ?? phase.createdAt;
    const quiet = now() - lastPart;
    const stalled = phase.stage === "execution" ? quiet > 12 * 3_600_000 : quiet > 72 * 3_600_000;
    if (stalled && phase.state !== "closed" && now() - (phase.record.agingSaidAt ?? 0) > 86_400_000) {
      const days = Math.round(quiet / 86_400_000 * 10) / 10;
      book(phase, "decisions", "aging", `no movement for ${days} day(s) at ${phase.stage}`);
      savePhase(db, phase.id, { record: { ...mustGet(phase.id).record, agingSaidAt: now() }, at: now() });
    }
    const last = getPhase(db, phase.id)?.pokedKey ?? null;
    if (!action.waitsForPm || action.key === last) return;
    // A busy PM is not queued a step: by the time it is delivered the phase may have moved (live ph_9ed0f7f04b, 2026-10-24: the
    // discussion's step arrived after the phase was closed). The next pass, two minutes on, pokes it once it is idle.
    const thread = await bb.sdk.threads.get({ threadId: phase.pmThreadId }).catch(() => null) as { status?: unknown } | null;
    if (thread?.status !== "idle") return;
    await bb.sdk.threads.send({ threadId: phase.pmThreadId, mode: "queue-if-active", input: [{ type: "text", text: `[Lane Pilot phase] ${action.text}`, mentions: [] }] } as never).catch(() => undefined);
    notePoked(db, phase.id, action.key, now());
  }

  async function tick(signal?: AbortSignal): Promise<number> {
    let moved = 0;
    // A phase the machine stopped for a gap of its own goes on once a release closes the gap (not one a person stopped).
    for (const row of listPhases(db, { limit: 200 }).filter((candidate) => candidate.state === "stopped")) {
      const back = recoverStopped(row);
      if (!back) continue;
      savePhase(db, row.id, { state: "active", record: back.record, at: now() });
      book(row, "decisions", "resume_after_fix", back.note);
      moved += 1;
    }
    // Finish an accepted analysis (SMA p7_recover): a lesson the owner applied whose memory write did not land is written again, no new worker.
    for (const row of listPhases(db, { limit: 200 }).filter((candidate) => candidate.record.lessons?.draft?.state === "staged" && candidate.record.lessons.draft.error
      && wordOf(candidate.record, "lesson")?.decision === "yes")) settleLesson(row, "yes");
    // Closed phases that have not finished their paperwork yet are driven once more.
    const unfinished = listPhases(db, { limit: 200 }).filter((row) => row.stage === "closed" && !row.record.closedDocs && Date.now() - row.updatedAt < 7 * 86_400_000);
    for (const phase of [...listPhases(db, { live: true, limit: 100 }), ...unfinished]) {
      if (signal?.aborted || ctx.isDisposed()) break;
      try {
        const after = await finishClosed(await drive(phase));
        if (after.stage !== phase.stage || after.state !== phase.state) moved += 1;
        // The machine drives the train: a stage it can run is not poked to the PM.
        if (!(await auto.step(mustGet(after.id)))) await poke(mustGet(after.id));
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
    return { phase, next: nextAction(phase, facts(phase)), gates: { discussion: discussionGate(phase.record), plan: planGate(phase.record), design: designGate(phase.record) }, book: renderBook(phase, parts), bookHead: parts.at(-1)?.hash ?? null, openQuestions: openQuestions(phase.record, phase.stage), ownerWord: { asked: !!phase.record.ownerWords, context: wordOf(phase.record, "context") ?? null, planning: wordOf(phase.record, "planning") ?? null, design: wordOf(phase.record, "design") ?? null, acceptance: wordOf(phase.record, "acceptance") ?? null, acceptanceKey: acceptanceKey(phase.record) }, facts: Object.fromEntries(facts(phase)) };
  }

  /** Did the plan stay the admitted one (Plan unchanged since checking). */
  const planUnchanged = (phase: Phase) => !!phase.record.plan?.admittedSha && phase.record.plan.admittedSha === planSignature(phase.record.plan.items, phase.record.plan.contextSha);

  /** What git says of each proof the run recorded with a commit (accepted merges, the verdicts): still about the code, or stale; for the goal audit. */
  async function proofCurrency(phase: Phase): Promise<string | null> {
    if (!phase.runId) return null;
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return null;
    const records = phaseProofRecords(db, phase, getRunGoal(db, phase.runId));
    if (!records.length) return null;
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const git = hostGit((command) => runOnHost(host, { hostId, cwd: run.writer_workspace_path!, command, timeoutSec: 60 }));
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
        if ((await cancelAttemptById(ctx, attempt.id, services.rollback)).ok) canceled.push(attempt.task_id);
      }
    }
    const verdict = phase.record.verification?.model?.state === "unmet" ? `the goal audit: ${phase.record.verification.model.summary}` : phase.record.verification?.verdict?.state === "failed" ? `the verification: ${phase.record.verification.verdict.detail}` : "";
    // The obligations the acceptance does not hold: the same lines the normal path reads (the owner's decisions are not a machine obligation).
    const lastGoal = phase.runId ? getRunGoal(db, phase.runId) : null;
    const openDeferrals = (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_deferral WHERE project_id=? AND closed_at IS NULL").get(phase.projectId) as { n: number } | undefined)?.n ?? 0;
    const noTerm = noTermDeferralsOf(db, phase.projectId);
    const unmet = acceptanceLines(phase, f, { mainSha: lastGoal?.headSha ?? null, openDeferrals, noTerm })
      .filter((line) => !line.ok && line.id !== "result_useful" && (line.id !== "limits_acknowledged" || noTerm.length > 0)).map((line) => `${line.id}: ${line.detail}`.slice(0, 300));
    const cut = unproven.length ? `${unproven.map(({ item }) => item.id).join(", ")} withdrawn (${unproven.map(({ why }) => why).join(" | ").slice(0, 600)})` : "no piece to withdraw";
    const outcome = proven.length ? `the phase stops, partial: its ${proven.length} proved piece(s) stay accepted (${proven.map((item) => item.id).join(", ")}), the goal is not met` : "no piece is proved, so the phase stops (empty scope)";
    const done = `${input.stage} ran out of tries (${input.why.slice(0, 300)}). Scope cut: ${cut}${canceled.length ? `; canceled: ${canceled.join(", ")}` : ""}${verdict ? `; not proved: ${verdict.slice(0, 500)}` : ""}${unmet.length ? `; unmet: ${unmet.join(" | ").slice(0, 700)}` : ""}; ${outcome}.`;
    book(phase, "decisions", "scope_withdrawn", `${unproven.length ? unproven.map(({ item }) => item.id).join(", ") : "nothing"} withdrawn by Lane Pilot (loop exhausted at ${input.stage}): ${done}`.slice(0, 1800));
    const scope = { revisions: phase.record.scope?.revisions ?? 0, withdrawn: [...(phase.record.scope?.withdrawn ?? []), ...unproven.map(({ item }) => item.id)] };
    const partial = { at: now(), kept: proven.map((item) => item.id), unproven: unproven.map(({ item, why }) => ({ id: item.id, why: why.slice(0, 300) })), unmet };
    book(phase, "decisions", proven.length ? "exhausted_partial" : "exhausted_stop", outcome);
    savePhase(db, phase.id, { state: "stopped", at: now(), record: { ...phase.record, scope, auto: undefined, partial, closing: { by: "Lane Pilot (loop exhausted)", words: done.slice(0, 1000), at: now() },
      lessons: { needed: true, why: "the loop ran out of tries; the phase stopped without its goal met, the analysis of the cut is in the backlog" } } });
    await services.wall?.loopExhausted({
      kind: input.kind, id: `${phase.id}:${input.stage}`, title: `phase ${phase.id} «${phase.title}»: the ${input.stage} loop ran out of tries`, projectId: phase.projectId, runId: phase.runId,
      taskIds: Object.values(issued), facts: [`goal: ${phase.goal}`, `why the loop ended: ${input.why}`, `what the machine did: ${done}`, ...(verdict ? [verdict] : [])],
      texts: [{ path: "PHASE-BOOK", text: renderBook(mustGet(phase.id), listParts(db, phase.id)).slice(-18_000) }],
      done, pmThreadId: phase.pmThreadId,
      // No notice to the PM chat: an informational message wakes an idle chat for nothing; the book and the owner's morning list carry it.
    });
  }

  const auto = createAutoStages(ctx, services, {
    exhausted: exhaust,
    api: { context, plan, planCheck, question, waveReview, goalAudit, lessons, drawing, returnTo },
    get: mustGet,
    save: (phaseId, record) => savePhase(db, phaseId, { record, at: now() }),
    book: (phase, section, kind, text) => book(phase, section as never, kind, text),
    writeDocs,
    runtime: (phase) => (phase.runId ? { ctx, services, pmThreadId: phase.pmThreadId, projectId: phase.projectId, runId: phase.runId } : null),
    pmIdle: async (phase) => ((await bb.sdk.threads.get({ threadId: phase.pmThreadId }).catch(() => null)) as { status?: unknown } | null)?.status === "idle",
    now,
    runStopped: async (phase) => !!phase.runId && (await isRunHalted(bb.storage.kv as never, phase.runId) || await isRunPaused(bb.storage.kv as never, phase.runId)),
    proofCurrency,
  });
  const phases = { open, context, plan, planCheck, drawing, goalAudit, lessons, question, answer, word, waveReview, withdraw, revise, correct, returnTo, setState, stop, stopWave, compensate, tick, drive, status, facts, planUnchanged, writeBook,
    list: (filter: Parameters<typeof listPhases>[1]) => listPhases(db, filter) };
  const architect = architectStarter(ctx, services);
  // The small-task graph for a small job or a batch of fixes: started by the machine, not chosen by the PM.
  const train = {
    start: (input: { projectId: string; pmThreadId: string; runId: string; requestId: string; text: string; kind: "small" | "batch" }) => {
      // A batch of independent fixes is one task per fix (issue-batch); a small job is one task (issue-quick).
      const workflow = builtinWorkflow(input.kind === "batch" ? "issue-batch" : "issue-quick");
      if (!workflow) return null;
      const title = input.text.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? "Owner's request";
      try {
        const started = services.workflowEngine.start({ workflow, inputs: { title, text: input.text.slice(0, 8000) }, key: `intake:${input.pmThreadId}:${input.requestId}`,
          runtime: { ctx, services, pmThreadId: input.pmThreadId, projectId: input.projectId, runId: input.runId }, link: { projectId: input.projectId, runId: input.runId } });
        started.done.catch((cause: unknown) => ctx.log(`intake: ${workflow.id} ${started.runId} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
        return started.runId;
      } catch (cause) {
        ctx.log(`intake: ${workflow.id} did not start: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    },
    status: (wfRunId: string) => services.workflowEngine.get(wfRunId)?.status ?? null,
    startProcess: async (input: { projectId: string; pmThreadId: string; text: string }) => (await architect.startOrder(input)).threadId,
  };
  return { phases, phaseIntake: createPhaseIntake(ctx, phases, train) };
}
export type PhaseApi = ReturnType<typeof createPhaseDriver>["phases"];

export function mountPhaseDriver(ctx: ServerCore, api: PhaseApi): void {
  scheduleIsolated(ctx.bb, "phase-drive", "*/2 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.tick(signal).catch((cause: unknown) => ctx.log(`phase drive failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 30 * 60_000 });
}
