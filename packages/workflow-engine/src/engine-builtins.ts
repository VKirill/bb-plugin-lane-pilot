import { MissingValueError } from "./expr";
import { MAX_SUBWORKFLOW_DEPTH } from "./schema";
import type { Field, GraphNode as WorkflowNode, Workflow } from "./schema";
import type { RunStatus } from "./journal";
import { outputFields } from "./lower";
import { pinKey } from "./pins";
import type { Pins } from "./pins";
import type { StepOutcome } from "./step-types";
import type { RunSummary } from "./engine-types";
import { summary } from "./run-status";
import { unknownUsageSteps } from "./engine-step";
import { runScriptCommand } from "./step-form";
import type { WorkflowEngine } from "./engine";

/** A human wait without a node timeout still ends: this is its deadline in seconds (72 h). */
export const HUMAN_WAIT_DEFAULT_SEC = 72 * 3_600;

/** Computes the absolute epoch deadline (ms) for a human wait using its timeoutSec or the 72 h default. */
export function humanWaitDeadline(nowMs: number, timeoutSec?: number, maxSec?: number): number {
  const raw = timeoutSec ?? HUMAN_WAIT_DEFAULT_SEC;
  const effective = maxSec !== undefined ? Math.min(raw, maxSec) : raw;
  return nowMs + effective * 1000;
}

