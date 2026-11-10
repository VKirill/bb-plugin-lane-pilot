import { phaseWordItemKey, phaseWordItemPrefix } from "./word-item";
import { randomUUID } from "node:crypto";
import { cancelAttemptById } from "../../runs/server";
import { taskFamily } from "@lane-pilot/contracts";
import { latestRunForPmThread, listOpenAttempts } from "../../storage";
import { isWholeConsent, ownerWordsOn } from "../../tasks";
import type { DrawingCritique } from "@lane-pilot/contracts";
import { sha256Hex, bestEffort } from "@lane-pilot/kit";
import { PHASE_STAGES, RETURN_STAGES, RISK_KINDS, acceptanceKey, checkerIndependence, contextSignature, designDecision, designGate, discussionGate, executionGate, phaseFolder, planGate, planGate as planGateOf, planSignature, staleAfterReturn, wordKeyOf } from "../logic";
import { archiveDrawing, uatState } from "../stages";
import { sendServiceMessage } from "../../relay/server";
import { insertPhase, listParts, listPhases, savePhase } from "../store";
import { PhaseRefusal, type DriverBase } from "./driver-tools";
import type { Docs } from "./driver-docs";
import type { Journal } from "./driver-journal";
import type { ContextDoc, Phase, PhaseRecord, PhaseStage, PlanItem, RiskKey, WordTurn } from "../logic";

type Reported = { phaseId: string; by?: string };
export type OpenInput = { projectId: string; pmThreadId: string; title: string; goal: string; legacy?: boolean; roadmapRow?: string; rails?: boolean };
export type ContextInput = Reported & { docs: string[]; risks?: Partial<Record<RiskKey, string>>; requirements?: string[]; decisions?: string[]; appetite?: string; noGos?: string[] };
export type PlanInput = Reported & { items: PlanItem[]; design?: boolean; alreadyMet?: string; fromRun?: string; objective?: string; premortem?: string[] };
export type PlanCheckInput = Reported & { decision: "approve" | "changes_requested"; by: string; summary?: string; wfRunId?: string };
export type DrawingInput = Reported & { paths: string[]; designer: string; feasible: boolean; contradiction?: string; reviewer?: string; critique?: DrawingCritique; lesson?: string };
export type GoalAuditInput = Reported & { state: "met" | "unmet"; by: string; summary: string };
export type LessonsInput = Reported & { analysis: string; reviewRun: string; reviewerNode?: string };
export type QuestionInput = Reported & { text: string; blocking: boolean };
export type AnswerInput = Reported & { questionId: string; answer: string };
export type WordInput = Reported & { turn: WordTurn; decision: "yes" | "no"; text: string; wave?: number; useful?: boolean; limits?: boolean; key?: string };
export type WaveReviewInput = Reported & { wave: number; state: "passed" | "failed"; by: string; summary: string };
export type WithdrawInput = Reported & { pieces: string[]; note: string };
export type ReviseInput = Reported & { goal: string; note: string };
export type CorrectInput = Reported & { note: string; pieces?: string[] };
export type ReturnToInput = Reported & { to: PhaseStage; note: string };
export type SetStateInput = Reported & { state: "pause" | "resume" | "stop" | "close"; words?: string };
export type StopInput = Reported & { words?: string };
export type StopWaveInput = Reported;
export type CompensateInput = Reported & { note: string };
export type UatLineInput = Reported & { line: number; result: "pass" | "fail"; note?: string };
export type DecideInput = Reported & { piece: string; choice: "skip" | "retry" | "cancel"; note?: string };
export type InterruptInput = Reported & { words?: string };

/**
 * The phase's state transitions: every method the PM, the owner or the machine calls to move a phase between its stages, and the
 * gates that admit a plan. Each one reads the phase, checks its gate in code, records the decision in the book and returns the
 * phase as it now is. The side effects on other rooms go through `tools.reactions`.
 */
