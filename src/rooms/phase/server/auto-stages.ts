import { builtinWorkflow } from "../../workflow";
import type { ServerCore, Services } from "../../core/server";
import { phaseFolder, planGate, type Phase, type PhaseRecord, type PlanItem, type RiskKind } from "../logic";
import packageJson from "../../../../package.json";

/**
 * The machine drives the train (Matvey #31766, #31782): at a stage that needs work, the driver starts that stage's workflow itself —
 * the discussion's analysis (lp.analyze), the plan with its critic (lp.plan), the review of a finished wave (lp.review), the goal
 * audit (lp.close) — and reports what it produced through the same gates a PM report goes through. The PM is no longer poked to
 * do a stage's work and to choose which workflow runs; a stage whose workflow failed twice goes back to the PM's hands, so the
 * train never stands without anyone named.
 */
export type AutoKind = "analyze" | "plan" | "draw" | "review" | "close" | "lessons";
/** Not a workflow: the machine signs again the documents a return to discussion left (the PM's or the owner's correction). */
export type AutoDue = { kind: AutoKind; wave?: number } | { kind: "resign" } | { kind: "replan" };
/** How many times the machine returns a phase to planning after a failed verdict before the loop is spent. */
/** A stage run that failed for Lane Pilot's own reasons (its guard, its output contract, its runtime, a provider), not because of the work. */
export const MACHINE_STAGE_FAILURE = /repo_edited|artifact_invalid|output_invalid|output field "[^"]+" is missing|thread_failed|thread_id_missing|plugin_stopped|interrupted by a reload|budget_exceeded|provider_error|writer_stream_error|read_binary_rejected|guard:|no_pm_environment|internal_error|timed out waiting/i;

export const AUTO_REPLANS = 2;
export const AUTO_WORKFLOWS: Record<AutoKind, string> = { analyze: "lp.analyze", plan: "lp.plan", draw: "lp.draw", review: "lp.review", close: "lp.close", lessons: "retrospective" };
/** Failed runs of one stage's workflow before the loop is spent. */
export const AUTO_TRIES = 2;
/** Failed runs of one stage's workflow over the phase's whole life: a new version forgets AUTO_TRIES, not this, so frequent releases do not give endless tries. */
export const AUTO_LIFETIME_TRIES = 3 * AUTO_TRIES;

export type AutoRecord = { kind: AutoKind; wfRunId: string; startedAt: number; wave?: number };

/** What the phase needs the machine to do now, or null when nothing is due (or the tries are spent: see `replansSpent` and `fail`). */
export function autoDue(phase: Phase): AutoDue | null {
  const r = phase.record;
  if (phase.state !== "active" || r.train === false) return null;
  const tried = (kind: AutoKind) => (r.autoFailures?.[kind] ?? 0) >= AUTO_TRIES || (r.autoFailuresTotal?.[kind] ?? 0) >= AUTO_LIFETIME_TRIES;
  if (phase.stage === "discussion" && !r.context && r.signedBefore?.docs.length) return { kind: "resign" };
  if (phase.stage === "discussion" && !r.context && !tried("analyze")) return { kind: "analyze" };
  // The plan, and the plan again in «gaps» mode while its critic asks for changes (at most three rounds, the plan gate's own limit).
  // Also when the critic approved but the plan gate (code) still refuses: the gate's reasons are the gaps of the next round.
  const gateRefuses = !!r.plan?.critique && r.plan.critique.decision === "approve" && !planGate(r).ok && !r.plan.admittedSha;
  if (phase.stage === "planning" && r.context && (!r.plan || gateRefuses || !!r.replan?.gaps || (r.plan.critique?.decision === "changes_requested" && (r.plan.rounds ?? 0) < 3)) && !tried("plan")) return { kind: "plan" };
  if (phase.stage === "design" && !r.design?.drawing && !tried("draw")) return { kind: "draw" };
  if (phase.stage === "execution" && r.waveReview) {
    const wave = Object.entries(r.execution?.waves ?? {}).find(([, done]) => done.lines.every((line) => line.ok) && !done.review);
    if (wave && !tried("review")) return { kind: "review", wave: Number(wave[0]) };
  }
  if (phase.stage === "verification" && r.verification?.verdict?.state === "passed" && !r.verification.model && !tried("close")) return { kind: "close" };
  // A failed verdict (red checks or an unmet goal audit) is planned again by the machine, with the verdict as the gaps, twice at most.
  if (phase.stage === "verification" && r.verification?.verdict?.state === "failed" && (r.replan?.count ?? 0) < AUTO_REPLANS) return { kind: "replan" };
  if (phase.stage === "lessons" && !r.lessons?.analysis && phase.runId && !tried("lessons")) return { kind: "lessons" };
  return null;
}

