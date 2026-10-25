import { builtinWorkflow } from "../../workflow";
import type { ServerCore, Services } from "../../core/server";
import { phaseFolder, planGate, type Phase, type PhaseRecord, type PlanItem, type RiskKind } from "../logic";

/**
 * The machine drives the train (Matvey #31766, #31782): at a stage that needs work, the driver starts that stage's workflow itself —
 * the discussion's analysis (lp.analyze), the plan with its critic (lp.plan), the review of a finished wave (lp.review), the goal
 * audit (lp.close) — and reports what it produced through the same gates a PM report goes through. The PM is no longer poked to
 * do a stage's work and to choose which workflow runs; a stage whose workflow failed twice goes back to the PM's hands, so the
 * train never stands without anyone named.
 */
export type AutoKind = "analyze" | "plan" | "review" | "close";
export const AUTO_WORKFLOWS: Record<AutoKind, string> = { analyze: "lp.analyze", plan: "lp.plan", review: "lp.review", close: "lp.close" };
/** Failed runs of one stage's workflow before the stage is the PM's again. */
export const AUTO_TRIES = 2;

export type AutoRecord = { kind: AutoKind; wfRunId: string; startedAt: number; wave?: number };

/** What the phase needs the machine to do now, or null when the stage is the PM's or nothing is due. */
export function autoDue(phase: Phase): { kind: AutoKind; wave?: number } | null {
  const r = phase.record;
  if (phase.state !== "active" || r.train === false) return null;
  const tried = (kind: AutoKind) => (r.autoFailures?.[kind] ?? 0) >= AUTO_TRIES;
  if (phase.stage === "discussion" && !r.context && !tried("analyze")) return { kind: "analyze" };
  // The plan, and the plan again in «gaps» mode while its critic asks for changes (at most three rounds, the plan gate's own limit).
  // Also when the critic approved but the plan gate (code) still refuses: the gate's reasons are the gaps of the next round.
  const gateRefuses = !!r.plan?.critique && r.plan.critique.decision === "approve" && !planGate(r).ok && !r.plan.admittedSha;
  if (phase.stage === "planning" && r.context && (!r.plan || gateRefuses || (r.plan.critique?.decision === "changes_requested" && (r.plan.rounds ?? 0) < 3)) && !tried("plan")) return { kind: "plan" };
  if (phase.stage === "execution" && r.waveReview) {
    const wave = Object.entries(r.execution?.waves ?? {}).find(([, done]) => done.lines.every((line) => line.ok) && !done.review);
    if (wave && !tried("review")) return { kind: "review", wave: Number(wave[0]) };
  }
  if (phase.stage === "verification" && r.verification?.verdict?.state === "passed" && !r.verification.model && !tried("close")) return { kind: "close" };
  return null;
}

/** The inputs of a stage's workflow, from the phase record. */
export function autoInputs(phase: Phase, due: { kind: AutoKind; wave?: number }): Record<string, unknown> {
  const r = phase.record;
  const contextText = (r.context?.docs ?? []).map((doc) => doc.path).join(", ");
  switch (due.kind) {
    case "analyze": return { goal: phase.goal, depth: "standard" };
    case "plan": {
      const gate = r.plan ? planGate(r) : null;
      const gaps = [...(r.plan?.critique?.decision === "changes_requested" && r.plan.critique.summary ? [r.plan.critique.summary] : []), ...(gate && !gate.ok ? gate.why : [])];
      return { goal: phase.goal, findings: { context: contextText, decisions: r.context?.decisions ?? [], requirements: r.context?.requirements ?? [] },
        ...(gaps.length ? { mode: "gaps", gaps } : {}),
        extra_rules: ["every command an acceptance line names is one of the task's verification commands", "each task's id is the piece id; depends_on only on tasks of earlier waves"] };
    }
    case "review": {
      const items = (r.plan?.items ?? []).filter((item) => item.wave === due.wave);
      return { range: r.execution?.baseSha ? `${r.execution.baseSha}..HEAD` : "HEAD~1..HEAD", dimensions: ["correctness", "tests", "contract"],
        criteria: items.map((item) => `${item.id}: given ${item.promise.given}; when ${item.promise.when}; then ${item.promise.then}`) };
    }
    case "close": return { goal: phase.goal, summary: r.verification?.verdict?.detail ?? "" };
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
    return {
      id: String(task.id), title: text(task.display_title ?? task.title, 200) || String(task.id), wave: waveOf(String(task.id)),
      promise: { given: text(task.objective ?? phase.goal, 600) || phase.title, when: text(task.title ?? task.id, 600), then: text(acceptance.join("; "), 600) || "its checks pass" },
      task,
    };
  });
}

export type AutoApi = {
  context(input: { phaseId: string; docs: string[]; risks: Partial<Record<RiskKind, string>>; decisions?: string[]; by: string }): Promise<Phase>;
  plan(input: { phaseId: string; items: PlanItem[]; design?: boolean; by: string }): Phase;
  planCheck(input: { phaseId: string; decision: "approve" | "changes_requested"; by: string; summary?: string }): Promise<Phase>;
  question(input: { phaseId: string; text: string; blocking: boolean; by: string }): Phase;
  waveReview(input: { phaseId: string; wave: number; state: "passed" | "failed"; by: string; summary: string }): Phase;
  goalAudit(input: { phaseId: string; state: "met" | "unmet"; by: string; summary: string }): Phase;
};

