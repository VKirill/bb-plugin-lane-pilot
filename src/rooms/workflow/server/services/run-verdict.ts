import {
  isOwnerRefusalReason,
  isRunVerdict,
  type OwnerRefusalReason,
  type RunVerdict,
} from "@lane-pilot/contracts";
import {
  TERMINAL_RUN,
  exprRefs,
  toExpr,
  valueSpecOf,
  wfRunRow,
  wfStepsOfRun,
  type Expr,
  type GraphNode,
  type Ref,
  type RunRow,
  type Workflow,
  type WorkflowEdge,
} from "@lane-pilot/workflow-engine";
import {
  getRunVerdict,
  setRunVerdict,
  type RunVerdictDb,
  type RunVerdictRow,
} from "../repositories/run-verdict-repository";
import { TEXT_KINDS } from "./workflow-human-form";

export type RunVerdictLogSink = {
  info?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
  debug?: ((message: string) => void) | undefined;
};

type VerdictWriteDb = RunVerdictDb & Parameters<typeof wfRunRow>[0] & Parameters<typeof wfStepsOfRun>[0];

const LITERAL_APPROVE_SET = new Set(["approve", "send", "yes"]);
const LITERAL_REJECT_SET = new Set(["abort", "no", "reject", "rework"]);
const NON_DECISION_KINDS = new Set<string>([
  "timeout", "none", "skipped", "not_run",
  ...TEXT_KINDS,
]);

export type RecordOwnerRunVerdictInput = {
  runId: string;
  verdict: string;
  reason?: string | null | undefined;
  note?: string | null | undefined;
  projectId?: string | null | undefined;
  now?: number | undefined;
};

export type RecordOwnerRunVerdictResult =
  | { ok: true; row: RunVerdictRow }
  | { ok: false; reason: string };

/**
 * Validates and persists an explicit owner verdict (`source = "owner"`) on a finished workflow run.
 * Logs `INFO run verdict ...` on write and `WARN run verdict refused ...` on refusal; note text is never logged.
 */
export function recordOwnerRunVerdict(
  db: VerdictWriteDb,
  input: RecordOwnerRunVerdictInput,
  log?: RunVerdictLogSink,
): RecordOwnerRunVerdictResult {
  const runId = input.runId.trim();
  const refuse = (reason: string): RecordOwnerRunVerdictResult => {
    log?.warn?.(`run verdict refused run=${runId || "unknown"}: ${reason}`);
    return { ok: false, reason };
  };

  if (!runId) return refuse("missing runId");
  if (!isRunVerdict(input.verdict)) return refuse(`invalid verdict "${input.verdict}"`);

  const rawReason = typeof input.reason === "string" ? input.reason.trim() : "";
  let parsedReason: OwnerRefusalReason | null = null;
  if (rawReason) {
    if (!isOwnerRefusalReason(rawReason)) return refuse(`unknown reason "${rawReason}"`);
    parsedReason = rawReason;
  }

  const run = wfRunRow(db, runId);
  if (!run) return refuse("unknown run");
  if (input.projectId && run.project_id !== input.projectId) return refuse("run belongs to another project");
  if (!TERMINAL_RUN.includes(run.status)) return refuse(`run not finished (${run.status})`);

  setRunVerdict(db, {
    runId: run.id,
    workflowId: run.workflow_id,
    graphVersion: run.workflow_version,
    verdict: input.verdict,
    source: "owner",
    reason: parsedReason,
    note: input.note,
    decidedAt: input.now ?? Date.now(),
  });
  log?.info?.(`run verdict run=${run.id} verdict=${input.verdict} source=owner reason=${parsedReason ?? "none"}`);
  const row = getRunVerdict(db, run.id)!;
  return { ok: true, row };
}

type EvalVal = { known: true; value: unknown } | { known: false };