/** A failed verdict the machine already planned again AUTO_REPLANS times: the loop of replans is spent. */
export function replansSpent(phase: Phase): boolean {
  const r = phase.record;
  return phase.state === "active" && r.train !== false && phase.stage === "verification" && r.verification?.verdict?.state === "failed" && (r.replan?.count ?? 0) >= AUTO_REPLANS;
}

/** The inputs of a stage's workflow, from the phase record. */
export function autoInputs(phase: Phase, due: { kind: AutoKind; wave?: number }): Record<string, unknown> {
  const r = phase.record;
  const contextText = (r.context?.docs ?? []).map((doc) => doc.path).join(", ");
  switch (due.kind) {
    case "analyze": return { goal: phase.goal, depth: "standard" };
    case "plan": {
      const gate = r.plan ? planGate(r) : null;
      const gaps = [...(r.replan?.gaps ? [`the verification failed: ${r.replan.gaps}`] : []),
        ...(r.plan?.critique?.decision === "changes_requested" && r.plan.critique.summary ? [r.plan.critique.summary] : []), ...(gate && !gate.ok ? gate.why : [])];
      // After a failed verdict, or when the plan gate (code) refused an approved plan, the planner sees the pieces as they are, with covers.
      const gateRound = !!gate && !gate.ok && r.plan?.critique?.decision === "approve";
      const current = (r.replan?.gaps || gateRound) && r.plan ? (r.plan.items ?? []).map((item) => ({ id: item.id, wave: item.wave, covers: item.covers ?? [], task: item.task })) : null;
      return { goal: phase.goal, findings: { context: contextText, decisions: r.context?.decisions ?? [], requirements: r.context?.requirements ?? [], ...(current ? { current_pieces: current } : {}) },
        ...(gaps.length ? { mode: "gaps", gaps } : {}),
        extra_rules: ["every command an acceptance line names is one of the task's verification commands", "each task's id is the piece id; depends_on only on tasks of earlier waves",
          "each task lists in a top-level field `covers` the ids of the requirements and locked decisions (findings.requirements, findings.decisions) it carries out; together the tasks cover every id",
          ...(current && r.replan?.gaps ? ["the plan after a failed verification: return every piece of findings.current_pieces the gaps do not name exactly as it is (same id, same contract); change only the failing pieces' contracts or add new pieces for what is missing",
            // A changed contract issues the piece again: its writer redid accepted work and the proof check failed on what it no longer touched (live ph_26f65b142d).
            "a goal that lacks only proof of work already accepted (current screenshots, a live run, a smoke on the current build) gets a new check piece whose writer produces that proof on the current main; never change an accepted piece's contract to re-prove it"] : []),
          ...(current && !r.replan?.gaps ? ["the plan gate refused the approved plan: return the whole plan again — every piece of findings.current_pieces with its id and contract — and fix only what the gaps name (a piece's covers, its wave, its checks), adding a piece only for an id no piece can carry"] : [])] };
    }
    case "review": {
      const items = (r.plan?.items ?? []).filter((item) => item.wave === due.wave);
      return { range: r.execution?.baseSha ? `${r.execution.baseSha}..HEAD` : "HEAD~1..HEAD", dimensions: ["correctness", "tests", "contract"],
        criteria: items.map((item) => `${item.id}: given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}`) };
    }
    case "draw": return { goal: phase.goal, folder: phaseFolder(phase.id),
      pieces: (r.plan?.items ?? []).map((item) => `${item.id} — ${item.title}: given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}`).join("\n").slice(0, 8000) };
    case "close": return { goal: phase.goal, summary: r.verification?.verdict?.detail ?? "" };
    case "lessons": return { run_id: phase.runId ?? "" };
  }
}

