import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import { getRun, getTask, getTaskPlan } from "../../storage";
import type { ServerCore, Services } from "../../core/server";
import { fullAccessSpawn, id, sendPmNotice, stageHelperSettings, stringAt } from "../../core/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { roleSelection, sdkCriticCatalog } from "../../critique/critic-pair";
import { taskMemoryContext } from "../../memory/server";
import { buildExecutionPacket, renderPacketExcerpts } from "../../tasks/execution-packet";
import { postOwnerItem } from "../../owner-waiting";
import { finishReturn, insertReturn, listReturns } from "../../stage-return";
import { NO_TOOLS_LINE, extractModelJson } from "@lane-pilot/workflow-engine";
import { writerExecutionSelection } from "@lane-pilot/models";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { isProductDecision, markAnsweredByDefault, SAFE_DEFAULT_ANSWER } from "./question-default";
import { resolve } from "node:path";

/**
 * The second pilot (W34, REL-03/REL-07): a writer's question to a human that nobody answered within `writer.question_wait_min` goes to a
 * read-only helper (the plan critic's role model) with the question, the contract, the plan, the read_first excerpts and the project's
 * memory. It decides one of three things, and the decision is a row of lane_pilot_stage_return (by `second-pilot`, to `writer`):
 *   answer — the contract, code or docs settle the question: the answer goes in through the PM's own door (answerWriter) and the same
 *            writer goes on in its thread, no attempt spent;
 *   narrow — a human is needed for part of the task, the rest is doable: a new task with the narrowed contract (the original named in
 *            its objective) is dispatched and the original attempt ends as superseded;
 *   owner  — only the owner can say: one compressed note to the PM chat while it is warm (sendPmNotice), else the owner's morning list.
 * At most one auto-return per task (a second question after it ends as today). Never returned here, because they never reach this sweep:
 * an exhausted attempt budget, task_wall_clock, verify_passes_exhausted, an owner's cancel, a phase stop, a critic's refusal — the PM sends
 * a new task itself. A question the heuristic reads as a product decision never gets an `answer` from the machine.
 */
export const SECOND_PILOT = "second-pilot";

export type PilotDecision =
  | { outcome:"answer"; answer:string; grounds:string }
  | { outcome:"narrow"; objective:string; acceptance:string[]; out_of_scope:string[]; owns_paths?:string[]; keep_checks?:number[]; grounds:string }
  | { outcome:"owner"; question:string; grounds:string };

export type PilotCase = { projectId:string; runId:string; taskId:string; attemptId:string; question:string; task:TaskV2; plan:string; excerpts:string; memory:string };
/** The model call: the case in, the decision out; null when no helper can be had (the heuristic then stands in). */
export type Consult = (input: PilotCase) => Promise<PilotDecision | null>;

/** Narrowing wording: the contract (paths, checks, tooling) is the problem, and the part inside it is still doable. */
const NARROW = /owns_paths|never_touch|expected_outputs|\bverification\b|\bcheck(?:s|ed)?\b|cannot run|can't run|cannot pass|cannot exit|не входят? в owns|расшир/i;
/** Report-shaped «questions»: nothing to decide, the writer reports and stops. */
const REPORT = /already green|nothing to fix|already gone|not needed because|уже зел[её]н|нечего чинить/i;

/**
 * The deterministic layer under the model: what the machine does when the helper cannot be spawned or its answer cannot be read, and the
 * classifier of the dry run over the hub's saved questions. A product decision goes to the owner; a report-shaped line is answered
 * (finish and report); a contract or sandbox complaint is narrowed; anything else is left to the owner.
 */
export function heuristicOutcome(question: string): PilotDecision["outcome"] {
  if (isProductDecision(question)) return "owner";
  if (REPORT.test(question)) return "answer";
  if (NARROW.test(question)) return "narrow";
  return "owner";
}

