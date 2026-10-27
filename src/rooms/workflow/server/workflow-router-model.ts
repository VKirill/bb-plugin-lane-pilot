import { outputContract, agentPrompt } from "@lane-pilot/workflow-engine";
import type { NodeExecutor, RouterModel, RouterModelOutput, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { Field } from "@lane-pilot/workflow-engine";
import type { WorkflowAgents } from "./workflow-agent";
import type { ChainRuntime } from "./workflow-runtime";
import { sha256Hex } from "@lane-pilot/kit";
import { ROUTE_WORKFLOW, builtinWorkflow } from "../builtin";

/**
 * The escalation of `lane_pilot_route` (Jev decides the clear cases first, src/jev/route-model.ts): a read-only helper thread of the PM chat that sees the owner's request and the cards of
 * the top candidates and chooses among them, with the evidence the router records (the pattern, the rejected options, a
 * confidence, questions). It chooses only among the candidates; the router discards an answer outside them and falls back to its
 * scorer, and the confidence rule (below 60 means questions) stays in code.
 * The call is a run of the built-in graph `lp.route` (workflows/lp.route.json), so its helper has a real run and step like every other model step.
 * It was once started under a made-up run id, which the daily coverage line counted as «inside a graph» (Astra's recheck of .341, F6).
 */
const FIELDS: Field[] = [
  { name: "choice", type: "string", required: true, description: "the id of the best candidate, or an empty string when none fits" },
  { name: "confidence", type: "number", required: true, description: "0 to 100: how sure you are that this is the workflow the owner wants" },
  { name: "pattern", type: "string", required: true, description: "the situation the request matches, in one sentence" },
  { name: "rejected", type: "array", required: true, description: "the other candidates you considered: [{id, reason}]" },
  { name: "questions", type: "array", required: true, description: "up to 3 short questions to the owner when the request does not decide between candidates; else an empty list" },
  { name: "handoff", type: "string", required: true, description: "one line: what you decided and why" },
];

/** The model step of `lp.route`: the helper thread of the PM chat, spawned under the run and step the engine made for it. */
export function registerRouterExecutor(engine: WorkflowEngine, agents: WorkflowAgents): void {
  engine.register<ChainRuntime>("lp.route", {
    // The spawn is keyed by the step, so a step a reload cut off finds its thread again instead of making a second.
    reentrant: true,
    run: async (c) => {
      if (!c.runtime) throw new Error("the router's model step has no PM chat to work in; ask lane_pilot_route again");
      const intent = String(c.resolve("$inputs.intent") ?? "");
      const context = String(c.resolve("$inputs.context") ?? "");
      const task = [
        "Choose which workflow fits the owner's request. Candidates are below, already ranked by a text search; the search can be wrong, so judge by what the request asks for.",
        "A candidate whose `not_for` describes the request is a bad match. If two fit equally well, or the request is too broad to tell, choose none and write up to 3 questions that would settle it. If none fits, choose none and ask nothing.",
        "Do not look at files; decide from the request and the cards.",
      ].join("\n");
      const result = await agents.run({
        rt: c.runtime, workflowRunId: c.runId, workflowId: c.workflow.id, stepKey: c.stepKey, nodeId: c.nodeId, spawnKey: c.spawnKey, role: "pm-reader", title: "route a request", fields: FIELDS, signal: c.signal,
        prompt: agentPrompt({ workflow: "router", node: "route", title: "route a request", role: "router", mode: "standard", task,
          inputs: { request: intent, ...(context ? { context } : {}), candidates: c.resolve("$inputs.candidates") }, contract: outputContract(FIELDS), readOnly: true }),
      });
      return { output: result.output, threadId: result.threadId, ...(result.usage ? { usage: result.usage } : {}) };
    },
  } as NodeExecutor<ChainRuntime>);
}

export function createRouterModel(rt: ChainRuntime, engine: WorkflowEngine): RouterModel {
  return async (input): Promise<RouterModelOutput> => {
    const workflow = builtinWorkflow(ROUTE_WORKFLOW);
    if (!workflow) throw new Error(`built-in workflow ${ROUTE_WORKFLOW} is not loaded`);
    const cards = input.candidates.map((card) => ({ id: card.id, name: card.name, description: card.description, examples: card.examples, not_for: card.not_for, inputs: card.inputs, score: card.score, rules: card.rules }));
    // The question itself names the run (the Lane Pilot run, the request and its context): asking again finds the run. A run that ended badly is
    // closed for good under its key, so the next ask takes the next numbered key.
    const base = `route:${sha256Hex(`route|${rt.runId}|${input.intent}|${input.context ?? ""}`).slice(0, 32)}`;
    let key = base;
    for (let attempt = 1; attempt < 20; attempt += 1) {
      const prior = rt.ctx.db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key) as { status: string } | undefined;
      if (!prior || !["failed", "blocked", "interrupted", "canceled"].includes(prior.status)) break;
      key = `${base}:${attempt}`;
    }
    // Not linked to the Lane Pilot run: the run's end must not post a notice to the PM chat that is waiting on this very call.
    const started = engine.start({ workflow, runtime: rt, key, link: { projectId: rt.projectId }, inputs: { intent: input.intent, context: input.context ?? "", candidates: cards } });
    const summary = await started.done;
    if (summary.status !== "succeeded") throw new Error(summary.error ?? summary.reason ?? `the router's model run ${summary.status}`);
    const output = (summary.output ?? {}) as Record<string, unknown>;
    const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    const choice = typeof output.choice === "string" && output.choice.trim() ? output.choice.trim() : null;
    return {
      choice, confidence: typeof output.confidence === "number" ? Math.max(0, Math.min(100, output.confidence)) : 0,
      pattern: typeof output.pattern === "string" ? output.pattern : "",
      rejected: list(output.rejected).flatMap((row) => (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? [{ id: (row as { id: string }).id, reason: String((row as { reason?: unknown }).reason ?? "") }] : [])),
      questions: list(output.questions).filter((question): question is string => typeof question === "string"),
    };
  };
}