const text = (value: unknown, max: number) => String(typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)).trim().slice(0, max);
const RISK_WORDS: Array<[RiskKind, RegExp]> = [["security", /secur|secret|auth|token|permission|безопас|секрет/i], ["operations", /deploy|ops|operat|backup|monitor|выкат|эксплуат/i], ["product", /user|product|ux|owner|пользоват|продукт/i]];

/** CONTEXT.md of the discussion, written by the machine from the analysis. */
export function contextDoc(phase: Phase, output: Record<string, unknown>): { content: string; risks: Record<RiskKind, string>; decisions: string[]; questions: string[] } {
  const decisions = Array.isArray(output.decisions) ? output.decisions as unknown[] : [];
  const risks = Array.isArray(output.risks) ? output.risks as unknown[] : [];
  const byKind: Record<RiskKind, string[]> = { technical: [], product: [], operations: [], security: [] };
  for (const risk of risks) {
    const line = text((risk as { text?: unknown; risk?: unknown; description?: unknown })?.text ?? (risk as { risk?: unknown })?.risk ?? (risk as { description?: unknown })?.description ?? risk, 300);
    const kind = (risk as { kind?: string })?.kind && ["technical", "product", "operations", "security"].includes(String((risk as { kind?: string }).kind)) ? (risk as { kind: RiskKind }).kind
      : RISK_WORDS.find(([, words]) => words.test(line))?.[0] ?? "technical";
    byKind[kind].push(line);
  }
  const ids: string[] = [];
  const decisionLines = decisions.map((decision, index) => {
    const d = decision as { id?: unknown; text?: unknown; decision?: unknown; status?: unknown; kind?: unknown };
    const id = text(d?.id, 40) || `D${index + 1}`;
    ids.push(id.slice(0, 40));
    return `- **${id}** (${text(d?.status ?? d?.kind, 20) || "locked"}): ${text(d?.text ?? d?.decision ?? decision, 500)}`;
  });
  const questions = (Array.isArray(output.open_questions) ? output.open_questions as unknown[] : []).map((question) => text(question, 1000)).filter(Boolean);
  const content = [
    `# Context — ${phase.title}`, "", `Goal: ${phase.goal}`, "",
    `Scope: ${text(output.scope_verdict, 40) || "unknown"}; recommendation: ${text(output.recommendation, 40) || "—"}; confidence: ${text(output.confidence, 10) || "—"}.`, "",
    "## Decisions", ...(decisionLines.length ? decisionLines : ["- none recorded"]), "",
    "## Risks", ...(["technical", "product", "operations", "security"] as RiskKind[]).map((kind) => `- ${kind}: ${byKind[kind].join("; ") || "none seen"}`), "",
    "## Open questions", ...(questions.length ? questions.map((question) => `- ${question}`) : ["- none"]), "",
    "Written by Lane Pilot from the analysis (lp.analyze); the plan stands on this file.",
  ].join("\n");
  const risksText = Object.fromEntries((["technical", "product", "operations", "security"] as RiskKind[]).map((kind) => [kind, (byKind[kind].join("; ") || "none seen").slice(0, 600)])) as Record<RiskKind, string>;
  return { content, risks: risksText, decisions: ids, questions };
}

