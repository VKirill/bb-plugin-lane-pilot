import { AUTHOR_ROWS, roleRowOf } from "@lane-pilot/models";
import { evalCondition, toExpr } from "./expr";
import type { EvalEnv, Ref } from "./expr";
import { humanTimeoutOutcome } from "./engine-builtins";
import { executorKey } from "./lower";
import { START } from "./schema";
import type { Field, GraphNode, Workflow, WorkflowEdge } from "./schema";

type ReportProblem = (code: string, message: string, extra?: { node?: string; edge?: number }) => void;

const SESSION_PASS = new Set(["same-session", "read-prior-session", "fork"]);
const PASS_WORDS = new Set(["pass", "passed", "ok", "green", "ship", "approve", "approved", "clean"]);
const PASS_BOOL_KEYS = ["ok", "passed", "confirmed", "all_met", "intent_aligned"] as const;
const CHECK_ID_RE = /(?:^|[-_])(review|audit|qa|tests|verify|critic|readiness)(?:[-_]|$)/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a specialist/agent role acts as an independent judge (one whose session must stay separate from workers). */
export function isJudgeRole(role: string): boolean {
  const row = roleRowOf(role);
  return row === "code-critic" || Object.prototype.hasOwnProperty.call(AUTHOR_ROWS, row);
}

function isCheckNode(node: GraphNode): boolean {
  if (node.type === "agent" && isJudgeRole(node.role)) return true;
  if (node.type === "subworkflow") return /(?:review|audit|qa|tests|verify|critic)/i.test(node.workflow);
  if (CHECK_ID_RE.test(node.id)) return true;
  return node.out.some(
    (field) =>
      (field.name === "status" || field.name === "disposition" || field.name === "verdict") &&
      field.type === "enum" &&
      Boolean(field.values?.some((value) => PASS_WORDS.has(value))),
  );
}

function sampleFieldValue(field: Field): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean": return false;
    case "number": return 0;
    case "string": return "";
    case "enum": return field.values?.[0] ?? "";
    case "array": return [];
    default: return {};
  }
}

function sampleEvalEnv(workflow: Workflow, nodeId: string, nodeOutput: Record<string, unknown>): EvalEnv {
  const inputs = Object.fromEntries(workflow.inputs.map((field) => [field.name, sampleFieldValue(field)]));
  return {
    visits: () => 1,
    read: (ref: Ref) => {
      if (ref.kind === "input") {
        const key = ref.path[0];
        return key !== undefined && key in inputs ? { ran: true, value: inputs[key] } : { ran: false, value: undefined };
      }
      if (ref.kind === "mode") return { ran: true, value: workflow.quality_mode?.default ?? "standard" };
      if (ref.kind === "node" && ref.node === nodeId) {
        let cur: unknown = nodeOutput;
        for (const part of ref.path) {
          if (cur === null || cur === undefined || typeof cur !== "object") return { ran: true, value: undefined };
          cur = (cur as Record<string, unknown>)[part];
        }
        return { ran: true, value: cur };
      }
      return { ran: false, value: undefined };
    },
  };
}

function hasTimeoutRoute(
  workflow: Workflow,
  nodeId: string,
  timeoutOutput: Record<string, unknown>,
  outgoing: readonly WorkflowEdge[],
): boolean {
  if (outgoing.length === 0) return false;
  const env = sampleEvalEnv(workflow, nodeId, timeoutOutput);
  for (const edge of outgoing) {
    if (!edge.when) return true;
    try {
      if (evalCondition(toExpr(edge.when, nodeId), env)) return true;
    } catch {
      // Conditions with malformed expressions are reported by validate.ts itself; treat as non-matching here.
    }
  }
  return false;
}

