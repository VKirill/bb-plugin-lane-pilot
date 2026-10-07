import type { LanePilotDatabase } from "../database";
import { WorkflowEngine } from "./engine";
import type { NodeExecutor, StepContext } from "./engine";
import { executorKey, lowerWorkflow, outputFields } from "./lower";
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
  /** Node id (or the id of a lowered node such as `score:child`) to the output the stub gives. */
  stubs: Record<string, Record<string, unknown>>;
  /** Human node id to its answer: an object (the node's output) or the text of `answer_kind`. */
  humanAnswers: Record<string, unknown>;
  expectStatus: string;
  expectPath?: string[];
  expectOutput?: Record<string, unknown>;
  /** The free-text expectations of the chains spec: shown, not checked. */
  notChecked: string[];
};

export type DraftTestResult = {
  caseId: string;
  green: boolean;
  status: string;
  reason: string | null;
  error: string | null;
  failedNode: string | null;
  path: string[];
  output: Record<string, unknown> | null;
  runId: string | null;
  failures: string[];
  /** The nodes that would have done something outside (agents, code tasks, actions), answered by a stub here. */
  stubbed: Array<{ node: string; type: string; executor: string }>;
  notChecked: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A value of the declared type, the same every time. */
export function sampleValue(field: Field, owner: string): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "string": return field.name === "handoff" ? `stub handoff of ${owner}` : `stub ${owner}.${field.name}`;
    case "number": return 1;
    case "boolean": return false;
    case "enum": return field.values![0];
    case "array": return [`stub ${field.name} 1`, `stub ${field.name} 2`];
    case "object": return {};
    default: return `stub ${owner}.${field.name}`;
  }
}

const sampleOutput = (fields: readonly Field[], owner: string): Record<string, unknown> => Object.fromEntries(fields.map((field) => [field.name, sampleValue(field, owner)]));

/** The cases of a draft: the `test.sim` it carries (and its `variant_*` entries), or one smoke case made from the declared inputs. */
export function testCasesOf(workflow: Workflow): DraftTestCase[] {
  const smoke = (): DraftTestCase => ({ id: "smoke", input: sampleOutput(workflow.inputs, "input"), stubs: {}, humanAnswers: {}, expectStatus: "succeeded", notChecked: [] });
  const test = workflow.test as ({ id: string; sim?: unknown } & Record<string, unknown>) | undefined;
  if (!test || !isRecord(test.sim)) return [smoke()];
  const sim = test.sim;
  const build = (id: string, layer: Record<string, unknown>, base?: DraftTestCase): DraftTestCase => {
    const pick = (key: string) => (isRecord(layer[key]) ? layer[key] as Record<string, unknown> : {});
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return {
      id,
      input: { ...(base?.input ?? sampleOutput(workflow.inputs, "input")), ...pick("input") },
      stubs: { ...(base?.stubs ?? {}), ...Object.fromEntries(Object.entries(pick("stubs")).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))) },
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
  return [main, ...variants];
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
  db: LanePilotDatabase;
  harnessVersion: string;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  now?: () => number;
  /** Real-time limit of one case; the run is canceled past it. */
  timeoutMs?: number;
};

/** Runs one case on stubs and judges it. The run stays in the journal under the id `draft-test.<workflow id>`, so a screen can show it. */
export async function runDraftTest(ports: DraftTestPorts, workflow: Workflow, testCase: DraftTestCase): Promise<DraftTestResult> {
  const stubbed = new Map<string, { node: string; type: string; executor: string }>();
  const lowered = lowerWorkflow(workflow, ports.resolveWorkflow);
  const nodesById = new Map(lowered.nodes.filter((node): node is GraphNode => node.type !== "note").map((node) => [node.id, node]));
  const engine = new WorkflowEngine({ db: ports.db, harnessVersion: ports.harnessVersion, resolveWorkflow: ports.resolveWorkflow, now: ports.now, leaseMs: 120_000 });
  const stubFor = (key: string): NodeExecutor => ({
    reentrant: true,
    run: async (ctx: StepContext) => {
      const fields = outputFields(ctx.workflow, ctx.node) as Field[] | "unknown";
      const given = testCase.stubs[ctx.nodeId] ?? testCase.stubs[ctx.nodeId.replace(/:(child|fan)$/, "")];
      stubbed.set(ctx.nodeId, { node: ctx.nodeId, type: ctx.node.type, executor: key });
      return { output: { ...(fields === "unknown" ? {} : sampleOutput(fields, ctx.nodeId)), ...(given ?? {}) } };
    },
  });
  const keys = new Set<string>();
  for (const node of nodesById.values()) { const key = executorKey(node); if (key && !engine.hasExecutor(key)) keys.add(key); }
  for (const key of keys) engine.register(key, stubFor(key));

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