/** Plan pieces from lp.plan: each task-v2 contract with its wave and a promise drawn from the contract. */
export function planItems(phase: Phase, output: Record<string, unknown>): PlanItem[] {
  const tasks = Array.isArray(output.tasks) ? output.tasks as Array<Record<string, unknown>> : [];
  const waves = Array.isArray(output.waves) ? output.waves as unknown[][] : [];
  const waveOf = (id: string) => { const index = waves.findIndex((wave) => Array.isArray(wave) && wave.map(String).includes(id)); return index >= 0 ? index + 1 : 1; };
  return tasks.filter((task) => typeof task.id === "string").map((task) => {
    const acceptance = Array.isArray(task.acceptance) ? (task.acceptance as unknown[]).map(String) : [];
    const { covers, ...contract } = task;
    const ids = Array.isArray(covers) ? (covers as unknown[]).map(String).filter(Boolean).slice(0, 40) : [];
    return {
      id: String(task.id), title: text(task.display_title ?? task.title, 200) || String(task.id), wave: waveOf(String(task.id)),
      promise: { given: text(task.objective ?? phase.goal, 600) || phase.title, when: text(task.title ?? task.id, 600), then: text(acceptance.join("; "), 600) || "its checks pass" },
      task: contract, ...(ids.length ? { covers: ids } : {}),
    };
  });
}

export type AutoApi = {
  context(input: { phaseId: string; docs: string[]; risks: Partial<Record<RiskKind, string>>; decisions?: string[]; by: string }): Promise<Phase>;
  plan(input: { phaseId: string; items: PlanItem[]; design?: boolean; alreadyMet?: string; by: string }): Phase;
  planCheck(input: { phaseId: string; decision: "approve" | "changes_requested"; by: string; summary?: string }): Promise<Phase>;
  question(input: { phaseId: string; text: string; blocking: boolean; by: string }): Phase;
  waveReview(input: { phaseId: string; wave: number; state: "passed" | "failed"; by: string; summary: string }): Phase;
  goalAudit(input: { phaseId: string; state: "met" | "unmet"; by: string; summary: string }): Phase;
  lessons(input: { phaseId: string; analysis: string; author: string; reviewer: string; reviewedHash: string; by: string }): Phase;
  drawing(input: { phaseId: string; paths: string[]; designer: string; feasible: boolean; contradiction?: string; reviewer?: string; by: string }): Promise<Phase>;
  returnTo(input: { phaseId: string; to: "planning"; note: string; by: string }): Phase;
};

