import type Database from "better-sqlite3";
import { replayPolicy, type ReplayPolicy, type ToolTier } from "@lane-pilot/contracts";

import { MissingValueError, WorkflowEngine } from "./engine";
import type { NodeExecutor, StepContext } from "./engine";
import { PURE_ACTION_KEYS, pureActionExecutor } from "./actions";
import { contractSample } from "./contract";
import { executorKey, lowerWorkflow, outputFields } from "./lower";
import { registerReducers } from "./reducers";
import type { ReplayCase } from "./replay-cases";
import type { Field, GraphNode, Workflow } from "./schema";

/**
 * A dry run of a draft on stubs. Every agent, lp-task and action node answers with a made-up value of its declared
 * output (or with the answer the test case gives for that node), so nothing leaves the machine: no browser, no message,
 * no code writer. The real engine drives the real graph, so the routing, the conditions, the loops and the guards are
 * the ones a live run has. A draft is green when the run ends as the case expects and every check of the case holds.
 */
export type DraftTestCase = {
  id: string;
  input: Record<string, unknown>;
  /**
   * What a stub gives, by node id (or the id of a lowered node such as `score:child`), by the id of the workflow a subworkflow node calls, by the
   * action key (`lp.preflight`) or by node type (`lp-task`). A list is one answer per visit, the last one repeats.
   */
  stubs: Record<string, Record<string, unknown> | Array<Record<string, unknown>>>;
  /** Human node id to its answer: an object (the node's output) or the text of `answer_kind`. */
  humanAnswers: Record<string, unknown>;
  expectStatus: string;
  expectPath?: string[];
  expectOutput?: Record<string, unknown>;
  /** The free-text expectations of the chains spec: shown, not checked. */
  notChecked: string[];
  /** Set when built from a past-run ReplayCase: `mode === "real"` nodes run live and missing recorded outputs mark `replay_needs_stub`. */
  isReplay?: boolean;
};

export const REPLAY_CASE_REASONS = ["replay_forbidden", "replay_needs_stub"] as const;
export type ReplayCaseReason = (typeof REPLAY_CASE_REASONS)[number];

export type DraftTestResult = {
  caseId: string;
  green: boolean;
  status: string;
  reason: string | null;
  error: string | null;
  failedNode: string | null;
  nodeId?: string | null;
  path: string[];
  output: Record<string, unknown> | null;
  runId: string | null;
  failures: string[];
  /** The nodes that would have done something outside (agents, code tasks, actions), answered by a stub here. */
  stubbed: Array<{ node: string; type: string; executor: string }>;
  notChecked: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A boolean that names a bad outcome is false, any other true: a stub answers «all went well» unless the case says otherwise. */
const FALSE_BY_NAME = /(^|_)(stalled|warn|has_ui|blocked|failed|thin|timeout|drift|error|errors|missing|dirty|unmet|needs|skipped|breaking|regression|rejected|duplicate|no)(_|$)/;

/** A value of the declared type, the same every time. */
export function sampleValue(field: Field, owner: string): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "string": return field.name === "handoff" ? `stub handoff of ${owner}` : `stub ${owner}.${field.name}`;
    case "number": return /confidence|score|percent|coverage/.test(field.name) ? 90 : 1;
    case "boolean": return !FALSE_BY_NAME.test(field.name);
    case "enum": return field.values![0];
    case "array": return [`stub ${field.name} 1`, `stub ${field.name} 2`];
    case "object": return {};
    default: return `stub ${owner}.${field.name}`;
  }
}

const sampleOutput = (fields: readonly Field[], owner: string): Record<string, unknown> => Object.fromEntries(fields.map((field) => [field.name, sampleValue(field, owner)]));

const isReplayCaseInput = (value: DraftTestCase | ReplayCase): value is ReplayCase =>
  "runId" in value && "recorded" in value && !("stubs" in value);

