import type { TaskV2 } from "../../contracts";
import { noteEngineWrite, gateRunVerdict } from "../../verification/server";
import { parseIntegrationGateSettings, type VerificationGatePort } from "../../contracts/integration-gate";
import type { IsTaskSatisfied } from "../../contracts";
import { getAttempt, getRun, getRunWriterHost, getRunSettingsScopes, getTaskPlan, latestGateRun, listAttemptsForTask, listOpenAttempts, listOpenWorktrees, listTaskIdsForRun, loadProjectSettings, fullGateVerdict, saveProjectSetting, planningHomeInputs } from "../../storage";
import { isPlanningPath, resolvePlanningHome } from "../../contracts";
import { getPhase, listPhases } from "../../phase";
import { PROFILE_KEYS, profilePairProblem, unsafeReason } from "../../anamnesis";
import { bestEffort, isNotFound, orMiss, redactKnown, sha256Hex, stringAt } from "@lane-pilot/kit";
import { validateTaskV2 } from "../../tasks/task-v2";
import { agentPrompt, outputContract, outputFields, parseAgentOutput, resolveTaskQualityMode } from "@lane-pilot/workflow-engine";
import type { NodeExecutor, PollResult, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { RunRow } from "../../storage";
import { getJudgment, jev } from "@lane-pilot/jev";
import { citationCheckJudgment } from "@lane-pilot/jev/judgments/citation-check";
import { postOwnerItem } from "../../owner-waiting";
import { BUILTIN_PRESETS, switchOn } from "@lane-pilot/models";
import type { Field, GraphNode } from "@lane-pilot/workflow-engine";
import { createTaskLinter } from "../../tasks/server";
import { agentRequest, createWorkflowAgents, stepPacket, withResolvedModel } from "./workflow-agent";
import type { WorkflowAgents } from "./workflow-agent";
import { registerRouterExecutor } from "./workflow-router-model";
import type { Judgment } from "@lane-pilot/jev";
import { registerQualityLoopClassifyExecutor } from "./workflow-classify";
import type { TaskUsage } from "../../platform/server";

import { keyedSpawnSupported, pickSkillTree, projectFolder, readSkillTreeText, skillTreeCached } from "../../platform/server";
import { startedBySchedule } from "./workflow-runtime";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";

import { ownerLocale, workflowHumanDetail } from "../../relay/server";
import { runOnHost } from "@lane-pilot/host-calls";
import { hostContract } from "../../contracts";
import { oneLine, ownsPathProblems, parkRoadmapRow, quickRow } from "../../phase";
import { instructionForms } from "../../project-life";
import { pageReviewByAgent } from "../../critique/server";

import type { DispatchWriter } from "../../platform/server";

import type { StabilityPort } from "../../contracts";
import type { WorkflowEngineApi } from "../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  dispatchWriter: DispatchWriter;
  isTaskSatisfied: IsTaskSatisfied;
  taskUsage: TaskUsage;
  stability: StabilityPort;
  resolveIntegrationGate: VerificationGatePort;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

type LpTaskRuntime = { attemptId: string };

/** The dispatch pipeline's `lp-task` executor: the writer room provides it from the composition root, per engine; the merged
 * executor reads it at run time, never at mount. */
const lpTaskPipelines = new WeakMap<WorkflowEngine, NodeExecutor<LpTaskRuntime>>();
export function provideLpTaskPipeline(engine: WorkflowEngine, executor: NodeExecutor<LpTaskRuntime>): void { lpTaskPipelines.set(engine, executor); }

/**
 * The executors that run a chain on the host: the generic agent step, the owner's question, the code task of a chain, the actions
 * that read the plugin's own state or the PM's checkout, and the actions that go through a helper thread (a skill, an MCP tool, the
 * owner's accounts) the way errands do. The pure ones (dedupe, the verdict thresholds, the citation check) are in workflow/actions.ts.
 */
type Row = Record<string, unknown>;
const rec = (value: unknown): Row => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The line of the owner's list a question of a run with no PM chat is (answered with `workflow_answer`, which closes it). */
export const workflowQuestionKey = (runId: string, stepKey: string) => `workflow-question:${runId}:${stepKey}`;

/** The runtime of a chain run rebuilt from its row after a reload; undefined for the per-task pipeline, which needs its own in-memory runtime. */
export function chainRuntimeFor(ctx: ServerCore, services: Services) {
  return (run: RunRow): ChainRuntime | undefined => {
    if (run.workflow_id === "lp-task-pipeline" || run.idem_key?.startsWith("lp-task:")) return undefined;
    if (!run.project_id) return undefined;
    // A run started in a project without a PM chat has no link: it works on its own.
    if (!run.link_run_id) return { ctx, services, pmThreadId: null, projectId: run.project_id, runId: null, ...(startedBySchedule(ctx.db, run) ? { origin: "schedule" as const } : {}) };
    const linked = getRun(ctx.db, run.link_run_id);
    if (!linked?.pm_thread_id) return undefined;
    return { ctx, services, pmThreadId: linked.pm_thread_id, projectId: run.project_id, runId: run.link_run_id, ...(startedBySchedule(ctx.db, run) ? { origin: "schedule" as const } : {}) };
  };
}

const need = (c: StepContext<ChainRuntime>): ChainRuntime => {
  if (!c.runtime) throw new Error("this workflow run has no PM chat to work in (its run was closed or the plugin lost it); start it again");
  return c.runtime;
};

/** The steps that build code or read the Lane Pilot run need a PM chat and its run; a run of a project without Lane Pilot stops there with the way out. */
type WithPm = ChainRuntime & { pmThreadId: string; runId: string };
const needLanePilot = (rt: ChainRuntime, what: string): WithPm => {
  if (!rt.pmThreadId || !rt.runId) throw new Error(`needs_lane_pilot: ${what} needs Lane Pilot in the project (an open PM chat) and this run has none; enable Lane Pilot in a chat of the project`);
  return rt as WithPm;
};

/** The PM's checkout: where a chain writes its reports and reads its diffs. Without a PM chat it is the project's own first folder. */
async function pmCheckout(rt: ChainRuntime): Promise<{ hostId: string; path: string }> {
  const { bb } = rt.ctx;
  if (!rt.pmThreadId) {
    const folder = await projectFolder(bb, rt.projectId);
    if (!folder) throw new Error("the project has no folder on a machine to work in");
    return folder;
  }
  const pm = await bb.sdk.threads.get({ threadId: rt.pmThreadId });
  const environmentId = stringAt(pm, "environmentId");
  const env = environmentId ? await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound) : null;
  const path = stringAt(env, "path"), hostId = stringAt(env, "hostId");
  if (!path || !hostId) throw new Error("the PM chat has no checkout to work in");
  return { hostId, path };
}

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
const PRUNE = /(^|\/)(node_modules|vendor|dist|build)\/|\.lock$|\.min\.[a-z]+$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

// ---------------------------------------------------------------- the owner's question

/** The enum values that carry words, not a decision: a free answer may stand for one of them, never for approve/deploy/send/proceed. */
const TEXT_KINDS = ["text", "answered", "provide", "given", "reason", "chosen", "resolved"];

/** What the form offers: the values of the node's `answer_kind` that a person can pick (not the clock's `timeout`, not the skip markers). */
export function humanOptions(node: Extract<GraphNode, { type: "human" }>): string[] {
  const kind = node.out.find((field) => field.name === "answer_kind");
  return (kind?.values ?? node.options).filter((value) => !["timeout", "none", "given"].includes(value));
}

