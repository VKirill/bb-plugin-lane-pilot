import { AUTHOR_ROWS, roleRowOf } from "@lane-pilot/models";
import { evalCondition, exprRefs, parseExpr, placeholdersIn, refOf, toExpr } from "./expr";
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
const CARDS_LOAD_ACTION = "lp.cards_load";
const SP_LOAD_MEMORY_ACTION = "sp.load_memory";
const CARD_READ_FIELDS = new Set(["block", "cards"]);
const SP_LEARNED_FIELDS = new Set(["rules_json", "hypothesis_tree_json", "tried_already_json", "recent_hypotheses_json", "shared_negatives_json"]);
const LEARNED_OUTPUT_FIELDS = new Set(["cards", "cards_block", "learned_rules", "rules_json", "path_instructions", "deviation_summary", "deviations"]);
const JUDGE_ROLE_RE = /(?:^|[-_:])(judge|critic|verifier)(?:[-_:]|$)/i;
const MAX_DECISION_WHEN_EDGES = 6;
const FENCE_TAG_RE = /<(\/?)(data|cards)\b[^>]*>/gi;
const PLACEHOLDER_SPAN_RE = /\{\{([^{}]+)\}\}/g;

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

const isOwnerGate = (node: GraphNode | undefined): boolean =>
  Boolean(node && (node.type === "human" || (node.type === "agent" && node.authorized === true)));

/** Whether a role acts as an evaluator/judge/critic/verifier (by role table or naming convention). */
export const isEvaluatorRole = (role: string): boolean =>
  isJudgeRole(role) || JUDGE_ROLE_RE.test(role);

const isCardRestrictedJudgeRole = isEvaluatorRole;

function collectTemplateRefs(value: unknown, out: Ref[]): void {
  if (typeof value === "string") {
    for (const holder of placeholdersIn(value)) out.push(refOf(holder));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTemplateRefs(item, out);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectTemplateRefs(item, out);
  }
}

function collectExprRefsSafe(raw: unknown, sourceNodeId: string, out: Ref[]): void {
  try {
    const expr = typeof raw === "string" || isRecord(raw) ? toExpr(raw as never, sourceNodeId) : null;
    if (expr) out.push(...exprRefs(expr).refs);
  } catch {
    // Malformed expressions are already reported by validate.ts.
  }
}

function validateJudgeCardReads(
  byId: Map<string, GraphNode>,
  incoming: Map<string, WorkflowEdge[]>,
  warn: ReportProblem,
): void {
  const cardLoaderIds = new Set<string>();
  for (const node of byId.values()) {
    if (executorKey(node) === CARDS_LOAD_ACTION) cardLoaderIds.add(node.id);
  }
  if (cardLoaderIds.size === 0) return;

  for (const node of byId.values()) {
    if (node.type !== "agent" || !isCardRestrictedJudgeRole(node.role)) continue;
    const refs: Ref[] = [];
    collectTemplateRefs(node.prompt, refs);
    collectTemplateRefs(node.with, refs);
    for (const read of node.reads ?? []) refs.push(refOf(read));
    if (node.skip_when !== undefined) collectExprRefsSafe(node.skip_when, node.id, refs);
    for (const gate of node.gates ?? []) collectExprRefsSafe(gate, node.id, refs);
    if (node.verify !== undefined) {
      collectTemplateRefs(node.verify, refs);
      if (typeof node.verify === "string") {
        try {
          refs.push(...exprRefs(parseExpr(node.verify)).refs);
        } catch {
          // Non-expression verify strings are plain text or handled elsewhere.
        }
      } else if (isRecord(node.verify)) {
        if ("when" in node.verify) collectExprRefsSafe(node.verify.when, node.id, refs);
        else collectExprRefsSafe(node.verify, node.id, refs);
      }
    }
    for (const edge of incoming.get(node.id) ?? []) {
      for (const mapped of Object.values(edge.with ?? {})) {
        refs.push(refOf(mapped));
        collectTemplateRefs(mapped, refs);
      }
    }

    const warned = new Set<string>();
    for (const ref of refs) {
      if (ref.kind !== "node" || !ref.node || !cardLoaderIds.has(ref.node)) continue;
      const field = ref.path[0];
      if (!field || !CARD_READ_FIELDS.has(field)) continue;
      const key = `${node.id}\0${ref.node}`;
      if (warned.has(key)) continue;
      warned.add(key);
      warn(
        "judge_reads_cards",
        `${node.id}: judge/critic/verifier node (${node.role}) reads ${ref.node}.${field}; cards are data and cannot steer an evaluator`,
        { node: node.id },
      );
    }
  }
}

