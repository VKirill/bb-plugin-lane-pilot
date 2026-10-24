import { createHash } from "node:crypto";

/**
 * The phase on rails (SMA map: Phase graph, Phase control work, Phase controls). Matvey Maslov, 2026-10-22: «the driver is the model in the
 * harness, the rails are code; it cannot go where there are no rails», «above the orchestrator there is a machine that drives the route and
 * at the turns switches on the orchestrator». This file is that route: the stages, the gates each stage must pass in code, the returns
 * the graph allows, the acceptance lines and the one next action the driver asks of the PM. No I/O here: server/driver.ts feeds it facts.
 */

export const PHASE_STAGES = ["discussion", "planning", "design", "execution", "verification", "acceptance", "lessons", "closed"] as const;
export type PhaseStage = (typeof PHASE_STAGES)[number];
export type PhaseState = "active" | "pause_requested" | "paused" | "stopped" | "closed";

/** Where a person (or the PM) may send a phase back to: from 4 to 1, from 5 to 2 and so on — always to an earlier stage. */
export const RETURN_STAGES: readonly PhaseStage[] = ["discussion", "planning", "design", "execution"];

/** A promise of the plan in Given / When / Then words; the check of the task proves it. */
export type Promise3 = { given: string; when: string; then: string };

/** One piece of the plan: the work it becomes (a task-v2 contract, issued as is) and the promise it keeps. */
export type PlanItem = { id: string; title: string; wave: number; promise: Promise3; task: Record<string, unknown> };

export type ContextDoc = { path: string; sha256: string; bytes: number };
export type PlanCritique = { decision: "approve" | "changes_requested"; by: string; summary?: string };
export type Drawing = { paths: string[]; sha256: string; designer: string; reviewer?: string; feasible?: boolean; contradiction?: string };
export type FrozenVerdict = { state: "passed" | "failed"; detail: string; mainSha: string | null; at: number; inputSha: string };
export type AcceptanceLine = { id: AcceptanceLineId; ok: boolean; detail: string };
export type ModelVerdict = { state: "met" | "unmet"; by: string; summary: string; at: number };

/** The four kinds of risk a discussion names before any solution (SMA: Four risk kinds); «none» is an answer, silence is not. */
export const RISK_KINDS = ["technical", "product", "operations", "security"] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

/** A question a stage parks instead of guessing (SMA: Plan question parked, Answer a stage question); a blocking one holds the gate. */
export type StageQuestion = { id: string; stage: PhaseStage; text: string; blocking: boolean; askedAt: number; answer?: string; answeredBy?: string; answeredAt?: number };

/** The owner's word at a turn, when the project asks for it (setting owner.words = on; SMA: Plan row awaits a word, Drawing confirmation, Keyed decision, UAT line). */
export const WORD_TURNS = ["planning", "design", "acceptance", "uat"] as const;
export type WordTurn = (typeof WORD_TURNS)[number];
export type OwnerWord = { turn: WordTurn; decision: "yes" | "no"; by: string; text: string; at: number };

/** What the phase holds besides its row: one JSON record, each stage writes its part. */
export type PhaseRecord = {
  context?: { docs: ContextDoc[]; sha: string; signedAt: number; risks?: Partial<Record<RiskKind, string>>; legacy?: boolean };
  questions?: StageQuestion[];
  /** The project asked for the owner's word at the turns (owner.words = on when the phase opened). */
  ownerWords?: boolean;
  words?: OwnerWord[];
  /** Goal revisions and withdrawn pieces, each one a decision in the book. */
  scope?: { revisions: number; withdrawn: string[] };
  plan?: { items: PlanItem[]; sha: string; contextSha: string; critique?: PlanCritique; admittedSha?: string; admittedAt?: number };
  design?: { decision: "needed" | "not_needed"; why: string; drawing?: Drawing; confirmedAt?: number };
  execution?: { issued: Record<string, string>; startedAt?: number; baseSha?: string | null; issueErrors?: Record<string, string>; acceptedNoted?: string[] };
  verification?: { verdict?: FrozenVerdict; model?: ModelVerdict };
  acceptance?: { lines: AcceptanceLine[]; at: number; accepted: boolean };
  lessons?: { needed: boolean; why: string; analysis?: string; author?: string; reviewer?: string; reviewedHash?: string; at?: number };
  /** The book written to the project (.agents/phases/<id>/BOOK.md) up to this part. */
  bookWritten?: { seq: number; sha256: string; at: number };
  closing?: { by: string; words: string; at: number };
};