/** Resolves the outcome of an expired human wait from the node's declared answer kinds / timeout policy. */
export function humanTimeoutOutcome(
  human: Extract<WorkflowNode, { type: "human" }>,
  timeoutFields?: (node: Extract<WorkflowNode, { type: "human" }>) => Record<string, unknown>,
): { output: Record<string, unknown> } | { error: string } {
  // A question whose answer kinds include `timeout` is answered by the clock; otherwise onTimeout says.
  const kind = human.out.find((field) => field.name === "answer_kind");
  if (kind?.values?.includes("timeout")) {
    return { output: timeoutFields ? timeoutFields(human) : { answer: "", answer_kind: "timeout" } };
  }
  if (human.onTimeout === "default" && human.defaultOption) {
    const field = human.out.find((candidate) => candidate.type === "string" || candidate.type === "enum");
    return { output: field ? { [field.name]: human.defaultOption } : {} };
  }
  return { error: "human_timeout" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWaitDeadline(nowMs: number, params: Record<string, unknown>, nodeTimeoutSec?: number): number {
  let untilDeadline: number | undefined;
  if (params.until !== undefined) {
    if (typeof params.until === "number" && Number.isFinite(params.until)) {
      untilDeadline = params.until;
    } else if (typeof params.until === "string" && params.until.trim()) {
      const parsed = Date.parse(params.until);
      if (!Number.isFinite(parsed)) throw new Error(`builtin:wait: invalid until "${params.until}"`);
      untilDeadline = parsed;
    } else {
      throw new Error("builtin:wait: invalid until value");
    }
  }
  const rawDuration = params.durationSec ?? nodeTimeoutSec;
  let durationDeadline: number | undefined;
  if (rawDuration !== undefined) {
    if (typeof rawDuration !== "number" || !Number.isFinite(rawDuration) || rawDuration < 0) {
      throw new Error(`builtin:wait: invalid durationSec "${String(rawDuration)}"`);
    }
    durationDeadline = nowMs + rawDuration * 1000;
  }
  if (untilDeadline !== undefined && durationDeadline !== undefined) return Math.min(untilDeadline, durationDeadline);
  if (untilDeadline !== undefined) return untilDeadline;
  if (durationDeadline !== undefined) return durationDeadline;
  throw new Error("builtin:wait requires until, durationSec, or timeoutSec");
}

/** A terminal child result, distinct from a retryable failure to read its journal. */
class ChildRunError extends Error {}

export function registerBuiltins(engine: WorkflowEngine): void {
  engine.register("builtin:parallel", { reentrant: true, run: async () => ({ output: {} }) });
  engine.register("builtin:script", {
    reentrant: true,
    run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "agent" }>;
      return runScriptCommand(ctx, node.script);
    },
  });
  engine.register("builtin:join", { reentrant: true, run: async (ctx) => {
    const results = (ctx.input.with.results as Array<Record<string, unknown>>) ?? [];
    const output: Record<string, unknown> = { results, count: results.length, failed_count: ((ctx.input.with.failed as unknown[] | undefined) ?? []).length };
    // The default reducer: a declared array field is the concatenation of the same field of every branch.
    for (const field of outputFields(ctx.workflow, ctx.node) as Field[]) {
      if (field.type === "array" && output[field.name] === undefined) output[field.name] = results.flatMap((row) => (Array.isArray(row[field.name]) ? row[field.name] as unknown[] : []));
    }
    return { output };
  } });
  engine.register("builtin:decision", { reentrant: true, run: async (ctx) => {
    const node = ctx.node as Extract<WorkflowNode, { type: "decision" }>;
    const fields = outputFields(ctx.workflow, node) as Field[];
    return { output: Object.fromEntries(fields.map((field) => [field.name, ctx.resolve(`${node.reads_node}.${field.name}`)]).filter(([, value]) => value !== undefined)) };
  } });
  engine.register("builtin:emit", { reentrant: true, run: async (ctx) => {
    const node = ctx.node as Extract<WorkflowNode, { type: "action" }>;
    return { output: Object.fromEntries(Object.entries(node.map ?? {}).map(([name, value]) => [name, ctx.value(value)]).filter(([, value]) => value !== undefined)) };
  } });
  engine.register("builtin:human", {
    run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "human" }>;
      // chains-end: no human question waits forever — a node without its own timeout gets the 72 h default;
      // the poll below turns an expired deadline into a timeout answer, a default option or a human_timeout error.
      const deadline = humanWaitDeadline(engine.now(), node.timeoutSec);
      return { wait: { kind: "human", detail: { question: ctx.render(node.question), options: node.options }, deadline } };
    },
    poll: async (step, { node }) => {
      const human = node as Extract<WorkflowNode, { type: "human" }>;
      if (!step.await.deadline || engine.now() < step.await.deadline) return null;
      return humanTimeoutOutcome(human);
    },
  });
  engine.register("builtin:wait", {
    run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "action" }>;
      const raw = { ...(isRecord(node.params) ? (ctx.template(node.params) as Record<string, unknown>) : {}), ...ctx.input.with };
      const deadline = parseWaitDeadline(engine.now(), raw, node.timeoutSec);
      const event = typeof raw.event === "string" && raw.event.trim() ? raw.event.trim() : undefined;
      const eventKey = raw.eventKey !== undefined && raw.eventKey !== null ? String(raw.eventKey) : (event ? "" : undefined);
      const attemptKey = typeof raw.attemptKey === "string" && raw.attemptKey.trim() ? raw.attemptKey.trim() : undefined;
      const timeoutOutput: Record<string, unknown> = { ...(isRecord(raw.timeoutOutput) ? raw.timeoutOutput : {}), woke: "timeout" };
      return {
        wait: {
          kind: event ?? "timer",
          ...(eventKey !== undefined ? { eventKey } : {}),
          ...(attemptKey ? { attemptKey } : {}),
          deadline,
          timeoutOutput,
        },
      };
    },
    poll: async (step) => {
      if (typeof step.await.deadline === "number" && engine.now() >= step.await.deadline) {
        return { output: step.await.timeoutOutput ?? { woke: "timeout" } };
      }
      return null;
    },
  });
  engine.register("builtin:subworkflow", {
    run: async (ctx) => {
      const node = ctx.node as Extract<WorkflowNode, { type: "subworkflow" }>;
      const run = engine.journal.getRun(ctx.runId)!;
      const depth = run.depth + 1;
      if (depth > Math.min(ctx.workflow.guards.maxSubworkflowDepth, MAX_SUBWORKFLOW_DEPTH)) throw new MissingValueError("subworkflow_depth", `subworkflows go ${depth} deep; the limit is ${MAX_SUBWORKFLOW_DEPTH}`);
      // The child the chain was started with; a run from before pins resolves it now.
      const pins = (ctx.workflow as Workflow & { pinned?: Pins }).pinned;
      const child = pins?.[pinKey(node.workflow, node.version)] ?? engine.options.resolveWorkflow?.(node.workflow, node.version);
      if (!child) throw new Error(`workflow "${node.workflow}" was not found`);
      const mapped = Object.fromEntries(Object.entries(node.inputs).map(([name, ref]) => [name, ctx.resolve(ref)]).filter(([, value]) => value !== undefined));
      const inputs = { ...mapped, ...ctx.input.with };
      const known = new Set(child.inputs.map((field) => field.name));
      const started = engine.start({ workflow: child, inputs: Object.fromEntries(Object.entries(inputs).filter(([name]) => known.has(name))), key: `child:${ctx.runId}:${ctx.stepKey}`, mode: ctx.mode, goals: ctx.goals, ...(pins ? { pins } : {}),
        parent: { runId: ctx.runId, stepKey: ctx.stepKey }, depth, link: { projectId: run.project_id ?? undefined, runId: run.link_run_id ?? undefined, taskId: run.link_task_id ?? undefined } });
      return childOutcome(engine, await started.done, node);
    },
    poll: async (step, { node }) => {
      const child = engine.journal.db.prepare("SELECT id, status FROM lane_pilot_wf_run WHERE parent_run_id=? AND parent_step_key=?").get(step.runId, step.stepKey) as { id: string; status: RunStatus } | undefined;
      if (!child) return { error: "child run not found" };
      if (child.status === "running" || child.status === "waiting") return null;
      try {
        const outcome = childOutcome(engine, summary(engine, child.id), node as Extract<WorkflowNode, { type: "subworkflow" }>);
        return "wait" in outcome ? null : outcome;
      } catch (cause) {
        if (cause instanceof ChildRunError) return { error: cause.message };
        throw cause;
      }
    },
  });
}