export function pilotPrompt(input: PilotCase): string {
  return [
    "You are the second pilot of a Lane Pilot task: a writer stopped with a question to a human and nobody answered it in time. Decide, from what is in this message only, what the machine does now. Answer with one JSON object and nothing else.",
    NO_TOOLS_LINE,
    "",
    `The writer asked:\n${input.question}`,
    "",
    `The task contract (TaskV2):\n${JSON.stringify(input.task, null, 1)}`,
    "",
    `The plan:\n${input.plan || "(none)"}`,
    input.excerpts ? `\nread_first excerpts:\n${input.excerpts}` : "",
    input.memory ? `\nProject memory:\n${input.memory}` : "",
    "",
    "Choose exactly one outcome:",
    "- \"answer\": the contract, the plan, the excerpts or the memory settle the question. Write the answer the writer needs to go on, concrete and short. You may not widen owns_paths, never_touch or the checks: an answer that needs a wider contract is not an answer.",
    "- \"narrow\": a human is needed for part of the task, but the rest is doable inside the contract as written. Give the narrowed objective, the acceptance items that remain, what moves to out_of_scope (the part that needs the human), optionally owns_paths to keep (a subset) and keep_checks (indexes into verification to keep; omit to keep all).",
    "- \"owner\": only the owner can say (what the product should do, wording, which behaviour is live, money, a contradiction in the ask). Give the question compressed to one or two sentences the owner can answer with one line.",
    "Always give grounds: one or two sentences naming what in the material decided it.",
    "",
    "Shape: {\"outcome\":\"answer\"|\"narrow\"|\"owner\",\"grounds\":\"…\",\"answer\":\"…\",\"objective\":\"…\",\"acceptance\":[\"…\"],\"out_of_scope\":[\"…\"],\"owns_paths\":[\"…\"],\"keep_checks\":[0],\"question\":\"…\"}",
  ].join("\n");
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];

/** The model's JSON read into a decision, or null when it has no usable shape (the heuristic then stands in). */
export function parsePilotDecision(raw: string): PilotDecision | null {
  let parsed: Record<string, unknown>;
  try { parsed = extractModelJson(raw) as Record<string, unknown>; } catch { return null; }
  const grounds = typeof parsed.grounds === "string" ? parsed.grounds.trim().slice(0, 600) : "";
  if (parsed.outcome === "answer" && typeof parsed.answer === "string" && parsed.answer.trim()) return { outcome:"answer", answer:parsed.answer.trim(), grounds };
  if (parsed.outcome === "narrow" && typeof parsed.objective === "string" && parsed.objective.trim() && strings(parsed.acceptance).length) {
    const keep = Array.isArray(parsed.keep_checks) ? parsed.keep_checks.filter((item): item is number => Number.isInteger(item) && (item as number) >= 0) : undefined;
    return { outcome:"narrow", objective:parsed.objective.trim(), acceptance:strings(parsed.acceptance), out_of_scope:strings(parsed.out_of_scope),
      ...(strings(parsed.owns_paths).length ? { owns_paths:strings(parsed.owns_paths) } : {}), ...(keep?.length ? { keep_checks:keep } : {}), grounds };
  }
  if (parsed.outcome === "owner") return { outcome:"owner", question:(typeof parsed.question === "string" && parsed.question.trim()) || "", grounds };
  return null;
}

/**
 * The narrowed contract: the original's fields, the objective and acceptance the pilot gave, the human's part in out_of_scope, owns_paths
 * never wider than the original (a path the pilot names outside it is dropped; none left keeps the original), checks kept by index.
 */
export function narrowedTask(original: TaskV2, decision: Extract<PilotDecision, { outcome:"narrow" }>, question: string): TaskV2 {
  const owns = decision.owns_paths?.filter((path) => original.owns_paths.includes(path)) ?? [];
  const verification = decision.keep_checks ? decision.keep_checks.map((index) => original.verification[index]).filter((check): check is TaskV2["verification"][number] => Boolean(check)) : original.verification;
  return {
    ...original,
    id:`${original.id}.n`,
    title:`${original.title} (narrowed)`,
    objective:`${decision.objective}\n\nNarrowed from ${original.id} by the second pilot: its writer asked «${question.slice(0, 300)}» and nobody answered. Do not widen owns_paths or the checks; what needs a human is out of scope.`,
    acceptance:decision.acceptance,
    out_of_scope:[...original.out_of_scope, ...decision.out_of_scope],
    owns_paths:owns.length ? owns : original.owns_paths,
    expected_outputs:owns.length ? original.expected_outputs.filter((path) => owns.some((pattern) => path === pattern || path.startsWith(pattern.replace(/\*\*$|\*$/, "")))) : original.expected_outputs,
    verification:verification.length ? verification : original.verification,
  };
}

