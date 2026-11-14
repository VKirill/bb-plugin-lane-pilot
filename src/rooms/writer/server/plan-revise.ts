/**
 * The planner's revision of a plan the plan critic returned (SMA n1269 «Up to three revision rounds», n1267 «Spawn the planner», n22 «Planner»,
 * n28 «while the planner can still rewrite»). On the direct dispatch path the critic's rework used to go to the PM, with no round limit; with
 * `plan_critique.revise_by = planner` the planner rewrites the plan in its own session (the same session on rounds 2 and 3), the critic judges
 * every revision in a fresh session and has the last word (n25), and only what the planner cannot fix goes to the PM, with the findings of every
 * round. The planner changes the plan text, read_first and the verification commands; objective, acceptance, owns_paths, never_touch,
 * expected_outputs and risk stay the PM's: a finding that needs them is answered `needs_pm`.
 *
 * One loop implementation: the `plan-revise` node of workflows/lp-task-pipeline.json (edges plan-critique -> plan-revise -> plan-critique),
 * the same shape as the `plan_critic -> plan` edge of workflows/lp.plan.json. lp.plan itself cannot run here as a sub-graph: its planner writes
 * a new set of task-v2 contracts from a goal and its critic is a generic agent node, while this loop revises one stored task in place and its
 * critic is the pipeline's own plan-critique stage (structural findings, stage receipts, owner words).
 */
import { ANSWER_FORM_LINE, extractModelJson, helperExit } from "@lane-pilot/workflow-engine";
import { sha256Hex, stringAt } from "@lane-pilot/kit";
import { bbServiceTier, findModelIn, listedServiceTier, resolveStageWriterSelection, writerExecutionSelection, writerServiceTier } from "@lane-pilot/models";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { contractEditions, getRun, saveTaskPlan, updateTaskContract, type LanePilotDatabase } from "../../storage";
import { PLANNER_METHOD, roleSelection, sdkCriticCatalog, taskBrief } from "../../critique";
import { ownerWordsOfRun } from "../../critique/server";
import { validateTaskV2 } from "../../tasks";
import { fullAccessSpawn, graphStepMetadata, zcodeBusyPeek } from "../../platform/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";

/** The reason of the contract edition a planner revision writes: `planner_revision:<n>/<max>`. */
export const plannerRevisionReason = (round: number, max: number): string => `planner_revision:${round}/${max}`;
export const PLANNER_REVISION_PREFIX = "planner_revision:";
/** The reason of the PM's contract edition that stopped a running planner loop: from then on the critic's returns go to the PM. */
export const PM_STOPPED_PLANNER_LOOP = "pm_update:planner_loop_stopped";

export type PlanReviseConfig = { by: "pm" | "planner"; maxRounds: number };

/**
 * `plan_critique.revise_by` (`pm`, the default: today's path, the PM fixes every return; `planner`: the planner revises first) and
 * `plan_critique.max_rounds` (how many times the planner may revise, 1 to 3, default 3).
 */
export function planReviseConfig(settings: Readonly<Record<string, unknown>>): PlanReviseConfig {
  const by = String(settings["plan_critique.revise_by"] ?? "pm").trim().toLowerCase() === "planner" ? "planner" : "pm";
  const raw = Number(settings["plan_critique.max_rounds"] ?? 3);
  const maxRounds = Number.isFinite(raw) ? Math.min(3, Math.max(1, Math.trunc(raw))) : 3;
  return { by, maxRounds };
}

export type PlanRevision = { editionRead: number | null; plan: string; readFirst?: string[]; verification?: TaskV2["verification"]; needsPm?: string; changes?: string };