export function childOutcome(engine: WorkflowEngine, child: RunSummary, node: Extract<WorkflowNode, { type: "subworkflow" }>): StepOutcome {
  // The child's spending is the parent's: a budget on the outer chain counts the whole tree.
  const spent = engine.journal.db.prepare("SELECT tokens_used, cost_micro_usd FROM lane_pilot_wf_run WHERE id=?").get(child.runId) as { tokens_used: number; cost_micro_usd: number } | undefined;
  const blind = unknownUsageSteps(engine, child.runId).length > 0 || Boolean(engine.journal.db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='usage_unknown' LIMIT 1").get(child.runId));
  const usage = spent && (spent.tokens_used || spent.cost_micro_usd || blind) ? { tokens: spent.tokens_used, costUsd: spent.cost_micro_usd / 1_000_000, ...(blind ? { unknown: true as const } : {}) } : undefined;
  if (child.status === "succeeded") return { output: child.output ?? {}, ...(usage ? { usage } : {}) };
  if (child.status === "waiting" || child.status === "running") return { wait: { kind: "subworkflow", detail: { childRunId: child.runId } } };
  // A child that ended badly still spent: the parent's step fails without an outcome, so its spend is added here, once.
  // Once, whatever the process does: the charge is a journal event of the parent run, so a reload that asks again does not add it a second time.
  if (usage) {
    const parent = engine.journal.db.prepare("SELECT parent_run_id FROM lane_pilot_wf_run WHERE id=?").get(child.runId) as { parent_run_id: string | null } | undefined;
    const parentId = parent?.parent_run_id;
    if (parentId && !engine.journal.db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='child_usage_charged' AND step_key=? LIMIT 1").get(parentId, child.runId)) {
      engine.journal.db.transaction(() => {
        engine.journal.event(parentId, child.runId, "child_usage_charged", null, null, `${Math.round(usage.tokens)} tokens of the failed child run`);
        engine.journal.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?").run(Math.round(usage.tokens), Math.round(usage.costUsd * 1_000_000), parentId);
      })();
    }
  }
  throw new ChildRunError(`subworkflow ${node.workflow} ${child.status}: ${child.error ?? child.reason ?? ""}`);
}
