import { createHash } from "node:crypto";
import { NO_CODE_KINDS } from "../tasks";
import { ANIMATOR_LAW, PLAN_ROUNDS_MAX, coverageGaps, designMode, motionRows, rubricLine, stageInit, threatGap, uiContractGap, validationGaps } from "./stages";

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
export type PlanItem = { id: string; title: string; wave: number; promise: Promise3; task: Record<string, unknown>; /** Requirement ids and locked decision ids this piece carries out (coverage gates). */ covers?: string[] };

export type ContextDoc = { path: string; sha256: string; bytes: number };
export type PlanCritique = { decision: "approve" | "changes_requested"; by: string; summary?: string };
export type Drawing = { paths: string[]; sha256: string; designer: string; reviewer?: string; feasible?: boolean; contradiction?: string };
export type FrozenVerdict = { state: "passed" | "failed"; detail: string; mainSha: string | null; at: number; inputSha: string };
/** What blindVerdict returns while the run's goal check is still running; it is never stored. */
export type PendingVerdict = Omit<FrozenVerdict, "state"> & { state: "pending" };
export type AcceptanceLine = { id: AcceptanceLineId; ok: boolean; detail: string };
export type ModelVerdict = { state: "met" | "unmet"; by: string; summary: string; at: number };

/** The four kinds of risk a discussion names before any solution (SMA: Four risk kinds); «none» is an answer, silence is not. */
export const RISK_KINDS = ["technical", "product", "operations", "security"] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

/** A question a stage parks instead of guessing (SMA: Plan question parked, Answer a stage question); a blocking one holds the gate. */
export type StageQuestion = { id: string; stage: PhaseStage; text: string; blocking: boolean; askedAt: number; answer?: string; answeredBy?: string; answeredAt?: number };

/** The owner's word at a turn, when the project asks for it (setting owner.words = on; SMA: Plan row awaits a word, Drawing confirmation, Keyed decision, UAT line). */
export const WORD_TURNS = ["planning", "design", "issue", "wave", "acceptance", "uat"] as const;
export type WordTurn = (typeof WORD_TURNS)[number];
export type OwnerWord = { turn: WordTurn; decision: "yes" | "no"; by: string; text: string; at: number; wave?: number };

/** A wave of the plan once its pieces are in (SMA: Wave package with hash, Wave acceptance lines, Wave verified by another model, Wave written to the book). */
export type WaveRecord = { packageSha: string; lines: Array<{ id: string; ok: boolean; detail: string }>; review?: { state: "passed" | "failed"; by: string; summary: string; at: number }; at: number };