/** Converts a past-run `ReplayCase` into a `DraftTestCase` whose stubs come from `recorded` and answers from `humanAnswers`. */
export function draftTestCaseFromReplay(replayCase: ReplayCase): DraftTestCase {
  const stubs: Record<string, Record<string, unknown>> = {};
  for (const [nodeId, value] of Object.entries(replayCase.recorded)) {
    if (isRecord(value)) stubs[nodeId] = value;
  }
  return {
    id: `replay:${replayCase.runId}`,
    input: { ...replayCase.inputs },
    stubs,
    humanAnswers: { ...replayCase.humanAnswers },
    expectStatus: "succeeded",
    notChecked: [],
    isReplay: true,
  };
}

/** The cases of a draft: the `test.sim` it carries (and its `variant_*` entries), or one smoke case made from the declared inputs, plus any replay cases. */
export function testCasesOf(workflow: Workflow, options?: { cases?: readonly ReplayCase[] }): DraftTestCase[] {
  const smoke = (): DraftTestCase => ({ id: "smoke", input: sampleOutput(workflow.inputs, "input"), stubs: {}, humanAnswers: {}, expectStatus: "succeeded", notChecked: [] });
  const test = workflow.test as ({ id: string; sim?: unknown } & Record<string, unknown>) | undefined;
  const replay = (options?.cases ?? []).map(draftTestCaseFromReplay);
  if (!test || !isRecord(test.sim)) return [smoke(), ...replay];
  const sim = test.sim;
  const build = (id: string, layer: Record<string, unknown>, base?: DraftTestCase): DraftTestCase => {
    const pick = (key: string) => (isRecord(layer[key]) ? layer[key] as Record<string, unknown> : {});
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return {
      id,
      input: { ...(base?.input ?? sampleOutput(workflow.inputs, "input")), ...pick("input") },
      stubs: { ...(base?.stubs ?? {}), ...Object.fromEntries(Object.entries(pick("stubs")).filter((entry): entry is [string, Record<string, unknown> | Array<Record<string, unknown>>] => isRecord(entry[1]) || (Array.isArray(entry[1]) && entry[1].every(isRecord)))) },
      humanAnswers: { ...(base?.humanAnswers ?? {}), ...pick("human_answers") },
      expectStatus: typeof layer.expect_status === "string" ? layer.expect_status : base?.expectStatus ?? "succeeded",
      ...(Array.isArray(layer.expect_path) ? { expectPath: strings(layer.expect_path) } : {}),
      ...(isRecord(layer.expect_output) ? { expectOutput: layer.expect_output as Record<string, unknown> } : {}),
      notChecked: [...strings(layer.expect_outputs)],
    };
  };
  const main = build(test.id || "main", sim);
  const variants = Object.entries(sim).filter(([key, value]) => key.startsWith("variant_") && isRecord(value))
    .map(([key, value]) => build(`${main.id}/${key.slice("variant_".length)}`, value as Record<string, unknown>, { ...main, expectPath: undefined, expectOutput: undefined, notChecked: [] }));
  return [main, ...variants, ...replay];
}

function answerFor(node: GraphNode | undefined, given: unknown, options: unknown): Record<string, unknown> {
  const fields: Field[] = node ? node.out : [];
  if (isRecord(given)) return given;
  const kind = fields.find((field) => field.name === "answer_kind") ?? fields.find((field) => field.type === "enum");
  const choice = typeof given === "string" ? given : Array.isArray(options) && typeof options[0] === "string" ? options[0] : kind?.values?.[0];
  const output = sampleOutput(fields.filter((field) => field !== kind), node?.id ?? "human");
  if (kind && typeof choice === "string") output[kind.name] = choice;
  else if (!kind) { const text = fields.find((field) => field.type === "string"); if (text && typeof choice === "string") output[text.name] = choice; }
  return output;
}

export type DraftTestPorts = {
  db: Database.Database;
  harnessVersion: string;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  executors?: Record<string, NodeExecutor>;
  now?: () => number;
  /** Real-time limit of one case; the run is canceled past it. */
  timeoutMs?: number;
  log?: ((message: string) => void) | { debug?: (message: string) => void };
};