export type MethodsTools = DriverBase & Docs & Journal;
export type Methods = ReturnType<typeof installMethods>;
export function installMethods(tools: MethodsTools) {
  const { ctx, services, db, bb, now, reactions } = tools;
  const { mustGet, book, move, facts, readFile, readText, writeDocs } = tools;

  async function open(input: { projectId: string; pmThreadId: string; title: string; goal: string; legacy?: boolean; roadmapRow?: string; rails?: boolean }): Promise<Phase> {
    // A roadmap row is one address (SMA pc_folder): a live phase already on it is named, never shadowed by a second.
    if (input.roadmapRow) {
      const held = listPhases(db, { projectId: input.projectId, live: true }).find((phase) => phase.record.roadmapRow === input.roadmapRow);
      if (held) throw new PhaseRefusal(`roadmap row ${input.roadmapRow} already has a live phase: ${held.id} «${held.title}» — work with that one, or close it first`);
    }
    const id = `ph_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const runId = latestRunForPmThread(db, input.pmThreadId)?.id ?? null;
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
      planBounce: String(settings["phase.plan_bounce"] ?? "off") === "on",
      browserQaOff: ["off", "false", "0"].includes(String(settings["browser_qa.enabled"] ?? "").toLowerCase()),
      branch: (() => { const mode = String(settings["phase.branch"] ?? "none"); return mode === "phase" || mode === "milestone" ? mode : "none"; })(), ...(input.roadmapRow ? { roadmapRow: input.roadmapRow } : {}), ...(input.rails ? { rails: true } : {}),
      ...(String(settings["phase.train"] ?? "on") === "off" ? { train: false } : {}) };
    if (input.legacy) {
      // Legacy mode without signature: a plan written before the phase existed is admitted on its own; the book says so.
      record.context = { docs: [], sha: sha256Hex(`legacy:${id}`), signedAt: now(), legacy: true };
      move(phase, "planning", record, "legacy mode: the plan exists already, there is no signed discussion");
    } else savePhase(db, phase.id, { record, at: now() });
    phase = mustGet(id);
    return phase;
  }

  async function context(input: ContextInput): Promise<Phase> {
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
    // SMA pc_contract: a yes counts only for the version it was given on — a context signed again voids the earlier word.
    if (record.context!.sha !== phase.record.context?.sha && record.words) record.words = record.words.filter((word) => word.turn !== "context");
    // A new signature is a new base for the plan: failures spent planning against the old documents are forgotten, so a phase
    // whose context was re-signed plans again (PH1: the plan tries stayed spent after the owner re-signed CONTEXT.md).
    if (record.context!.sha !== phase.record.context?.sha) {
      const drop = (map?: Partial<Record<string, number>>) => { if (!map) return undefined; const { plan: _plan, ...rest } = map; return Object.keys(rest).length ? rest : undefined; };
      record.autoFailures = drop(record.autoFailures);
      record.autoFailuresTotal = drop(record.autoFailuresTotal);
      record.autoMachineFailures = drop(record.autoMachineFailures);
    }
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

  function plan(input: PlanInput): Phase {
    const phase = mustGet(input.phaseId);
    // No replanning of a closed phase: its book is final; a new goal is a new phase.
    if (phase.stage === "closed" || phase.state === "closed") throw new PhaseRefusal(`phase ${phase.id} is closed: open a new phase for new work`);
    if (phase.stage !== "planning") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: a plan is submitted at planning (return the phase there first)`);
    if (!phase.record.context) throw new PhaseRefusal("the phase has no signed context");
    const items = input.items.map((item) => ({ ...item, task: { ...item.task, id: item.id } }));
    const contextSha = phase.record.context.sha;
    // `alreadyMet`: the planner found the repository already doing what the goal asks, a plan with no pieces that the plan gate admits as such.
    const record: PhaseRecord = { ...phase.record, plan: { items, contextSha, sha: planSignature(items, contextSha), rounds: phase.record.plan?.rounds ?? 0, submittedAt: now(),
      ...(input.objective?.trim() ? { objective: input.objective.trim().slice(0, 600) } : {}),
      ...(input.premortem?.length ? { premortem: input.premortem.map((risk) => risk.trim()).filter(Boolean).slice(0, 10) } : {}),
      ...(input.fromRun ? { fromRun: input.fromRun } : {}), ...(input.alreadyMet ? { alreadyMet: { evidence: input.alreadyMet.slice(0, 1000) } } : {}) } };
    // SMA pc_contract: a resubmitted plan with another signature voids the owner's earlier planning yes.
    if (record.plan!.sha !== phase.record.plan?.sha && record.words) record.words = record.words.filter((word) => word.turn !== "planning");
    if (input.design) record.design = designDecision(items, true);
    savePhase(db, phase.id, { record, at: now() });
    if (input.alreadyMet) book(phase, "plan", "already_met", `the planner found the goal already met, no pieces to build: ${input.alreadyMet.slice(0, 1000)}`);
    else book(phase, "plan", "submitted", `plan ${record.plan!.sha.slice(0, 12)}: ${items.length} piece(s) in ${new Set(items.map((item) => item.wave)).size} wave(s) — ${items.map((item) => `${item.id} (w${item.wave}): ${item.promise.then}`).join("; ")}`);
    return mustGet(phase.id);
  }

  async function planCheck(input: PlanCheckInput): Promise<Phase> {
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
    const steps = input.wfRunId ? tools.journalSteps(input.wfRunId) : null;
    const bound = input.wfRunId ? tools.checkerRunBinding(phase, input.wfRunId, input.decision) : null;
    const independence = !input.wfRunId ? undefined : !steps ? { ok: false, wfRunId: input.wfRunId, why: `workflow run ${input.wfRunId} is not in the journal` }
      : bound ? { ok: false, wfRunId: input.wfRunId, why: bound }
      : checkerIndependence(input.wfRunId, steps, { pmThread: phase.pmThreadId, submittedAt: phase.record.plan.submittedAt });
    const record: PhaseRecord = { ...phase.record, plan: { ...phase.record.plan, rounds, critique: { decision: input.decision, by: input.by, ...(input.summary ? { summary: input.summary } : {}), ...(independence ? { independence } : {}) } } };
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

  async function drawing(input: DrawingInput): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "design") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not design`);
    const folder = `${phaseFolder(phase.id)}/design/`;
    const outside = input.paths.filter((path) => !path.startsWith(folder) || path.includes(".."));
    if (outside.length) throw new PhaseRefusal(`the drawing lives in its own folder ${folder}`, outside.map((path) => `${path} is outside it`));
    const drawn: import("../logic").Drawing = { paths: input.paths.slice(0, 30), sha256: await tools.drawingSha(phase, input.paths.slice(0, 30)), designer: input.designer, feasible: input.feasible, ...(input.contradiction ? { contradiction: input.contradiction } : {}), ...(input.reviewer ? { reviewer: input.reviewer } : {}) };
    // The previous contract to the archive: a replaced drawing stays in the record with its hash.
    const archived = archiveDrawing(phase.record, drawn);
    if (archived.length > (phase.record.design?.archived?.length ?? 0)) book(phase, "design", "archived", `previous drawing ${phase.record.design!.drawing!.sha256.slice(0, 12)} (${phase.record.design!.drawing!.paths.join(", ")}) archived`);
    const record: PhaseRecord = { ...phase.record, design: { ...(phase.record.design ?? { decision: "needed", why: "" }), drawing: drawn, archived } };
    // SMA pc_contract: a redrawn drawing (another sha) voids the owner's earlier design yes.
    if (drawn.sha256 !== phase.record.design?.drawing?.sha256 && record.words) record.words = record.words.filter((word) => word.turn !== "design");
    if (input.critique) {
      const why = reactions.critiqueProblems(input.critique);
      if (why.length) throw new PhaseRefusal("the drawing critique form is not filled", why);
    }
    // The design measurement journal: one line per drawing; first pass = the first drawing of the phase, feasible, and passed by its critic.
    await reactions.journalDrawing({ at: now(), projectId: phase.projectId, phaseId: phase.id, designer: input.designer, reviewer: input.reviewer ?? null, drawingSha: drawn.sha256,
      firstPass: archived.length === 0 && input.feasible && (input.critique ? input.critique.verdict === "pass" : true), critique: input.critique ?? null, codeScore: null, ownerWord: null });
    if (input.lesson?.trim()) await reactions.addRoleLine(phase.projectId, "design-lead", reactions.roleLine(input.lesson));
    book(phase, "design", "drawing", `${input.paths.join(", ")} by ${input.designer}; ${input.feasible ? "feasible" : `contradiction: ${input.contradiction ?? "?"}`}${input.reviewer ? `; reviewed by ${input.reviewer}` : ""}`);
    if (!input.feasible) {
      savePhase(db, phase.id, { record, at: now() });
      return returnTo({ phaseId: phase.id, to: "planning", note: `the drawing contradicts the plan: ${input.contradiction ?? "no reason given"}`, by: input.designer });
    }
    // SMA p3_requirements: the contract is read, not only named — every required section has its heading in UI-SPEC.md.
    const specPath = drawn.paths.find((path) => /(UI-SPEC|DESIGN)\.md$/i.test(path));
    const specText = specPath ? await readText(phase, specPath) : null;
    const check = designGate(record, specText);
    if (!check.ok) {
      savePhase(db, phase.id, { record, at: now() });
      if (record.ownerWords && check.why.length === 1 && check.why[0]!.includes("owner's word")) return mustGet(phase.id);
      throw new PhaseRefusal("the drawing is not confirmed", check.why);
    }
    record.design = { ...record.design!, confirmedAt: now() };
    // SMA k_wd_c1: the drawing and its contract are committed by their explicit manifest paths (best effort — a failed
    // commit does not stop the phase, it is only booked). k_wd_version: paths the new drawing dropped get a one-line stub
    // at the old address pointing to the new file; the previous bytes stay at the drawing's own commit.
    const committed = await tools.commitFiles(phase, drawn.paths, `phase ${phase.id}: drawing and UI contract`);
    // The sha goes on the drawing itself, so the archived edition keeps it (SMA k_wd_version).
    if (committed.commit) {
      drawn.commit = committed.commit;
      book(phase, "design", "drawing_committed", `the drawing and its contract committed (${committed.commit.slice(0, 12)}): ${drawn.paths.join(", ")}`);
    } else book(phase, "design", "drawing_commit_failed", "the drawing could not be committed (no writer host or git refused): the phase goes on, the files are only hashed");
    const previous = phase.record.design?.drawing;
    if (previous) {
      const dropped = previous.paths.filter((path) => !drawn.paths.includes(path));
      if (dropped.length) {
        const note = `Superseded by ${drawn.paths.join(", ")}; previous bytes at commit ${previous.commit ?? "not recorded (archived before drawing commits)"}`;
        await bestEffort(ctx.log, "phase drawing superseded", writeDocs(phase, dropped.map((path) => ({ path, content: `${note}\n` })), `phase ${phase.id}: old drawing addresses link to the new one`), null);
        book(phase, "design", "drawing_superseded", `${dropped.join(", ")} now point to the new drawing; their bytes stay at commit ${previous.commit ?? "none recorded"}`);
      }
    }
    move(phase, "execution", { ...record, design: { ...record.design!, drawing: drawn } }, "the drawing is feasible and reviewed by a separate role");
    return mustGet(phase.id);
  }

  function goalAudit(input: GoalAuditInput): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "verification" || !phase.record.verification?.verdict) throw new PhaseRefusal("no blind verdict to audit yet");
    const record: PhaseRecord = { ...phase.record, verification: { ...phase.record.verification, model: { state: input.state, by: input.by, summary: input.summary.slice(0, 2000), at: now() } } };
    book(phase, "verification", "goal_audit", `${input.by}: ${input.state} — ${input.summary}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  function lessons(input: LessonsInput): Phase {
    const phase = mustGet(input.phaseId);
    if (phase.stage !== "lessons") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not lessons`);
    const analysis = input.analysis.slice(0, 4000);
    const read = tools.reviewerRead(phase, input.reviewRun, input.reviewerNode ?? "stage", analysis);
    if ("why" in read) throw new PhaseRefusal("the lessons are not proven read by their reviewer", [read.why]);
    const text = `Phase «${phase.title}» lessons: ${analysis}`.slice(0, 2000);
    const record: PhaseRecord = { ...phase.record, lessons: { ...(phase.record.lessons ?? { needed: true, why: "" }), analysis, author: read.author, reviewer: read.reviewer, reviewedHash: read.inputSha, reviewRun: input.reviewRun, at: now(),
      ...(phase.record.ownerWords ? { draft: { text, stagedAt: now(), state: "staged" as const } } : {}) } };
    book(phase, "lessons", "analysis", `${analysis} (by ${read.author}, read by ${read.reviewer} in ${input.reviewRun}, input ${read.inputSha.slice(0, 12)})`);
    if (phase.record.ownerWords) {
      // Lesson is a draft (SMA p7_staged): it waits for the person's word in drafts; the phase does not wait for it.
      book(phase, "lessons", "staged", "the lesson waits as a draft for the owner's word «lesson»");
      reactions.postOwnerItem({ key: phaseWordItemKey(phase.id, "lesson"), source: "phase", kind: "word", projectId: phase.projectId,
        what: `Этап «${phase.title}» завершён: записать его урок в память проекта?`, why: text.slice(0, 600) });
      reactions.askPhaseWord(phase, "lesson", undefined, text);
    } else tools.writeLesson(phase, text);
    move(phase, "closed", record, "the lessons are written and reviewed");
    // State «closed» comes only after finishClosed writes the closing documents and reads them back intact (SMA ta_closed).
    return mustGet(phase.id);
  }

  function question(input: QuestionInput): Phase {
    const phase = mustGet(input.phaseId);
    const id = `q${(phase.record.questions?.length ?? 0) + 1}`;
    const record: PhaseRecord = { ...phase.record, questions: [...(phase.record.questions ?? []), { id, stage: phase.stage, text: input.text.slice(0, 1000), blocking: input.blocking, askedAt: now() }] };
    book(phase, phase.stage === "planning" ? "plan" : "decisions", "question", `${id}${input.blocking ? " (blocking)" : ""}: ${input.text}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  function answer(input: AnswerInput): Phase {
    const phase = mustGet(input.phaseId);
    const questions = phase.record.questions ?? [];
    if (!questions.some((row) => row.id === input.questionId)) throw new PhaseRefusal(`no question ${input.questionId}`);
    const record: PhaseRecord = { ...phase.record, questions: questions.map((row) => row.id === input.questionId ? { ...row, answer: input.answer.slice(0, 2000), answeredBy: input.by ?? "pm", answeredAt: now() } : row) };
    book(phase, "decisions", "answer", `${input.questionId}: ${input.answer}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  /** The owner's word at a turn (owner.words on). «no» sends the phase back: from planning or design to planning, from acceptance to execution. */
  async function word(input: WordInput): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    // Keyed decision on the phase (SMA p6_decide): two decisions under the key of the shown package.
    if (input.turn === "acceptance" && input.decision === "yes" && !(input.useful === true && input.limits === true))
      throw new PhaseRefusal("the acceptance is two decisions: the result is clear and useful (useful:true) and the remaining limits and recovery are acknowledged (limits:true); a «no» to either is decision no with the words why");
    // The yes is for the package that was shown (SMA p6_decide, p6_stale): the caller names its key, and a package that changed since
    // is not signed by it (SMA audit N-02: the key was taken at write time, so a click on package A signed package B).
    // The design yes signs the drawing it was shown (SMA tb_design_gate_confirmed): without the drawing's hash, or over
    // an older edition, it is refused — a redrawn drawing needs a new yes.
    const drawingSha = phase.record.design?.drawing?.sha256 ?? null;
    if (input.turn === "design" && input.decision === "yes" && phase.record.ownerWords && input.key !== drawingSha)
      throw new PhaseRefusal(`the design yes names the hash of the drawing the owner was shown (status ownerWord.designKey, now ${drawingSha ?? "none"})`);
    const shownKey = acceptanceKey(phase.record);
    if (input.turn === "acceptance" && input.decision === "yes" && !input.key) throw new PhaseRefusal(`the acceptance yes names the key of the package the owner was shown (status ownerWord.acceptanceKey, now ${shownKey})`);
    if (input.turn === "acceptance" && input.decision === "yes" && input.key !== shownKey) throw new PhaseRefusal(`the package changed since it was shown (shown ${input.key}, now ${shownKey}): show the acceptance again and ask anew`);
    // The planning yes is for the proposal shown (SMA m_ce_proposal): a yes that names a key counts only for the plan with
    // that key (the PM takes it from status ownerWord.planKey); a yes without one is for the plan in the record now and is
    // stored with its key, so the owner's button keeps working. A project that sets phase.proposal_ttl_hours also refuses
    // a yes on a proposal older than that; unset there is no term — the owner often answers a day later.
    if (input.turn === "planning" && input.decision === "yes" && phase.record.ownerWords && phase.record.plan) {
      const plan = phase.record.plan;
      const settings = await ctx.effectiveProjectSettings(phase.projectId).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
      const ttlHours = Number(settings["phase.proposal_ttl_hours"] ?? NaN);
      if (plan.submittedAt && Number.isFinite(ttlHours) && ttlHours > 0 && now() - plan.submittedAt > ttlHours * 3_600_000) {
        throw new PhaseRefusal(`the proposal is stale (submitted ${Math.round((now() - plan.submittedAt) / 3_600_000)} h ago, phase.proposal_ttl_hours ${ttlHours}): show the plan again and ask anew`);
      }
      if (input.key && input.key !== plan.sha) throw new PhaseRefusal(`the plan changed since it was shown (shown ${input.key}, now ${plan.sha}): show the plan again and ask anew`);
    }
    // Consent is the whole message: «да» alone is consent; «да, но …» is a new word that goes back as words, not as yes.
    if (input.decision === "yes" && !isWholeConsent(input.text) && !/^owner via (screen|cli)$/.test(input.by ?? "")) throw new PhaseRefusal("the owner's message is not a whole consent: «да, но …» is a new word — record it as decision no with his words, or ask again");
    if (input.turn === "uat" && input.decision === "yes") {
      // Session complete (SMA p5_uat_line): the owner's yes counts only when every UAT line of the record is passed.
      const lines = phase.record.uat?.lines;
      if (lines) {
        const open = lines.filter((row) => row.state === "open"), failed = lines.filter((row) => row.state === "failed");
        if (open.length || failed.length || !lines.length) throw new PhaseRefusal(`UAT is not complete: ${open.length} open, ${failed.length} failed of ${lines.length} — the owner answers each line by its number (uat_line)`);
      } else {
        // A UAT written before the record lines existed: fall back to the checkboxes of UAT.md.
        const path = phase.record.uat?.path;
        const text = path ? await readText(phase, path) : null;
        const state = text ? uatState(text) : null;
        if (!state || !state.lines || state.open.length || state.failed.length) throw new PhaseRefusal(`UAT is not complete: ${!state ? "no UAT.md" : `${state.open.length} open, ${state.failed.length} failed of ${state.lines}`} — the owner marks each line in ${path ?? "UAT.md"} first`);
      }
    }
    // A yes at planning, design or issue signs what was shown (the plan, the drawing) under its key, like the acceptance's
    // (sma as_launchable): what changes after the word launches nothing on it.
    const consentKey = input.turn !== "acceptance" && input.decision === "yes" ? wordKeyOf(phase.record, input.turn) : null;
    const record: PhaseRecord = { ...phase.record, words: [...(phase.record.words ?? []), { turn: input.turn, decision: input.decision, by: input.by ?? "owner", text: input.text.slice(0, 2000), at: now(), ...(input.wave !== undefined ? { wave: input.wave } : {}),
      // SMA pc_contract: the version this word signs, so a new version of the context, the plan or the drawing cannot pass on it.
      ...(input.turn === "context" && phase.record.context ? { sha: phase.record.context.sha } : {}),
      ...(input.turn === "planning" && phase.record.plan ? { sha: phase.record.plan.sha, key: phase.record.plan.sha } : {}),
      ...(input.turn === "design" ? { ...(phase.record.design?.drawing ? { sha: phase.record.design.drawing.sha256 } : {}), key: drawingSha ?? undefined } : {}),
      // The issue yes signs the plan it launches (sma as_launchable).
      ...(input.turn === "issue" && consentKey ? { key: consentKey } : {}),
      ...(input.turn === "acceptance" ? { useful: input.useful === true, limits: input.limits === true, key: shownKey } : {}) }] };
    reactions.answerPhaseWord(phase.id, input.turn, input.wave, input.decision, input.text, input.by ?? "owner");
    reactions.closeOwnerItem(phaseWordItemKey(phase.id, input.turn, input.wave), input.by ?? "owner");
    book(phase, "decisions", `word_${input.turn}`, `${input.by ?? "owner"}: ${input.decision} — ${input.text}`);
    if (input.turn === "design") await reactions.noteDesignWord(phase.id, input.decision);
    savePhase(db, phase.id, { record, at: now() });
    if (input.turn === "lesson") { tools.settleLesson(mustGet(phase.id), input.decision); return mustGet(phase.id); }
    if (input.turn === "context") {
      if (phase.stage !== "discussion" || !record.context) return mustGet(phase.id);
      // The owner signs the context, or says no: then it is unsigned and the discussion goes on with his words in the book.
      if (input.decision === "no") { savePhase(db, phase.id, { record: { ...record, context: undefined }, at: now() }); return mustGet(phase.id); }
      if (discussionGate(record).ok) move(phase, "planning", record, "the owner signed the context");
      return mustGet(phase.id);
    }
    // Drawing feedback (SMA ts_feedback): the owner's «no» on a drawing keeps his remark against that exact edition, archives
    // it and clears the drawing, so lp.draw redraws it with the remark — the phase stays at design.
    if (input.turn === "design" && input.decision === "no" && phase.stage === "design" && phase.record.design?.drawing) {
      const design = phase.record.design;
      const drawing = design.drawing!;
      const designRecord: NonNullable<PhaseRecord["design"]> = { ...design, drawing: undefined,
        archived: [...(design.archived ?? []), drawing].slice(-10),
        feedback: [...(design.feedback ?? []), { drawingSha: drawing.sha256, text: input.text.slice(0, 2000), by: input.by ?? "owner", at: now() }].slice(-20) };
      savePhase(db, phase.id, { record: { ...record, design: designRecord }, at: now() });
      book(phase, "design", "drawing_returned", `the owner returned drawing ${drawing.sha256.slice(0, 12)}: ${input.text.slice(0, 300)} — it is redrawn with the remark`);
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
  function waveReview(input: WaveReviewInput): Phase {
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
  function withdraw(input: WithdrawInput): Phase {
    const phase = mustGet(input.phaseId);
    const plan = phase.record.plan;
    if (!plan) throw new PhaseRefusal("no plan to withdraw from");
    const issued = phase.record.execution?.issued ?? {};
    const refused = input.pieces.filter((id) => issued[id]);
    if (refused.length) throw new PhaseRefusal("issued pieces are canceled, not withdrawn", refused.map((id) => `${id} is issued: lane_pilot_cancel_task, then withdraw`));
    const items = plan.items.filter((item) => !input.pieces.includes(item.id));
    if (!items.length) throw new PhaseRefusal("withdrawing every piece closes the phase: use close with the words why");
    const sha = planSignature(items, plan.contextSha);
    // A trimmed scope revokes the earlier permission to issue (SMA bi_revise): the new scope asks for a new «issue» word.
    const revoked = (phase.record.words ?? []).some((word) => word.turn === "issue" || word.turn === "wave");
    const record: PhaseRecord = { ...phase.record, plan: { ...plan, items, sha, ...(plan.admittedSha ? { admittedSha: sha } : {}) }, scope: { revisions: phase.record.scope?.revisions ?? 0, withdrawn: [...(phase.record.scope?.withdrawn ?? []), ...input.pieces] },
      ...(revoked ? { words: (phase.record.words ?? []).filter((word) => word.turn !== "issue" && word.turn !== "wave") } : {}) };
    book(phase, "decisions", "scope_withdrawn", `${input.pieces.join(", ")} withdrawn by ${input.by ?? "pm"}: ${input.note}${revoked ? "; issue permission revoked" : ""}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
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

  /** A person answers one UAT line at a time, pass or fail, by its number (SMA p5_uat_line); every answer is recorded. */
  function uatLine(input: UatLineInput): Phase {
    const phase = mustGet(input.phaseId);
    const lines = phase.record.uat?.lines;
    if (!lines?.length) throw new PhaseRefusal(`phase ${phase.id} has no UAT lines yet: they are numbered when the UAT session opens at acceptance`);
    const line = lines.find((row) => row.n === input.line);
    if (!line) throw new PhaseRefusal(`no UAT line ${input.line}: the lines are 1 to ${lines.length}`);
    const record: PhaseRecord = { ...phase.record, uat: { ...phase.record.uat!, lines: lines.map((row) => row.n === input.line
      ? { ...row, state: input.result === "pass" ? "passed" as const : "failed" as const, ...(input.note?.trim() ? { note: input.note.trim().slice(0, 600) } : { note: undefined }), by: input.by ?? "owner", at: now() } : row) } };
    book(phase, "acceptance", "uat_line", `UAT line ${input.line} (${line.pieceId}): ${input.result}${input.note ? ` — ${input.note}` : ""} by ${input.by ?? "owner"}`);
    savePhase(db, phase.id, { record, at: now() });
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

  /** Open acceptance items across all phases (SMA k_t_audit_uat): every phase's UAT.md parsed for open and failed lines. */
  async function uatOpen(input: { projectId?: string }): Promise<Array<{ phaseId: string; state: "open" | "failed"; line: string }>> {
    const out: Array<{ phaseId: string; state: "open" | "failed"; line: string }> = [];
    for (const row of listPhases(db, { projectId: input.projectId, limit: 200 })) {
      const path = row.record.uat?.path;
      if (!path) continue;
      const text = await readText(row, path);
      if (!text) continue;
      const state = uatState(text);
      for (const line of state.open) out.push({ phaseId: row.id, state: "open", line });
      for (const line of state.failed) out.push({ phaseId: row.id, state: "failed", line });
    }
    return out;
  }

  /** Compensates the phase's own effects: each accepted piece is reverted (git revert through the merge lock), newest first. */
  async function compensate(input: CompensateInput): Promise<{ phase: Phase; results: Array<{ taskId: string; state: string; detail?: string }> }> {
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

  return { open, context, plan, planCheck, drawing, goalAudit, lessons, question, answer, word, waveReview, withdraw, revise, correct, returnTo, setState, stop, stopWave, compensate, admitIfReady, uatLine, uatOpen, decide, interrupt };
}