/** What the phase holds besides its row: one JSON record, each stage writes its part. */
export type PhaseRecord = {
  /** Opened by the rails for the owner's heavy request (src/rooms/phase/server/intake.ts): the PM cannot close it before acceptance. */
  rails?: boolean;
  /** The machine runs the stages' workflows itself (setting phase.train, on by default); false leaves every stage to the PM. */
  train?: boolean;
  /** The stage workflow the machine runs now (src/rooms/phase/server/auto-stages.ts). */
  auto?: { kind: "analyze" | "plan" | "draw" | "review" | "close" | "lessons"; wfRunId: string; startedAt: number; wave?: number };
  /** The context signed before a return to discussion: the machine signs these documents again instead of analysing anew. */
  signedBefore?: { docs: string[]; risks?: Partial<Record<RiskKind, string>>; decisions?: string[] };
  /** Runs of a stage's workflow that did not finish; at two the loop is spent and the machine ends it (scope cut, hunters, backlog). */
  autoFailures?: Partial<Record<"analyze" | "plan" | "draw" | "review" | "close" | "lessons", number>>;
  /** Failed runs of each stage's workflow over the phase's whole life, across versions (a new version forgets autoFailures, not this). */
  autoFailuresTotal?: Partial<Record<"analyze" | "plan" | "draw" | "review" | "close" | "lessons", number>>;
  /** Set before the machine's outcome for a spent loop runs (exhausted), so a pass that finds the phase still active does not run it again. */
  exhausted?: { at: number };
  /** The machine's returns to planning after a failed verdict: what to plan for (cleared once planned) and how many so far. */
  replan?: { gaps?: string; count: number };
  /** The Lane Pilot version the failures were counted under: a new version tries the stages again. */
  autoFailuresVersion?: string;
  context?: { docs: ContextDoc[]; sha: string; signedAt: number; risks?: Partial<Record<RiskKind, string>>; legacy?: boolean; /** REQUIREMENTS ids this phase delivers. */ requirements?: string[]; /** Locked decision ids of CONTEXT.md. */ decisions?: string[] };
  questions?: StageQuestion[];
  /** The project asked for the owner's word at the turns (owner.words = on when the phase opened). */
  ownerWords?: boolean;
  words?: OwnerWord[];
  /** Goal revisions and withdrawn pieces, each one a decision in the book. */
  scope?: { revisions: number; withdrawn: string[] };
  plan?: { items: PlanItem[]; sha: string; contextSha: string; critique?: PlanCritique; admittedSha?: string; admittedAt?: number; /** Rounds of the independent check that asked for changes. */ rounds?: number;
    /** The planner checked that the repository already does what the goal asks: no pieces, no execution; the goal audit checks the claim. */ alreadyMet?: { evidence: string } };
  design?: { decision: "needed" | "not_needed"; why: string; drawing?: Drawing; confirmedAt?: number; mode?: "screens" | "system" | "mixed"; motion?: string[]; archived?: Drawing[] };
  /** The roadmap row this phase is (lane-plan ROADMAP.md), marked done when the phase closes. */
  roadmapRow?: string;
  /** Autonomous mode (setting phase.autonomous): when the phase closes the driver opens the next open roadmap row itself. */
  autonomous?: boolean;
  /** Execution with or without parallel writers (setting phase.subagents; off issues one piece at a time, inline). */
  subagents?: boolean;
  /** A marker branch phase/<id> at the accepted main (setting phase.branch = phase). */
  branch?: "none" | "phase";
  /** UAT.md written for the owner at acceptance (owner.words on). */
  uat?: { path: string; sha256: string; at: number };
  /** The conclusion and the roadmap/STATE marks written when the phase closed. */
  closedDocs?: { at: number; commit: string | null };
  execution?: { issued: Record<string, string>; startedAt?: number; baseSha?: string | null; issueErrors?: Record<string, string>; acceptedNoted?: string[]; waves?: Record<string, WaveRecord>;
    /** The contract each piece was issued with (pieceSha): a piece whose contract changed after a return to planning is issued again. */
    issuedSha?: Record<string, string>;
    /** All pieces accepted, but the facts are the ones a verdict already failed on: the phase waits for new work instead of failing again. */
    unchanged?: { inputSha: string; detail: string } };
  /** Each finished wave is verified by another model before the next one is issued (setting phase.wave_review, on by default). */
  waveReview?: boolean;
  /** The most pieces the driver issues in one pass (Batch issue capacity; setting phase.issue_cap, 8 by default). */
  issueCap?: number;
  /** When the driver last said the phase is aging or stalled (once a day). */
  agingSaidAt?: number;
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
  // Tests are part of the task from the start (Matvey #31865): an acceptance line that names a command is proved only when that command
  // is a check of the contract (live ph_ae0a8de9db: «npm test is green» with no `npm test` among the checks failed plan-fact forever).
  const commands = checks.map((check) => String(check.command ?? ""));
  const acceptance = Array.isArray(task.acceptance) ? (task.acceptance as unknown[]).map(String) : [];
  for (const line of acceptance) for (const named of acceptanceCommands(line)) {
    if (!commands.some((command) => command.includes(named))) why.push(`${item.id}: the acceptance line «${line.slice(0, 120)}» names \`${named}\`, which is not a verification command — add it to verification or reword the line`);
  }
  return why;
}