export type Phase = {
  id: string; projectId: string; pmThreadId: string; runId: string | null; title: string; goal: string;
  stage: PhaseStage; state: PhaseState; record: PhaseRecord; edition: number; createdAt: number; updatedAt: number;
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Stable JSON (sorted keys) so the same plan always has the same hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** The signature of the discussion: the documents' paths and hashes, in path order. */
export const contextSignature = (docs: readonly ContextDoc[]) => sha256(canonical([...docs].sort((a, b) => a.path.localeCompare(b.path)).map((doc) => [doc.path, doc.sha256])));
export const planSignature = (items: readonly PlanItem[], contextSha: string) => sha256(canonical({ contextSha, items }));

// ---------------------------------------------------------------- gates

export type GateResult = { ok: true } | { ok: false; why: string[] };
const gate = (why: string[]): GateResult => (why.length ? { ok: false, why } : { ok: true });

/** Discussion → planning: the context documents exist, none is empty, and they are signed (CONTEXT exists and is not empty; Context signature). */
export function discussionGate(record: PhaseRecord): GateResult {
  const docs = record.context?.docs ?? [];
  const why: string[] = [];
  if (!docs.length) why.push("no context documents: write the discussion (decisions, FAQ, ADR) to files in the project and name them");
  for (const doc of docs) if (doc.bytes === 0) why.push(`${doc.path} is empty`);
  if (docs.length && record.context?.sha !== contextSignature(docs)) why.push("the context signature does not match its documents");
  const risks = record.context?.risks ?? {};
  const unnamed = RISK_KINDS.filter((kind) => !risks[kind]?.trim());
  if (unnamed.length) why.push(`risks not named: ${unnamed.join(", ")} (name each, «none» is an answer)`);
  return gate(why);
}

/** The waves come out of depends_on: a piece depends only on pieces of the plan and of an earlier wave, and nothing loops. */
export function waveProblems(items: readonly PlanItem[]): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const why: string[] = [];
  for (const item of items) {
    const deps = Array.isArray(item.task.depends_on) ? (item.task.depends_on as unknown[]).filter((dep): dep is string => typeof dep === "string") : [];
    for (const dep of deps) {
      const other = byId.get(dep);
      if (!other) why.push(`${item.id} depends on ${dep}, which is not in the plan`);
      else if (other.wave >= item.wave) why.push(`${item.id} (wave ${item.wave}) depends on ${dep} of wave ${other.wave}: a dependency belongs to an earlier wave`);
    }
  }
  return why;
}

/** Will each piece become a work: a task with an id equal to the piece, owned paths, and a check that can run. */
export function pieceProblems(item: PlanItem): string[] {
  const why: string[] = [];
  const task = item.task;
  if (task.id !== item.id) why.push(`${item.id}: the task id must equal the piece id`);
  for (const key of ["given", "when", "then"] as const) if (!item.promise[key]?.trim()) why.push(`${item.id}: the promise has no «${key}»`);
  const owns = Array.isArray(task.owns_paths) ? task.owns_paths : [];
  if (!owns.length) why.push(`${item.id}: no owns_paths — the piece cannot become a work`);
  const checks = Array.isArray(task.verification) ? (task.verification as Array<{ command?: unknown }>) : [];
  if (!checks.length && task.verify !== "none") why.push(`${item.id}: no verification command — nothing proves the promise`);
  for (const check of checks) if (typeof check.command !== "string" || !check.command.trim()) why.push(`${item.id}: a verification item has no command`);
  return why;
}

/** Planning → admission: every piece becomes a work, waves are computable, the plan was built on the signed context, and an independent checker approved it. */
export function planGate(record: PhaseRecord): GateResult {
  const plan = record.plan;
  if (!plan?.items.length) return { ok: false, why: ["no plan: submit the plan's pieces (each a task-v2 contract with a Given/When/Then promise and its wave)"] };
  const why = [...plan.items.flatMap(pieceProblems), ...waveProblems(plan.items)];
  const ids = plan.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) why.push("two pieces have the same id");
  if (!record.context || plan.contextSha !== record.context.sha) why.push("the plan was not built on the signed context (contextSha differs): read the context documents and plan again");
  if (plan.sha !== planSignature(plan.items, plan.contextSha)) why.push("the plan signature does not match its pieces");
  if (!plan.critique) why.push("no independent plan check: run the plan critic (workflow lp.plan or grill-plan) and report its decision");
  else if (plan.critique.decision !== "approve") why.push(`the plan checker asked for changes${plan.critique.summary ? `: ${plan.critique.summary}` : ""}`);
  why.push(...openQuestions(record, "planning").map((question) => `open question ${question.id}: ${question.text}`));
  if (record.ownerWords && wordOf(record, "planning")?.decision !== "yes") why.push("the plan awaits the owner's word (owner.words is on)");
  return gate(why);
}