export function createAutoStages(ctx: Pick<ServerCore, "log">, services: Pick<Services, "workflowEngine">, deps: {
  api: AutoApi;
  /** The machine's one outcome when a loop of tries is spent (loop_exhausted): scope cut or stop, hunters, backlog item, morning-list line, one notice to the PM. */
  exhausted(phase: Phase, input: { kind: "stage" | "replan"; stage: string; why: string }): Promise<void>;
  get(phaseId: string): Phase;
  save(phaseId: string, record: PhaseRecord): void;
  book(phase: Phase, section: string, kind: string, text: string): void;
  writeDocs(phase: Phase, files: Array<{ path: string; content: string }>, message: string): Promise<{ written: string[] }>;
  /** The hash of the phase book's last part: what the machine read when it reports the lessons. */
  bookHead(phase: Phase): string;
  runtime(phase: Phase): unknown | null;
  /** Whether the PM chat is idle (no turn running). */
  pmIdle(phase: Phase): Promise<boolean>;
  now(): number;
  /** Whether the phase's run is halted or paused: the machine starts nothing for it meanwhile. */
  runStopped?(phase: Phase): Promise<boolean>;
  /** The running Lane Pilot version (package.json when not given). */
  version?: string;
  /** Git's verdicts on whether the run's recorded proofs still cover the code (proof-currency), as text for the goal audit; null when none. */
  proofCurrency?(phase: Phase): Promise<string | null>;
}) {
  const version = deps.version ?? packageJson.version;
  /** Counts a failed run of a stage's workflow. True when that spent the stage's tries: the loop is ended by the machine (scope cut, hunters, backlog), not handed to the PM. */
  const fail = async (phase: Phase, kind: AutoKind, why: string): Promise<boolean> => {
    // Lane Pilot's own fault is no loop of the product: the stage waits for a release that fixes it and runs again then (auto_retry on a new
    // version); it does not count toward the phase's life and never cuts its scope. Every one of the 15 live stage failures before 0.1.336 was
    // of this kind (repo_edited, a missing output field, guard:maxVisits, plugin_stopped, budget_exceeded, provider_error, a binary read),
    // and under 0.1.336 a pair of them would have stopped the owner's phase for good (Fable's recheck, 2026-10-27).
    if (MACHINE_STAGE_FAILURE.test(why)) {
      const failures = { ...(phase.record.autoFailures ?? {}), [kind]: (phase.record.autoFailures?.[kind] ?? 0) + 1 };
      const waits = failures[kind]! >= AUTO_TRIES;
      deps.book(phase, "decisions", "auto_failed", `${AUTO_WORKFLOWS[kind]} did not finish (${why}): Lane Pilot's own fault, not the work's — ${waits ? "the stage waits for a release that fixes it and runs again then" : "run again on the next pass"}; the phase's scope is not cut`);
      ctx.log(`phase stage failed from Lane Pilot: ${AUTO_WORKFLOWS[kind]}: ${why.slice(0, 300)}`);
      deps.save(phase.id, { ...phase.record, auto: undefined, autoFailures: failures, autoFailuresVersion: version });
      return false;
    }
    const failures = { ...(phase.record.autoFailures ?? {}), [kind]: (phase.record.autoFailures?.[kind] ?? 0) + 1 };
    const total = { ...(phase.record.autoFailuresTotal ?? {}), [kind]: (phase.record.autoFailuresTotal?.[kind] ?? 0) + 1 };
    const lifetime = total[kind]! >= AUTO_LIFETIME_TRIES;
    const spent = lifetime || failures[kind]! >= AUTO_TRIES;
    deps.book(phase, "decisions", "auto_failed", `${AUTO_WORKFLOWS[kind]} did not finish (${why})${spent ? `: ${lifetime ? `${total[kind]} failed runs in the life of the phase` : `${AUTO_TRIES} runs`} — the loop is spent, the machine ends it: scope cut, hunters, backlog` : ": run again on the next pass"}`);
    deps.save(phase.id, { ...phase.record, auto: undefined, autoFailures: failures, autoFailuresTotal: total, autoFailuresVersion: version });
    if (!spent) return false;
    await deps.exhausted(deps.get(phase.id), { kind: "stage", stage: kind, why: `${AUTO_WORKFLOWS[kind]} failed ${failures[kind]} time(s) in this version, ${total[kind]} in the life of the phase; the last: ${why}` })
      .catch((cause: unknown) => ctx.log(`phase ${phase.id}: the ended ${kind} loop could not be closed out: ${cause instanceof Error ? cause.message : String(cause)}`));
    return true;
  };

  async function apply(phase: Phase, auto: AutoRecord, output: Record<string, unknown>): Promise<void> {
    const by = `Lane Pilot ${AUTO_WORKFLOWS[auto.kind]} (${auto.wfRunId})`;
    if (auto.kind === "analyze") {
      // The PM may have signed a context meanwhile: then the analysis is not written over its documents.
      if (phase.stage !== "discussion" || phase.record.context) return;
      const doc = contextDoc(phase, output);
      const path = `${phaseFolder(phase.id)}/CONTEXT.md`;
      const written = await deps.writeDocs(phase, [{ path, content: doc.content }], `phase ${phase.id}: CONTEXT.md from the analysis`);
      if (!written.written.includes(path)) throw new Error("CONTEXT.md was not written");
      for (const question of doc.questions.slice(0, 5)) deps.api.question({ phaseId: phase.id, text: question, blocking: false, by });
      await deps.api.context({ phaseId: phase.id, docs: [path], risks: doc.risks, decisions: doc.decisions, by });
    } else if (auto.kind === "plan") {
      if (phase.stage !== "planning" || phase.record.plan?.admittedSha) return;
      const fresh = planItems(phase, output);
      // An empty plan with already_met is the planner's answer that the repository does the goal: booked as such, nothing is executed,
      // the goal audit checks the claim. After a failed verdict (replan gaps) it is not believed: the verdict said the goal is not met.
      const met = !fresh.length && output.already_met === true && !phase.record.replan?.gaps;
      if (!fresh.length && !met) throw new Error(`lp.plan returned no tasks (status ${text(output.status, 30)})`);
      // After a failed verdict the planner returns the pieces it changed or added; the others stay as they were (a planner that dropped
      // them dropped their coverage and the work they carry, live 2026-10-25). The new pieces run after the old waves.
      const old = phase.record.replan?.gaps ? phase.record.plan?.items ?? [] : [];
      const lastWave = Math.max(0, ...old.map((item) => item.wave));
      const items = old.length ? [...old.filter((item) => !fresh.some((next) => next.id === item.id)), ...fresh.map((item) => ({ ...item, wave: lastWave + item.wave }))] : fresh;
      const planned = deps.api.plan({ phaseId: phase.id, items, design: output.has_ui === true, ...(met ? { alreadyMet: `the planner checked the repository: ${text(output.objective, 600) || phase.goal}` } : {}), by });
      // lp.plan has the whole plan critiqued by its own critic role: that is the independent check of this plan.
      const approved = output.status === "ok" && !/reject|changes|rework|fail/i.test(text(output.plan_verdict, 200));
      await deps.api.planCheck({ phaseId: planned.id, decision: approved ? "approve" : "changes_requested", by: `${by}, plan critic`, summary: text(output.plan_verdict, 2000) });
      // The replan's gaps hold until the plan is admitted: a second round still merges into the pieces that were.
      const checked = deps.get(planned.id);
      if (checked.record.replan?.gaps && checked.record.plan?.admittedSha) deps.save(checked.id, { ...checked.record, replan: { count: checked.record.replan.count } });
    } else if (auto.kind === "draw") {
      if (phase.stage !== "design" || phase.record.design?.drawing) return;
      if (output.verdict !== "pass") throw new Error(`the drawing's checker asks for rework: ${text(output.notes, 300)}`);
      const paths = Array.isArray(output.paths) ? (output.paths as unknown[]).map(String) : [];
      await deps.api.drawing({ phaseId: phase.id, paths, designer: "lp.draw: specialist design-lead", feasible: output.feasible !== false,
        ...(output.contradiction ? { contradiction: text(output.contradiction, 2000) } : {}), reviewer: "lp.draw: plan-critic", by });
    } else if (auto.kind === "review") {
      const passed = output.status === "pass";
      deps.api.waveReview({ phaseId: phase.id, wave: auto.wave ?? 1, state: passed ? "passed" : "failed", by,
        summary: text(`${output.status}; critical ${text(output.critical_count, 6)}, high ${text(output.high_count, 6)}; ${JSON.stringify(output.findings ?? []).slice(0, 1500)}`, 2000) });
    } else if (auto.kind === "lessons") {
      if (phase.stage !== "lessons" || phase.record.lessons?.analysis) return;
      const insights = Array.isArray(output.insights) ? output.insights as unknown[] : [];
      const analysis = [`Retrospective of the run (${text(output.status, 20)}; ${text(output.candidates_staged, 6) || 0} rule or note candidate(s) staged${output.retro_path ? `, ${text(output.retro_path, 200)}` : ""}).`,
        ...insights.slice(0, 12).map((insight) => `- ${text((insight as { text?: unknown; title?: unknown })?.text ?? (insight as { title?: unknown })?.title ?? insight, 280)}`)].join("\n");
      // The retrospective's two roles: «retro» writes the insights, «stage» weighs and stages them — the author and its reviewer.
      deps.api.lessons({ phaseId: phase.id, analysis, author: "retrospective: retro", reviewer: "retrospective: stage", reviewedHash: deps.bookHead(phase), by });
    } else {
      const met = output.status === "closed";
      // The replan reads this summary as its gaps: each unmet goal with what it lacks, and the drift. Ids alone left the planner
      // blind (2026-10-26, a Roblox UI phase: «unmet: []; halted» twice, the planner fixed something else, the audit asked again).
      const goals = Array.isArray(output.goals) ? output.goals as Array<{ id?: unknown; status?: unknown; missing?: unknown }> : [];
      const lacking = goals.filter((goal) => String(goal?.status ?? "").toUpperCase() !== "MET").map((goal) => `- ${text(goal.id, 80)}: ${text(goal.missing, 400) || "not met"}`);
      const drift = (Array.isArray(output.drift_items) ? output.drift_items : []).map((item) => `- drift: ${text(item, 400)}`);
      const unmetSummary = [`unmet: ${JSON.stringify(output.unmet_ids ?? [])}; ${text(output.status, 30)}`, ...lacking, ...drift].join("\n");
      deps.api.goalAudit({ phaseId: phase.id, state: met ? "met" : "unmet", by, summary: text(met ? `every goal met; report ${text(output.report_path, 200)}` : unmetSummary, 2000) || "goal audit" });
    }
  }

  /** One pass: settles a finished stage run, or starts the stage's workflow. True when the machine has the stage (the PM is not poked). */
  /** A close run started before 0.1.331 ends «halted» from the owner's form with no goals: its audit step still has them. */
  function withAuditGoals(runId: string, output: Record<string, unknown>): Record<string, unknown> {
    if (output.status === "closed" || Array.isArray(output.goals)) return output;
    const audit = services.workflowEngine.snapshot?.(runId)?.steps.find((row) => row.node_id === "goal_audit" && row.output_json);
    try {
      const found = audit?.output_json ? JSON.parse(audit.output_json) as Record<string, unknown> : null;
      return found ? { ...output, goals: found.goals, drift_items: found.drift_items } : output;
    } catch { return output; }
  }

  async function step(phase: Phase): Promise<boolean> {
    // Failures counted under another version may be the ones it fixed: after a deploy the machine tries the stage again.
    if (phase.record.autoFailures && phase.record.autoFailuresVersion !== version) {
      deps.book(phase, "decisions", "auto_retry", `Lane Pilot ${version}: the stages the machine gave up on under ${phase.record.autoFailuresVersion ?? "an earlier version"} are tried again`);
      deps.save(phase.id, { ...phase.record, autoFailures: undefined, autoFailuresVersion: undefined });
      phase = deps.get(phase.id);
    }
    const running = phase.record.auto;
    if (running) {
      const summary = services.workflowEngine.get(running.wfRunId);
      if (!summary || summary.status === "running" || summary.status === "waiting") return true;
      if (summary.status !== "succeeded" || !summary.output) {
        // A run a reload or deploy stopped (its helper thread died with the plugin) is not the stage's failure: it runs again and keeps its tries (live, 2026-10-25).
        if (summary.status === "interrupted" || /plugin_stopped|interrupted by a reload/.test(`${summary.error ?? ""} ${summary.reason ?? ""}`)) {
          deps.book(phase, "decisions", "auto_restart", `${AUTO_WORKFLOWS[running.kind]} was stopped by a reload (${summary.error ?? summary.reason ?? summary.status}): run again, the try is not counted`);
          deps.save(phase.id, { ...phase.record, auto: undefined });
          return false;
        }
        return fail(phase, running.kind, summary.error ?? summary.reason ?? summary.status);
      }
      try {
        await apply(phase, running, running.kind === "close" ? withAuditGoals(running.wfRunId, summary.output) : summary.output);
        const after = deps.get(phase.id);
        deps.save(after.id, { ...after.record, auto: undefined });
        deps.book(after, "decisions", "auto_done", `${AUTO_WORKFLOWS[running.kind]} done (${running.wfRunId}) and reported through the gates`);
      } catch (cause) {
        await fail(deps.get(phase.id), running.kind, cause instanceof Error ? cause.message : String(cause));
      }
      return true;
    }
    const due = autoDue(phase);
    if (!due) {
      // Two machine replans did not make the verification pass: the loop of replans is spent and the machine ends it.
      if (!replansSpent(phase)) return false;
      if (await deps.runStopped?.(phase)) return true;
      deps.book(phase, "decisions", "replans_spent", `the verification failed again after ${AUTO_REPLANS} machine replans — the loop is spent, the machine ends it: scope cut, hunters, backlog`);
      await deps.exhausted(phase, { kind: "replan", stage: "replan", why: `${AUTO_REPLANS} replans did not make the verification pass; now: ${phase.record.verification?.verdict?.detail ?? "failed"}` })
        .catch((cause: unknown) => ctx.log(`phase ${phase.id}: the ended replan loop could not be closed out: ${cause instanceof Error ? cause.message : String(cause)}`));
      return true;
    }
    // A run the owner stopped or paused starts no stage on the machine's own; the stage is held (the PM is not poked) until it goes on.
    if (await deps.runStopped?.(phase)) return true;
    if (due.kind === "replan") {
      const detail = phase.record.verification?.verdict?.detail ?? "the verification failed";
      const count = (phase.record.replan?.count ?? 0) + 1;
      const back = deps.api.returnTo({ phaseId: phase.id, to: "planning", note: `the verification failed (${count} of ${AUTO_REPLANS} machine returns): ${detail}`, by: "Lane Pilot (replan after a failed verdict)" });
      deps.save(back.id, { ...back.record, replan: { gaps: detail, count } });
      return true;
    }
    if (due.kind === "resign") {
      // Signed when the PM's turn is over, so a file it is still editing is not signed half-way.
      if (!(await deps.pmIdle(phase))) return true;
      const before = phase.record.signedBefore!;
      try {
        await deps.api.context({ phaseId: phase.id, docs: before.docs, risks: before.risks ?? {}, ...(before.decisions ? { decisions: before.decisions } : {}), by: "Lane Pilot (signed again after the return)" });
        const after = deps.get(phase.id);
        deps.save(after.id, { ...after.record, signedBefore: undefined });
      } catch (cause) {
        // A document that is gone or empty: the stage is analysed anew.
        deps.book(phase, "decisions", "auto_failed", `signing the returned documents again failed (${cause instanceof Error ? cause.message : String(cause)}): the discussion is analysed anew`);
        deps.save(phase.id, { ...deps.get(phase.id).record, signedBefore: undefined });
      }
      return true;
    }
    const workflow = builtinWorkflow(AUTO_WORKFLOWS[due.kind]);
    const runtime = deps.runtime(phase);
    if (!workflow || !runtime) return false;
    try {
      // The goal audit is told from git which recorded proofs are stale, so it does not work currency out by hand; a failed lookup only leaves the facts out.
      const currency = due.kind === "close" && deps.proofCurrency ? await deps.proofCurrency(phase).catch(() => null) : null;
      const started = services.workflowEngine.start({ workflow, inputs: { ...autoInputs(phase, due), ...(currency ? { proof_currency: currency } : {}) }, key: `phase:${phase.id}:${due.kind}:${phase.edition}:${deps.now()}`, runtime,
        link: { projectId: phase.projectId, ...(phase.runId ? { runId: phase.runId } : {}) } });
      started.done.catch((cause: unknown) => ctx.log(`phase ${phase.id}: ${AUTO_WORKFLOWS[due.kind]} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
      deps.save(phase.id, { ...phase.record, auto: { kind: due.kind, wfRunId: started.runId, startedAt: deps.now(), ...(due.wave ? { wave: due.wave } : {}) } });
      deps.book(phase, "decisions", "auto_started", `Lane Pilot runs ${AUTO_WORKFLOWS[due.kind]} for the ${phase.stage} stage (${started.runId})`);
      return true;
    } catch (cause) {
      return fail(phase, due.kind, cause instanceof Error ? cause.message : String(cause));
    }
  }

  return { step };
}