/** The real consult: the plan critic's role model, one shot, no tools; null when no helper can be spawned here. */
export function modelConsult(ctx: ServerCore): Consult {
  const { bb, db } = ctx;
  return async (input) => {
    const run = getRun(db, input.runId);
    const config = run ? await ctx.configForRun(input.projectId, run) : null;
    if (!run || !config) return null;
    const settings = await stageHelperSettings(bb, db, input.projectId, input.runId);
    const selection = await roleSelection({ catalog:sdkCriticCatalog(bb, config.hostId), settings, role:"plan-critic", fallback:{ providerId:config.pmProviderId, model:config.pmModel } });
    const effort = selection.effort ?? (typeof settings["plan_critique.reasoning_effort"] === "string" ? settings["plan_critique.reasoning_effort"] as string : "medium");
    const policy = requireHelperSpawn({ bb, db, projectId:input.projectId, runId:input.runId });
    const placement = await helperChildPlacement({ bb, db, projectId:input.projectId, runId:input.runId, role:"plan-critic", taskTitle:input.task.title });
    const spawned = await fullAccessSpawn(bb, {
      ...placement, ...requiredPolicyField(bb, policy, selection.providerId, "plan-critic"), ...writerExecutionSelection(selection.providerId, selection.model, effort, null),
      prompt:pilotPrompt(input),
      environment:{ type:"host", hostId:config.hostId, workspace:{ type:"unmanaged", path:input.task.project_cwd } },
      pluginMetadata:{ role:"plan-critic", lanePilotRunId:input.runId, lanePilotTaskId:input.taskId, stageId:SECOND_PILOT, parentPmThreadId:run.pm_thread_id ?? null, helperMode:policy.mode, helperRequired:policy.policy?.required === true },
    });
    const threadId = stringAt(spawned, "id");
    if (!threadId) return null;
    await waitThreadIdle(bb, threadId, "second_pilot_thread_timeout", 15 * 60_000);
    const raw = (await bb.sdk.threads.output({ threadId })).output;
    return typeof raw === "string" ? parsePilotDecision(raw) : null;
  };
}

export type PilotResult = { outcome:PilotDecision["outcome"]; returnId:string; newTaskId?:string; ok:boolean };

/**
 * One auto-return of a blocked question. `answerWriter` and `end` are the sweep's own doors (question-timeout.ts), so the pilot adds no
 * second way from «blocked» to «running». Returns null when this task already had its auto-return.
 */