const UI_PATH = /\.(tsx|jsx|vue|svelte|css|scss|html)$|(^|\/)(ui|components|pages|screens|views)\//i;

/** Blocking questions of a stage that nobody answered yet. */
export const openQuestions = (record: PhaseRecord, stage: PhaseStage) => (record.questions ?? []).filter((question) => question.stage === stage && question.blocking && !question.answer);

/** The owner's latest word at a turn. */
export const wordOf = (record: PhaseRecord, turn: WordTurn) => [...(record.words ?? [])].reverse().find((word) => word.turn === turn);

/** Where a phase keeps its own files in the project: the book, and the drawing in design/ (SMA: The phase has a home, Drawing in its own folder). */
export const phaseFolder = (phaseId: string) => `.agents/phases/${phaseId}`;

/** Is a drawing needed: a piece that changes a screen (UI files) needs one; the PM can ask for one on any plan. */
export function designDecision(items: readonly PlanItem[], asked?: boolean): { decision: "needed" | "not_needed"; why: string } {
  if (asked) return { decision: "needed", why: "the PM asked for a drawing" };
  const ui = items.filter((item) => (Array.isArray(item.task.owns_paths) ? item.task.owns_paths as string[] : []).some((path) => UI_PATH.test(path)));
  return ui.length ? { decision: "needed", why: `pieces that change screens: ${ui.map((item) => item.id).join(", ")}` } : { decision: "not_needed", why: "no piece changes a screen" };
}

/** Design → execution: the drawing exists, an answer on feasibility, and a reviewer other than the designer saw it. */
export function designGate(record: PhaseRecord): GateResult {
  const design = record.design;
  if (!design) return { ok: false, why: ["the design decision is not made"] };
  if (design.decision === "not_needed") return { ok: true };
  const drawing = design.drawing;
  const why: string[] = [];
  if (!drawing?.paths.length) why.push("no drawing: the designer draws the screens into the phase's design folder and names the files");
  else {
    if (drawing.feasible === undefined) why.push("no feasibility answer: feasible, or the contradiction with the plan");
    if (drawing.feasible === false) why.push(`the drawing contradicts the plan: ${drawing.contradiction ?? "no reason given"} — return the phase to planning`);
    if (!drawing.reviewer) why.push("the drawing is not reviewed by a separate role");
    else if (drawing.reviewer === drawing.designer) why.push("the reviewer of the drawing is its designer: it must be a separate role");
  }
  if (record.ownerWords && wordOf(record, "design")?.decision !== "yes") why.push("the drawing awaits the owner's word (owner.words is on)");
  return gate(why);
}

export type TaskFact = { taskId: string; state: string | null; planFact: "passed" | "failed" | "skipped" | null; verification: "passed" | "failed" | "skipped" | null; codeCritique: "passed" | "blocked" | "skipped" | "failed" | null; browserQa?: "passed" | "failed" | "skipped" | null };

/** The pieces that may be issued now: wave by wave, the next wave only once every piece of the earlier waves is accepted. */
export function issuable(items: readonly PlanItem[], issued: Readonly<Record<string, string>>, facts: ReadonlyMap<string, TaskFact>): PlanItem[] {
  const waves = [...new Set(items.map((item) => item.wave))].sort((a, b) => a - b);
  for (const wave of waves) {
    const pieces = items.filter((item) => item.wave === wave);
    const waiting = pieces.filter((item) => !issued[item.id]);
    if (waiting.length) return waiting;
    if (!pieces.every((item) => facts.get(item.id)?.state === "accepted")) return [];
  }
  return [];
}