/** Runs one case on stubs and judges it. The run stays in the journal under the id `draft-test.<workflow id>`, so a screen can show it. */
export async function runDraftTest(ports: DraftTestPorts, workflow: Workflow, testCaseInput: DraftTestCase | ReplayCase): Promise<DraftTestResult> {
  const testCase = isReplayCaseInput(testCaseInput) ? draftTestCaseFromReplay(testCaseInput) : testCaseInput;
  const stubbed = new Map<string, { node: string; type: string; executor: string }>();
  const lowered = lowerWorkflow(workflow, ports.resolveWorkflow);
  const nodesById = new Map(lowered.nodes.filter((node): node is GraphNode => node.type !== "note").map((node) => [node.id, node]));
  const engine = new WorkflowEngine({ db: ports.db, harnessVersion: ports.harnessVersion, resolveWorkflow: ports.resolveWorkflow, now: ports.now, leaseMs: 120_000 });
  const visits = new Map<string, number>();
  let replayBlock: { reason: ReplayCaseReason; nodeId: string; effect: ToolTier } | null = null;
  const debugLog = (nodeId: string, policy: ReplayPolicy, action: "run" | "stub" | "refuse") => {
    if (!ports.log) return;
    const line = `DEBUG draft test replay node=${nodeId} policy=${policy} action=${action}`;
    if (typeof ports.log === "function") ports.log(line);
    else ports.log.debug?.(line);
  };
  /** The case's stub for a node: its own id, the workflow a subworkflow node calls, the parent of a fan-out's body, the action key, then the node type. */
  const stubOf = (ctx: StepContext): Record<string, unknown> | undefined => {
    const node = ctx.node;
    const visit = (visits.get(ctx.nodeId) ?? 0) + 1;
    // `key#2` is the answer of the second visit of that node; a plain key answers every visit.
    const keys = [ctx.nodeId, ...(node.type === "subworkflow" ? [node.workflow] : []), ...(ctx.nodeId.endsWith(":child") ? [ctx.nodeId.slice(0, -":child".length)] : []),
      ctx.nodeId.replace(/:(child|fan)$/, ""), ...(node.type === "action" && node.action ? [node.action] : []), node.type];
    const entry = keys.map((key) => testCase.stubs[`${key}#${visit}`] ?? testCase.stubs[key]).find((value) => value !== undefined);
    return Array.isArray(entry) ? entry[Math.min(visit - 1, entry.length - 1)] : entry;
  };
  const hasSimOutput = (ctx: StepContext): boolean =>
    stubOf(ctx) !== undefined || (ctx.node.type === "human" && testCase.humanAnswers[ctx.nodeId] !== undefined);
  const answer = (ctx: StepContext, key: string): Record<string, unknown> => {
    const given = stubOf(ctx);
    visits.set(ctx.nodeId, (visits.get(ctx.nodeId) ?? 0) + 1);
    stubbed.set(ctx.nodeId, { node: ctx.nodeId, type: ctx.node.type, executor: key });
    // A person answers at once from the case (`human_answers`): the first answer kind when it says nothing.
    if (ctx.node.type === "human") return answerFor(ctx.node, testCase.humanAnswers[ctx.nodeId], ctx.node.options);
    const fields = outputFields(ctx.workflow, ctx.node) as Field[] | "unknown";
    return { ...(fields === "unknown" ? {} : { ...sampleOutput(fields, ctx.nodeId), ...contractSample("produces" in ctx.node ? ctx.node.produces : undefined, fields) }), ...(given ?? {}) };
  };
  // A stub spends nothing, and says so: an unmeasured cost would park a step under the graph's USD cap.
  const stubOutcome = (ctx: StepContext, key: string) => ({ output: answer(ctx, key), usage: { tokens: 0, costUsd: 0, costState: "measured" as const } });
  const blockReplay = (ctx: StepContext, reason: ReplayCaseReason, policy: ReplayPolicy): never => {
    debugLog(ctx.nodeId, policy, "refuse");
    if (!replayBlock) replayBlock = { reason, nodeId: ctx.nodeId, effect: ctx.node.effect! };
    let rootId = ctx.runId;
    for (let row = engine.journal.getRun(rootId); row?.parent_run_id; row = engine.journal.getRun(rootId)) rootId = row.parent_run_id;
    engine.cancel(rootId, `${reason}:${ctx.nodeId}`);
    throw new MissingValueError(reason, `${ctx.nodeId}: ${reason} (effect ${ctx.node.effect})`);
  };
  const guardExecutor = (key: string, mode: "stub" | "real" | "structural", real?: NodeExecutor, isOverride = false): NodeExecutor => ({
    ...(real?.poll ? { poll: real.poll } : {}),
    reentrant: real?.reentrant ?? true,
    run: async (ctx: StepContext) => {
      const policy = replayPolicy(ctx.node.effect);
      const sim = hasSimOutput(ctx);
      if (policy === "forbidden") {
        if (sim) { debugLog(ctx.nodeId, policy, "stub"); return stubOutcome(ctx, key); }
        return blockReplay(ctx, testCase.isReplay ? "replay_needs_stub" : "replay_forbidden", policy);
      }
      if (policy === "stubbed") {
        if (isOverride && testCase.isReplay) {
          debugLog(ctx.nodeId, policy, "run");
          if (key !== "builtin:subworkflow") visits.set(ctx.nodeId, (visits.get(ctx.nodeId) ?? 0) + 1);
          return real!.run(ctx);
        }
        if (sim) { debugLog(ctx.nodeId, policy, "stub"); return stubOutcome(ctx, key); }
        return blockReplay(ctx, "replay_needs_stub", policy);
      }
      if (policy === "live") debugLog(ctx.nodeId, policy, mode !== "structural" && (!testCase.isReplay || mode === "stub") && sim ? "stub" : "run");
      if (mode === "stub") return stubOutcome(ctx, key);
      if (mode === "real" && !testCase.isReplay && sim) return stubOutcome(ctx, key);
      if (mode === "real" && key !== "builtin:subworkflow") visits.set(ctx.nodeId, (visits.get(ctx.nodeId) ?? 0) + 1);
      return real!.run(ctx);
    },
  });
  // The executors of the workflow and of every workflow it calls, however deep: a child run needs its own agents, tasks and actions answered too.
  const keys = new Set<string>();
  const seen = new Set<string>();
  const collect = (flow: Workflow) => {
    if (seen.has(flow.id)) return;
    seen.add(flow.id);
    for (const node of flow.nodes) {
      if (node.type === "note") continue;
      const key = executorKey(node);
      if (key && !engine.hasExecutor(key)) keys.add(key);
      if (node.type === "subworkflow") { const child = ports.resolveWorkflow?.(node.workflow, node.version); if (child) collect(lowerWorkflow(child, ports.resolveWorkflow)); }
    }
  };
  collect(lowered);
  // The code-only actions and the reducers are code: they run for real, unless the case stubs that node; everything else that reaches outside answers from a stub.
  registerReducers(engine);
  const pureSet = new Set(PURE_ACTION_KEYS);
  const realBuiltins = new Set(["builtin:subworkflow", "builtin:script"]);
  for (const [key, exec] of [...engine.executors.entries()]) {
    if (key === "builtin:human" || pureSet.has(key)) continue;
    const override = ports.executors?.[key];
    engine.register(key, guardExecutor(key, realBuiltins.has(key) || override ? "real" : "structural", override ?? exec, Boolean(override)));
  }
  for (const key of PURE_ACTION_KEYS) {
    const override = ports.executors?.[key];
    engine.register(key, guardExecutor(key, "real", override ?? pureActionExecutor(key), Boolean(override)));
  }
  for (const key of keys) {
    if (!engine.hasExecutor(key)) {
      const override = ports.executors?.[key];
      engine.register(key, guardExecutor(key, override ? "real" : "stub", override, Boolean(override)));
    }
  }
  // A person answers at once, at any depth (a waiting question of a called workflow would hold the whole run): the case's human_answers, else the first option.
  engine.register("builtin:human", guardExecutor("builtin:human", "stub"));

  const failures: string[] = [];
  const base: DraftTestResult = { caseId: testCase.id, green: false, status: "not_started", reason: null, error: null, failedNode: null, path: [], output: null, runId: null, failures, stubbed: [], notChecked: testCase.notChecked };
  const problems = engine.preflight(workflow);
  if (problems.length) return { ...base, status: "invalid", failures: problems.map((message) => `cannot run: ${message}`) };

  const tested = { ...workflow, id: `draft-test.${workflow.id}`.slice(0, 48) };
  let started: ReturnType<typeof engine.start>;
  try { started = engine.start({ workflow: tested, inputs: testCase.input }); }
  catch (cause) { return { ...base, status: "invalid", failures: [`cannot start: ${cause instanceof Error ? cause.message : String(cause)}`] }; }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), ports.timeoutMs ?? 30_000); });
  const drive = (async () => {
    let summary = await started.done;
    for (let round = 0; summary.status === "waiting" && round < 25; round += 1) {
      for (const step of summary.waiting) {
        if (step.await.kind !== "human") continue;
        const options = isRecord(step.await.detail) ? step.await.detail.options : undefined;
        await engine.resolve(summary.runId, step.stepKey, answerFor(nodesById.get(step.nodeId), testCase.humanAnswers[step.nodeId], options));
      }
      await engine.idle();
      summary = engine.get(summary.runId)!;
    }
    return summary;
  })();
  const raced = await Promise.race([drive, late]);
  clearTimeout(timer);
  if (raced === "late") {
    engine.cancel(started.runId, "draft test timed out");
    return { ...base, runId: started.runId, status: "timeout", failures: [`the run did not finish in ${(ports.timeoutMs ?? 30_000) / 1000} s`], stubbed: [...stubbed.values()] };
  }
  const summary = raced;
  if (summary.status === "waiting") engine.cancel(summary.runId, "draft test: a step still waits");
  const steps = engine.snapshot(summary.runId)?.steps ?? [];
  const path = steps.filter((step) => (step.state === "succeeded" || step.state === "skipped") && !step.node_id.includes(":")).map((step) => step.node_id);

  if (replayBlock) {
    const blocked: { reason: ReplayCaseReason; nodeId: string; effect: ToolTier } = replayBlock;
    const status = blocked.reason === "replay_needs_stub" ? "skipped" : "failed";
    const error = `${blocked.reason}: node "${blocked.nodeId}" has effect "${blocked.effect}" without ${testCase.isReplay ? "recorded" : "test.sim"} output`;
    failures.push(error);
    return { ...base, green: false, status, reason: blocked.reason, error, failedNode: blocked.nodeId, nodeId: blocked.nodeId, path, output: summary.output, runId: summary.runId, failures, stubbed: [...stubbed.values()] };
  }

  if (summary.status !== testCase.expectStatus) {
    failures.push(`the run ended ${summary.status}${summary.reason ? ` (${summary.reason})` : ""}${summary.failedNode ? ` at ${summary.failedNode}` : ""}${summary.error ? `: ${summary.error}` : ""}; the case expects ${testCase.expectStatus}`);
  }
  if (testCase.expectPath && JSON.stringify(path) !== JSON.stringify(testCase.expectPath)) {
    failures.push(`path ${path.join(" > ")} is not the expected ${testCase.expectPath.join(" > ")}`);
  }
  for (const [name, expected] of Object.entries(testCase.expectOutput ?? {})) {
    const got = summary.output?.[name];
    if (JSON.stringify(got) !== JSON.stringify(expected)) failures.push(`output ${name} is ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  return { ...base, green: failures.length === 0, status: summary.status, reason: summary.reason, error: summary.error, failedNode: summary.failedNode, path, output: summary.output, runId: summary.runId, failures, stubbed: [...stubbed.values()] };
}
