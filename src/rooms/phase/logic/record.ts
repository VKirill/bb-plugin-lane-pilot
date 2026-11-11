import type { PhaseObservation } from "./observation";

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
export type CandidateTree = { path: string; startSha: string };
export type PhaseCandidate = { branch: string; trees: Record<string, CandidateTree>; off?: string;
  /** Each tree's head when the blind verdict froze: the package the acceptance decides on. */ verified?: Record<string, string>;
  /** The goal check of the candidate's own trees (the run's goal check reads main). */ goal?: { state: string; headSha: string | null; red: unknown[]; detail: string | null; at: number; tasks: number; runId: string; projectId: string };
  landed?: Record<string, string | null>; landedAt?: number };
/** A candidate in use: made, and not switched off. */
export const candidateOn = (record: PhaseRecord): boolean => !!record.candidate && !record.candidate.off && Object.keys(record.candidate.trees).length > 0;
/** What the run journal says about the plan checker (SMA p2_checker, p2_order, p2_session_end): a session of its own, started after the
 *  plan was done, with the last word. `ok` false names why; the gate admits an approval only with `ok`. */
export type CheckerIndependence = { ok: boolean; why: string; wfRunId?: string; checker?: string; planners?: string[]; checkerStartedAt?: number; plannedUntil?: number };
export type PlanCritique = { decision: "approve" | "changes_requested"; by: string; summary?: string; independence?: CheckerIndependence };
export type JournalStep = { nodeId: string; role: string | null; state: string; threadId: string | null; startedAt: number | null; endedAt: number | null };

/** Is the plan checker of this workflow run independent of the planner: judged by the journal's sessions and times, never by a name.
 *  `pmThread` and `submittedAt` stand for the planner when the run itself has no planner step (the PM wrote the plan). */
export function checkerIndependence(wfRunId: string, steps: readonly JournalStep[], opts: { pmThread: string; submittedAt?: number }): CheckerIndependence {
  const critics = steps.filter((step) => step.role === "plan-critic" && step.state === "succeeded" && step.threadId && step.startedAt != null)
    .sort((a, b) => a.startedAt! - b.startedAt!);
  const critic = critics.at(-1);
  if (!critic) return { ok: false, wfRunId, why: `no plan-critic session finished in workflow run ${wfRunId} (a skipped or missing critic is no check)` };
  const planners = steps.filter((step) => step.role === "planner" && step.threadId);
  const plannerThreads = [...new Set([...planners.map((step) => step.threadId!), opts.pmThread])];
  const plannedUntil = planners.length ? Math.max(...planners.map((step) => step.endedAt ?? step.startedAt ?? 0)) : opts.submittedAt ?? 0;
  const base = { wfRunId, checker: critic.threadId!, planners: plannerThreads, checkerStartedAt: critic.startedAt!, plannedUntil };
  if (plannerThreads.includes(critic.threadId!)) return { ...base, ok: false, why: `the plan checker went on in the planner's session ${critic.threadId}: continuing by message is no independent check` };
  const after = planners.filter((step) => (step.startedAt ?? 0) > (critic.endedAt ?? critic.startedAt!));
  if (after.length) return { ...base, ok: false, why: "the planner wrote again after the check: the checker must have the last word" };
  if (critic.startedAt! < plannedUntil) return { ...base, ok: false, why: "the plan checker started before the plan was done: the check must come after the planner" };
  return { ...base, ok: true, why: `checker ${critic.threadId} started after the planner (${plannerThreads.join(", ")}) and had the last word` };
}
export type Drawing = { paths: string[]; sha256: string; designer: string; reviewer?: string; feasible?: boolean; contradiction?: string; /** The commit the drawing's files landed under (SMA k_wd_c1): an archived edition's bytes are recoverable with `git show <commit>:<path>` (k_wd_version). */ commit?: string | null };
/** The sections the drawing's UI-SPEC.md must cover (SMA p3_requirements); system and mixed modes add c4 and the event chain. */
export const DRAWING_SECTIONS = ["actions", "screens_states", "texts", "heuristics", "accessibility"] as const;
export const DRAWING_SYSTEM_SECTIONS = ["c4", "event_chain"] as const;
export type FrozenVerdict = { state: "passed" | "failed"; detail: string; mainSha: string | null; at: number; inputSha: string };
/** What blindVerdict returns while the run's goal check is still running; it is never stored. */
export type PendingVerdict = Omit<FrozenVerdict, "state"> & { state: "pending" };
export type AcceptanceLine = { id: AcceptanceLineId | `design_${string}`; ok: boolean; detail: string };
export type ModelVerdict = { state: "met" | "unmet"; by: string; summary: string; at: number };