const truthy = (value: unknown): boolean => (Array.isArray(value) ? true : Boolean(value));
const blank = (v: unknown): boolean => v === undefined || v === null || v === "";
const same = (a: unknown, b: unknown): boolean =>
  a === b || (blank(a) && blank(b)) || (a !== null && b !== null && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

function readInputPath(inputs: Record<string, unknown>, path: readonly string[]): EvalVal {
  if (!path.length) return { known: true, value: inputs };
  let cur: unknown = inputs;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return { known: false };
    if (!(key in (cur as Record<string, unknown>))) return { known: false };
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur === undefined ? { known: false } : { known: true, value: cur };
}

function evalExprForOption(expr: Expr, humanNodeId: string, option: string, inputs: Record<string, unknown>): EvalVal {
  switch (expr.t) {
    case "lit": return { known: true, value: expr.v };
    case "visits": return { known: true, value: 0 };
    case "list": {
      const items = expr.items.map((item) => evalExprForOption(item, humanNodeId, option, inputs));
      return items.every((item) => item.known)
        ? { known: true, value: items.map((item) => (item as { known: true; value: unknown }).value) }
        : { known: false };
    }
    case "ref": {
      const ref: Ref = expr.ref;
      if (ref.kind === "node" && ref.node === humanNodeId && ref.path[0] === "answer_kind" && ref.path.length === 1) {
        return { known: true, value: option };
      }
      if (ref.kind === "input") return readInputPath(inputs, ref.path);
      return { known: false };
    }
    case "not": {
      const inner = evalExprForOption(expr.e, humanNodeId, option, inputs);
      return inner.known ? { known: true, value: !truthy(inner.value) } : { known: false };
    }
    case "bin": {
      if (expr.op === "&&") {
        const l = evalExprForOption(expr.l, humanNodeId, option, inputs);
        if (l.known && !truthy(l.value)) return { known: true, value: false };
        const r = evalExprForOption(expr.r, humanNodeId, option, inputs);
        if (r.known && !truthy(r.value)) return { known: true, value: false };
        if (l.known && r.known) return { known: true, value: truthy(l.value) && truthy(r.value) };
        return { known: false };
      }
      if (expr.op === "||") {
        const l = evalExprForOption(expr.l, humanNodeId, option, inputs);
        if (l.known && truthy(l.value)) return { known: true, value: true };
        const r = evalExprForOption(expr.r, humanNodeId, option, inputs);
        if (r.known && truthy(r.value)) return { known: true, value: true };
        if (l.known && r.known) return { known: true, value: truthy(l.value) || truthy(r.value) };
        return { known: false };
      }
      const l = evalExprForOption(expr.l, humanNodeId, option, inputs);
      const r = evalExprForOption(expr.r, humanNodeId, option, inputs);
      if (!l.known || !r.known) return { known: false };
      switch (expr.op) {
        case "==": return { known: true, value: same(l.value, r.value) };
        case "!=": return { known: true, value: !same(l.value, r.value) };
        case "in": return { known: true, value: Array.isArray(r.value) && r.value.some((item) => same(item, l.value)) };
        case "+": return typeof l.value === "number" && typeof r.value === "number" ? { known: true, value: l.value + r.value } : { known: false };
        case "-": return typeof l.value === "number" && typeof r.value === "number" ? { known: true, value: l.value - r.value } : { known: false };
        case "<": return typeof l.value === "number" && typeof r.value === "number" ? { known: true, value: l.value < r.value } : { known: false };
        case "<=": return typeof l.value === "number" && typeof r.value === "number" ? { known: true, value: l.value <= r.value } : { known: false };
        case ">": return typeof l.value === "number" && typeof r.value === "number" ? { known: true, value: l.value > r.value } : { known: false };
        case ">=": return typeof l.value === "number" && typeof r.value === "number" ? { known: true, value: l.value >= r.value } : { known: false };
      }
    }
  }
}

function findLiveSuccessNodes(workflow: Workflow): Set<string> {
  const rule = workflow.live_success;
  if (!rule) return new Set();
  const field = rule.output || "status";
  const targets = new Set(rule.in);
  const out = new Set<string>();
  let hasEmit = false;
  for (const node of workflow.nodes) {
    if (node.type === "action" && node.action === "emit") {
      hasEmit = true;
      const map = typeof node.map === "object" && node.map !== null ? node.map : null;
      if (!map) continue;
      const spec = valueSpecOf(map[field]);
      if ("literal" in spec && targets.has(String(spec.literal))) out.add(node.id);
    }
  }
  if (hasEmit) return out;
  for (const node of workflow.nodes) {
    if (node.type === "note") continue;
    const outField = node.out.find((f) => f.name === field);
    if (outField?.values?.some((v) => targets.has(v))) {
      const toEnd = workflow.edges.some((e) => e.from === node.id && e.to === "end");
      if (toEnd) out.add(node.id);
    }
  }
  return out;
}

function reachesTarget(edges: readonly WorkflowEdge[], startId: string, blockedId: string, targets: ReadonlySet<string>): boolean {
  if (targets.has(startId)) return true;
  const visited = new Set<string>([blockedId]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === blockedId || visited.has(cur)) continue;
    if (targets.has(cur)) return true;
    visited.add(cur);
    for (const edge of edges) {
      if (edge.from === cur && !visited.has(edge.to)) queue.push(edge.to);
    }
  }
  return false;
}

function edgeReferencesAnswerKind(edge: WorkflowEdge, humanNodeId: string): boolean {
  if (!edge.when) return false;
  try {
    const refs = exprRefs(toExpr(edge.when, humanNodeId)).refs;
    return refs.some((ref) => ref.kind === "node" && ref.node === humanNodeId && ref.path[0] === "answer_kind");
  } catch {
    return false;
  }
}