/** Execution → verification: every piece issued and accepted; a blocked piece is reported, not skipped. */
export function executionGate(items: readonly PlanItem[], issued: Readonly<Record<string, string>>, facts: ReadonlyMap<string, TaskFact>): GateResult {
  const why: string[] = [];
  for (const item of items) {
    if (!issued[item.id]) { why.push(`${item.id} is not issued yet`); continue; }
    const state = facts.get(item.id)?.state ?? "queued";
    if (state !== "accepted") why.push(`${item.id} is ${state}`);
  }
  return gate(why);
}

/**
 * The frozen blind verdict of the phase: decided by code from what the checks left (plan-fact of every piece, the run's goal check),
 * never from what the writer says. Its input hash freezes it: the same facts give the same verdict, new facts a new verdict.
 */
export function blindVerdict(items: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>, runGoal: { state: string; detail?: string | null; headSha?: string | null } | null, now: number): FrozenVerdict {
  const problems: string[] = [];
  for (const item of items) {
    const fact = facts.get(item.id);
    if (fact?.state !== "accepted") problems.push(`${item.id} not accepted`);
    if (fact?.planFact === "failed") problems.push(`${item.id}: plan-fact failed — the promise is not proved`);
    if (fact?.verification === "failed") problems.push(`${item.id}: its checks failed`);
  }
  if (!runGoal) problems.push("the run's goal check has not run yet");
  else if (runGoal.state === "failed") problems.push(`the run's goal check failed${runGoal.detail ? `: ${runGoal.detail}` : ""}`);
  const inputSha = sha256(canonical({ items: items.map((item) => item.id), facts: items.map((item) => facts.get(item.id) ?? null), runGoal }));
  return { state: problems.length ? "failed" : "passed", detail: problems.join("; ") || "every piece accepted and proved; the composition passes on main", mainSha: runGoal?.headSha ?? null, at: now, inputSha };
}

export const ACCEPTANCE_LINES = ["contract_current", "promises_proved", "checks_passed", "independent_check", "landed", "composition_verified", "main_unmoved", "qa_read", "goal_met", "limits_acknowledged", "owner_word"] as const;
export type AcceptanceLineId = (typeof ACCEPTANCE_LINES)[number];

/** The phase acceptance calculation: each line decided by code; the phase is accepted only when every line holds. */
export function acceptanceLines(phase: Phase, facts: ReadonlyMap<string, TaskFact>, now: { mainSha: string | null; openDeferrals: number }): AcceptanceLine[] {
  const items = phase.record.plan?.items ?? [];
  const verdict = phase.record.verification?.verdict;
  const line = (id: AcceptanceLineId, ok: boolean, detail: string): AcceptanceLine => ({ id, ok, detail });
  const failed = (pick: (fact: TaskFact | undefined) => boolean) => items.filter((item) => pick(facts.get(item.id))).map((item) => item.id);
  const notProved = failed((fact) => fact?.planFact !== "passed" && fact?.planFact !== "skipped");
  const notChecked = failed((fact) => fact?.verification === "failed");
  const blockedByCritic = failed((fact) => fact?.codeCritique === "blocked");
  const notLanded = failed((fact) => fact?.state !== "accepted");
  const qaRed = failed((fact) => fact?.browserQa === "failed");
  const model = phase.record.verification?.model;
  const word = wordOf(phase.record, "acceptance");
  return [
    line("contract_current", !!phase.record.plan?.admittedSha && phase.record.plan.admittedSha === phase.record.plan.sha, phase.record.plan?.admittedSha === phase.record.plan?.sha ? "the plan is the admitted one" : "the plan changed after its admission"),
    line("promises_proved", notProved.length === 0, notProved.length ? `not proved by plan-fact: ${notProved.join(", ")}` : `${items.length} promises proved`),
    line("checks_passed", notChecked.length === 0, notChecked.length ? `checks failed: ${notChecked.join(", ")}` : "every piece's checks passed"),
    line("independent_check", blockedByCritic.length === 0, blockedByCritic.length ? `the code critic blocks: ${blockedByCritic.join(", ")}` : "no independent checker blocks"),
    line("landed", notLanded.length === 0, notLanded.length ? `not merged: ${notLanded.join(", ")}` : "every piece is merged into main"),
    line("composition_verified", verdict?.state === "passed", verdict ? verdict.detail : "no blind verdict yet"),
    line("main_unmoved", !verdict?.mainSha || !now.mainSha || verdict.mainSha === now.mainSha, verdict?.mainSha && now.mainSha && verdict.mainSha !== now.mainSha ? `main moved from ${verdict.mainSha.slice(0, 12)} to ${now.mainSha.slice(0, 12)} since the verdict — verify again` : "main is where the verdict saw it"),
    line("qa_read", qaRed.length === 0, qaRed.length ? `the browser check failed: ${qaRed.join(", ")}` : "the window, the blind verdict and the browser checks read clean"),
    line("goal_met", model?.state === "met", model ? `${model.by}: ${model.summary}` : "no goal audit yet"),
    line("limits_acknowledged", true, now.openDeferrals ? `${now.openDeferrals} deferred item(s) of this project stay open, named in the book` : "nothing deferred"),
    line("owner_word", !phase.record.ownerWords || word?.decision === "yes", !phase.record.ownerWords ? "the project does not ask for the owner's word (owner.words off)" : word ? `${word.by}: ${word.decision} — ${word.text}` : "awaits the owner's keyed decision"),
  ];
}