/** The four kinds of risk a discussion names before any solution (SMA p1_risks: value, usability, feasibility, viability); «none» is an answer, silence is not. */
export const RISK_KINDS = ["value", "usability", "feasibility", "viability"] as const;
export type RiskKind = (typeof RISK_KINDS)[number];
/** A security risk is named beside the four when there is one: it asks for a threat model before the plan (SMA k_wp_threat). */
export type RiskKey = RiskKind | "security";

/** A question a stage parks instead of guessing (SMA: Plan question parked, Answer a stage question); a blocking one holds the gate. */
export type StageQuestion = { id: string; stage: PhaseStage; text: string; blocking: boolean; askedAt: number; answer?: string; answeredBy?: string; answeredAt?: number };

/**
 * The owner's word at a turn, when the project asks for it (owner.words, on by default; SMA: Context signature, Plan row awaits a word,
 * Drawing confirmation, Issue gate, Person accepts the wave, UAT line, Keyed decision on the phase, Draft awaits a person).
 */
export const WORD_TURNS = ["context", "planning", "design", "issue", "wave", "acceptance", "uat", "lesson"] as const;
export type WordTurn = (typeof WORD_TURNS)[number];
/** At acceptance the word is two decisions (SMA p6_l_useful, p6_l_limits) under the key of the package the person was shown (p6_decide). */
export type OwnerWord = { turn: WordTurn; decision: "yes" | "no"; by: string; text: string; at: number; wave?: number; useful?: boolean; limits?: boolean; key?: string;
  /** The version the word was given on (SMA pc_contract): context sha, plan sha or drawing sha256; a yes counts only for it. */ sha?: string };

/** One UAT line a person answers by its number, pass or fail (SMA p5_uat_line). */
export type UatLine = { n: number; pieceId: string; state: "open" | "passed" | "failed"; note?: string; by?: string; at?: number };

/** A wave of the plan once its pieces are in (SMA: Wave package with hash, Wave acceptance lines, Wave verified by another model, Wave written to the book). */
export type WaveRecord = { packageSha: string; lines: Array<{ id: string; ok: boolean; detail: string }>; review?: { state: "passed" | "failed"; by: string; summary: string; at: number }; at: number;
  /** Each piece's own lines, the same set the wave folds (SMA bw_lines). */ pieces?: Record<string, Array<{ id: string; ok: boolean; detail: string }>> };