/** Commands an acceptance line names: `code spans` that look like a command, and the usual test runners written plainly. */
export function acceptanceCommands(line: string): string[] {
  const found = new Set<string>();
  for (const match of line.matchAll(/`([^`]{2,120})`/g)) if (/^(npm|pnpm|yarn|npx|node|bun|deno|pytest|python3? -m|cargo|go|make|bash|sh|\.\/)\b/.test(match[1]!.trim())) found.add(match[1]!.trim());
  const plain = line.replace(/`[^`]*`/g, " ");
  for (const match of plain.matchAll(/\b(npm (?:test|run [\w:.-]+)|pnpm (?:test|run [\w:.-]+)|yarn (?:test|run [\w:.-]+)|node --test|pytest|cargo test|go test)\b/g)) found.add(match[1]!);
  return [...found];
}

/** Planning → admission: every piece becomes a work, waves are computable, the plan was built on the signed context, and an independent checker approved it. */
export function planGate(record: PhaseRecord): GateResult {
  const plan = record.plan;
  if (!plan?.items.length && !plan?.alreadyMet) return { ok: false, why: ["no plan: submit the plan's pieces (each a task-v2 contract with a Given/When/Then promise and its wave)"] };
  const why = [...plan.items.flatMap(pieceProblems), ...waveProblems(plan.items)];
  const ids = plan.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) why.push("two pieces have the same id");
  if (!record.context || plan.contextSha !== record.context.sha) why.push("the plan was not built on the signed context (contextSha differs): read the context documents and plan again");
  if (plan.sha !== planSignature(plan.items, plan.contextSha)) why.push("the plan signature does not match its pieces");
  // A goal the repository already meets has no pieces to cover its requirements; the goal audit checks each of them.
  why.push(...(plan.alreadyMet ? [] : coverageGaps(record)), ...validationGaps(plan.items));
  const threat = threatGap(record);
  if (threat) why.push(threat);
  if ((plan.rounds ?? 0) >= PLAN_ROUNDS_MAX && plan.critique?.decision !== "approve") why.push(`${plan.rounds} rounds of the plan check asked for changes: stop revising — return the phase to discussion with what the checker keeps finding, or close it`);
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
export function designDecision(items: readonly PlanItem[], asked?: boolean): { decision: "needed" | "not_needed"; why: string; mode?: "screens" | "system" | "mixed"; motion?: string[] } {
  const extra = { mode: designMode(items), motion: motionRows(items) };
  if (asked) return { decision: "needed", why: "the PM asked for a drawing", ...extra };
  const ui = items.filter((item) => (Array.isArray(item.task.owns_paths) ? item.task.owns_paths as string[] : []).some((path) => UI_PATH.test(path)));
  return ui.length ? { decision: "needed", why: `pieces that change screens: ${ui.map((item) => item.id).join(", ")}`, ...extra } : { decision: "not_needed", why: "no piece changes a screen" };
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
  const contract = uiContractGap(record);
  if (contract) why.push(contract);
  if (record.ownerWords && wordOf(record, "design")?.decision !== "yes") why.push("the drawing awaits the owner's word (owner.words is on)");
  return gate(why);
}

export type TaskFact = { taskId: string; state: string | null; planFact: "passed" | "failed" | "skipped" | null; verification: "passed" | "failed" | "skipped" | null; codeCritique: "passed" | "blocked" | "skipped" | "failed" | null; browserQa?: "passed" | "failed" | "skipped" | null };

/** The pieces that may be issued now: wave by wave, the next wave only once every piece of the earlier waves is accepted. */
/** What a piece's work is: its contract and its promise. A changed one after a return to planning is new work. */
export const pieceSha = (item: PlanItem) => sha256(canonical({ task: item.task, promise: item.promise }));