function validateWaitNode(
  workflow: Workflow,
  node: GraphNode,
  incoming: readonly WorkflowEdge[],
  outgoing: readonly WorkflowEdge[],
  error: ReportProblem,
): void {
  const key = executorKey(node);
  if (key === "builtin:wait") {
    const params = node.type === "action" && isRecord(node.params) ? node.params : undefined;
    const hasDeadline =
      node.timeoutSec !== undefined ||
      (params !== undefined && (params.until !== undefined || params.durationSec !== undefined)) ||
      incoming.some((edge) => isRecord(edge.with) && ("until" in edge.with || "durationSec" in edge.with));
    if (!hasDeadline) {
      error("wait_no_deadline", `${node.id}: builtin:wait needs until, durationSec, or timeoutSec`, { node: node.id });
    }
    const timeoutOut = { ...(params && isRecord(params.timeoutOutput) ? params.timeoutOutput : {}), woke: "timeout" };
    if (!hasTimeoutRoute(workflow, node.id, timeoutOut, outgoing)) {
      error("wait_no_timeout_edge", `${node.id}: waiting node has no outgoing edge accepting its timeout output`, { node: node.id });
    }
    return;
  }

  if (node.type === "human") {
    const timeoutOutcome = humanTimeoutOutcome(node);
    if ("output" in timeoutOutcome && !hasTimeoutRoute(workflow, node.id, timeoutOutcome.output, outgoing)) {
      error("wait_no_timeout_edge", `${node.id}: human wait has no outgoing edge accepting its timeout output`, { node: node.id });
    }
    return;
  }

  if (node.type === "lp-task") {
    const timeoutOut = { status: "blocked", outcome: "blocked", handoff: "lp-task timeout" };
    if (!hasTimeoutRoute(workflow, node.id, timeoutOut, outgoing)) {
      error("wait_no_timeout_edge", `${node.id}: lp-task wait has no outgoing edge accepting its timeout output`, { node: node.id });
    }
  }
}

function validateSkipOut(node: GraphNode, error: ReportProblem): void {
  if (!isCheckNode(node) || !isRecord(node.skip_out)) return;
  const skipOut = node.skip_out;
  for (const field of ["status", "disposition", "verdict"] as const) {
    const value = skipOut[field];
    if (typeof value === "string" && PASS_WORDS.has(value)) {
      error("check_skip_pass", `${node.id}: skipped check node outputs ${field}="${value}", must output "not_run"`, { node: node.id });
      return;
    }
  }
  for (const field of PASS_BOOL_KEYS) {
    if (skipOut[field] === true) {
      error("check_skip_pass", `${node.id}: skipped check node outputs ${field}=true, must output status "not_run"`, { node: node.id });
      return;
    }
  }
  const hasStatusField = node.out.some((field) => field.name === "status" || field.name === "disposition" || field.name === "verdict")
    || "status" in skipOut || "disposition" in skipOut || "verdict" in skipOut;
  if (hasStatusField && skipOut.status !== "not_run" && skipOut.disposition !== "not_run" && skipOut.verdict !== "not_run") {
    error("check_skip_not_run", `${node.id}: skipped check node must output "not_run"`, { node: node.id });
  }
}

/** Validates wait deadlines/timeout edges, check skip outputs, and judge session isolation on a lowered workflow. */
export function validateWorkflowRails(
  workflow: Workflow,
  byId: Map<string, GraphNode>,
  error: ReportProblem,
): void {
  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const node of byId.keys()) {
    incoming.set(node, []);
    outgoing.set(node, []);
  }
  for (let index = 0; index < workflow.edges.length; index += 1) {
    const edge = workflow.edges[index]!;
    incoming.get(edge.to)?.push(edge);
    outgoing.get(edge.from)?.push(edge);
    if (edge.from === START || !edge.pass || !SESSION_PASS.has(edge.pass)) continue;
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (target?.type === "agent" && isJudgeRole(target.role) && source?.type === "agent" && !isJudgeRole(source.role)) {
      error(
        "judge_reads_worker_session",
        `${target.id}: judge node (${target.role}) may not take ${source.id}'s session as input (pass="${edge.pass}")`,
        { node: target.id, edge: index },
      );
    }
  }
  for (const node of byId.values()) {
    validateWaitNode(workflow, node, incoming.get(node.id) ?? [], outgoing.get(node.id) ?? [], error);
    validateSkipOut(node, error);
  }
}