/** What the phase holds besides its row: one JSON record, each stage writes its part. */
export type PhaseRecord = {
  /** Opened by the rails for the owner's heavy request (src/rooms/phase/server/intake.ts): the PM cannot close it before acceptance. */
  rails?: boolean;
  /** The machine runs the stages' workflows itself (setting phase.train, on by default); false leaves every stage to the PM. */
  train?: boolean;
  /** The stage workflow the machine runs now (src/rooms/phase/server/auto-stages.ts). */
  auto?: { kind: string; wfRunId: string; startedAt: number; wave?: number };
  /** The context signed before a return to discussion: the machine signs these documents again instead of analysing anew. */
  signedBefore?: { docs: string[]; risks?: Partial<Record<RiskKey, string>>; decisions?: string[]; appetite?: string; noGos?: string[] };
  /** Runs of a stage's workflow that did not finish; at two the loop is spent and the machine ends it (scope cut, hunters, backlog). */
  autoFailures?: Partial<Record<string, number>>;
  /** Runs of a stage that failed from Lane Pilot's own fault (MACHINE_STAGE_FAILURE): at two the stage waits for a release; never cuts the scope. */
  autoMachineFailures?: Partial<Record<string, number>>;
  /** Failed runs of each stage's workflow over the phase's whole life, across versions (a new version forgets autoFailures, not this). */
  autoFailuresTotal?: Partial<Record<string, number>>;
  /** Set before the machine's outcome for a spent loop runs (exhausted), so a pass that finds the phase still active does not run it again. */
  exhausted?: { at: number };
  /** The machine's returns to planning after a failed verdict: what to plan for (cleared once planned) and how many so far. */
  replan?: { gaps?: string; count: number };
  /** The Lane Pilot version the failures were counted under: a new version tries the stages again. */
  autoFailuresVersion?: string;
  context?: { docs: ContextDoc[]; sha: string; signedAt: number; risks?: Partial<Record<RiskKey, string>>; legacy?: boolean; /** REQUIREMENTS ids this phase delivers. */ requirements?: string[]; /** Locked decision ids of CONTEXT.md. */ decisions?: string[];
    /** How much the phase may take, decided before the solution (SMA p1_appetite), and what it will not do (no-gos). */ appetite?: string; noGos?: string[] };
  questions?: StageQuestion[];
  /** The project asked for the owner's word at the turns (owner.words = on when the phase opened). */
  ownerWords?: boolean;
  /** The project set phase.diagnose = on when the phase opened: a failed verdict gets a parallel diagnosis before the replan. Absent = off. */
  diagnose?: boolean;
  /** The project set phase.gray_areas = on when the phase opened (and owner.words is on): the analysis asks the owner which gray areas to settle and
   * starts an adviser per area. Absent = off: the analysis is what it was. */
  grayAreas?: boolean;
  /** The project set phase.grill_gate = off when the phase opened: a grill that ended `open` does not hold admission. Absent = on. */
  grillGate?: boolean;
  words?: OwnerWord[];
  /** Goal revisions and withdrawn pieces, each one a decision in the book. */
  scope?: { revisions: number; withdrawn: string[] };
  plan?: { items: PlanItem[]; sha: string; contextSha: string; critique?: PlanCritique; admittedSha?: string; admittedAt?: number; /** When the plan was submitted. */ submittedAt?: number; /** The workflow run whose planner made this plan (the auto plan stage); its critic reviewed this very plan. */ fromRun?: string; /** Rounds of the independent check that asked for changes. */ rounds?: number;
    /** The plan's goals in one line (SMA p2_record: the plan's shape). */ objective?: string;
    /** Three to five pre-mortem risks: each a likely cause of failure a week after merge (SMA p2_record). */ premortem?: string[];
    /** The planner checked that the repository already does what the goal asks: no pieces, no execution; the goal audit checks the claim. */ alreadyMet?: { evidence: string };
    /** The one external refinement of this plan sha (SMA k_wp_bounce): ran once, its decision and rounds. */ bounce?: { sha: string; decision: string; rounds?: number; at: number };
    /** The budget read at admission (SMA k_v_grill): the pre-push plan states the remaining appetite and the money hold it read. */ budget?: string };
  design?: { decision: "needed" | "not_needed"; why: string; drawing?: Drawing; confirmedAt?: number; mode?: "screens" | "system" | "mixed"; motion?: string[]; archived?: Drawing[];
    /** The person's remarks on a returned drawing edition (SMA ts_feedback): kept against that edition's hash, fed to the redraw. */ feedback?: Array<{ drawingSha: string; text: string; by: string; at: number }>;
    /** The sections the drawing's UI-SPEC.md must cover, decided before anything is drawn (SMA p3_requirements). */ requirements?: string[] };
  /** The roadmap row this phase is (lane-plan ROADMAP.md), marked done when the phase closes. */
  roadmapRow?: string;
  /** Autonomous mode (setting phase.autonomous): when the phase closes the driver opens the next open roadmap row itself. */
  autonomous?: boolean;
  /** Execution with or without parallel writers (setting phase.subagents; off issues one piece at a time, inline). */
  subagents?: boolean;
  /** A marker branch at the accepted main (setting phase.branch): phase/<id>, or milestone/<slug> of the roadmap section (SMA k_we_branch). */
  branch?: "none" | "phase" | "milestone";
  /** The external plan bounce (setting phase.plan_bounce, off default): an approved plan is refined once by a second tool before admission (SMA k_wp_bounce). */
  planBounce?: boolean;
  /** Setting phase.commit_docs (on default): phase documents are committed after they are written; off writes the
   *  files without the gitCommitDocs call (SMA k_wp_commit). */
  commitDocs?: boolean;
  /** Setting phase.threat_closure (off default): verification refuses a pass while a SECURITY.md threat row lacks a
   *  mitigation citing a real file:line (SMA k_pl_security). */
  threatClosure?: boolean;
  /** Setting phase.design_points = on (off when unset): UI-SPEC.md checklist items become acceptance lines judged by the
   *  goal audit (SMA k_wv_design). Copied at open; absent = the acceptance lines are the fixed set. */
  designPoints?: boolean;
  /** Setting phase.doc_files = on (off when unset): STATE.md on every stage move and wave issue, SPEC.md, PLAN.md,
   *  VERIFICATION.md and the UAT.md rewrite are written into the project. Copied at open; absent = none of them. */
  docFiles?: boolean;
  /** Setting phase.ambiguity_gate = on (off when unset): the plan gate refuses above 0.5 ambiguity. Copied at open. */
  ambiguityGate?: boolean;
  /** Setting phase.piece_notes = on (off when unset): a piece's plan text carries Predictions, Risk and the animator's law
   *  (SMA k_d_tpl_predictions, k_we_animator_inline). Copied at open; absent = the plan text of a piece is unchanged. */
  pieceNotes?: boolean;
  /** The sha of each SPEC.md / PLAN.md / VERIFICATION.md the command last wrote (phase.doc_files): a file that no longer has this
   *  sha was changed by a person, and the new text goes next to it as <name>.new.md. */
  docShas?: Record<string, string>;
  /** The browser check is owed (SMA k_we_verify): browser_qa.enabled not off (unset = on) AND a browser machine named
   *  (browser_qa.host_id, project row else the hub-wide one). Copied at open; absent on older phases = nothing is owed. */
  liveCheck?: boolean;
  /** Research before the plan (setting phase.research, off by default = the daemon's skip answer; SMA k_wp_research). */
  research?: "on";
  /** Pattern mapping before the plan (setting phase.pattern_map, off by default; SMA k_wp_patterns). */
  patternMap?: "on";
  /** The validation strategy before the plan (setting phase.validation, off by default; SMA k_wp_validation). */
  validation?: "on";
  /** MATERIAL.md before the drawing (setting phase.draw_material, off by default; SMA k_wd_i1). */
  drawMaterial?: "on";
  /** The sha of each pre-plan document (RESEARCH/VALIDATION/PATTERNS.md) as the machine last wrote it, by path: a hand-edited file is not overwritten. */
  preDocShas?: Record<string, string>;
  /** The phase candidate (SMA p6_prepared → p6_merge): the pieces merge into branch phase/<id>, one worktree per base checkout, and the
   *  branch lands on main only after the acceptance. `off` says why a phase merges its pieces into main as before. */
  candidate?: PhaseCandidate;
  /** UAT.md written for the owner at acceptance (owner.words on): its lines, answered one by one by number (SMA p5_uat_line). */
  uat?: { path: string; sha256: string; at: number; lines?: UatLine[] };
  /** The conclusion and the roadmap/STATE marks written when the phase closed. */
  closedDocs?: { at: number; commit: string | null };
  execution?: { issued: Record<string, string>; startedAt?: number; baseSha?: string | null; issueErrors?: Record<string, string>; acceptedNoted?: string[]; waves?: Record<string, WaveRecord>;
    /** The contract each piece was issued with (pieceSha): a piece whose contract changed after a return to planning is issued again. */
    issuedSha?: Record<string, string>;
    /** All pieces accepted, but the facts are the ones a verdict already failed on: the phase waits for new work instead of failing again. */
    unchanged?: { inputSha: string; detail: string };
    /** The note of the return to execution: it rides into each redo's plan (SMA px_return_exec). */ returnNote?: string };
  /** Each finished wave is verified by another model before the next one is issued (setting phase.wave_review, on by default). */
  waveReview?: boolean;
  /** A stop asked for while a writer's stop is not observed yet (SMA px_stop): the phase stays open, issues nothing and asks again each pass. */
  stopping?: { by: string; words?: string; at: number; unconfirmed: string[] };
  /** A force-interrupt (SMA px_force): running work canceled by an explicit choice; the phase turns paused only once every stop is observed. */
  interrupting?: { by: string; at: number; unconfirmed: string[] };
  /** The most pieces the driver issues in one pass (Batch issue capacity; setting phase.issue_cap, 8 by default). */
  issueCap?: number;
  /** The seven-day rollback watch after acceptance (SMA p6_observe): what the machine saw in history; the acceptance is never touched. */
  observation?: PhaseObservation;
  verification?: { verdict?: FrozenVerdict; model?: ModelVerdict;
    /** The live interface check between the blind verdict and the goal audit (SMA k_we_uiqa): run by the machine, tied to the candidate head.
     *  "skipped" records a check that could not run (reason says why: no browser machine named) and never holds the phase. */
    live?: { state: "passed" | "blocked" | "skipped"; score40?: number; findings?: unknown; reportPath?: string; head?: string | null; reason?: string; at: number };
    /** The drawing contract's checkable points (SMA k_wv_design): read from UI-SPEC.md at verification, each an
     *  acceptance line once the goal audit judges it (met only with evidence). */
    points?: Array<{ id: string; text: string; met?: boolean; evidence?: string }>;
    /** The parallel diagnosis of a failed verdict's gaps (SMA k_c_diagnose): one per verdict, keyed by its inputSha. */
    diagnosis?: { inputSha: string; diagnoses: unknown[]; diagnosis: string; at: number } };
  acceptance?: { lines: AcceptanceLine[]; at: number; accepted: boolean };
  lessons?: { needed: boolean; why: string; analysis?: string; author?: string; reviewer?: string; reviewedHash?: string; /** The workflow run whose reviewer step read the analysis (its journal is the proof). */ reviewRun?: string; at?: number;
    /** The lesson as a draft (SMA p7_staged): it waits for the owner's word «lesson»; applied, it goes into memory (m_apply). A write that did not land is finished on a later pass from the same text (p7_recover). */
    draft?: { text: string; stagedAt: number; state: "staged" | "applied" | "declined"; at?: number; error?: string } };
  /** The book written to the project (.agents/phases/<id>/BOOK.md) up to this part. */
  bookWritten?: { seq: number; sha256: string; at: number };
  closing?: { by: string; words: string; at: number };
  /** A spent loop of tries ended the phase stopped, not closed: the proved pieces stay accepted, the others are withdrawn, the acceptance lines that do not hold are listed. */
  partial?: { at: number; kept: string[]; unproven: Array<{ id: string; why: string }>; unmet: string[] };
};

export type Phase = {
  id: string; projectId: string; pmThreadId: string; runId: string | null; title: string; goal: string;
  stage: PhaseStage; state: PhaseState; record: PhaseRecord; edition: number; createdAt: number; updatedAt: number;
};

export const ACCEPTANCE_LINES = ["contract_current", "promises_proved", "checks_passed", "independent_check", "landed", "composition_verified", "main_unmoved", "qa_read", "goal_met", "nothing_missing", "book_intact", "book_closed", "limits_acknowledged", "result_useful"] as const;
export type AcceptanceLineId = (typeof ACCEPTANCE_LINES)[number];