const normalizeChoice = (text: string) => text.toLowerCase().replace(/[_\-\s]+/g, " ").replace(/^[\s.,;:!?'"«»()]+|[\s.,;:!?'"«»()]+$/g, "");

/** The 1-based option a typed answer names outright (the option's own words, or its number); never a guess from the wording around it. */
function namedOption(options: string[], text: string): number | null {
  const said = normalizeChoice(text);
  if (!said) return null;
  const byName = options.findIndex((value) => normalizeChoice(value) === said);
  if (byName >= 0) return byName + 1;
  const byNumber = /^(?:option|choice|вариант|№|#)?\s*(\d{1,2})$/.exec(said);
  const number = byNumber ? Number(byNumber[1]) : 0;
  return number >= 1 && number <= options.length ? number : null;
}

/** The node's output with `answer_kind` set to `kind` and the words as `answer`; the other fields empty. */
export function humanFields(node: Extract<GraphNode, { type: "human" }>, kind: string | undefined, text: string): Row {
  const out: Row = {};
  for (const field of node.out) {
    if (field.name === "answer_kind") { if (kind !== undefined) out.answer_kind = kind; continue; }
    if (field.name === "answer") { out.answer = text; continue; }
    out[field.name] = field.type === "array" ? (text && node.out.filter((other) => other.type === "array").length === 1 ? [{ answer: text }] : []) : field.type === "number" ? 0 : field.type === "boolean" ? false : field.type === "object" ? {} : field.type === "enum" ? field.values![0] : "";
  }
  return out;
}

/**
 * The node's output from the owner's answer: the chosen value as `answer_kind`, the words as `answer`, the other fields empty.
 * Words alone make a choice only when they name an option; otherwise they are a text answer if the node has a text kind.
 * Null when the answer decides nothing (an approval answered with a remark): the step keeps waiting and the owner is asked again.
 */
export function humanOutput(node: Extract<GraphNode, { type: "human" }>, answer: { choiceIndex: number | null; text: string }): Row | null {
  const options = humanOptions(node);
  const values = node.out.find((field) => field.name === "answer_kind")?.values ?? [];
  const index = answer.choiceIndex ?? (answer.text ? namedOption(options, answer.text) : null);
  // «Decide yourself» hands the choice back: the step's default option is the machine's answer.
  const delegated = index === null && node.defaultOption && DELEGATE.test(answer.text.trim()) ? options.indexOf(node.defaultOption) + 1 || null : null;
  const chosen = (index ?? delegated) !== null ? options[(index ?? delegated)! - 1] : undefined;
  if (chosen !== undefined) return humanFields(node, chosen, answer.text);
  if (!answer.text) return options.length ? null : humanFields(node, undefined, "");
  const kind = TEXT_KINDS.find((value) => values.includes(value));
  return kind !== undefined || !values.length ? humanFields(node, kind, answer.text) : null;
}

/** Words that hand the decision back to the machine. */
const DELEGATE = /^(сам[аи]? реша[йи]|реша[йи] сам[аи]?|на (тво[её]|ваше) усмотрение|как (считаешь|хочешь|лучше)|выбери сам|decide (yourself|for me)|your call|up to you|whatever you think)[.!]?$/iu;

/** The longest a human step of a machine-started run waits for the owner's answer. */
export const MACHINE_HUMAN_WAIT_SEC = 15 * 60;
/** Whether the machine started the run (or the run it is a subworkflow of): keys `intake:` and `phase:`. */
function machineStarted(engine: WorkflowEngine, runId: string): boolean {
  let row = engine.journal.getRun(runId);
  for (let hop = 0; row && hop < 8; hop += 1) {
    if (row.idem_key?.startsWith("intake:") || row.idem_key?.startsWith("phase:")) return true;
    row = row.parent_run_id ? engine.journal.getRun(row.parent_run_id) : undefined;
  }
  return false;
}

/** Whether the run (or the run it is a subworkflow of) is work the lead handed over: intake key `intake:<pm thread>:lead:<road>`. */
function leadHanded(engine: WorkflowEngine, runId: string): boolean {
  let row = engine.journal.getRun(runId);
  for (let hop = 0; row && hop < 8; hop += 1) {
    if (/^intake:[^:]+:lead:/.test(row.idem_key ?? "")) return true;
    row = row.parent_run_id ? engine.journal.getRun(row.parent_run_id) : undefined;
  }
  return false;
}

// ---------------------------------------------------------------- code tasks of a chain

const TERMINAL_ATTEMPT = ["accepted", "blocked", "canceled"];
const safeId = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

/** The task standard (the Tasks board): a workflow's own task fills what its contract leaves out, so the contract lint never refuses it. */
/** The short path's code critic: only the medium writer of issue-quick. quick stays off; a full contract still conflicts with fixed quick. */
export function shortPathCriticDefault(workflowId: string, mode: string): "medium" | undefined {
  return workflowId === "issue-quick" && mode === "standard" ? "medium" : undefined;
}

const withTaskStandard = (contract: Row, key: string): Row => ({ ...withContractDefaults(contract),
  display_title: str(contract.display_title).trim() || str(contract.title).slice(0, 60), kind: str(contract.kind) || "feature", area: str(contract.area).trim() || `workflow:${safeId(key)}` });

const RISKS = ["low", "medium", "high", "critical"];
const VERIFY = ["none", "smoke", "tests"];
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]);
/**
 * The structural fields of task-v2 a planner agent leaves out, filled the same way every time: a planner that wrote the work right but
 * not the envelope (schema_version, lane, risk, the empty lists, checks as plain command strings) was refused three times by the lint
 * and the small-task graph stopped for the owner (live issue-quick wfrun_8adbad9a…, 2026-10-25). What the planner did write wins.
 */
/**
 * The command of a check a planner wrote as prose: «`npm test` prints `0`» is the first code span, not the sentence — the shell ran the
 * backticks as command substitution and the check failed with exit 127 (live issue-quick, 2026-10-25). A plain string is the command.
 */
export function commandOf(check: string): string {
  const span = /`([^`]+)`/.exec(check);
  return (span ? span[1]! : check).trim();
}

/** The verification budget a planner's check gets when it names none: the PM's normal tasks run checks for 40 minutes. */
export const PLAN_CHECK_TIMEOUT_SEC = 2400;

export function withContractDefaults(input: Row): Row {
  // `covers` (the requirement and decision ids a phase's piece carries out) belongs to the plan's piece, not to the strict task-v2.
  const { covers: _covers, ...contract } = input;
  const files = asList(contract.files).map((file) => (file && typeof file === "object" ? str((file as Row).path) : "")).filter(Boolean);
  const owns = asList(contract.owns_paths).map(String);
  const outputs = asList(contract.expected_outputs).map(String);
  return {
    ...contract,
    schema_version: 2,
    risk: RISKS.includes(str(contract.risk)) ? str(contract.risk) : "medium",
    lane: str(contract.lane).trim() || "default",
    read_first: asList(contract.read_first).map(String),
    interfaces: asList(contract.interfaces).map(String),
    invariants: asList(contract.invariants).map(String),
    out_of_scope: asList(contract.out_of_scope).map(String),
    never_touch: asList(contract.never_touch).map(String),
    depends_on: asList(contract.depends_on).map(String),
    owns_paths: owns.length ? owns : files,
    expected_outputs: outputs.length ? outputs : files.length ? files : owns.filter((path) => !/[*?]/.test(path)),
    acceptance: asList(contract.acceptance).map((item) => (typeof item === "string" ? item : JSON.stringify(item))),
    verify: VERIFY.includes(str(contract.verify)) ? str(contract.verify) : "tests",
    verification: asList(contract.verification).map((check) => {
      const row = (typeof check === "string" ? { command: commandOf(check), cwd: "." } : check) as Row;
      // A planner never writes timeout_sec, and without one the sandbox kills the check at 120 s — under a full suite the task
      // cannot ever go green (live issue-quick, 2026-11-02). The project's normal verification budget is 40 minutes.
      return row.timeout_sec === undefined || row.timeout_sec === null ? { ...row, timeout_sec: PLAN_CHECK_TIMEOUT_SEC } : row;
    }),
    objective: str(contract.objective).trim() || str(contract.title).trim(),
    // The criteria are strings; a planner that wrote them like its checks ({command}) meant the command.
    ...(contract.convergence && typeof contract.convergence === "object" ? { convergence: { ...(contract.convergence as Row),
      criteria: asList((contract.convergence as Row).criteria).map((item) => (item && typeof item === "object" ? str((item as Row).command) || JSON.stringify(item) : String(item))) } } : {}),
  };
}

type HelperUsage = { tokens: number; costUsd: number; unknown?: true };
type LpTaskNode = Extract<GraphNode, { type: "lp-task" }>;

export { secretKeyName } from "../../anamnesis";

const QUICK_STATE_PATH = ".agents/planning/STATE.md";

/** The STATE.md write of a finished quick task: null when the project has no STATE.md (exit code of the read), else the new text and the hash it replaces. */
export function quickStateEdit(read: { exitCode: number; stdout: string }, row: { date: string; task: string; commit: string }): { content: string; expectedSha256: string } | null {
  const content = read.exitCode === 0 ? quickRow(read.stdout, row) : null;
  return content === null ? null : { content, expectedSha256: sha256Hex(read.stdout) };
}

/** The file name of a debug session: letters, digits, dot, dash and underscore only, so it can never leave .agents/planning/debug/ ("" when nothing is left). */
export function debugSessionSlug(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "").slice(0, 60);
}

/** A new session file: the symptom (a list from the phase is one gap per line) and the empty sections. */
export function debugSessionDoc(slug: string, symptom: unknown): string {
  const text = (Array.isArray(symptom) ? symptom.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n") : str(symptom)).slice(0, 2000);
  return `# Debug session — ${slug}\n\nStatus: open\n\n## Symptom\n\n${text || "—"}\n\n## Hypotheses\n\n## Evidence\n\n## Root cause\n\n## Fix directions\n`;
}