export function createAutoStages(ctx: Pick<ServerCore, "log">, services: Pick<Services, "workflowEngine">, deps: {
  api: AutoApi;
  get(phaseId: string): Phase;
  save(phaseId: string, record: PhaseRecord): void;
  book(phase: Phase, section: string, kind: string, text: string): void;
  writeDocs(phase: Phase, files: Array<{ path: string; content: string }>, message: string): Promise<{ written: string[] }>;
  runtime(phase: Phase): unknown | null;
  now(): number;
}) {
  const fail = (phase: Phase, kind: AutoKind, why: string) => {
    const failures = { ...(phase.record.autoFailures ?? {}), [kind]: (phase.record.autoFailures?.[kind] ?? 0) + 1 };
    deps.book(phase, "decisions", "auto_failed", `${AUTO_WORKFLOWS[kind]} did not finish (${why})${failures[kind]! >= AUTO_TRIES ? `: after ${AUTO_TRIES} runs the stage is the PM's` : ": run again on the next pass"}`);
    deps.save(phase.id, { ...phase.record, auto: undefined, autoFailures: failures });
  };

  async function apply(phase: Phase, auto: AutoRecord, output: Record<string, unknown>): Promise<void> {
    const by = `Lane Pilot ${AUTO_WORKFLOWS[auto.kind]} (${auto.wfRunId})`;
    if (auto.kind === "analyze") {
      const doc = contextDoc(phase, output);
      const path = `${phaseFolder(phase.id)}/CONTEXT.md`;
      const written = await deps.writeDocs(phase, [{ path, content: doc.content }], `phase ${phase.id}: CONTEXT.md from the analysis`);
      if (!written.written.includes(path)) throw new Error("CONTEXT.md was not written");
      for (const question of doc.questions.slice(0, 5)) deps.api.question({ phaseId: phase.id, text: question, blocking: false, by });
      await deps.api.context({ phaseId: phase.id, docs: [path], risks: doc.risks, decisions: doc.decisions, by });
    } else if (auto.kind === "plan") {
      const items = planItems(phase, output);
      if (!items.length) throw new Error(`lp.plan returned no tasks (status ${text(output.status, 30)})`);
      const planned = deps.api.plan({ phaseId: phase.id, items, design: output.has_ui === true, by });
      // lp.plan has the whole plan critiqued by its own critic role: that is the independent check of this plan.
      const approved = output.status === "ok" && !/reject|changes|rework|fail/i.test(text(output.plan_verdict, 200));
      await deps.api.planCheck({ phaseId: planned.id, decision: approved ? "approve" : "changes_requested", by: `${by}, plan critic`, summary: text(output.plan_verdict, 2000) });
    } else if (auto.kind === "review") {
      const passed = output.status === "pass";
      deps.api.waveReview({ phaseId: phase.id, wave: auto.wave ?? 1, state: passed ? "passed" : "failed", by,
        summary: text(`${output.status}; critical ${text(output.critical_count, 6)}, high ${text(output.high_count, 6)}; ${JSON.stringify(output.findings ?? []).slice(0, 1500)}`, 2000) });
    } else {
      const met = output.status === "closed";
      deps.api.goalAudit({ phaseId: phase.id, state: met ? "met" : "unmet", by, summary: text(met ? `every goal met; report ${text(output.report_path, 200)}` : `unmet: ${JSON.stringify(output.unmet_ids ?? [])}; ${text(output.status, 30)}`, 2000) || "goal audit" });
    }
  }

  /** One pass: settles a finished stage run, or starts the stage's workflow. True when the machine has the stage (the PM is not poked). */
  async function step(phase: Phase): Promise<boolean> {
    const running = phase.record.auto;
    if (running) {
      const summary = services.workflowEngine.get(running.wfRunId);
      if (!summary || summary.status === "running" || summary.status === "waiting") return true;
      if (summary.status !== "succeeded" || !summary.output) { fail(phase, running.kind, summary.error ?? summary.reason ?? summary.status); return false; }
      try {
        await apply(phase, running, summary.output);
        const after = deps.get(phase.id);
        deps.save(after.id, { ...after.record, auto: undefined });
        deps.book(after, "decisions", "auto_done", `${AUTO_WORKFLOWS[running.kind]} done (${running.wfRunId}) and reported through the gates`);
      } catch (cause) {
        fail(deps.get(phase.id), running.kind, cause instanceof Error ? cause.message : String(cause));
      }
      return true;
    }
    const due = autoDue(phase);
    if (!due) return false;
    const workflow = builtinWorkflow(AUTO_WORKFLOWS[due.kind]);
    const runtime = deps.runtime(phase);
    if (!workflow || !runtime) return false;
    try {
      const started = services.workflowEngine.start({ workflow, inputs: autoInputs(phase, due), key: `phase:${phase.id}:${due.kind}:${phase.edition}:${deps.now()}`, runtime,
        link: { projectId: phase.projectId, ...(phase.runId ? { runId: phase.runId } : {}) } });
      started.done.catch((cause: unknown) => ctx.log(`phase ${phase.id}: ${AUTO_WORKFLOWS[due.kind]} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
      deps.save(phase.id, { ...phase.record, auto: { kind: due.kind, wfRunId: started.runId, startedAt: deps.now(), ...(due.wave ? { wave: due.wave } : {}) } });
      deps.book(phase, "decisions", "auto_started", `Lane Pilot runs ${AUTO_WORKFLOWS[due.kind]} for the ${phase.stage} stage (${started.runId})`);
      return true;
    } catch (cause) {
      fail(phase, due.kind, cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }

  return { step };
}