/** The planner's answer: one JSON object with `plan` (the whole new plan text), optional `read_first` and `verification`, or `needs_pm`. */
export function parsePlanRevision(raw: string): PlanRevision {
  const value = extractModelJson(raw) as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("planner answer is not a JSON object");
  const editionRead = typeof value.edition_read === "number" ? value.edition_read : typeof value.edition_read === "string" && /^\d+$/.test(value.edition_read) ? Number(value.edition_read) : null;
  const needsPm = typeof value.needs_pm === "string" && value.needs_pm.trim() ? value.needs_pm.trim().slice(0, 2000) : undefined;
  const plan = typeof value.plan === "string" ? value.plan : "";
  if (!needsPm && !plan.trim()) throw new Error("planner answer has neither a plan nor needs_pm");
  const readFirst = Array.isArray(value.read_first) ? value.read_first.filter((item): item is string => typeof item === "string" && !!item.trim()) : undefined;
  const verification = Array.isArray(value.verification) ? value.verification as TaskV2["verification"] : undefined;
  const changes = typeof value.changes === "string" ? value.changes.slice(0, 2000) : undefined;
  return { editionRead, plan, ...(readFirst ? { readFirst } : {}), ...(verification ? { verification } : {}), ...(needsPm ? { needsPm } : {}), ...(changes ? { changes } : {}) };
}

/** The fingerprint of what the critic is shown: the plan text with the planner's own contract fields. The same fingerprint is never sent to the critic twice. */
export const planFingerprint = (plan: string, task: Pick<TaskV2, "read_first" | "verification">): string =>
  sha256Hex(JSON.stringify({ plan: plan.trim(), read_first: task.read_first, verification: task.verification }));

export type RoundFindings = { round: number; reason?: string; findings: unknown[] };

/** The form line of the hand-off standard (docs/guide/handoff.md): reasoning first, the object last, the honest exit offered before the form. */
const ANSWER = ANSWER_FORM_LINE + " {\"edition_read\": <the contract edition number you read>, \"plan\": \"<the whole revised plan text>\", \"read_first\": [optional, the whole list], \"verification\": [optional, the whole list of {\"command\", \"cwd\", \"timeout_sec\"}], \"changes\": \"<one line per finding: what you changed>\"}. When a finding can only be fixed by changing objective, acceptance, owns_paths, never_touch, expected_outputs, depends_on or risk, do not rewrite around it: answer {\"edition_read\": <n>, \"needs_pm\": \"<which finding, which field, what the PM should change>\"}. A finding of severity info is a note, not a defect: answer it with a line or a step in the plan, never with needs_pm.";

/** The planner's first brief: its method, the task as the PM wrote it, the plan the critic returned and the critic's findings. */
export function planRevisePrompt(input: { task: TaskV2; plan: string; edition: number; round: number; max: number; findings: readonly RoundFindings[]; ownerWords?: readonly string[] }): string {
  return [
    `You are the planner of one bounded software task. The independent plan critic returned its plan. Revise the plan so that it answers every finding; this is revision ${input.round} of at most ${input.max}, and a fresh critic judges your plan after you.`,
    "You are running in the project checkout. Read the files the plan names and grep for the names it relies on before you write; do not edit any file: your answer is the plan.",
    ...PLANNER_METHOD,
    "You may change only the plan text, read_first and the verification commands. objective, acceptance, owns_paths, never_touch, expected_outputs, depends_on and risk are the PM's: keep them exactly as they are.",
    ANSWER,
    `CONTRACT EDITION ${input.edition}:`, taskBrief(input.task, { fields: ["title", "objective", "risk", "acceptance", "invariants", "out_of_scope", "read_first", "expected_outputs", "owns_paths", "never_touch", "depends_on", "verification"] }),
    ...(input.ownerWords?.length ? ["OWNER'S WORDS (what the owner wrote before this task; the contract is the PM's reading of them, do not go beyond it):", input.ownerWords.map((text) => `> ${text.replace(/\n/g, "\n> ")}`).join("\n").slice(0, 3000)] : []),
    "THE CRITIC'S FINDINGS:", findingsText(input.findings),
    "THE PLAN THE CRITIC RETURNED:", input.plan,
  ].join("\n\n");
}

/** The next round in the same planner session: only what is new (the edition and the latest findings) and the answer form again. */
export function planReviseFollowUp(input: { edition: number; round: number; max: number; findings: readonly RoundFindings[] }): string {
  return [
    `Lane Pilot: a fresh critic returned your revised plan again. This is revision ${input.round} of at most ${input.max}; contract edition ${input.edition}. Answer these findings by revising the plan once more.`,
    findingsText(input.findings.slice(-1)),
    ANSWER,
  ].join("\n\n");
}