/** Is a lessons analysis needed: a phase that went straight through has nothing to teach; returns, failed attempts or a failed verdict do. */
export function lessonsNeeded(input: { returns: number; failedAttempts: number; verdictFailures: number }): { needed: boolean; why: string } {
  const reasons = [input.returns ? `${input.returns} return(s) to an earlier stage` : "", input.failedAttempts ? `${input.failedAttempts} failed attempt(s)` : "", input.verdictFailures ? `${input.verdictFailures} failed verdict(s)` : ""].filter(Boolean);
  return reasons.length ? { needed: true, why: reasons.join(", ") } : { needed: false, why: "the phase went through without returns or failures" };
}

/** Every stage names the gate that lets a phase out of it (SMA: Stage without gates is refused); the test checks none is missing. */
export const STAGE_GATES: Readonly<Record<Exclude<PhaseStage, "closed">, string>> = {
  discussion: "discussionGate", planning: "planGate", design: "designGate", execution: "executionGate",
  verification: "blindVerdict", acceptance: "acceptanceLines", lessons: "lessonsNeeded",
};

// ---------------------------------------------------------------- the driver's next action

export type NextAction = { key: string; stage: PhaseStage; text: string; waitsForPm: boolean };

const tool = (action: string, args = "") => `lane_pilot_phase {action:"${action}"${args}}`;

/**
 * What the phase needs now, in one instruction for the PM (the driver sends it once per key: «one wait — one message»). `waitsForPm` is
 * false when the driver itself has the next step (issuing a wave, waiting for writers, running the checks).
 */