export function issuable(items: readonly PlanItem[], issued: Readonly<Record<string, string>>, facts: ReadonlyMap<string, TaskFact>, cleared: (wave: number) => boolean = () => true,
  issuedSha: Readonly<Record<string, string>> = {}): PlanItem[] {
  for (const wave of wavesOf(items)) {
    const pieces = piecesOfWave(items, wave);
    // The head changed (SMA: the train runs again on a new head from the stage that changed, skipping the stages that did not):
    // a piece whose contract changed since it was issued is issued again; an unchanged one keeps its work.
    const waiting = pieces.filter((item) => !issued[item.id] || (issuedSha[item.id] !== undefined && issuedSha[item.id] !== pieceSha(item)));
    if (waiting.length) return waiting;
    if (!pieces.every((item) => facts.get(item.id)?.state === "accepted")) return [];
    if (!cleared(wave)) return [];
  }
  return [];
}

/** The pieces of one wave. */
export const piecesOfWave = (items: readonly PlanItem[], wave: number) => items.filter((item) => item.wave === wave);
export const wavesOf = (items: readonly PlanItem[]) => [...new Set(items.map((item) => item.wave))].sort((a, b) => a - b);

/** The wave's package: its pieces, their tasks and states, hashed — the same wave has the same package. */
export const wavePackage = (pieces: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>) =>
  sha256(canonical(pieces.map((item) => [item.id, facts.get(item.id)?.taskId ?? null, facts.get(item.id)?.state ?? null, facts.get(item.id)?.planFact ?? null])));

/** The wave's acceptance lines, decided by code from what its pieces left. */
export function waveLines(pieces: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>): WaveRecord["lines"] {
  const bad = (pick: (fact: TaskFact | undefined) => boolean) => pieces.filter((item) => pick(facts.get(item.id))).map((item) => item.id);
  const notIn = bad((fact) => fact?.state !== "accepted");
  const unproved = bad((fact) => fact?.planFact === "failed");
  const red = bad((fact) => fact?.verification === "failed");
  const blocked = bad((fact) => fact?.codeCritique === "blocked");
  return [
    { id: "pieces_accepted", ok: !notIn.length, detail: notIn.length ? `not accepted: ${notIn.join(", ")}` : `${pieces.length} piece(s) accepted` },
    { id: "promises_proved", ok: !unproved.length, detail: unproved.length ? `plan-fact failed: ${unproved.join(", ")}` : "every promise of the wave is proved" },
    { id: "checks_passed", ok: !red.length, detail: red.length ? `checks failed: ${red.join(", ")}` : "the wave's checks pass" },
    { id: "no_critic_block", ok: !blocked.length, detail: blocked.length ? `the code critic blocks: ${blocked.join(", ")}` : "no critic blocks" },
  ];
}