export function createSecondPilot(ctx: ServerCore, services: Services, consult: Consult = modelConsult(ctx)) {
  const { bb, db } = ctx;

  async function excerptsFor(task: TaskV2, projectId: string, runId: string): Promise<string> {
    const run = getRun(db, runId);
    const config = run ? await ctx.configForRun(projectId, run).catch(() => null) : null;
    if (!config || !task.read_first.length) return "";
    try {
      const packet = await buildExecutionPacket(task.read_first, async (path) => {
        const file = await bb.sdk.files.read({ hostId:config.hostId, rootPath:task.project_cwd, path:resolve(task.project_cwd, path) });
        return typeof file.content === "string" ? { content:file.content, contentEncoding:file.contentEncoding, sha256:file.sha256, sizeBytes:file.sizeBytes } : null;
      });
      return renderPacketExcerpts(packet);
    } catch { return ""; }
  }

  async function run(row: { id:string; run_id:string; task_id:string; project_id:string; thread_id:string|null }, question: string, now: number,
    doors: { answerWriter:(answer:string) => Promise<boolean>; end:(why:string) => Promise<void> }): Promise<PilotResult | null> {
    if (listReturns(db, row.run_id, row.task_id).some((record) => record.by === SECOND_PILOT)) return null;
    const stored = getTask(db, row.task_id);
    const parsed = stored ? taskV2Schema.safeParse(stored.contract) : null;
    const runRow = getRun(db, row.run_id);
    if (!parsed?.success || !runRow) return null;
    const task = parsed.data;
    const returnId = id("lpret");
    insertReturn(db, { id:returnId, at:now, projectId:row.project_id, runId:row.run_id, taskId:row.task_id, attemptId:row.id, to:"writer", from:"writer", by:SECOND_PILOT,
      note:`question unanswered for the wait: ${question.slice(0, 400)}`, reused:[], stale:[] });
    const done = (outcome: PilotDecision["outcome"], ok: boolean, detail: string, newTaskId?: string): PilotResult => {
      finishReturn(db, returnId, { state:ok ? (outcome === "owner" ? "handed_to_pm" : "restarted") : "failed", detail:`${outcome}: ${detail}`.slice(0, 1000) });
      ctx.log(`second pilot ${row.task_id}: ${outcome}${ok ? "" : " (failed)"}: ${detail.slice(0, 200)}`);
      return { outcome, returnId, ok, ...(newTaskId ? { newTaskId } : {}) };
    };
    const pilotCase: PilotCase = { projectId:row.project_id, runId:row.run_id, taskId:row.task_id, attemptId:row.id, question, task, plan:getTaskPlan(db, row.task_id) ?? "",
      excerpts:await excerptsFor(task, row.project_id, row.run_id), memory:taskMemoryContext(db, row.project_id, row.run_id, `${task.title}\n${question}`) };
    let decision: PilotDecision | null = null;
    try { decision = await consult(pilotCase); } catch (cause) { ctx.log(`second pilot ${row.task_id}: the helper failed, the heuristic stands in: ${cause instanceof Error ? cause.message : String(cause)}`); }
    // The machine never decides the product: a product decision the model «answered» goes to the owner with the model's grounds.
    if (decision?.outcome === "answer" && isProductDecision(question)) decision = { outcome:"owner", question:"", grounds:`a product decision; the helper said: ${decision.grounds}` };
    if (!decision) {
      const fallback = heuristicOutcome(question);
      decision = fallback === "answer" ? { outcome:"answer", answer:SAFE_DEFAULT_ANSWER, grounds:"no helper could be read; the safe default answers a report-shaped question" }
        : { outcome:"owner", question:"", grounds:`no helper could be read; the heuristic says ${fallback}, which needs a person` };
    }
    const grounds = decision.grounds || "no grounds given";
    if (decision.outcome === "answer") {
      // finish.ts ends a second question after this one the way it ends one after the safe default.
      await markAnsweredByDefault(bb.storage.kv as never, row.run_id, row.task_id, now);
      const answered = await doors.answerWriter(`The second pilot answers in the PM's place (nobody answered in time; grounds: ${grounds}).\n\n${decision.answer}\n\nThe contract stays as written: do not widen owns_paths or the checks. This is an answer, not a new question: do not start your report with NEEDS_HUMAN.`);
      if (answered) return done("answer", true, grounds);
      await doors.end("the second pilot answered but the writer's thread cannot take it");
      return done("answer", false, "the writer's thread cannot take the answer");
    }
    if (decision.outcome === "narrow") {
      if (!runRow.pm_thread_id) { await doors.end("the second pilot narrowed the task but the run has no PM thread to dispatch it"); return done("narrow", false, "no PM thread"); }
      const narrowed = narrowedTask(task, decision, question);
      // The original attempt ends first: a live member of the family would make the new task a duplicate (dispatch.ts runningFamilyMember).
      await doors.end(`superseded by ${narrowed.id}: the second pilot narrowed the task (${grounds.slice(0, 200)})`);
      try {
        const dispatched = await services.dispatchWriter({ threadId:runRow.pm_thread_id, projectId:row.project_id, task:narrowed, plan:`${pilotCase.plan || narrowed.objective}\n\n${narrowed.objective}`, birth:"redo" });
        const newTaskId = stringAt(dispatched, "taskId");
        const rejected = dispatched.ok === false || dispatched.state === "rejected" || !newTaskId;
        if (!rejected) return done("narrow", true, `${newTaskId}: ${grounds}`, newTaskId);
        await leaveToOwner(row, runRow.pm_thread_id, question, `the narrowed task was not accepted (${stringAt(dispatched, "reason") ?? stringAt(dispatched, "hint") ?? "rejected"})`, now);
        return done("narrow", false, `dispatch rejected: ${stringAt(dispatched, "reason") ?? stringAt(dispatched, "hint") ?? "rejected"}`);
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        await leaveToOwner(row, runRow.pm_thread_id, question, `the narrowed task could not be dispatched (${why})`, now);
        return done("narrow", false, `dispatch failed: ${why}`);
      }
    }
    const asked = decision.question || question.slice(0, 400);
    await doors.end(`left to the owner by the second pilot (${grounds.slice(0, 200)})`);
    await leaveToOwner(row, runRow.pm_thread_id, asked, grounds, now);
    return done("owner", true, grounds);
  }

  /** One PM note while the chat is warm, else one line in the owner's morning list; never both. */
  async function leaveToOwner(row: { run_id:string; task_id:string; project_id:string; id:string }, pmThreadId: string | null, question: string, grounds: string, now: number): Promise<void> {
    const text = `Lane Pilot: ${row.task_id} waits on the owner. Its writer asked: ${question.slice(0, 400)}\nThe second pilot could not settle it (${grounds.slice(0, 300)}). Answer it in the task's objective and send the task again (the attempt ended uncharged).`;
    if (pmThreadId && await sendPmNotice(bb, pmThreadId, text, now)) return;
    postOwnerItem(db as never, { key:`writer-question:${row.run_id}:${row.task_id}`, source:"writer", kind:"product_decision", projectId:row.project_id, wake:false,
      what:`${row.task_id}: ${question.slice(0, 400)}`, why:`The writer asked and nobody answered; the second pilot could not settle it (${grounds.slice(0, 300)}). Answer it in the task's objective and send the task again.`,
      evidence:[{ kind:"attempt", ref:row.id }, { kind:"task", ref:row.task_id }] });
  }

  return { run };
}
