import { outputContract, agentPrompt } from "@lane-pilot/workflow-engine";
import type { RouterModel, RouterModelOutput } from "@lane-pilot/workflow-engine";
import type { Field } from "@lane-pilot/workflow-engine";
import type { WorkflowAgents } from "./workflow-agent";
import type { ChainRuntime } from "./workflow-runtime";
import { sha256Hex } from "@lane-pilot/kit";

/**
 * The escalation of `lane_pilot_route` (Jev decides the clear cases first, src/jev/route-model.ts): a read-only helper thread of the PM chat that sees the owner's request and the cards of
 * the top candidates and chooses among them, with the evidence the router records (the pattern, the rejected options, a
 * confidence, questions). It chooses only among the candidates; the router discards an answer outside them and falls back to its
 * scorer, and the confidence rule (below 60 means questions) stays in code.
 */
const FIELDS: Field[] = [
  { name: "choice", type: "string", required: true, description: "the id of the best candidate, or an empty string when none fits" },
  { name: "confidence", type: "number", required: true, description: "0 to 100: how sure you are that this is the workflow the owner wants" },
  { name: "pattern", type: "string", required: true, description: "the situation the request matches, in one sentence" },
  { name: "rejected", type: "array", required: true, description: "the other candidates you considered: [{id, reason}]" },
  { name: "questions", type: "array", required: true, description: "up to 3 short questions to the owner when the request does not decide between candidates; else an empty list" },
  { name: "handoff", type: "string", required: true, description: "one line: what you decided and why" },
];

export function createRouterModel(rt: ChainRuntime, agents: WorkflowAgents): RouterModel {
  return async (input): Promise<RouterModelOutput> => {
    const cards = input.candidates.map((card) => ({ id: card.id, name: card.name, description: card.description, examples: card.examples, not_for: card.not_for, inputs: card.inputs, score: card.score, rules: card.rules }));
    const spawnKey = sha256Hex(`route|${rt.runId}|${input.intent}|${input.context ?? ""}`).slice(0, 32);
    const task = [
      "Choose which workflow fits the owner's request. Candidates are below, already ranked by a text search; the search can be wrong, so judge by what the request asks for.",
      "A candidate whose `not_for` describes the request is a bad match. If two fit equally well, or the request is too broad to tell, choose none and write up to 3 questions that would settle it. If none fits, choose none and ask nothing.",
      "Do not look at files; decide from the request and the cards.",
    ].join("\n");
    const result = await agents.run({
      rt, workflowRunId: `route-${rt.runId}`, stepKey: `route-${spawnKey.slice(0, 8)}`, nodeId: "route", spawnKey, role: "pm-reader", title: "route a request", fields: FIELDS,
      prompt: agentPrompt({ workflow: "router", node: "route", title: "route a request", role: "router", mode: "standard", task,
        inputs: { request: input.intent, ...(input.context ? { context: input.context } : {}), candidates: cards }, contract: outputContract(FIELDS), readOnly: true }),
    });
    const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    const choice = typeof result.output.choice === "string" && result.output.choice.trim() ? result.output.choice.trim() : null;
    return {
      choice, confidence: typeof result.output.confidence === "number" ? Math.max(0, Math.min(100, result.output.confidence)) : 0,
      pattern: typeof result.output.pattern === "string" ? result.output.pattern : "",
      rejected: list(result.output.rejected).flatMap((row) => (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? [{ id: (row as { id: string }).id, reason: String((row as { reason?: unknown }).reason ?? "") }] : [])),
      questions: list(result.output.questions).filter((question): question is string => typeof question === "string"),
    };
  };
}