/** Is a finished wave cleared for the next one: its lines hold, another model verified it (when asked), the owner said yes (when asked). */
export function waveCleared(record: PhaseRecord, wave: number): boolean {
  const done = record.execution?.waves?.[String(wave)];
  if (!done || !done.lines.every((line) => line.ok)) return false;
  if (record.waveReview && done.review?.state !== "passed") return false;
  if (record.ownerWords && ![...(record.words ?? [])].reverse().find((word) => word.turn === "wave" && word.wave === wave && word.decision === "yes")) return false;
  return true;
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

const listOf = (value: unknown) => (Array.isArray(value) ? value : []);
/** A piece that makes acceptance promises about code must show plan-fact for them: a skipped stage proves nothing. */
const needsPlanFact = (item: PlanItem) => listOf(item.task?.acceptance).length > 0 && !NO_CODE_KINDS.has(String(item.task?.kind ?? ""));
/** A piece with verification commands must show the checks ran: skipped means they did not. */
const needsChecks = (item: PlanItem) => listOf(item.task?.verification).length > 0;

/** The run's goal check is still at work: the verdict waits for it, it neither passes nor fails. */
export const runGoalPending = (runGoal: { state: string } | null) => runGoal?.state === "running";

/**
 * The frozen blind verdict of the phase: decided by code from what the checks left (plan-fact of every piece, the run's goal check),
 * never from what the writer says. Its input hash freezes it: the same facts give the same verdict, new facts a new verdict.
 * `pending`: only the run's goal check is still running; the driver records nothing and asks again.
 */
/** What keeps one piece from being proved: not accepted, its promise unproved against the diff, its checks red or never run. Empty when it is proved. */
function pieceProof(item: PlanItem, fact: TaskFact | undefined): string[] {
  const problems: string[] = [];
  if (fact?.state !== "accepted") problems.push(`${item.id} not accepted`);
  if (fact?.planFact === "failed") problems.push(`${item.id}: plan-fact failed — the promise is not proved`);
  else if (fact?.planFact === "skipped" && needsPlanFact(item)) problems.push(`${item.id}: plan-fact was skipped — its acceptance items were not checked against the diff`);
  if (fact?.verification === "failed") problems.push(`${item.id}: its checks failed`);
  else if (fact?.verification === "skipped" && needsChecks(item)) problems.push(`${item.id}: its checks were skipped — nothing ran`);
  return problems;
}

/** The pieces a scope cut keeps (proved) and the ones it withdraws, each with why; a piece of a wave the other model did not pass is not proved when waves are reviewed. */
export function provenPieces(items: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>, waves?: Record<string, WaveRecord>): { proven: PlanItem[]; unproven: Array<{ item: PlanItem; why: string }> } {
  const proven: PlanItem[] = [];
  const unproven: Array<{ item: PlanItem; why: string }> = [];
  for (const item of items) {
    const problems = pieceProof(item, facts.get(item.id));
    if (waves && waves[String(item.wave)]?.review?.state !== "passed") problems.push(`${item.id}: wave ${item.wave} was not passed by the other model's review`);
    if (problems.length) unproven.push({ item, why: problems.join("; ") }); else proven.push(item);
  }
  return { proven, unproven };
}

export function blindVerdict(items: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>, runGoal: { state: string; detail?: string | null; headSha?: string | null } | null, now: number): FrozenVerdict | PendingVerdict {
  const problems: string[] = [];
  for (const item of items) problems.push(...pieceProof(item, facts.get(item.id)));
  const waiting = runGoalPending(runGoal);
  if (!runGoal) problems.push("the run's goal check has not run yet");
  else if (runGoal.state === "failed") problems.push(`the run's goal check failed${runGoal.detail ? `: ${runGoal.detail}` : ""}`);
  const inputSha = sha256(canonical({ items: items.map((item) => item.id), facts: items.map((item) => facts.get(item.id) ?? null), runGoal }));
  const state = problems.length ? "failed" : waiting ? "pending" : "passed";
  return { state, detail: problems.join("; ") || (waiting ? "the run's goal check is still running" : "every piece accepted and proved; the composition passes on main"), mainSha: runGoal?.headSha ?? null, at: now, inputSha } as FrozenVerdict | PendingVerdict;
}

/** The verdict of a plan that found the goal already met: nothing was built, so nothing is composed; the goal audit weighs the evidence next. */
export function alreadyMetVerdict(alreadyMet: { evidence: string }, now: number): FrozenVerdict {
  return { state: "passed", detail: `already met, nothing to build: ${alreadyMet.evidence}`.slice(0, 1000), mainSha: null, at: now, inputSha: sha256(canonical({ alreadyMet })) };
}

export const ACCEPTANCE_LINES = ["contract_current", "promises_proved", "checks_passed", "independent_check", "landed", "composition_verified", "main_unmoved", "qa_read", "goal_met", "limits_acknowledged", "owner_word"] as const;
export type AcceptanceLineId = (typeof ACCEPTANCE_LINES)[number];

/** The phase acceptance calculation: each line decided by code; the phase is accepted only when every line holds. */
export function acceptanceLines(phase: Phase, facts: ReadonlyMap<string, TaskFact>, now: { mainSha: string | null; openDeferrals: number }): AcceptanceLine[] {
  const items = phase.record.plan?.items ?? [];
  const verdict = phase.record.verification?.verdict;
  const line = (id: AcceptanceLineId, ok: boolean, detail: string): AcceptanceLine => ({ id, ok, detail });
  const failed = (pick: (fact: TaskFact | undefined) => boolean) => items.filter((item) => pick(facts.get(item.id))).map((item) => item.id);
  const notProved = items.filter((item) => { const fact = facts.get(item.id); return fact?.planFact !== "passed" && !(fact?.planFact === "skipped" && !needsPlanFact(item)); }).map((item) => item.id);
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
    : phase.stage === "acceptance" && r.uat && wordOf(r, "uat")?.decision !== "yes" ? "uat"
    : phase.stage === "acceptance" && wordOf(r, "acceptance")?.decision !== "yes" ? "acceptance" : null;
  if (turn) return { key: key(`word:${turn}`), stage: phase.stage, waitsForPm: true,
    text: `${head} awaits the owner's word at ${turn} (owner.words is on). Ask him with lane_pilot_ask_owner, then record it with ${tool("word", `, phaseId:"${id}", turn:"${turn}", decision:"yes"|"no", text`)}.` };
  if (phase.state === "paused" || phase.state === "pause_requested") return { key: key("paused"), stage: phase.stage, text: `${head} is paused; ${tool("resume", `, phaseId:"${id}"`)} moves it on.`, waitsForPm: false };
  switch (phase.stage) {
    case "discussion": {
      const check = discussionGate(r);
      return { key: key(r.context?.sha ?? "none"), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 1, discussion. Goal: ${phase.goal}\nWrite the discussion to files in the project (decisions locked/free/deferred, FAQ, ADR — workflow lp.brainstorm or lp.analyze writes them), name the four risks (${RISK_KINDS.join(", ")}), then ${tool("context", `, phaseId:"${id}", docs:["<path>", ...], risks:{technical, product, operations, security}`)}: Lane Pilot reads and signs them; pass requirements:[ids] and decisions:[locked ids] when the phase has them — the plan must cover each.\nRead first: ${stageInit(phase).join(", ")}. ${rubricLine("discussion")}${check.ok ? "" : `\nOpen: ${check.why.join("; ")}`}` };
    }
    case "planning": {
      const check = planGate(r);
      return { key: key(`${r.plan?.sha ?? "none"}:${r.plan?.critique?.decision ?? "-"}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 2, planning, on context ${r.context?.sha.slice(0, 12) ?? "?"}.\nSubmit the plan with ${tool("plan", `, phaseId:"${id}", items:[{id, title, wave, promise:{given, when, then}, task:<task-v2>}]`)}; then run the independent plan checker (workflow lp.plan's critic or grill-plan) and report it with ${tool("plan_check", `, phaseId:"${id}", decision:"approve"|"changes_requested", by, summary`)} (round ${(r.plan?.rounds ?? 0) + 1} of ${PLAN_ROUNDS_MAX}; a checker of another model than the planner).\nRead first: ${stageInit(phase).join(", ")}. ${rubricLine("planning")}${check.ok ? "" : `\nOpen: ${check.why.slice(0, 8).join("; ")}`}` };
    }
    case "design": {
      const check = designGate(r);
      return { key: key(`${r.design?.drawing?.sha256 ?? "none"}:${r.design?.drawing?.feasible ?? "-"}:${r.design?.drawing?.reviewer ?? "-"}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 3, design (${r.design?.why ?? ""}).\nHave design-lead draw the screens into ${phaseFolder(id)}/design/ (lane_pilot_helpers {action:"specialist", role:"design-lead"}), then ${tool("drawing", `, phaseId:"${id}", paths:[...], designer, feasible:true|false, contradiction?, reviewer`)} — the reviewer is a role other than the designer (ui-review / design-taste). Mode: ${r.design?.mode ?? "screens"}; the drawing's paths include its UI-SPEC.md (lane-plan template fill UI-SPEC).${r.design?.motion?.length ? ` Motion rows ${r.design.motion.join(", ")}: ${ANIMATOR_LAW}.` : ""}\nRead first: ${stageInit(phase).join(", ")}. ${rubricLine("design")}${check.ok ? "" : `\nOpen: ${check.why.join("; ")}`}` };
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
      if (r.ownerWords && !wordOf(r, "issue")) return { key: key("word:issue"), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution awaits the owner's word «issue» (owner.words is on). Ask him, then ${tool("word", `, phaseId:"${id}", turn:"issue", decision:"yes"|"no", text`)}.` };
      // A wave that is in with a failing line stops the next wave: said to the PM, not left as «Lane Pilot issues the next wave».
      const red = Object.entries(r.execution?.waves ?? {}).find(([wave, done]) => !done.lines.every((line) => line.ok)
        && !items.some((item) => item.wave === Number(wave) && issued[item.id] && facts.get(item.id)?.state !== "accepted"));
      if (red) return { key: key(`wave_red:${red[0]}:${red[1].packageSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: wave ${red[0]} is in, but ${red[1].lines.filter((line) => !line.ok).map((line) => `${line.id} (${line.detail})`).join("; ")}; the next wave waits. A failing promise needs new work: return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the failing piece (it is issued again) or add one.` };
      // A wave whose review by another model failed holds the phase at execution: said, with the review's words.
      const rejected = Object.entries(r.execution?.waves ?? {}).find(([, wave]) => wave.review?.state === "failed");
      if (rejected) return { key: key(`wave_review_failed:${rejected[0]}:${rejected[1].packageSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: the review of wave ${rejected[0]} by another model failed (${(rejected[1].review?.summary ?? "").slice(0, 600)}). Return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the pieces it names (they are issued again), or add one.` };
      const unreviewed = Object.entries(r.execution?.waves ?? {}).find(([, wave]) => wave.lines.every((line) => line.ok) && r.waveReview && !wave.review);
      if (unreviewed) return { key: key(`wave_review:${unreviewed[0]}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — wave ${unreviewed[0]} is in (package ${unreviewed[1].packageSha.slice(0, 12)}). Have another model verify it (workflow lp.review on the wave's diff, a reviewer model other than the writers'), then ${tool("wave_review", `, phaseId:"${id}", wave:${unreviewed[0]}, state:"passed"|"failed", by, summary`)}; the next wave waits for it.` };
      const unworded = Object.keys(r.execution?.waves ?? {}).find((wave) => r.ownerWords && !(r.words ?? []).some((word) => word.turn === "wave" && word.wave === Number(wave) && word.decision === "yes"));
      if (unworded) return { key: key(`word:wave:${unworded}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — wave ${unworded} awaits the owner's word (owner.words is on). Ask him, then ${tool("word", `, phaseId:"${id}", turn:"wave", wave:${unworded}, decision:"yes"|"no", text`)}.` };
      if (r.execution?.unchanged) return { key: key(`unchanged:${r.execution.unchanged.inputSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: every piece is accepted, but nothing changed since the verification failed (${r.execution.unchanged.detail}). Return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the failing piece's contract or add a piece; a changed piece is issued again.` };
      return { key: key(`running:${Object.keys(issued).length}:${open.length}`), stage: phase.stage, waitsForPm: false,
        text: `${head} — stage 4, execution: ${Object.keys(issued).length} of ${items.length} pieces issued, ${open.length} at work. Lane Pilot issues the next wave itself once this one is accepted.` };
    }
    case "verification": {
      const verdict = r.verification?.verdict;
      if (verdict?.state === "failed") return { key: key(`verdict-failed:${verdict.inputSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 5, verification failed: ${verdict.detail}. Accepted pieces are not run again by themselves: return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the failing piece's contract (a changed piece is issued again as a redo) or add a piece; a return to execution without new work meets the same verdict.` };
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
  // The signed documents are kept aside: back at discussion they are the PM's or the owner's correction to sign again, not a reason to analyse anew.
  if (order <= PHASE_STAGES.indexOf("discussion")) { if (next.context) next.signedBefore = { docs: next.context.docs.map((doc) => doc.path), risks: next.context.risks, decisions: next.context.decisions }; delete next.context; }
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
