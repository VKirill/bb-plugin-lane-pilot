import type { GraphNode, Workflow } from "@lane-pilot/workflow-engine";
import { closeOwnerItem } from "../../owner-waiting";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { humanOptions, humanOutput, workflowQuestionKey } from "./workflow-executors";

/**
 * The owner's answer to a question of a workflow run that has no PM chat to show a form in (the question is a line of his list:
 * `workflow-question:<run>:<step>`). The same step-settling the form does: the words or the chosen option become the step's output.
 */
export type WorkflowAnswerResult =
  | { ok: true; stepKey: string; output: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "not_waiting" | "answer_decides_nothing"; message: string; options?: string[] };

export async function answerWorkflowQuestion(ctx: Pick<ServerCore, "db">, services: Pick<Services, "workflowEngine">, input: { runId: string; stepKey?: string | undefined; choice?: string | undefined; text?: string | undefined }): Promise<WorkflowAnswerResult> {
  const engine = services.workflowEngine;
  const run = engine.journal.getRun(input.runId);
  if (!run) return { ok: false, reason: "not_found", message: `there is no workflow run ${input.runId}` };
  const waiting = engine.journal.steps(input.runId).filter((step) => step.state === "waiting" && (!input.stepKey || step.step_key === input.stepKey));
  const step = waiting.find((row) => (JSON.parse(run.definition_json) as Workflow).nodes.some((node) => node.id === row.node_id && node.type === "human"));
  if (!step) return { ok: false, reason: "not_waiting", message: input.stepKey ? `step ${input.stepKey} of ${input.runId} is not waiting for an answer` : `run ${input.runId} has no question waiting` };
  const node = (JSON.parse(run.definition_json) as Workflow).nodes.find((candidate) => candidate.id === step.node_id) as Extract<GraphNode, { type: "human" }>;
  const options = humanOptions(node);
  const asked = input.choice?.trim().toLowerCase().replace(/[_\s]+/gu, " ");
  const at = asked ? options.findIndex((option) => option.toLowerCase().replace(/_/gu, " ") === asked) : -1;
  const output = humanOutput(node, { choiceIndex: at >= 0 ? at + 1 : null, text: input.text?.trim() ?? (asked && at < 0 ? input.choice!.trim() : "") });
  if (!output) return { ok: false, reason: "answer_decides_nothing", message: `the answer names no option and the question takes no free text; the options are: ${options.join(", ")}`, options };
  if (!await engine.resolve(input.runId, step.step_key, output)) return { ok: false, reason: "not_waiting", message: `step ${step.step_key} of ${input.runId} could not take the answer (it moved on)` };
  closeOwnerItem(ctx.db, workflowQuestionKey(input.runId, step.step_key), "answered");
  return { ok: true, stepKey: step.step_key, output };
}
