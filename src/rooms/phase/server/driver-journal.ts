import { getRunSettingsScopes } from "../../storage";
import { sha256 } from "../logic";
import { savePhase } from "../store";
import { PhaseRefusal, type DriverTools } from "./driver-tools";
import type { Phase } from "../logic";

/**
 * The phase's journal: the workflow journal the independence check reads, the proof that a reviewer saw the lessons, and the
 * lesson itself as it goes through the memory door. The door is a reaction (`tools.reactions`), so this piece decides what the
 * phase learned and does not import the room that keeps the memory.
 */
export function installJournal(tools: DriverTools): Pick<DriverTools,
  "journalSteps" | "checkerRunBinding" | "reviewerRead" | "writeLesson" | "settleLesson"> {
  const { db, now, reactions } = tools;

  /** The journal of a workflow run as the independence check reads it: each step's role from the run's own stored definition. */
  function journalSteps(wfRunId: string) {
    const run = db.prepare("SELECT definition_json FROM lane_pilot_wf_run WHERE id=?").get(wfRunId) as { definition_json: string } | undefined;
    if (!run) return null;
    let roles = new Map<string, string>();
    try { roles = new Map(((JSON.parse(run.definition_json) as { nodes?: Array<{ id: string; role?: string }> }).nodes ?? []).filter((node) => node.role).map((node) => [node.id, node.role!])); } catch { /* no roles: no critic */ }
    const rows = db.prepare("SELECT node_id, state, receipt_json, started_at, ended_at FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid").all(wfRunId) as Array<{ node_id: string; state: string; receipt_json: string | null; started_at: number | null; ended_at: number | null }>;
    return rows.map((row) => {
      let threadId: string | null = null;
      try { threadId = (JSON.parse(row.receipt_json ?? "null") as { threadId?: string | null } | null)?.threadId ?? null; } catch { /* no receipt */ }
      return { nodeId: row.node_id, role: roles.get(row.node_id) ?? null, state: row.state, threadId, startedAt: row.started_at, endedAt: row.ended_at };
    });
  }

  /**
   * Is this journal the check of this plan (SMA audit N-03): a run of the phase's own project and run, made for this plan — the run
   * whose planner made it (plan.fromRun), or for a plan the PM submitted, a run handed its plan_sha after it — and an approval its critic's own
   * output gives (plan_verdict pass), not one the caller says over a «changes requested». The reason it is not; null when it is.
   */
  function checkerRunBinding(phase: Phase, wfRunId: string, decision: "approve" | "changes_requested"): string | null {
    const run = db.prepare("SELECT project_id, link_run_id, created_at, inputs_json, output_json FROM lane_pilot_wf_run WHERE id=?").get(wfRunId) as
      { project_id: string | null; link_run_id: string | null; created_at: number; inputs_json: string | null; output_json: string | null } | undefined;
    if (!run) return `workflow run ${wfRunId} is not in the journal`;
    if (run.project_id !== phase.projectId) return `workflow run ${wfRunId} belongs to project ${run.project_id ?? "none"}, not to this phase's ${phase.projectId}`;
    if (run.link_run_id && run.link_run_id !== phase.runId) return `workflow run ${wfRunId} belongs to run ${run.link_run_id}, not to this phase's ${phase.runId ?? "(none yet)"}`;
    const plan = phase.record.plan!;
    // The plan the run checked is this plan: the run whose planner made it, or a run handed its signature (plan_sha) after it was
    // submitted. A fresh run of the same project that checked another plan does not admit this one (SMA audit R-02).
    let handed: { plan_sha?: unknown } = {};
    try { handed = JSON.parse(run.inputs_json ?? "{}") ?? {}; } catch { /* no inputs: no plan handed */ }
    if (plan.fromRun ? plan.fromRun !== wfRunId : handed.plan_sha !== plan.sha || run.created_at < (plan.submittedAt ?? 0))
      return `workflow run ${wfRunId} did not check this plan (${plan.fromRun ? `the plan came from ${plan.fromRun}` : `it was not handed plan_sha ${plan.sha.slice(0, 12)} after the plan was submitted`})`;
    if (decision === "approve") {
      let output: { status?: unknown; plan_verdict?: unknown } = {};
      try { output = JSON.parse(run.output_json ?? "{}") ?? {}; } catch { /* no output: no approval in it */ }
      if (output.plan_verdict !== "pass" || (output.status !== undefined && output.status !== "ok")) return `the critic of ${wfRunId} did not approve: its output says ${String(output.plan_verdict ?? output.status ?? "nothing").slice(0, 120)}`;
    }
    return null;
  }

  /**
   * Reviewer saw these bytes (SMA p7_saw_bytes), read from the run journal, never from the caller: the reviewer step of `reviewRun` (a session
   * of its own, not the author's) received the analysis in its input, and the engine's receipt measured that input (inputSha256 of input_json).
   * Before (SMA audit N-04) a caller's own hash and a reviewer's name were enough, with no run at all.
   */
  function reviewerRead(phase: Phase, runId: string, node: string, analysis: string): { author: string; reviewer: string; inputSha: string } | { why: string } {
    const run = db.prepare("SELECT project_id FROM lane_pilot_wf_run WHERE id=?").get(runId) as { project_id: string | null } | undefined;
    if (!run) return { why: `workflow run ${runId} is not in the journal: the lessons name the run whose reviewer read them` };
    if (run.project_id !== phase.projectId) return { why: `workflow run ${runId} belongs to project ${run.project_id ?? "none"}, not to this phase's ${phase.projectId}` };
    const step = db.prepare("SELECT input_json, receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state='succeeded' ORDER BY rowid DESC LIMIT 1").get(runId, node) as { input_json: string; receipt_json: string | null } | undefined;
    if (!step) return { why: `no finished reviewer step «${node}» in workflow run ${runId}` };
    let receipt: { inputSha256?: string; threadId?: string | null } = {};
    let input: { with?: unknown; via?: { fromThreadId?: string; handoff?: string } } = {};
    try { receipt = JSON.parse(step.receipt_json ?? "{}") ?? {}; input = JSON.parse(step.input_json) ?? {}; } catch { /* unreadable: no proof */ }
    if (!receipt.threadId) return { why: `the reviewer step «${node}» of ${runId} ran in no session of its own` };
    if (receipt.inputSha256 !== sha256(step.input_json)) return { why: `the journal's measurement of the reviewer's input does not match its bytes in ${runId}` };
    const author = input.via?.fromThreadId ?? null;
    if (!author || author === receipt.threadId) return { why: `the reviewer of ${runId} is not a session other than the analysis's author` };
    const carried = `${input.via?.handoff ?? ""}\n${JSON.stringify(input.with ?? {})}`;
    if (!carried.includes(analysis)) return { why: `the reviewer step «${node}» of ${runId} did not receive these bytes: the analysis is not in its input` };
    return { author, reviewer: receipt.threadId, inputSha: receipt.inputSha256 };
  }

  /** Lesson written by the pipeline: the analysis goes through the memory door as a note of the project (refused text stays only in the book). */
  function writeLesson(phase: Phase, text: string): string | null {
    try {
      reactions.storeMemoryRecord({ projectId: phase.projectId, audience: "subagent", sourceSha256: sha256(`${phase.id}:${text}`), origin: "phase-lessons",
        scope: phase.runId ? getRunSettingsScopes(db, phase.runId) : [], coreBudget: 3072, noteBudget: 200_000, indexBudget: 65536,
        entries: [{ kind: "note", content: text, concepts: ["phase", "lessons"] }] });
      return null;
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      tools.book(phase, "lessons", "memory_refused", `the memory door refused the lesson: ${why}`);
      return why;
    }
  }

  /** The owner's word on the lesson draft: yes applies it to memory (SMA m_apply), no declines it; a write that did not land is tried again on a later pass. */
  function settleLesson(phase: Phase, decision: "yes" | "no"): void {
    const draft = phase.record.lessons?.draft;
    if (!draft || draft.state !== "staged") throw new PhaseRefusal(`phase ${phase.id} has no lesson draft waiting`);
    const error = decision === "yes" ? writeLesson(phase, draft.text) : null;
    const next = decision === "no" ? { ...draft, state: "declined" as const, at: now() } : error ? { ...draft, error, at: now() } : { ...draft, state: "applied" as const, at: now(), error: undefined };
    if (!error) tools.book(phase, "lessons", decision === "yes" ? "lesson_applied" : "lesson_declined", decision === "yes" ? "the owner applied the lesson draft: it is in memory" : "the owner declined the lesson draft");
    savePhase(db, phase.id, { record: { ...phase.record, lessons: { ...phase.record.lessons!, draft: next } }, at: now() });
  }

  return { journalSteps, checkerRunBinding, reviewerRead, writeLesson, settleLesson };
}