export function nextAction(phase: Phase, facts: ReadonlyMap<string, TaskFact>): NextAction {
  const id = phase.id;
  const r = phase.record;
  const head = `Phase ${id} «${phase.title}»`;
  const key = (suffix: string) => `${phase.stage}:${suffix}`;
  const questions = (r.questions ?? []).filter((question) => !question.answer && question.stage === phase.stage);
  if (questions.length) return { key: key(`questions:${questions.map((question) => question.id).join(",")}`), stage: phase.stage, waitsForPm: true,
    text: `${head} — open question(s) at ${phase.stage}: ${questions.map((question) => `${question.id}${question.blocking ? " (blocking)" : ""}: ${question.text}`).join("; ")}. Answer with ${tool("answer", `, phaseId:"${id}", questionId, answer`)}; ask the owner first (lane_pilot_ask_owner) if only he knows.` };
  const turn: WordTurn | null = !r.ownerWords ? null : phase.stage === "planning" && r.plan?.critique?.decision === "approve" && wordOf(r, "planning")?.decision !== "yes" ? "planning"
    : phase.stage === "design" && r.design?.drawing?.reviewer && wordOf(r, "design")?.decision !== "yes" ? "design"
    : phase.stage === "acceptance" && wordOf(r, "acceptance")?.decision !== "yes" ? "acceptance" : null;
  if (turn) return { key: key(`word:${turn}`), stage: phase.stage, waitsForPm: true,
    text: `${head} awaits the owner's word at ${turn} (owner.words is on). Ask him with lane_pilot_ask_owner, then record it with ${tool("word", `, phaseId:"${id}", turn:"${turn}", decision:"yes"|"no", text`)}.` };
  if (phase.state === "paused" || phase.state === "pause_requested") return { key: key("paused"), stage: phase.stage, text: `${head} is paused; ${tool("resume", `, phaseId:"${id}"`)} moves it on.`, waitsForPm: false };
  switch (phase.stage) {
    case "discussion": {
      const check = discussionGate(r);
      return { key: key(r.context?.sha ?? "none"), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 1, discussion. Goal: ${phase.goal}\nWrite the discussion to files in the project (decisions locked/free/deferred, FAQ, ADR — workflow lp.brainstorm or lp.analyze writes them), name the four risks (${RISK_KINDS.join(", ")}), then ${tool("context", `, phaseId:"${id}", docs:["<path>", ...], risks:{technical, product, operations, security}`)}: Lane Pilot reads and signs them.${check.ok ? "" : `\nOpen: ${check.why.join("; ")}`}` };
    }
    case "planning": {
      const check = planGate(r);
      return { key: key(`${r.plan?.sha ?? "none"}:${r.plan?.critique?.decision ?? "-"}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 2, planning, on context ${r.context?.sha.slice(0, 12) ?? "?"}.\nSubmit the plan with ${tool("plan", `, phaseId:"${id}", items:[{id, title, wave, promise:{given, when, then}, task:<task-v2>}]`)}; then run the independent plan checker (workflow lp.plan's critic or grill-plan) and report it with ${tool("plan_check", `, phaseId:"${id}", decision:"approve"|"changes_requested", by, summary`)}.${check.ok ? "" : `\nOpen: ${check.why.slice(0, 8).join("; ")}`}` };
    }
    case "design": {
      const check = designGate(r);
      return { key: key(`${r.design?.drawing?.sha256 ?? "none"}:${r.design?.drawing?.feasible ?? "-"}:${r.design?.drawing?.reviewer ?? "-"}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 3, design (${r.design?.why ?? ""}).\nHave design-lead draw the screens into ${phaseFolder(id)}/design/ (lane_pilot_helpers {action:"specialist", role:"design-lead"}), then ${tool("drawing", `, phaseId:"${id}", paths:[...], designer, feasible:true|false, contradiction?, reviewer`)} — the reviewer is a role other than the designer (ui-review / design-taste).${check.ok ? "" : `\nOpen: ${check.why.join("; ")}`}` };
    }
    case "execution": {
      const items = r.plan?.items ?? [];
      const issued = r.execution?.issued ?? {};
      const open = items.filter((item) => issued[item.id] && facts.get(item.id)?.state !== "accepted");
      const blocked = open.filter((item) => ["blocked", "canceled"].includes(facts.get(item.id)?.state ?? ""));
      if (blocked.length) return { key: key(`blocked:${blocked.map((item) => item.id).join(",")}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: ${blocked.map((item) => `${item.id} is ${facts.get(item.id)?.state}`).join("; ")}. Fix the task (lane_pilot_update_task) and send it again, or return the phase to planning with ${tool("return", `, phaseId:"${id}", to:"planning", note`)}.` };
      const errors = Object.entries(r.execution?.issueErrors ?? {});
      if (errors.length) return { key: key(`issue_error:${errors.map(([piece]) => piece).join(",")}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: Lane Pilot could not issue ${errors.map(([piece, why]) => `${piece} (${why})`).join("; ")}. Correct the plan with ${tool("return", `, phaseId:"${id}", to:"planning", note`)}.` };
      return { key: key(`running:${Object.keys(issued).length}:${open.length}`), stage: phase.stage, waitsForPm: false,
        text: `${head} — stage 4, execution: ${Object.keys(issued).length} of ${items.length} pieces issued, ${open.length} at work. Lane Pilot issues the next wave itself once this one is accepted.` };
    }
    case "verification": {
      const verdict = r.verification?.verdict;
      if (verdict?.state === "failed") return { key: key(`failed:${verdict.inputSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 5, verification failed: ${verdict.detail}. Return the phase to execution (fix tasks) or planning with ${tool("return", `, phaseId:"${id}", to:"execution"|"planning", note`)}.` };
      if (verdict && !r.verification?.model) return { key: key("model"), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 5, verification: the blind check passed (${verdict.detail}). Run the goal audit (workflow lp.close) against the phase goal «${phase.goal}»${r.design?.drawing ? ` and the phase drawing (${r.design.drawing.paths.join(", ")})` : ""} and report it with ${tool("goal_audit", `, phaseId:"${id}", state:"met"|"unmet", by, summary`)}.` };
      return { key: key("running"), stage: phase.stage, waitsForPm: false, text: `${head} — stage 5, verification: Lane Pilot runs every piece's checks together on main.` };
    }
    case "acceptance": {
      const lines = r.acceptance?.lines ?? [];
      const bad = lines.filter((line) => !line.ok);
      return { key: key(bad.map((line) => line.id).join(",") || "ok"), stage: phase.stage, waitsForPm: bad.length > 0,
        text: bad.length ? `${head} — stage 6, acceptance holds: ${bad.map((line) => `${line.id}: ${line.detail}`).join("; ")}.` : `${head} — stage 6, accepted.` };
    }
    case "lessons":
      return { key: key(r.lessons?.analysis ? "written" : "analysis"), stage: phase.stage, waitsForPm: !r.lessons?.analysis,
        text: `${head} — stage 7, lessons (${r.lessons?.why ?? ""}). Run the retrospective (workflow retrospective) on the phase book and report it with ${tool("lessons", `, phaseId:"${id}", analysis, author, reviewer, reviewedHash`)}: the reviewer is a role other than the author, and reviewedHash is the book's last part hash the reviewer read (status shows it).` };
    case "closed":
      return { key: key("closed"), stage: phase.stage, waitsForPm: false, text: `${head} is closed.` };
  }
}

/** The stages a return to `to` makes stale: everything after it is decided again. */
export function staleAfterReturn(to: PhaseStage, record: PhaseRecord): PhaseRecord {
  const next: PhaseRecord = { ...record };
  const order = PHASE_STAGES.indexOf(to);
  if (order <= PHASE_STAGES.indexOf("discussion")) delete next.context;
  if (order <= PHASE_STAGES.indexOf("planning") && next.plan) next.plan = { ...next.plan, critique: undefined, admittedSha: undefined, admittedAt: undefined };
  if (order <= PHASE_STAGES.indexOf("design")) delete next.design;
  if (order <= PHASE_STAGES.indexOf("execution")) { delete next.verification; delete next.acceptance; }
  delete next.lessons;
  const later = (stage: string) => PHASE_STAGES.indexOf(stage as PhaseStage) >= order;
  if (next.words) next.words = next.words.filter((word) => !later(word.turn === "uat" ? "acceptance" : word.turn));
  return next;
}

/** The nine sections of the phase book, in order. */
export const BOOK_SECTIONS = ["goal", "discussion", "plan", "design", "execution", "verification", "acceptance", "lessons", "decisions"] as const;
export type BookSection = (typeof BOOK_SECTIONS)[number];
export type BookPart = { seq: number; at: number; section: BookSection; kind: string; text: string; prevHash: string; hash: string };

export const GENESIS = "0".repeat(64);
export const partHash = (prevHash: string, part: { seq: number; at: number; section: string; kind: string; text: string }) =>
  sha256(`${prevHash}\n${part.seq}\n${part.at}\n${part.section}\n${part.kind}\n${part.text}`);

/** The first part whose hash or link does not hold, or null when the whole chain is intact. */
export function brokenLink(parts: readonly BookPart[]): number | null {
  let prev = GENESIS;
  for (const part of parts) {
    if (part.prevHash !== prev || part.hash !== partHash(prev, part)) return part.seq;
    prev = part.hash;
  }
  return null;
}

/** The phase book as Markdown: the nine sections, each with its parts in order, and the chain's state. */
export function renderBook(phase: Phase, parts: readonly BookPart[]): string {
  const titles: Record<BookSection, string> = { goal: "1. Goal", discussion: "2. Discussion", plan: "3. Plan", design: "4. Design", execution: "5. Execution", verification: "6. Verification", acceptance: "7. Acceptance", lessons: "8. Lessons", decisions: "9. Decisions and returns" };
  const broken = brokenLink(parts);
  const lines = [`# Phase ${phase.id}: ${phase.title}`, "", `Stage: ${phase.stage} · state: ${phase.state} · edition ${phase.edition} · chain: ${broken === null ? `intact (${parts.length} parts)` : `BROKEN at part ${broken}`}`, ""];
  for (const section of BOOK_SECTIONS) {
    const own = parts.filter((part) => part.section === section);
    lines.push(`## ${titles[section]}`, "");
    if (section === "goal") lines.push(phase.goal, "");
    for (const part of own) lines.push(`- ${new Date(part.at).toISOString().slice(0, 16).replace("T", " ")} **${part.kind}** — ${part.text}`);
    if (own.length) lines.push("");
  }
  return lines.join("\n");
}