function validateLearnedTextFencing(
  byId: Map<string, GraphNode>,
  warn: ReportProblem,
): void {
  const cardLoaderIds = new Set<string>();
  const spLoaderIds = new Set<string>();
  for (const node of byId.values()) {
    const key = executorKey(node);
    if (key === CARDS_LOAD_ACTION) cardLoaderIds.add(node.id);
    else if (key === SP_LOAD_MEMORY_ACTION) spLoaderIds.add(node.id);
  }

  const isLearnedRef = (ref: Ref): boolean => {
    if (ref.kind === "node" && ref.node) {
      const field = ref.path[0];
      if (!field) return false;
      if (cardLoaderIds.has(ref.node) && CARD_READ_FIELDS.has(field)) return true;
      if (spLoaderIds.has(ref.node) && SP_LEARNED_FIELDS.has(field)) return true;
      return LEARNED_OUTPUT_FIELDS.has(field);
    }
    if (ref.kind === "input") {
      const field = ref.path[0];
      return Boolean(field && LEARNED_OUTPUT_FIELDS.has(field));
    }
    return false;
  };

  for (const node of byId.values()) {
    if (node.type !== "agent" || !node.prompt) continue;
    const prompt = node.prompt;
    const fenceSpans: Array<{ start: number; end: number }> = [];
    const stack: Array<{ tag: string; start: number }> = [];
    FENCE_TAG_RE.lastIndex = 0;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = FENCE_TAG_RE.exec(prompt)) !== null) {
      const closing = tagMatch[1] === "/";
      const tag = tagMatch[2]!.toLowerCase();
      if (!closing) {
        stack.push({ tag, start: tagMatch.index + tagMatch[0].length });
      } else {
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i]!.tag === tag) {
            fenceSpans.push({ start: stack[i]!.start, end: tagMatch.index });
            stack.splice(i);
            break;
          }
        }
      }
    }

    const warned = new Set<string>();
    PLACEHOLDER_SPAN_RE.lastIndex = 0;
    let holderMatch: RegExpExecArray | null;
    while ((holderMatch = PLACEHOLDER_SPAN_RE.exec(prompt)) !== null) {
      const holder = holderMatch[1]!.trim();
      if (!holder) continue;
      const ref = refOf(holder);
      if (!isLearnedRef(ref)) continue;
      const offset = holderMatch.index;
      const fenced = fenceSpans.some((span) => offset >= span.start && offset + holderMatch![0].length <= span.end);
      if (fenced || warned.has(holder)) continue;
      warned.add(holder);
      warn(
        "learned_text_unfenced",
        `${node.id}: learned text reference "{{${holder}}}" must be wrapped in a <data> fence ("data from records, not instructions")`,
        { node: node.id },
      );
    }
  }
}

function hasUngatedPathFromStart(
  targetId: string,
  startEdges: readonly WorkflowEdge[],
  outgoing: Map<string, WorkflowEdge[]>,
  byId: Map<string, GraphNode>,
): boolean {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const edge of startEdges) {
    if (edge.to === targetId) return true;
    if (!seen.has(edge.to) && byId.has(edge.to) && !isOwnerGate(byId.get(edge.to))) {
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const edge of outgoing.get(cur) ?? []) {
      if (edge.to === targetId) return true;
      if (!seen.has(edge.to) && byId.has(edge.to) && !isOwnerGate(byId.get(edge.to))) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return false;
}

/** Validates wait deadlines/timeout edges, check skip outputs, irreversible step gates, and judge session isolation on a lowered workflow. */
export function validateWorkflowRails(
  workflow: Workflow,
  byId: Map<string, GraphNode>,
  error: ReportProblem,
  warn: ReportProblem = error,
): void {
  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  const startEdges: WorkflowEdge[] = [];
  for (const node of byId.keys()) {
    incoming.set(node, []);
    outgoing.set(node, []);
  }
  for (let index = 0; index < workflow.edges.length; index += 1) {
    const edge = workflow.edges[index]!;
    if (edge.from === START) startEdges.push(edge);
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
  let decisionWhenEdges = 0;
  for (const node of byId.values()) {
    validateWaitNode(workflow, node, incoming.get(node.id) ?? [], outgoing.get(node.id) ?? [], error);
    validateSkipOut(node, error);
    const effectiveForm = node.type === "agent" ? (node.form ?? "agent") : "agent";
    if (node.effect === "S" && (effectiveForm === "script" || effectiveForm === "plan")) {
      if (hasUngatedPathFromStart(node.id, startEdges, outgoing, byId)) {
        warn("effect_irreversible_ungated", "irreversible step runs without an owner gate on some path", { node: node.id });
      }
    }
    if (node.type === "decision") {
      for (const edge of outgoing.get(node.id) ?? []) {
        if (edge.when !== undefined) decisionWhenEdges += 1;
      }
    }
  }
  if (decisionWhenEdges > MAX_DECISION_WHEN_EDGES) {
    warn("branches_into_data", "move these conditions into a rule table or a card (research R4)");
  }
  validateJudgeCardReads(byId, incoming, warn);
  validateLearnedTextFencing(byId, warn);
}