export function registerChainExecutors(engine: WorkflowEngine, ctx: ServerCore, services: Services, agents: WorkflowAgents = createWorkflowAgents()): void {
  const { bb, db, host } = ctx;
  /** The planning home of a project on the checkout's host (SMA d_project_planning), checked on that host; null: planning lives in the checkout. */
  const planHome = (projectId: string, checkout: { hostId: string; path: string }): Promise<string | null> =>
    resolvePlanningHome({ host: ctx.host, hostId: checkout.hostId, cwd: checkout.path, inputs: planningHomeInputs(db, projectId), log: bb.log });
  const lintTask = createTaskLinter(ctx, services);
  const rebuild = chainRuntimeFor(ctx, services);
  const runtimeOf = (c: { runtime: unknown }, runId?: string): ChainRuntime | undefined => {
    if (c.runtime) return c.runtime as ChainRuntime;
    const row = runId ? engine.journal.getRun(runId) : undefined;
    return row ? rebuild(row) : undefined;
  };

  // The model step of the router's graph `lp.route`.
  registerRouterExecutor(engine, agents);

  // The native System One node (`type:"jev"`): a registered judgment answers the node's `state` whitelist in one cheap
  // call — no helper thread. An unsure verdict comes back `escalated`; the graph routes it to a model step with a `when`
  // edge (`out.escalated == true`). Jev off or unavailable escalates to `model` so the graph's model edge takes it.
  engine.register<ChainRuntime>("builtin:jev", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<GraphNode, { type: "jev" }>;
      const judgment = getJudgment(node.judgment) as Judgment<Record<string, unknown>, unknown> | undefined;
      if (!judgment) throw new Error(`builtin:jev: unknown judgment "${node.judgment}" (the id is registered in the Jev layer, e.g. route.workflow)`);
      const rt = c.runtime;
      const settings = rt ? (((await bestEffort(rt.ctx.log, "workflow jev settings", rt.ctx.effectiveProjectSettings(rt.projectId), null))?.values) ?? {}) : {};
      // The whitelist, field by field; a long text is clipped with a marker (no spread of run data into the state).
      // `"$task.<path>"` reads the dispatch task's own fields (title, contract) — the spec stays the whitelist.
      const state: Record<string, unknown> = {};
      const task = (rt as { task?: Record<string, unknown> } | undefined)?.task;
      for (const [name, spec] of Object.entries(node.state)) {
        let value: unknown;
        if (typeof spec === "string" && spec.startsWith("$task.")) {
          let at: unknown = task;
          for (const part of spec.slice(6).split(".")) at = (at as Record<string, unknown> | null)?.[part];
          value = at === undefined || at === null ? "" : typeof at === "object" ? JSON.stringify(at) : at;
        } else value = c.template(spec);
        state[name] = typeof value === "string" && value.length > 4_000 ? `${value.slice(0, 3_999)}…` : value;
      }
      const instance = jev();
      // `value` is always the judgment's fallback when Jev did not answer, so a graph reading `value.*` never fails closed.
      if (!instance || !instance.enabled(settings)) { const fb = judgment.fallback(state); return { output: { decision: "jev_unavailable", value: fb, ...(fb && typeof fb === "object" ? fb as Record<string, unknown> : {}), escalated: true, to: "model" } }; }
      // The decision's own fields also sit at the top level of the output, so an artifact consumer or a `when` edge can
      // read them directly (goal-screen.goals) while `value` keeps the whole object for a nested read.
      const flat = (decision: unknown) => (decision && typeof decision === "object" && !Array.isArray(decision) ? decision as Record<string, unknown> : {});
      // In a task's own pipeline the receipt names the task: the nightly labels find a task's fate by run and subject.
      const verdict = await instance.judge(judgment, state, { projectId: rt?.projectId ?? null, runId: rt?.runId ?? null, subject: typeof task?.["id"] === "string" && task["id"] ? task["id"] : node.id, settings });
      const handoff = (decision: unknown) => (decision && typeof decision === "object" ? judgment.describe(decision) : "escalated");
      // `receiptId` and `would` let a later step label the receipt with what really happened (`jev().outcome`): `would` is the
      // decision Jev gave or, in shadow, would have given — the fallback that actually applied is in `decision`. A graph that
      // does not declare them in the node's output does not see them.
      const receipt = verdict.receiptId === null ? {} : { receiptId: verdict.receiptId };
      if (verdict.by === "jev") return { output: { decision: judgment.describe(verdict.decision), handoff: handoff(verdict.decision), value: verdict.decision, ...flat(verdict.decision), escalated: false, ...receipt, would: judgment.describe(verdict.decision) } };
      if (verdict.by === "escalate") return { output: { decision: `escalate:${verdict.to}`, handoff: `escalated to ${verdict.to}`, escalated: true, to: verdict.to, ...receipt } };
      const would = verdict.shadow?.decision ?? verdict.decision;
      return { output: { decision: judgment.describe(verdict.decision), handoff: handoff(verdict.decision), value: verdict.decision, ...flat(verdict.decision), escalated: false, fallback: true, status: verdict.status, ...receipt, would: judgment.describe(would) } };
    },
  } as NodeExecutor<ChainRuntime>);
  // `citations.jev`: for each {claim, source, excerpt} triple Jev decides whether the source supports the claim
  // (research.citation, shadow by default — verdicts go to receipts and to `citation_check` in the output).
  engine.register<ChainRuntime>("citations.jev", { reentrant: true, run: async (c) => {
    const params = rec(rec(c.node).params);
    const items = list((c.input.with as Row | undefined)?.[str(params.items ?? "citations")] ?? c.inputs[str(params.items ?? "citations")]);
    const rt = runtimeOf(c, c.runId);
    const judge = jev();
    if (!judge || !items.length) return { output: { checked: 0, kept: items.length, verdicts: [] } };
    const inputs = items.map((item) => {
      const row = rec(item);
      return { claim: str(row.claim), quote: str(row.quote), sourceTitle: str(row.title ?? row.source_title), sourceUrl: str(row.url ?? row.source_url), excerpt: str(row.excerpt ?? row.text), question: str(row.question) };
    });
    const settings = rt?.projectId ? await bestEffort(ctx.log, "workflow settings", ctx.effectiveProjectSettings(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) : {};
    const verdicts = await judge.judgeMany(citationCheckJudgment, inputs, { projectId: rt?.projectId ?? null, runId: rt?.runId ?? null, settings });
    const out = verdicts.map((v, i) => {
      const decision = v.by === "jev" ? v.decision : v.by === "fallback" && v.shadow?.decision ? v.shadow.decision : citationCheckJudgment.fallback(inputs[i]!);
      return { index: i, verdict: decision.verdict, keep: decision.keep, by: v.by === "jev" ? "jev" : "fallback" };
    });
    return { output: { checked: verdicts.length, kept: out.filter((v) => v.keep).length, verdicts: out } };
  } });

  // `deliverable.validate` — the three-layer acceptance of a non-code artifact (see docs/workflow-executors.md):
  // in:  { validator: "page"|"design"|"text"|"3d"|"video"|"invoice"|"composite"|"artifact", target, brief?, hostId? }
  // out: { verdict: "pass"|"rework"|"fail", reason, issues? } — the step's own rules turn rework into a revision.
  engine.register<ChainRuntime>("deliverable.validate", { reentrant: true, run: async (c) => {
    const params = rec(rec(c.node).params);
    const w = (c.input.with ?? {}) as Row;
    const pick = (key: string) => params[key] ?? w[key] ?? c.inputs[key];
    const validator = str(pick("validator") ?? "artifact"), target = str(pick("target") ?? pick("deliverable") ?? pick("path"));
    const rt = runtimeOf(c, c.runId);
    if (!target) throw new Error("deliverable.validate: no target");
    const hostId = str(pick("hostId") ?? "");
    const settings = rt?.projectId ? await bestEffort(ctx.log, "workflow settings", ctx.effectiveProjectSettings(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) : {};
    const { validateDeliverable } = await import("../../validators");
    const verdict = await validateDeliverable(validator, target, {
      host: { run: (id, cwd, command, timeoutSec) => runOnHost(host, { hostId: id, cwd, command, timeoutSec }) as never },
      hostId,
      brief: rec(pick("brief")),
      jevCtx: { projectId: rt?.projectId ?? null, runId: rt?.runId ?? c.runId ?? null, settings },
      review: rt?.projectId ? async (req) => pageReviewByAgent(ctx, services, {
        pmThreadId: rt.pmThreadId ?? "", projectId: rt.projectId!, parentRunId: rt.runId ?? c.runId ?? "",
        design: validator === "design" || Boolean(rec(pick("brief")).design), request: req,
      }) : undefined,
    });
    const out = verdict.ok ? "pass" : "rework";
    return { output: { verdict: out, reason: verdict.reason, ...(verdict.details ? { issues: verdict.details } : {}) } };
  } });

  // `skills.jev`: Jev walks the catalog tree for this step (skills.tree_pick, hierarchical) and returns the picked
  // skill names — a graph passes {task} instead of listing skills in the prompt.
  engine.register<ChainRuntime>("skills.jev", { reentrant: true, run: async (c) => {
    const params = rec(rec(c.node).params);
    const task = str(params.task ?? (c.input.with as Row | undefined)?.task ?? c.inputs.task);
    const rt = runtimeOf(c, c.runId);
    const judge = jev();
    if (!judge) return { output: { skills: [], picked: [], by: "off" } };
    
    const tree = await skillTreeCached(readSkillTreeText);
    if (!tree) return { output: { skills: [], picked: [], by: "off" } };
    const settings = rt?.projectId ? await bestEffort(ctx.log, "workflow settings", ctx.effectiveProjectSettings(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) : {};
    const got = await pickSkillTree(judge, tree, { title: task, prompt: "" }, { projectId: rt?.projectId ?? null, runId: rt?.runId ?? null, settings });
    return { output: { skills: got.skills, picked: got.picked, by: got.by } };
  } });
  // The failure classification step of `quality-loop`.
  registerQualityLoopClassifyExecutor(engine, ctx, agents);

  // ---------------------------------------------------------------- agent
  engine.register<ChainRuntime>("agent", {
    // A re-run after a reload is safe only when the spawn is idempotent (the VK thread keys); else the step is interrupted instead.
    get reentrant() { return keyedSpawnSupported(bb); },
    run: async (c) => {
      const rt = need(c);
      const node = c.node as Extract<GraphNode, { type: "agent" }>;
      // A required artifact that arrives under a name (`consumes.as`) must be there before a helper is started for it.
      for (const spec of node.consumes ?? []) {
        if (spec.required && spec.as && (c.input.with[spec.as] ?? c.inputs[spec.as]) === undefined) throw new Error(`consumes_missing: ${node.id} needs ${spec.kind}/${spec.version} as "${spec.as}"${spec.from ? ` from ${spec.from}` : ""}, which did not arrive`);
      }
      // The inputs that are too long to repeat stand in the packet as a file and a summary: the files are written first, and if that fails the packet shows them cut.
      const plan = stepPacket(c, node);
      let byReference = true;
      if (plan?.files.length) {
        try {
          const checkout = await pmCheckout(rt);
          for (const file of plan.files) await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${file.path}`, content: file.text, contentEncoding: "utf8", createParents: true });
        } catch (cause) {
          byReference = false;
          bb.log.warn(`Lane Pilot could not write the input files of ${node.id} (${cause instanceof Error ? cause.message : String(cause)}); the packet shows them cut`);
        }
      }
      const result = await agents.run(await withResolvedModel(agentRequest(c, node, { byReference })));
      return { output: result.output, threadId: result.threadId, ...(result.usage ? { usage: result.usage } : {}) };
    },
  } as NodeExecutor<ChainRuntime>);

  // ---------------------------------------------------------------- human: the owner's question as a BB form
  const openForms = new Set<string>();
  const composing = new Map<string, Promise<string>>();
  /**
   * A human step's text is an instruction to whoever asks («Show the findings and offer revise, proceed, abort»), in English. Shown as
   * it is, the owner got the instruction instead of the question, with no findings in it (live 2026-10-25). A cheap helper writes the
   * question from it and the run's results so far, in the owner's language; when it fails the instruction is shown as before.
   */
  const composeQuestion = (rt: ChainRuntime, runId: string, stepKey: string, node: Extract<GraphNode, { type: "human" }>, instruction: string): Promise<string> => {
    const key = `${runId}|${stepKey}`;
    const known = composing.get(key);
    if (known) return known;
    const job = (async () => {
      const locale = await bestEffort(rt.ctx.log, "workflow owner locale", ownerLocale(rt.ctx.bb), "ru");
      const results = engine.journal.steps(runId).filter((step) => step.state === "succeeded" && step.output_json && step.output_json !== "{}").slice(-6)
        .map((step) => `${step.node_id}: ${step.output_json!.slice(0, 1500)}`).join("\n");
      const options = humanOptions(node).map((value) => value.replace(/_/g, " "));
      const fields: Field[] = [{ name: "question", type: "string", required: true }];
      const preset = BUILTIN_PRESETS["cheap-fast"]!;
      const result = await agents.run({
        rt, workflowRunId: runId, stepKey, nodeId: node.id, spawnKey: `${stepKey}:question`, role: "analyst", title: `question for the owner: ${node.id}`, fields,
        provider: preset.providerId, model: preset.model, reasoning: preset.reasoning ?? "low",
        prompt: [`Write the question the owner sees in a form, in ${locale === "ru" ? "Russian" : "English"}, from the step's instruction and the run's results so far. Plain words, no ids, no JSON, no English terms the owner would not know; say briefly what happened, what is being decided and what each option leads to.${options.length ? ` The form shows these buttons as they are: ${options.join(", ")}; name them the same way.` : ""} At most 900 characters. Read nothing else and change nothing.`,
          `Instruction: ${instruction}`, `Results so far:\n${results || "(none)"}`, outputContract(fields)].join("\n\n"),
      });
      const text = str(result.output.question).trim();
      return text || instruction;
    })().catch((cause: unknown) => { bb.log.warn(`Lane Pilot could not word the question of ${node.id} (${cause instanceof Error ? cause.message : String(cause)}); the instruction is shown`); return instruction; });
    composing.set(key, job);
    return job;
  };
  const ask = async (rt: ChainRuntime, runId: string, stepKey: string, node: Extract<GraphNode, { type: "human" }>, question: string, deadline?: number, base: string = question): Promise<void> => {
    const key = `${runId}|${stepKey}`;
    if (openForms.has(key)) return;
    // No PM chat to show a form in: the question is a line of the owner's list, with a push, answered by `workflow-answer` or its button.
    if (!rt.pmThreadId) {
      const options = humanOptions(node);
      const workflowId = engine.journal.getRun(runId)?.workflow_id ?? "a workflow";
      postOwnerItem(db, {
        key: workflowQuestionKey(runId, stepKey), source: "workflow", kind: "workflow_question", projectId: rt.projectId, wake: true,
        what: `Процесс «${workflowId}» спрашивает: ${base}`,
        why: `Процесс стоит, пока нет ответа.${options.length ? ` Варианты: ${options.map((value) => value.replace(/_/g, " ")).join(" / ")}.` : ""}${node.timeoutSec ? " Если не ответить, шаг решит сам, когда выйдет его время." : ""}`,
        evidence: [{ kind: "run", ref: runId, label: node.id }, { kind: "command", ref: `bb lane-pilot workflow-answer ${runId} ${stepKey} <${options.length ? "option" : "words"}> [words]` }],
        actions: options.map((value) => ({ id: value, label: value.replace(/_/g, " "), cli: `bb lane-pilot workflow-answer ${runId} ${stepKey} ${value}`, rpc: { method: "workflow_answer", input: { runId, stepKey, choice: value } } })),
      });
      openForms.add(key);
      return;
    }
    const worded = await composeQuestion(rt, runId, stepKey, node, base);
    if (openForms.has(key)) return;
    const options = humanOptions(node);
    // An answer can come before the form is reported shown: the form is then not marked open, or the re-ask would think it still is.
    let answered = false;
    const shown = await rt.ctx.ownerAsk.askInBackground(rt.pmThreadId, { source: "pm", kind: "decision", question: question === base ? worded : `${question.slice(0, question.length - base.length)}${worded}`, detail: workflowHumanDetail(await ownerLocale(rt.ctx.bb), runId, node.id), options: options.map((value) => value.replace(/_/g, " ")) },
      async (answer) => {
        answered = true;
        openForms.delete(key);
        if (answer.outcome === "answered") {
          const output = humanOutput(node, { choiceIndex: answer.choice ? Number(answer.choice.id) : null, text: answer.text });
          // Words that name no option and fit no text kind decide nothing: the step keeps waiting and the owner is asked again, with the options listed.
          // The notice goes before the step's own question once, not once per wrong answer (it stacked up, live 2026-10-25).
          const listed = options.map((value) => value.replace(/_/g, " ")).join(" / ");
          if (!output) { await ask(rt, runId, stepKey, node, `${(await bestEffort(rt.ctx.log, "workflow owner locale", ownerLocale(rt.ctx.bb), "ru")) === "ru" ? `Ответ не выбрал вариант (${listed}).` : `Your answer did not choose an option (${listed}).`} ${base}`, deadline, base); return; }
          // The form opens while the step is being recorded as waiting: an answer that arrives first is retried until the step can take it.
          for (let tries = 0; tries < 50; tries += 1) {
            if (await engine.resolve(runId, stepKey, output)) return;
            const state = engine.journal.getStep(runId, stepKey)?.state;
            if (state !== "running" && state !== "waiting" && state !== "pending") return;
            if (state !== "waiting") await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        // A dismissed or timed-out form leaves the step waiting: the next poll asks again, or the step's own timeout answers it.
      }, { timeoutMs: deadline ? Math.max(1000, deadline - Date.now()) : undefined });
    if (shown && !answered) openForms.add(key);
  };
  engine.register<ChainRuntime>("builtin:human", {
    run: async (c) => {
      const node = c.node as Extract<GraphNode, { type: "human" }>;
      const question = c.render(node.question);
      // A run the machine started (the intake's small-task graph, a phase's stage) does not stand for the owner (he takes no part in the
      // loop): the form is still shown, but the step's own timeout answers it after MACHINE_HUMAN_WAIT_SEC at most.
      const timeoutSec = machineStarted(engine, c.runId) ? Math.min(node.timeoutSec ?? MACHINE_HUMAN_WAIT_SEC, MACHINE_HUMAN_WAIT_SEC) : node.timeoutSec;
      const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : undefined;
      const rt = runtimeOf(c, c.runId);
      if (rt) void ask(rt, c.runId, c.stepKey, node, question, deadline).catch((cause) => bb.log.warn(`Lane Pilot could not ask the owner (${node.id}): ${cause instanceof Error ? cause.message : String(cause)}`));
      return { wait: { kind: "human", detail: { question, options: humanOptions(node) }, ...(deadline ? { deadline } : {}) } };
    },
    poll: async (step, { node, runtime }): Promise<PollResult> => {
      const human = node as Extract<GraphNode, { type: "human" }>;
      if (step.await.deadline && Date.now() >= step.await.deadline) {
        // A question whose answer kinds include `timeout` is answered by the clock; otherwise onTimeout says.
        const kind = human.out.find((field) => field.name === "answer_kind");
        if (kind?.values?.includes("timeout")) return { output: humanFields(human, "timeout", "") };
        if (human.onTimeout === "default" && human.defaultOption) {
          const field = human.out.find((candidate) => candidate.type === "string" || candidate.type === "enum");
          return { output: field ? { [field.name]: human.defaultOption } : {} };
        }
        return { error: "human_timeout" };
      }
      // After a reload the form is gone with the old instance: ask again.
      const rt = runtimeOf({ runtime }, step.runId);
      const detail = step.await.detail as { question?: string } | undefined;
      if (rt && detail?.question) await ask(rt, step.runId, step.stepKey, human, detail.question, step.await.deadline);
      return null;
    },
  } as NodeExecutor<ChainRuntime>);

  // ---------------------------------------------------------------- lp-task: one code task through the writer pipeline
  const pipeline = () => { const p = lpTaskPipelines.get(engine); if (!p) throw new Error("the lp-task pipeline executor is not registered"); return p; };
  const chainTask: NodeExecutor<ChainRuntime> = {
    reentrant: true,
    run: async (c) => {
      const rt = needLanePilot(need(c), "a code task");
      const node = c.node as LpTaskNode;
      const { contract, usage: planned } = await contractOf(c, rt, node);
      const run = getRun(db, rt.runId);
      if (!run?.writer_workspace_path) throw new Error("the run has no workspace to build in");
      const stem = sha256Hex(`${c.runId}|${c.stepKey}`).slice(0, 8);
      const picked = resolveTaskQualityMode({ contract: contract.quality_mode, node: node.quality_mode, asked: c.mode, workflow: c.workflow.quality_mode ?? null });
      if (!picked.ok) return { output: failedTask("blocked", picked.detail) };
      const task = { ...withTaskStandard(contract, node.id), id: `w${stem}-${safeId(str(contract.id) || node.id)}`, project_cwd: run.writer_workspace_path, quality_mode: picked.mode };
      const valid = validateTaskV2(task);
      if (!valid.ok) return { output: failedTask("failed", `task-v2 invalid: ${valid.errors.join("; ")}`) };
      const hostId = getRunWriterHost(db, rt.runId) ?? "";
      const lint = await bestEffort(rt.ctx.log, "workflow task lint", lintTask(rt.projectId, rt.runId, valid.task, run.writer_workspace_path, hostId, "workflow"), null);
      if (lint?.errors.length) return { output: failedTask("failed", `contract lint: ${lint.errors.map((error) => error.message).join("; ").slice(0, 600)}`) };
      // The planner's files[] are its concrete steps; passing only the objective hid them from the plan critic (Roblox T5, 2026-11-08).
      // A reentrant dispatch keeps its stored plan, including the legacy format: changing its hash would defeat duplicate detection.
      const plan = getTaskPlan(db, valid.task.id) ?? (valid.task.files?.length ? [valid.task.objective, "Planned changes:", ...valid.task.files.map((file, index) =>
        `${index + 1}. ${file.action} ${file.path}${file.target ? ` (${file.target})` : ""}: ${file.change}`)].join("\n\n") : valid.task.objective);
      const reply = await services.dispatchWriter({ threadId: rt.pmThreadId, projectId: rt.projectId, task: valid.task, plan, birth: leadHanded(engine, c.runId) ? "lead" : "workflow", criticCodeDefault: shortPathCriticDefault(c.workflow.id, picked.mode) });
      if (reply.state === "rejected" || reply.ok === false) return { output: failedTask("blocked", String(reply.reason ?? reply.hint ?? "the dispatch was rejected")) };
      const taskId = str(reply.taskId) || valid.task.id;
      // chains-end: an attempt whose row is lost (task deleted, base wiped) would wait forever; the wait gets a
      // deadline — the node's own timeout or 48 h — and the engine turns it into an explicit await_timeout.
      const deadline = Date.now() + ((node.timeoutSec ?? 48 * 3_600)) * 1000;
      return { wait: { kind: "attempt", detail: { runId: str(reply.runId) || rt.runId, taskId, files: valid.task.owns_paths }, deadline }, ...(planned ? { usage: planned } : {}) };
    },
    poll: async (step): Promise<PollResult> => {
      const detail = step.await.detail as { runId: string; taskId: string } | undefined;
      if (!detail) return { error: "the waiting step does not say which task it waits for" };
      const listed = listAttemptsForTask(db, detail.runId, detail.taskId);
      const latest = listed.at(-1) ? getAttempt(db, listed.at(-1)!.id) : null;
      if (!latest || !TERMINAL_ATTEMPT.includes(latest.state)) return null;
      const reason = latest.reason ?? "";
      const state = latest.state === "accepted" ? "accepted" : latest.state === "canceled" ? "cancelled" : /needs[_ -]?human/i.test(reason) ? "needs_human" : "blocked";
      const rt = runtimeOf({ runtime: undefined }, step.runId);
      const merge = state === "accepted" && rt ? await mergeFacts(rt, latest.id) : { commit: "", files: [] as string[] };
      // What the task spent: the turns of its attempts in their threads (a sticky writer's thread carries other tasks' turns too) and the helpers it
      // started inside, read once, when the task is over (attempt-usage.ts).
      const spent = await services.taskUsage(bb, db, detail.runId, detail.taskId);
      const usage: HelperUsage | undefined = spent.usage;
      return { output: { state, attempts: listed.length, merge_commit: merge.commit, files: merge.files,
        verdict: { status: state === "accepted" ? "pass" : "rework", summary: reason, findings: [], evidence: reason || state } }, ...(usage ? { usage } : {}) };
    },
  };
  const failedTask = (state: string, reason: string): Row => ({ state, attempts: 0, merge_commit: "", files: [], verdict: { status: "rework", summary: reason, findings: [], evidence: reason } });

  /** The task contract of an lp-task node: the `contract` as rendered, or one written from `contract_template` and the step's data by a planner helper. */
  async function contractOf(c: StepContext<ChainRuntime>, rt: ChainRuntime, node: LpTaskNode): Promise<{ contract: Row; usage?: HelperUsage }> {
    if (node.contract !== undefined) {
      const rendered = c.template(node.contract);
      const value = typeof rendered === "string" ? (() => { try { return JSON.parse(rendered) as unknown; } catch { return rendered; } })() : rendered;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return { contract: value as Row };
      throw new Error(`the contract of ${node.id} is not an object (got ${typeof value})`);
    }
    const template = typeof node.contract_template === "string" ? node.contract_template : JSON.stringify(node.contract_template ?? {});
    const fields = taskContractFields();
    const result = await agents.run({
      rt, workflowRunId: c.runId, stepKey: c.stepKey, nodeId: node.id, spawnKey: c.spawnKey, role: "planner", title: `contract for ${node.id}`, fields, signal: c.signal,
      prompt: agentPrompt({ workflow: c.workflow.id, node: node.id, title: `contract for ${node.id}`, role: "planner", mode: c.mode, task: `Write ONE task-v2 contract for a writer from this template and the run's artifacts. Template: ${template}\nThe repository paths come from the artifacts in the run's folder; use only real paths. Put the whole contract object in the field \`contract\`.`, inputs: c.input.with, contract: outputContract(fields), readOnly: true }),
    });
    return { contract: rec(result.output.contract), ...(result.usage ? { usage: result.usage } : {}) };
  }

  /** The merge commit of an accepted attempt (found by the trailer every merge commit carries) and the files it changed. */
  async function mergeFacts(rt: ChainRuntime, attemptId: string): Promise<{ commit: string; files: string[] }> {
    if (!rt.runId) return { commit: "", files: [] };
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId);
    if (!run?.writer_workspace_path || !hostId) return { commit: "", files: [] };
    const ran = await bestEffort(rt.ctx.log, "workflow attempt commit probe", runOnHost(host, { hostId, cwd: run.writer_workspace_path, command: `c=$(git log --all -1 --format=%H --grep=${quote(`Lane-Pilot-Attempt: ${attemptId}`)}) && echo "$c" && git show --name-only --format= "$c"`, timeoutSec: 30, timeoutMs: 45_000 }), null);
    if (!ran || ran.exitCode !== 0) return { commit: "", files: [] };
    const [commit = "", ...files] = ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return { commit, files };
  }

  // One key serves the per-task pipeline (its runtime has an attempt) and the code tasks of a chain.
  engine.register<ChainRuntime | LpTaskRuntime>("lp-task", {
    reentrant: true,
    run: (c) => ((c.runtime as { attemptId?: string } | undefined)?.attemptId !== undefined ? pipeline().run(c as StepContext<LpTaskRuntime>) : chainTask.run(c as StepContext<ChainRuntime>)),
    // A step of the per-task pipeline waits on an attempt it started itself (its detail names the attempt); a chain's code task waits on a dispatched task.
    poll: (step, extra) => (step.await.detail && "attemptId" in (step.await.detail as object)
      ? pipeline().poll!(step, extra as { runtime: LpTaskRuntime | undefined; node: GraphNode }) : chainTask.poll!(step, extra as { runtime: ChainRuntime | undefined; node: GraphNode })),
  } as NodeExecutor<ChainRuntime | LpTaskRuntime>);

  // ---------------------------------------------------------------- actions on the plugin's own state and the PM's checkout
  const action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) =>
    engine.register<ChainRuntime>(key, { reentrant: true, run: async (c) => ({ output: await run(c, need(c)) }) } as NodeExecutor<ChainRuntime>);

  action("fs.write", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = node.params as Row;
    const checkout = await pmCheckout(rt);
    const rel = c.render(str(params.path)).replace(/^\/+/, "");
    if (!rel || rel.includes("..") || rel.includes("\0")) throw new Error(`fs.write: the path "${rel}" is not inside the checkout`);
    const isFolder = rel.endsWith("/");
    // A planning file (.agents/phases|planning|todos|plans, not a task's own folder) goes to the planning home when the project set one (SMA d_project_planning); unset, the checkout.
    const home = isPlanningPath(rel) ? await planHome(rt.projectId, checkout) : null;
    const write = async (path: string, content: string) => {
      if (home) { await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: home, path: `${home}/${path}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null }); return; }
      // Noted before the write lands, so a helper's status read right after it already sees it as the engine's.
      noteEngineWrite(checkout.path, path);
      await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${path}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
    };
    const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
    let first = rel;
    if (params.contents && typeof params.contents === "object") {
      for (const [name, template] of Object.entries(params.contents as Row)) { const value = c.template(template); await write(`${rel}${name}`, asText(value ?? "")); first = first === rel ? `${rel}${name}` : first; }
    } else if (!isFolder) {
      await write(rel, asText(reportBody(c, params)));
    }
    const out: Row = {};
    for (const field of c.node.out) {
      if (field.name === "folder") out.folder = isFolder ? rel : rel.slice(0, rel.lastIndexOf("/") + 1) || "./";
      else if (field.name === "handoff_path") out.handoff_path = isFolder ? `${rel}handoff.md` : rel;
      else if (field.name.endsWith("_path")) out[field.name] = isFolder && !params.contents ? rel : first;
    }
    return out;
  });

  /** A file the chain writes: JSON of what it `reads`, else a Markdown report of the run so far. */
  function reportBody(c: StepContext<ChainRuntime>, params: Row): unknown {
    const reads = list(rec(c.node).reads).map(String);
    if (reads.length) return Object.fromEntries(reads.map((ref) => [ref.split(".").pop()!, c.resolve(ref)]));
    const rows = c.workflow.nodes.filter((node) => node.type !== "note" && node.id !== c.nodeId).map((node) => [node.id, c.resolve(node.id)] as const).filter(([, value]) => value !== undefined && Object.keys(rec(value)).length);
    return [`# ${c.workflow.name.en}`, "", str(params.template) ? `Contents: ${str(params.template)}.` : "", ...rows.flatMap(([id, value]) => ["", `## ${id}`, "```json", JSON.stringify(value, null, 1).slice(0, 12_000), "```"])].join("\n");
  }

  action("git.diff_files", async (c, rt) => {
    const checkout = await pmCheckout(rt);
    const files = c.resolve("$inputs.files"), range = c.resolve("$inputs.range"), pr = str(c.resolve("$inputs.pr"));
    let names: string[] = [];
    if (Array.isArray(files) && files.length) names = files.map(String);
    else {
      const command = Array.isArray(range) && range.length ? `git show --name-only --format= ${range.map((commit) => quote(String(commit))).join(" ")}`
        : typeof range === "string" && range ? `git diff --name-only ${quote(range)}` : pr ? `gh pr diff ${quote(pr)} --name-only` : "";
      if (command) {
        const ran = await runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command, timeoutSec: 60, timeoutMs: 75_000 });
        if (ran.exitCode !== 0) throw new Error(`git.diff_files: ${ran.stderr.trim().slice(0, 300) || `exit ${ran.exitCode}`}`);
        names = [...new Set(ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
      }
    }
    const kept = names.filter((name) => !PRUNE.test(name));
    return { files: kept, count: kept.length, level: kept.length <= 3 ? "quick" : kept.length >= 20 ? "deep" : "standard" };
  });

  action("lp.state_probe", async (_c, rt) => {
    const checkout = await bestEffort(ctx.log, "workflow PM checkout", pmCheckout(rt), null);
    let hasPassport = false, hasUi = false, hasValueMap = false, hasRoadmap = false, hasProfile = false;
    if (checkout) {
      // The planning files of a started project (SMA k_wst_quick): an existing install asks only for what is still missing.
      // With a planning home, the planning part of the probe is asked there; the rest stays in the checkout.
      const research = flagOf(rt, "project.start_research");
      const home = research ? await planHome(rt.projectId, checkout) : null;
      const planningLs = "ls .agents/planning/VALUE-MAP.md .agents/planning/ROADMAP.md .agents/planning/PROFILE.md .agents/planning/profile.json 2>/dev/null";
      const ran = await bestEffort(ctx.log, "workflow state probe", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command: `ls .agents/PASSPORT.md .agents/passport.md PROJECT.md 2>/dev/null | head -1; echo ---; ls package.json src/ui app components 2>/dev/null | head -3${research && !home ? `; echo ---; ${planningLs}` : ""}`, timeoutSec: 20, timeoutMs: 30_000 }), null);
      const homeLs = home ? await bestEffort(ctx.log, "workflow state probe (planning home)", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: home, command: planningLs, timeoutSec: 20, timeoutMs: 30_000 }), null) : null;
      const [passport = "", ui = "", planning = ""] = `${ran?.stdout ?? ""}${home ? `---\n${homeLs?.stdout ?? ""}` : ""}`.split("---");
      const present = new Set(planning.split("\n").map((line) => line.trim().split("/").pop()!.toLowerCase()).filter(Boolean));
      hasPassport = passport.trim().length > 0; hasUi = /app|components|ui/.test(ui);
      hasValueMap = present.has("value-map.md"); hasRoadmap = present.has("roadmap.md");
      // The infra profile lives in the project settings (SMA k_pl_infra): a file from before, or any profile.* key, counts as set.
      const settings = loadProjectSettings(db, rt.projectId);
      hasProfile = present.has("profile.md") || present.has("profile.json") || PROFILE_KEYS.some((key) => String(settings[`profile.${key}`] ?? "").trim() !== "");
    }
    const open = listOpenAttempts(db).filter((row) => row.project_id === rt.projectId).length;
    return { has_passport: hasPassport, open_tasks: open, plan_exists: open > 0, has_ui: hasUi, has_value_map: hasValueMap, has_roadmap: hasRoadmap, has_profile: hasProfile };
  });

  // SMA k_c_backlog: an item into the roadmap's parking lot under the next 999.N number, hash-guarded like the phase's own marks.
  // The file is read with the host's bounded reader (its hash comes with it): absent is the only reason to start a new file; a read
  // that failed, was cut, or does not match its hash stops the action with the reason and writes nothing. (The host's writePhaseBook
  // answers `conflict` and writes nothing when it is given `expectedSha256: null` for a file that exists, so a file wrongly taken as
  // absent could not have been overwritten either; the action now says why instead of reporting a hash conflict.)
  action("lp.roadmap_park", async (c, rt) => {
    const checkout = await pmCheckout(rt);
    const path = ".agents/planning/ROADMAP.md";
    const host = ctx.host as never as { call(m: string, i: unknown, o?: unknown): Promise<Record<string, unknown>> };
    // The planning home moves the roadmap off the checkout (SMA d_project_planning); unset, it is the checkout.
    const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
    let current = "", expected: string | null = null;
    try {
      const file = await host.call("readBoundedFile", { requestedHostId: checkout.hostId, projectCwd: root, relativePath: path, offset: 0, maxLines: 2000 }, { hostId: checkout.hostId, timeoutMs: 20_000 });
      if (typeof file.content !== "string") throw new Error("the read returned no text");
      if (file.truncated === true) throw new Error("the file is longer than one read");
      if (typeof file.sha256 === "string" && file.sha256 !== sha256Hex(file.content)) throw new Error("the text read does not match the file's hash");
      current = file.content;
      expected = sha256Hex(current);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      if (!/ENOENT|no such file/i.test(why)) throw new Error(`lp.roadmap_park: ${path} could not be read (${why.slice(0, 300)}): nothing is written`);
    }
    const name = oneLine(str(c.resolve("$inputs.name")), 200);
    if (!name) throw new Error("lp.roadmap_park: the item needs a name");
    const parked = parkRoadmapRow(current, name, str(c.resolve("$inputs.goal")));
    const edits = [{ path, expectedSha256: expected, content: parked.text }];
    const result = await host.call("writePhaseBook", { requestedHostId: checkout.hostId, projectCwd: root, previewSha256: sha256Hex(JSON.stringify(edits)), edits }, { hostId: checkout.hostId, timeoutMs: 30_000 }) as { status: string; reason?: string | null };
    if (result.status !== "applied") throw new Error(`lp.roadmap_park: ${result.reason ?? result.status}`);
    return { ok: true, n: parked.n, path };
  });

  // SMA k_c_import: the pieces an imported plan was cut into stay inside the checkout (the plan gate only asks for some owns_paths).
  action("lp.plan_import_check", async (c) => {
    const problems = list(c.resolve("pieces.pieces")).flatMap((piece) => ownsPathProblems(str(rec(piece).id) || "piece", rec(rec(piece).task).owns_paths));
    return { ok: problems.length === 0, problems: problems.slice(0, 40) };
  });

  // What the start of a project counts from the tree itself, before any question (SMA k_wst_map): five numbers the value map
  // opens VALUE-MAP.md with. Counted on the host (git ls-files, else a find), never by a model. Only where the project set
  // project.start_research to on: unset, nothing is read on the host, `enabled` is off and every note is empty, so the start
  // runs the nodes it always ran with the prompts it always had. The notes (text of the node's params) are the only way the
  // new instructions reach the prompts of the start.
  action("lp.tree_counts", async (c, rt) => {
    const params = rec(rec(c.node).params);
    const none = { enabled: "off", sources: 0, tests: 0, docs: 0, planning: 0, commits: 0, counts_note: "", profile_note: "", recap_note: "" };
    if (!flagOf(rt, "project.start_research")) return none;
    const checkout = await bestEffort(ctx.log, "tree counts checkout", pmCheckout(rt), null);
    if (!checkout) return { ...none, enabled: "on", profile_note: str(params.profile_note), recap_note: str(params.recap_note) };
    const ran = await bestEffort(ctx.log, "tree counts", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path,
      command: "git ls-files 2>/dev/null || find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './dist/*' -not -path './build/*' | sed 's|^\\./||'; echo ===PLAN===; ls .agents/planning 2>/dev/null; echo ===COM===; git rev-list --count HEAD 2>/dev/null || echo 0",
      timeoutSec: 30, timeoutMs: 45_000 }), null);
    const [listing = "", rest = ""] = (ran?.stdout ?? "").split("===PLAN===");
    const [planningHere = "", commitsRaw = ""] = rest.split("===COM===");
    // With a planning home its artifacts are counted there, not in the checkout.
    const home = await planHome(rt.projectId, checkout);
    const planningList = home ? (await bestEffort(ctx.log, "tree counts (planning home)", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: home, command: "ls .agents/planning 2>/dev/null", timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "" : planningHere;
    const files = listing.split("\n").map((line) => line.trim()).filter(Boolean);
    const isTest = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z0-9]+$/i, isCode = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|kts|lua|vue|svelte|c|cc|cpp|h|hpp)$/i;
    const counts = { sources: files.filter((file) => isCode.test(file) && !isTest.test(file)).length,
      tests: files.filter((file) => isTest.test(file)).length,
      docs: files.filter((file) => file.endsWith(".md")).length,
      planning: planningList.split("\n").filter((line) => line.trim()).length,
      commits: parseInt(commitsRaw, 10) || 0 };
    return { enabled: "on", ...counts, counts_note: `${str(params.counts_note)} sources ${counts.sources}, tests ${counts.tests}, docs ${counts.docs}, planning artifacts ${counts.planning}, commits ${counts.commits}.`.trim(),
      profile_note: str(params.profile_note), recap_note: str(params.recap_note) };
  });

  // The post-ship hook files of the project, counted on the host (SMA k_ws_post): the ship starts a session for the hooks only when
  // there is at least one, so a repository without hook files costs no model session. The hooks themselves are listed by `lane-plan render-hooks post-ship`.
  action("lp.post_ship_hooks", async (_c, rt) => {
    const checkout = await bestEffort(ctx.log, "post-ship hooks checkout", pmCheckout(rt), null);
    if (!checkout) return { count: 0, files: [] as string[] };
    const ran = await bestEffort(ctx.log, "post-ship hooks", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: (await planHome(rt.projectId, checkout)) ?? checkout.path, command: "ls .agents/planning/hooks/post-ship*.md 2>/dev/null || true", timeoutSec: 15, timeoutMs: 20_000 }), null);
    const files = (ran?.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    return { count: files.length, files };
  });

  // The one profile writer (SMA k_pl_infra): the start's preview hands the profile object over and it lands in the project's
  // profile.* settings — the same keys `bb lane-pilot profile` reads and sets. Every key name (password, secret, token, api
  // key, credential, private key), every unknown key and every value goes through the anamnesis unsafeReason first; a refused
  // pair is skipped and reported by key name only, never by content.
  action("lp.profile_write", async (c, rt) => {
    const params = rec(rec(c.node).params);
    let profile: unknown = params.profile === undefined ? undefined : c.template(params.profile);
    if (typeof profile === "string") { try { profile = JSON.parse(profile); } catch { profile = undefined; } }
    const entries = Object.entries(rec(profile)).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value));
    // A refused pair is skipped and named by key with its reason (never the value); the others are written and the start goes on.
    const problems = entries.map(([key, value]) => [key, profilePairProblem(key, String(value))] as const).filter(([, problem]) => problem !== null);
    const refused = problems.map(([key]) => key);
    const set: string[] = [];
    for (const [key, value] of entries.filter(([key]) => !refused.includes(key))) {
      saveProjectSetting(db, rt.projectId, `profile.${key}`, String(value));
      set.push(key);
    }
    for (const [key, problem] of problems) ctx.log(`lp.profile_write: pair «${key.slice(0, 40)}» refused: ${problem}`);
    await writeInstructionForms(rt, profile);
    return { refused, set, reasons: problems.map(([key, problem]) => `${key.slice(0, 40)}: ${problem}`) };
  });

  // The agent-instruction forms go with the start's profile write (SMA k_d_tpl_instructions): CLAUDE.md and the Copilot
  // instructions are written by the machine, as pointers to PROJECT.md, and the «Developer preferences» section is appended
  // to it. writePhaseBook with a null hash only creates, so an existing file — or a hand-edited one — is never overwritten.
  async function writeInstructionForms(rt: ChainRuntime, profile: unknown): Promise<void> {
    const checkout = await bestEffort(ctx.log, "instruction forms checkout", pmCheckout(rt), null);
    if (!checkout) return;
    const prof = rec(profile);
    const host = ctx.host as never as { call(m: string, i: unknown, o?: unknown): Promise<Record<string, unknown>> };
    const forms = instructionForms({ name: checkout.path.split("/").filter(Boolean).pop() ?? "project", test: str(prof.test_command), language: str(prof.stack), style: str(prof.style) });
    const apply = async (cwd: string, edits: Array<{ path: string; expectedSha256: string | null; content: string }>) =>
      bestEffort(ctx.log, "instruction forms write", host.call("writePhaseBook", { requestedHostId: checkout.hostId, projectCwd: cwd, previewSha256: sha256Hex(JSON.stringify(edits)), edits }, { hostId: checkout.hostId, timeoutMs: 30_000 }), null);
    const checkoutEdits = await apply(checkout.path, [
      { path: "CLAUDE.md", expectedSha256: null, content: forms.claudeMd },
      { path: ".github/copilot-instructions.md", expectedSha256: null, content: forms.copilotInstructions },
    ]);
    if (checkoutEdits && checkoutEdits.status !== "applied") ctx.log(`lp.profile_write: instruction files not written (${checkoutEdits.reason ?? checkoutEdits.status}) — existing files are never overwritten`);
    const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
    const projectPath = ".agents/planning/PROJECT.md";
    const current = await bestEffort(ctx.log, "instruction forms PROJECT.md", host.call("readBoundedFile", { requestedHostId: checkout.hostId, projectCwd: root, relativePath: projectPath, offset: 0, maxLines: 4000 }, { hostId: checkout.hostId, timeoutMs: 20_000 }), null);
    if (current && typeof current.content === "string" && current.truncated !== true && typeof current.sha256 === "string" && current.sha256 === sha256Hex(current.content) && !current.content.includes("Developer preferences"))
      await apply(root, [{ path: projectPath, expectedSha256: current.sha256, content: `${current.content.trimEnd()}\n\n${forms.preferences}` }]);
  }

  // A project's switch for a new behaviour (unset = off, as before the change): read when the node runs, so any graph can use it.
  const flagOf = (rt: ChainRuntime, key: string): boolean => switchOn(loadProjectSettings(db, rt.projectId, rt.runId ? getRunSettingsScopes(db, rt.runId) : []), key);
  const switchOf = (rt: ChainRuntime, key: string): string => String(loadProjectSettings(db, rt.projectId, rt.runId ? getRunSettingsScopes(db, rt.runId) : [])[key] ?? "").trim().toLowerCase();

  // Ids of REQUIREMENTS.md that no closed phase of the project covers in its plan items (SMA k_c_auditms). Advisory: it never stops a close.
  const requirementCoverage = async (rt: ChainRuntime) => {
    const checkout = await pmCheckout(rt);
    const text = (await bestEffort(ctx.log, "requirements read", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: (await planHome(rt.projectId, checkout)) ?? checkout.path, command: "cat .agents/planning/REQUIREMENTS.md 2>/dev/null || true", timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "";
    const ids = [...new Set([...text.matchAll(/\bREQ-[A-Za-z0-9][\w.-]*/g)].map((hit) => hit[0]))];
    // The coverage matrix (SMA k_c_auditms): every requirement id against the closed phases that cover it.
    const byPhase = listPhases(db, { projectId: rt.projectId }).filter((phase) => phase.stage === "closed" || phase.state === "closed")
      .map((phase) => ({ id: phase.id, covers: (phase.record.plan?.items ?? []).flatMap((item) => item.covers ?? []) }));
    const covered = new Set(byPhase.flatMap((phase) => phase.covers));
    const matrix = ids.map((id) => `${id}: ${byPhase.filter((phase) => phase.covers.includes(id)).map((phase) => phase.id).join(", ") || "—"}`).join("\n");
    return { uncovered: ids.filter((id) => !covered.has(id)), covered: ids.filter((id) => covered.has(id)), total: ids.length, matrix };
  };

  action("lp.run_status", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.run_status");
    const runId = str(c.resolve("$inputs.run_id")) || rt.runId;
    const open = listOpenAttempts(db).filter((row) => row.run_id === runId);
    const tasks = listTaskIdsForRun(db, runId);
    const latest = tasks.map((taskId) => listAttemptsForTask(db, runId, taskId).at(-1)).filter(Boolean) as Array<{ state: string }>;
    const failed = latest.filter((attempt) => ["blocked", "canceled", "validation_failed"].includes(attempt.state)).length;
    // gate_ok and unmerged keep the values the ask_finish condition always had; the real gate state, the work that has not landed
    // (this project's phase candidates and open phase worktrees) and the uncovered requirements are separate readings for the summary text.
    const gate = latestGateRun(db, rt.projectId);
    const gateVerdict = gateRunVerdict(gate);
    const gateState = !gate ? "none" : gateVerdict.pending ? "running" : gateVerdict.failed ? "red" : "green";
    const phases = listPhases(db, { projectId: rt.projectId });
    const unlanded = phases.filter((phase) => !phase.closedAt && phase.record.candidate && !phase.record.candidate.off && Object.keys(phase.record.candidate.trees).length > 0 && !phase.record.candidate.landedAt).length;
    const mine = new Set(phases.map((phase) => phase.id));
    const phaseTrees = listOpenWorktrees(db).filter((tree) => tree.owner_kind === "phase" && !!tree.owner_id && mine.has(tree.owner_id)).length;
    const coverage = await bestEffort(ctx.log, "requirement coverage", requirementCoverage(rt), { uncovered: [] as string[], covered: [] as string[], total: 0, matrix: "" });
    return { open_tasks: tasks.length - latest.filter((attempt) => attempt.state === "accepted").length - failed, failed_tasks: failed, unmerged: 0, gate_ok: failed === 0, running_attempts: open.length, merged_commits: list(c.resolve("ctx.merged_commits")).map(String),
      gate_state: gateState, unmerged_seen: Math.max(unlanded, phaseTrees), uncovered_reqs: coverage.uncovered, coverage_matrix: coverage.matrix,
      retro_living: flagOf(rt, "retro.living") ? "on" : "off", milestone_archive: flagOf(rt, "milestone.archive") ? "on" : "off", milestone_summary: flagOf(rt, "milestone.summary") ? "on" : "off" };
  });

  // The full-gate mark (SMA k_ws_fullgate), only where the project set ship.full_gate to on; unset the node answers ok as it always did.
  // On: the ship needs proof the integration gate ran green no more than six hours ago, and on the head being shipped when the run
  // knows it (input head, else the phase candidate's one verified head). A project without a gate passes as before; a configured gate never run does not.
  action("lp.integration_gate_status", async (c, rt) => {
    if (!flagOf(rt, "ship.full_gate")) return { ok: true, failing: [], skipped: true };
    const gate = latestGateRun(db, rt.projectId);
    const phaseId = str(c.resolve("$inputs.phase_id"));
    const verified = Object.values((phaseId ? getPhase(db, phaseId) : undefined)?.record.candidate?.verified ?? {});
    const head = str(c.resolve("$inputs.head")) || (verified.length === 1 ? verified[0]! : "") || null;
    if (!gate) {
      const settings = parseIntegrationGateSettings(loadProjectSettings(db, rt.projectId, rt.runId ? getRunSettingsScopes(db, rt.runId) : []));
      return settings.gateOff || !settings.gateCommand
        ? { ok: true, failing: [], reason: "", skipped: true }
        : { ok: false, failing: [`integration gate not run: no run of \`${settings.gateCommand}\` is recorded for this project`], reason: "the integration gate never ran" };
    }
    const verdict = fullGateVerdict(gate, head);
    return { ok: verdict.ok, failing: verdict.ok ? [] : [verdict.reason], reason: verdict.reason };
  });

  action("lp.run_close", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.run_close");
    const runId = str(c.resolve("$inputs.run_id")) || rt.runId;
    // The PM's run is closed by the PM chat's own lifecycle (closeAbandonedRuns); this marks the workflow's end and leaves the run to it.
    return { archived: Boolean(getRun(db, runId)) };
  });

  // Coverage as a node of its own (advisory): a graph that wants the list without lp.run_status can still call it.
  action("lp.requirement_coverage", async (_c, rt) => requirementCoverage(rt));

  // The milestone archive (SMA k_pl_milestones), only where the project set milestone.archive to on: a snapshot of the roadmap and
  // requirements under .agents/planning/milestones/<slug>-<sha8>/, indexed in INDEX.md. The folder name is a slug that cannot start
  // with a dot plus the first 8 hex of the sha of the full name, so two long goals with one beginning do not collide. A second archive
  // of the same name keeps the first snapshot. Every write is best effort: a failure is logged and returned, never thrown, so a close goes on.
  action("lp.milestone_archive", async (c, rt) => {
    if (!flagOf(rt, "milestone.archive")) return { folder: "", files: [] as string[], kept: false, skipped: true };
    let dir = "";
    try {
      const checkout = await pmCheckout(rt);
      const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
      const read = async (rel: string) => (await bestEffort(ctx.log, "milestone archive read", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: root, command: `cat ${quote(rel)} 2>/dev/null || true`, timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "";
      const write = async (rel: string, content: string) => {
        if (root === checkout.path) noteEngineWrite(checkout.path, rel);
        await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: root, path: `${root}/${rel}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
      };
      // The closing milestone is named by its goal. new-milestone names none: the previous milestone is the roadmap's own heading when it has one, else the date.
      const params = rec(rec(c.node).params);
      const closing = "name" in params;
      const heading = closing ? "" : /^#\s+(.+)$/m.exec(await read(".agents/planning/ROADMAP.md"))?.[1]?.replace(/^\s*(roadmap|дорожная карта)\s*[:—–-]*\s*/i, "").trim() ?? "";
      const name = (closing ? str(c.render(str(params.name))).trim() || str(c.resolve("$inputs.run_id")) : heading) || new Date().toISOString().slice(0, 10);
      const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 40).replace(/-+$/, "") || "milestone";
      dir = `.agents/planning/milestones/${slug}-${sha256Hex(name).slice(0, 8)}`;
      const kept = await runOnHost(ctx.host, { hostId: checkout.hostId, cwd: root, command: `test -f ${quote(`${dir}/ROADMAP.md`)} && echo yes`, timeoutSec: 15, timeoutMs: 20_000 }).then((ran) => ran.stdout.trim() === "yes", () => false);
      const files: string[] = [];
      if (!kept) {
        for (const file of ["ROADMAP.md", "REQUIREMENTS.md"]) {
          const body = await read(`.agents/planning/${file}`);
          if (body.trim()) { await write(`${dir}/${file}`, body); files.push(file); }
        }
        const index = await read(".agents/planning/milestones/INDEX.md");
        await write(".agents/planning/milestones/INDEX.md", `${index}${index && !index.endsWith("\n") ? "\n" : ""}- ${slug}-${sha256Hex(name).slice(0, 8)}: ${name.replace(/\s+/g, " ").slice(0, 120)} (archived ${new Date().toISOString().slice(0, 10)}: ${files.join(" + ") || "nothing to copy"})\n`);
      }
      return { folder: dir, files, kept };
    } catch (cause) {
      const failed = cause instanceof Error ? cause.message : String(cause);
      ctx.log(`milestone archive failed, the close goes on: ${failed}`);
      return { folder: dir, files: [] as string[], kept: false, failed };
    }
  });

  // The living retrospective (SMA k_d_tpl_milestone), only where the project set retro.living to on: insights upserted by their INS id into
  // .agents/retro/LIVING.md — a repeated id only moves its last-seen milestone, nothing is ever deleted. The model's text is cut to one
  // plain line, an id that is not INS-<8 hex> is dropped, and a failed write is logged, not thrown.
  action("lp.retro_living", async (c, rt) => {
    const path = ".agents/retro/LIVING.md";
    if (!flagOf(rt, "retro.living")) return { updated: 0, total: 0, path: "", skipped: true };
    try {
      const checkout = await pmCheckout(rt);
      const line = (value: unknown, max: number) => str(value).replace(/[<>`\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
      const insights = list(c.resolve("retro.insights") ?? c.resolve("$inputs.insights")).map(rec);
      const milestone = line(c.resolve("$inputs.goal"), 80) || line(c.resolve("$inputs.run_id"), 80) || line(c.runId, 80) || "milestone";
      const byId = new Map(insights.filter((ins) => /^INS-[0-9a-f]{8}$/.test(str(ins.id))).map((ins) => [str(ins.id), { id: str(ins.id), title: line(ins.title ?? ins.text, 200), lens: /^(technical|process|quality|decision)$/.test(str(ins.lens)) ? str(ins.lens) : "" }]));
      if (!byId.size) return { updated: 0, total: 0, path };
      const prev = (await bestEffort(ctx.log, "living retro read", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command: `cat ${quote(path)} 2>/dev/null || true`, timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "";
      const seen = new Set<string>();
      const lines = (prev.trim() ? prev.split("\n") : ["# Living retrospective", ""]).map((row) => {
        const id = /INS-[A-Za-z0-9]{6,}/.exec(row)?.[0];
        if (id && byId.has(id)) { seen.add(id); return `${row.replace(/\s*\(last seen [^)]*\)\s*$/, "")} (last seen ${milestone})`; }
        return row;
      });
      for (const { id, title, lens } of byId.values()) if (!seen.has(id)) lines.push(`- ${id}${lens ? ` [${lens}]` : ""}${title ? ` ${title}` : ""} (last seen ${milestone})`);
      noteEngineWrite(checkout.path, path);
      await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${path}`, content: `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`, contentEncoding: "utf8", createParents: true, expectedSha256: null });
      return { updated: byId.size, total: lines.filter((row) => /- INS-[A-Za-z0-9]{6,}/.test(row)).length, path };
    } catch (cause) {
      ctx.log(`living retro not written, the close goes on: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { updated: 0, total: 0, path };
    }
  });

  // The structural pre-pass of a review (SMA k_wr_prepass): cheap checks on the host before any model reads the code. It reads what the
  // review's range ADDED (git diff -U0), never whole files, so a line that was already there is not the task's fault: conflict markers,
  // leftover debugger/.only( in code files, secret-like lines (reported by location and kind, never the value), and git diff --check
  // limited to the same range. A checkout that is not git, or an empty diff, gives no finding. By default the findings are only notes
  // handed to the reviewers; with review.prepass = strict they join the verdict and a quick review with a critical one is rework without a model.
  action("lp.review_prepass", async (c, rt) => {
    const strict = switchOf(rt, "review.prepass") === "strict";
    const none = { findings: [] as Row[], notes: "", critical_count: 0, rework: false };
    const checkout = await bestEffort(ctx.log, "review prepass checkout", pmCheckout(rt), null);
    const files = list(c.resolve("scope.files") ?? c.resolve("$inputs.files")).map(String).slice(0, 100);
    if (!checkout || !files.length) return none;
    const range = c.resolve("$inputs.range"), pr = str(c.resolve("$inputs.pr"));
    const only = `-- ${files.map(quote).join(" ")}`;
    const [diffCmd, checkCmd] = Array.isArray(range) && range.length
      ? [`git show -U0 --format= ${range.map((commit) => quote(String(commit))).join(" ")} ${only}`, `git show --check --format= ${range.map((commit) => quote(String(commit))).join(" ")} ${only}`]
      : typeof range === "string" && range ? [`git diff -U0 ${quote(range)} ${only}`, `git diff --check ${quote(range)} ${only}`]
      : pr ? [`gh pr diff ${quote(pr)}`, ""]
      : [`git diff -U0 HEAD ${only}`, `git diff --check HEAD ${only}`];
    const scan = async (command: string) => command ? (await bestEffort(ctx.log, "review prepass", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command: `${command} 2>/dev/null; true`, timeoutSec: 60, timeoutMs: 75_000 }), null))?.stdout ?? "" : "";
    const found: Row[] = [];
    const add = (file: string, line: number, severity: string, evidence: string) => found.push({ id: `pp-${found.length + 1}`, file: `${file}:${line}`, line, severity, evidence });
    let file = "", at = 0;
    for (const row of (await scan(diffCmd)).split("\n")) {
      const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(row), hunk = /^@@ -\S+ \+(\d+)/.exec(row);
      if (header) { file = header[1]!.trim(); continue; }
      if (hunk) { at = Number(hunk[1]); continue; }
      if (!row.startsWith("+") || !file || file === "/dev/null" || found.length >= 60) continue;
      const added = row.slice(1);
      if (/^(<{7}|>{7})(\s|$)/.test(added)) add(file, at, "critical", "merge conflict marker left in the file");
      else if (/\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(file) && /\bdebugger\b|\.only\(/.test(added)) add(file, at, "high", "leftover debugger or focused test");
      else { const reason = unsafeReason(added); if (reason) add(file, at, "critical", `possible ${reason} (location only, the value is withheld)`); }
      at += 1;
    }
    for (const row of (await scan(checkCmd)).split("\n")) {
      const hit = /^(.+?):(\d+): (.+)$/.exec(row);
      if (hit && !row.startsWith("+") && found.length < 80) add(hit[1]!, Number(hit[2]), "medium", `git diff --check: ${hit[3]!.slice(0, 120)}`);
    }
    const critical = found.filter((finding) => finding.severity === "critical").length;
    if (strict) return { findings: found, notes: "", critical_count: critical, rework: critical > 0 && c.resolve("scope.level") === "quick" };
    return { findings: [] as Row[], notes: found.slice(0, 20).map((finding) => `${finding.file} ${finding.severity}: ${finding.evidence}`).join("\n"), critical_count: critical, rework: false };
  });

  // chains-end: the goal check of a deliverable graph — validateDeliverable (validators room) on the artifact the
  // run produced, not "file exists": DOM → Jev → vision review for pages, kind validators for the rest.
  // Node fields: validator (text|design|page|3d|video|invoice|composite|artifact), path (artifact path or url), brief.
  action("deliverable.validate", async (c, rt) => {
    const node = c.node as { validator?: string; path?: string; brief?: unknown; host?: string };
    const { validateDeliverable } = await import("../../validators");
    const inputs = (c.input.with ?? {}) as Record<string, unknown>;
    const path = String(node.path ?? inputs.path ?? c.resolve("$inputs.deliverable") ?? c.resolve("$inputs.path") ?? "");
    const validator = String(node.validator ?? inputs.validator ?? c.resolve("$inputs.validator") ?? "artifact");
    const hostId = String(node.host ?? inputs.hostId ?? c.resolve("$inputs.hostId") ?? "");
    const brief = (node.brief ?? inputs.brief ?? c.resolve("$inputs.brief")) as Record<string, unknown> | undefined;
    const settings = await bestEffort(rt.ctx.log, "workflow settings", rt.ctx.effectiveProjectSettings?.(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) ?? {};
    const verdict = await validateDeliverable(validator, path, {
      host: { run: (id, cwd, command, timeoutSec) => runOnHost(rt.ctx.host, { hostId: id, cwd, command, timeoutSec }) as never },
      ...(hostId ? { hostId } : {}), ...(brief ? { brief } : {}),
      jevCtx: { projectId: rt.projectId, runId: rt.runId ?? null, settings },
    });
    return { ok: verdict.ok, verdict: verdict.ok ? "pass" : "rework", reason: verdict.reason, details: verdict.details ?? {} };
  });

  action("lp.lint_contract", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.lint_contract");
    const tasks = list(c.resolve("plan.tasks"));
    const waves = list(c.resolve("plan.waves")).map((wave) => list(wave).map(String));
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId) ?? "";
    const errors: string[] = [];
    const parsed: TaskV2[] = [];
    for (const [at, raw] of tasks.entries()) {
      const valid = validateTaskV2({ ...withTaskStandard(rec(raw), str(rec(raw).id) || `task-${at + 1}`), project_cwd: run?.writer_workspace_path ?? str(rec(raw).project_cwd) });
      if (!valid.ok) { errors.push(`task #${at + 1} (${str(rec(raw).id) || "no id"}): ${valid.errors.join("; ")}`); continue; }
      parsed.push(valid.task);
      if (run?.writer_workspace_path) {
        const lint = await bestEffort(rt.ctx.log, "workflow task lint", lintTask(rt.projectId, rt.runId, valid.task, run.writer_workspace_path, hostId, "workflow"), null);
        for (const error of lint?.errors ?? []) errors.push(`${valid.task.id}: ${error.message}`);
      }
    }
    // Tasks of one wave run together: their owned paths must not meet.
    const own = (task: TaskV2) => task.owns_paths.map((path) => path.replace(/\/?\*+.*$/, "").replace(/\/$/, ""));
    for (const wave of waves) {
      const members = parsed.filter((task) => wave.includes(task.id));
      for (const [i, a] of members.entries()) for (const b of members.slice(i + 1)) {
        const clash = own(a).find((x) => own(b).some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
        if (clash !== undefined) errors.push(`${a.id} and ${b.id} run in the same wave but both own ${clash || "the repository root"}`);
      }
    }
    // An empty plan is right when the planner checked that the repository already does what the goal asks (already_met).
    if (!tasks.length && c.resolve("plan.already_met") !== true) errors.push("the plan has no tasks");
    return { ok: errors.length === 0, errors };
  });

  // The quick path's row in STATE.md (SMA k_wq_state): the task joins the «Quick Tasks Completed» table of
  // .agents/planning/STATE.md on the writer host and is committed — only where that file already exists (it is never created);
  // a failed write is returned, never thrown — a closed task does not reopen for a bookkeeping write.
  action("lp.quick_state", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.quick_state");
    const comment = str((c.input.with as Row | undefined)?.comment ?? c.resolve("review.comment")) || "quick path: built and verified";
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId);
    if (!run?.writer_workspace_path || !hostId) return { ok: false, note: "no writer workspace", comment };
    // The planning home holds STATE.md when one is set (SMA d_project_planning); its row and its commit go there too.
    const root = (await planHome(rt.projectId, { hostId, path: run.writer_workspace_path })) ?? run.writer_workspace_path;
    const read = await runOnHost(ctx.host, { hostId, cwd: root, command: `if [ -f ${QUICK_STATE_PATH} ]; then cat ${QUICK_STATE_PATH}; else exit 3; fi`, timeoutSec: 20, timeoutMs: 30_000 });
    const title = str((c.input.with as Row | undefined)?.title ?? c.resolve("$inputs.title")) || "quick task";
    const commit = list((c.input.with as Row | undefined)?.commits ?? c.resolve("ctx.merged_commits")).map(String)[0] ?? "—";
    const edit = quickStateEdit(read, { date: new Date().toISOString().slice(0, 10), task: title.slice(0, 120), commit });
    if (!edit) return { ok: true, note: "no STATE.md in the project: nothing written", comment };
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const path = QUICK_STATE_PATH;
    try {
      const edits = [{ path, expectedSha256: edit.expectedSha256, content: edit.content }];
      const written = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: root, previewSha256: sha256Hex(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
      if (!written.writes.some((row) => row.path === path && row.status === "applied")) throw new Error(written.writes.find((row) => row.path === path)?.status ?? "not applied");
      const committed = await bestEffort(ctx.log, "quick STATE.md commit", host.call("gitCommitDocs", { requestedHostId: hostId, projectCwd: root, paths: [path], message: `state: quick task done — ${title.replace(/\s+/g, " ").trim().slice(0, 60)}` }, { hostId, timeoutMs: 60_000 }), null);
      return { ok: true, note: committed?.commit ? "" : "row written, not committed", comment };
    } catch (cause) {
      return { ok: false, note: `STATE.md write failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300), comment };
    }
  });

  // The debug session file of an investigation (SMA k_pl_debug): `.agents/planning/debug/<slug>.md` — an existing one is
  // resumed instead of asking the symptoms again; a new run starts the file with the symptom and status open.
  action("lp.debug_session", async (c, rt) => {
    const slug = debugSessionSlug((c.input.with as Row | undefined)?.session ?? c.resolve("$inputs.session"));
    if (!slug) return { found: false, path: "" };
    const path = `.agents/planning/debug/${slug}.md`;
    const checkout = await pmCheckout(rt);
    const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
    const read = await runOnHost(ctx.host, { hostId: checkout.hostId, cwd: root, command: `test -f ${quote(path)} && cat ${quote(path)} || true`, timeoutSec: 20, timeoutMs: 30_000 });
    if (read.exitCode === 0 && read.stdout.trim()) return { found: true, path };
    const content = debugSessionDoc(slug, c.resolve("$inputs.symptom"));
    try {
      if (root === checkout.path) noteEngineWrite(checkout.path, path);
      await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: root, path: `${root}/${path}`, content, contentEncoding: "utf8", createParents: true });
      return { found: false, path };
    } catch {
      return { found: false, path: "" };
    }
  });

  // ---------------------------------------------------------------- actions that go through a helper thread (skills, MCP, accounts)
  const DELEGATED: Record<string, { role: string; skills: string[]; how: string }> = {
    "telegram.send_rich": { role: "errand", skills: ["telegram-user", "telegram-rich-messages"], how: "Send the markdown as a Telegram rich message from the owner's account to `target` with the telegram-user skill (`tg rich-send --execute`). The send has receipts: never repeat it blindly, and if the first attempt may have gone through, read the chat before you try again. Report the message id, its link and the status the receipt gives." },
    "shell.skill_script": { role: "errand", skills: [], how: "Run the named script of the named skill with the given args, from the skill's own folder, and report the fields below from what it printed. Do not run any other script." },
    "shell.repo_script": { role: "errand", skills: [], how: "Run the named script of the repository (and only it) with the args and env given, from the repository root, and report the fields below. A deploy script has its own gates: report them, never bypass them." },
    "deploy.post_check": { role: "errand", skills: ["browser-automation"], how: "Check that the deployment works as the rule says and report ok with details (what you ran and saw)." },
    "lp.preflight": { role: "errand", skills: [], how: "Check the repository state the rule lists with read-only commands and report each field as you found it. Change nothing." },
    "lp.project_checks": { role: "errand", skills: [], how: "Run the project's own check commands (its test script and linter, as the project documents them; the gate detection notes of the project if there are any) and report the counts. Change nothing." },
  };
  for (const [key, spec] of Object.entries(DELEGATED)) {
    engine.register<ChainRuntime>(key, {
      get reentrant() { return keyedSpawnSupported(bb); },
      run: async (c) => {
        const rt = need(c);
        const node = c.node as Extract<GraphNode, { type: "action" }>;
        const fields = outputFields(c.workflow, node) as Field[];
        const params = rec(c.template(node.params));
        const reads = Object.fromEntries(list(rec(node).reads).map(String).map((ref) => [ref, c.resolve(ref)]));
        const title = `${key}${node.title ? `: ${node.title.en}` : ""}`;
        const prompt = agentPrompt({ workflow: c.workflow.id, node: node.id, title, role: "errand", mode: c.mode, readOnly: key === "lp.preflight",
          task: `${spec.how}\n\nAction: ${key}\nParameters: ${redactKnown(JSON.stringify(params))}`, inputs: { ...c.input.with, ...reads }, contract: outputContract(fields),
          skills: [...spec.skills, ...stringList(params.skill)] });
        const result = await agents.run(await withResolvedModel({ rt, workflowRunId: c.runId, workflowId: c.workflow.id, stepKey: c.stepKey, nodeId: node.id, spawnKey: c.spawnKey, role: spec.role, title, prompt, fields, skills: [...spec.skills, ...stringList(params.skill)], signal: c.signal }));
        return { output: result.output, threadId: result.threadId, ...(result.usage ? { usage: result.usage } : {}) };
      },
    } as NodeExecutor<ChainRuntime>);
  }
}

const stringList = (value: unknown): string[] => (typeof value === "string" && value ? [value] : []);
const taskContractFields = (): Field[] => [
  { name: "contract", type: "object", required: true, ref: "Task", description: "one task-v2 contract object (objective, read_first, owns_paths, never_touch, acceptance, verification ...)" },
  { name: "handoff", type: "string", required: true },
];