const findingsText = (rounds: readonly RoundFindings[]): string => rounds.map((row) =>
  `Round ${row.round}${row.reason ? ` (${row.reason})` : ""}:\n${JSON.stringify(row.findings).slice(0, 6000)}`).join("\n\n");

export type PlanReviseOutcome = { revised: boolean; reason?: string; edition?: number; plan?: string; task?: TaskV2; plannerThreadId?: string; fromSha: string; planSha?: string };

/** What the PM owns: a planner revision that changes any of these is refused. */
const PM_FIELDS = ["objective", "acceptance", "owns_paths", "never_touch", "expected_outputs", "depends_on", "risk"] as const;

/**
 * One planner round: spawn the planner (round 1) or go on in its session (later rounds), read its answer, and store a revision as a new
 * contract edition `planner_revision:<n>/<max>`. Nothing is written when the PM changed the task meanwhile, the step was canceled, the planner
 * needs the PM, or its plan is one the critic already saw.
 */
export async function runPlanRevise(input: {
  bb: BbPluginApi; db: LanePilotDatabase; projectId: string; runId: string; taskId: string; config: PrototypeConfig; task: TaskV2; plan: string;
  settings: Record<string, unknown>; round: number; max: number; findings: readonly RoundFindings[]; plannerThreadId: string | null; tried: ReadonlySet<string>;
  signal?: AbortSignal; workflow?: { runId: string; stepKey: string; nodeId: string };
}): Promise<PlanReviseOutcome> {
  const { bb, db } = input;
  const fromSha = planFingerprint(input.plan, input.task);
  const editionAtStart = contractEditions(db, input.taskId).at(-1)?.edition ?? 0;
  let threadId = input.plannerThreadId;
  const askedAt = Date.now();
  if (threadId) {
    await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: planReviseFollowUp({ edition: editionAtStart, round: input.round, max: input.max, findings: input.findings }) }] } as never);
  } else {
    const legacy = resolveStageWriterSelection({ settings: input.settings, config: input.config, stageProviderKey: "plan_revise.provider", stageModelKey: "plan_revise.model" });
    const selection = await roleSelection({ zcodeBusy: zcodeBusyPeek(bb), catalog: sdkCriticCatalog(bb, input.config.hostId), settings: input.settings, role: "planner", fallback: { providerId: legacy.providerId, model: legacy.model } });
    const [providers, catalog] = await Promise.all([bb.sdk.providers.list({ hostId: input.config.hostId }), bb.sdk.providers.models({ providerId: selection.providerId, hostId: input.config.hostId })]);
    const provider = providers.find((row) => row.id === selection.providerId && row.available);
    const model = findModelIn(catalog.models, selection.model);
    if (!provider || !model) return { revised: false, reason: "planner_unavailable: provider or model not offered", fromSha };
    const levels = new Set<string>(model.supportedReasoningEfforts.map((item) => item.reasoningEffort));
    const wanted = selection.effort ?? (typeof input.settings["writer.reasoning_effort"] === "string" ? input.settings["writer.reasoning_effort"] as string : "medium");
    const effort = levels.has(wanted) ? wanted : String(model.defaultReasoningEffort ?? [...levels][0] ?? "medium");
    const serviceTier = listedServiceTier(provider, bbServiceTier(writerServiceTier(input.settings)));
    const helperPolicy = requireHelperSpawn({ bb, db: db as never, projectId: input.projectId, runId: input.runId });
    const placement = await helperChildPlacement({ bb, db: db as never, projectId: input.projectId, runId: input.runId, role: "planner", taskTitle: input.task.title });
    const ownerWords = await ownerWordsOfRun({ bb, db, runId: input.runId, taskId: input.taskId }).catch(() => [] as string[]);
    const spawned = await fullAccessSpawn(bb, {
      ...placement,
      ...requiredPolicyField(bb, helperPolicy, selection.providerId, "planner"),
      ...writerExecutionSelection(selection.providerId, selection.model, effort, serviceTier),
      prompt: planRevisePrompt({ task: input.task, plan: input.plan, edition: editionAtStart, round: input.round, max: input.max, findings: input.findings, ownerWords }),
      environment: { type: "host", hostId: input.config.hostId, workspace: { type: "unmanaged", path: input.task.project_cwd } },
      pluginMetadata: { role: "planner", lanePilotRunId: input.runId, lanePilotTaskId: input.taskId, stageId: "plan-revise", parentPmThreadId: getRun(db as never, input.runId)?.pm_thread_id ?? null,
        helperMode: helperPolicy.mode, helperRequired: helperPolicy.policy?.required === true, ...graphStepMetadata(input.workflow) },
    } as never);
    threadId = stringAt(spawned, "id");
    if (!threadId) return { revised: false, reason: "planner_unavailable: no thread id", fromSha };
  }
  const stop = async () => { try { await bb.sdk.threads.stop({ threadId: threadId! }); } catch { /* the thread already ended */ } };
  try {
    await waitThreadIdle(bb, threadId, "planner_thread_timeout", undefined, input.plannerThreadId ? askedAt : undefined, () => (input.signal?.aborted ? "canceled" : null));
  } catch (cause) {
    if (input.signal?.aborted) { await stop(); return { revised: false, reason: "planner_loop_stopped: the step was canceled", plannerThreadId: threadId, fromSha }; }
    return { revised: false, reason: `planner_failed:${cause instanceof Error ? cause.message : String(cause)}`, plannerThreadId: threadId, fromSha };
  }
  const raw = (await bb.sdk.threads.output({ threadId })).output;
  // The honest exit of the standard: a planner that could not do the task at all (a named path missing, the checkout unreadable) hands it to the PM.
  const exit = helperExit(typeof raw === "string" ? raw : "");
  if (exit) return { revised: false, reason: `planner_${exit}`, plannerThreadId: threadId, fromSha };
  let revision: PlanRevision;
  try { revision = parsePlanRevision(typeof raw === "string" ? raw : ""); }
  catch (cause) { return { revised: false, reason: `planner_answer_unreadable:${cause instanceof Error ? cause.message : String(cause)}`, plannerThreadId: threadId, fromSha }; }
  if (revision.needsPm) return { revised: false, reason: `planner_needs_pm:${revision.needsPm}`, plannerThreadId: threadId, fromSha };
  const next = { ...input.task, ...(revision.readFirst ? { read_first: revision.readFirst } : {}), ...(revision.verification ? { verification: revision.verification } : {}) } as TaskV2;
  const valid = validateTaskV2(next);
  if (!valid.ok) return { revised: false, reason: `planner_contract_invalid:${valid.errors.slice(0, 3).join("; ")}`, plannerThreadId: threadId, fromSha };
  const changedPm = PM_FIELDS.filter((field) => JSON.stringify(valid.task[field]) !== JSON.stringify(input.task[field]));
  if (changedPm.length) return { revised: false, reason: `planner_needs_pm: the revision would change ${changedPm.join(", ")}`, plannerThreadId: threadId, fromSha };
  // Keep the placed fields as the task has them (project_cwd, repo_scope): the planner's contract is the stored one plus its three fields.
  const contract = { ...input.task, read_first: valid.task.read_first, verification: valid.task.verification } as TaskV2;
  const planSha = planFingerprint(revision.plan, contract);
  if (planSha === fromSha || input.tried.has(planSha)) return { revised: false, reason: "planner_unchanged: the planner returned a plan the critic already judged", plannerThreadId: threadId, fromSha, planSha };
  if (input.signal?.aborted) return { revised: false, reason: "planner_loop_stopped: the step was canceled", plannerThreadId: threadId, fromSha };
  // A PM update during the round wins: the edition the planner started from is no longer the latest, so nothing of the planner is stored.
  const reason = plannerRevisionReason(input.round, input.max);
  const stored = db.transaction(() => {
    if ((contractEditions(db, input.taskId).at(-1)?.edition ?? 0) !== editionAtStart) return null;
    saveTaskPlan(db, input.taskId, revision.plan);
    updateTaskContract(db, input.taskId, contract, reason);
    return contractEditions(db, input.taskId).at(-1)?.edition ?? null;
  })();
  if (stored === null) return { revised: false, reason: "planner_loop_stopped: the PM changed the task during the round", plannerThreadId: threadId, fromSha };
  return { revised: true, edition: stored, plan: revision.plan, task: contract, plannerThreadId: threadId, fromSha, planSha };
}