function approveSetForHumanNode(
  workflow: Workflow,
  humanNode: Extract<GraphNode, { type: "human" }>,
  inputs: Record<string, unknown>,
): Set<string> {
  const liveTargets = findLiveSuccessNodes(workflow);
  const outEdges = workflow.edges.filter((edge) => edge.from === humanNode.id);
  if (liveTargets.size === 0 || !outEdges.some((edge) => edgeReferencesAnswerKind(edge, humanNode.id))) {
    return new Set(LITERAL_APPROVE_SET);
  }

  const kindValues = humanNode.out.find((field) => field.name === "answer_kind")?.values ?? [];
  const options = [...new Set([...kindValues, ...(humanNode.options ?? [])])]
    .filter((opt) => !NON_DECISION_KINDS.has(opt) && !LITERAL_REJECT_SET.has(opt) && opt !== "decline");

  const effectiveInputs: Record<string, unknown> = { ...inputs };
  for (const field of workflow.inputs) {
    if (effectiveInputs[field.name] === undefined && field.default !== undefined) {
      effectiveInputs[field.name] = field.default;
    }
  }

  const approved = new Set<string>();
  const conditional = outEdges.filter((edge) => edge.when !== undefined);
  const fallback = outEdges.find((edge) => edge.when === undefined);

  for (const opt of options) {
    const candidates: WorkflowEdge[] = [];
    let definiteMatch = false;
    for (const edge of conditional) {
      try {
        const res = evalExprForOption(toExpr(edge.when!, humanNode.id), humanNode.id, opt, effectiveInputs);
        if (res.known && truthy(res.value)) {
          candidates.push(edge);
          definiteMatch = true;
          break;
        }
        if (!res.known) candidates.push(edge);
      } catch {
        candidates.push(edge);
      }
    }
    if (!definiteMatch && fallback) candidates.push(fallback);
    if (candidates.some((edge) => reachesTarget(workflow.edges, edge.to, humanNode.id, liveTargets))) {
      approved.add(opt);
    }
  }
  return approved;
}

/**
 * Derives an implicit verdict (`source = "human_node"`) from a finished top-level run's human steps.
 * Never overrides an existing `owner` verdict; leaves unreviewed runs without a row.
 */
export function deriveRunVerdict(
  db: VerdictWriteDb,
  run: Pick<RunRow, "id" | "workflow_id" | "workflow_version" | "status" | "parent_run_id" | "definition_json" | "inputs_json">,
  now = Date.now(),
  log?: RunVerdictLogSink,
): RunVerdict | null {
  try {
    if (!run || run.parent_run_id || !TERMINAL_RUN.includes(run.status)) return null;
    let workflow: Workflow | null = null;
    try {
      const parsed = JSON.parse(run.definition_json) as Workflow | null;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        workflow = parsed;
      }
    } catch {
      workflow = null;
    }
    if (!workflow) return null;

    let inputs: Record<string, unknown> = {};
    try {
      const parsedInputs = JSON.parse(run.inputs_json || "{}") as unknown;
      if (parsedInputs && typeof parsedInputs === "object" && !Array.isArray(parsedInputs)) {
        inputs = parsedInputs as Record<string, unknown>;
      }
    } catch {
      inputs = {};
    }

    const humanNodes = new Map<string, Extract<GraphNode, { type: "human" }>>();
    for (const node of workflow.nodes) {
      if (node.type === "human") humanNodes.set(node.id, node);
    }
    if (humanNodes.size === 0) return null;

    const steps = wfStepsOfRun(db, run.id);
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i]!;
      if (step.state !== "succeeded") continue;
      const nodeId = typeof step.node_id === "string" ? step.node_id : "";
      const humanNode = humanNodes.get(nodeId);
      if (!humanNode) continue;

      let answerKind: string | null = null;
      if (typeof step.output_json === "string" && step.output_json.trim()) {
        try {
          const out = JSON.parse(step.output_json) as Record<string, unknown> | null;
          if (out && typeof out.answer_kind === "string" && out.answer_kind.trim()) {
            answerKind = out.answer_kind.trim();
          }
        } catch {
          answerKind = null;
        }
      }
      if (!answerKind || NON_DECISION_KINDS.has(answerKind)) continue;

      let verdict: RunVerdict | null = null;
      if (LITERAL_REJECT_SET.has(answerKind)) {
        verdict = "reject";
      } else {
        const approveSet = approveSetForHumanNode(workflow, humanNode, inputs);
        if (approveSet.has(answerKind)) verdict = "accept";
      }
      if (!verdict) continue;

      const { written } = setRunVerdict(db, {
        runId: run.id,
        workflowId: run.workflow_id,
        graphVersion: run.workflow_version,
        verdict,
        source: "human_node",
        reason: null,
        note: null,
        decidedAt: now,
      });
      if (written) {
        log?.info?.(`run verdict run=${run.id} verdict=${verdict} source=human_node reason=none`);
      }
      return verdict;
    }
    return null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`run verdict derivation failed run=${run?.id ?? "unknown"}: ${message}`);
    return null;
  }
}
