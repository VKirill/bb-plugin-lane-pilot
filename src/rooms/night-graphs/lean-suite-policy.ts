import { redactKnown } from "@lane-pilot/kit";
import { placeholdersIn, refOf, valueSpecOf } from "@lane-pilot/workflow-engine";
import type { ProcessBlueprint, ProcessBlueprintGraphSpec } from "./process-blueprint";

export const MAX_PHASE_GRAPH_EXECUTABLE_NODES = 7;
export const MAX_PHASE_GRAPH_HUMAN_GATES = 2;
export const OPTIONAL_FEATURE_INPUTS = [
  "legacy_domain",
  "content_factory_endpoint",
  "identity_profile",
  "semantic_core_artifact",
] as const;

const NARROW_PREFIXES = ["cms/", "src/collections/", "payload", "strapi/", "wp-content/", "sanity/", "directus/", "migrations/", "src/app/api/ingest/"] as const;
const OPTIONAL_STAGE_ID_RE = /^(?:legacy[_-]?import|ingest[_-]?api|brand[_-]?imagery|imagery)$/i;
const LOG_RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const;

export type LeanPolicyViolationCode =
  | "node_budget_exceeded"
  | "human_gate_budget_exceeded"
  | "human_gate_not_skippable"
  | "optional_stage_not_skippable"
  | "bypassed_producer_without_skip_out"
  | "invalid_skip_out_literal"
  | "narrow_framework_owns_paths"
  | "missing_scope_tier"
  | "missing_variant_lean_test"
  | "missing_chat_routing_metadata"
  | "missing_or_invalid_process_state_checkpoint";

export type LeanPolicyViolation = {
  readonly workflowId: string;
  readonly code: LeanPolicyViolationCode;
  readonly nodeId?: string;
  readonly detail: string;
};
export type LeanSuitePolicyOptions = {
  readonly blueprint?: ProcessBlueprint | null;
  readonly log?: (message: string) => void;
  readonly logLevel?: "debug" | "info" | "warn" | "error" | "silent";
};
export type LeanSuitePolicyVerdict = { readonly ok: boolean; readonly violations: LeanPolicyViolation[] };
type FieldMeta = { type?: string; values?: string[]; default?: unknown; required?: boolean };

const asRec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asRecs = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(asRec(x))) : []);
const asStrs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isControlAction = (n: Record<string, unknown>) => n.type === "action" && (n.action === "emit" || n.action === "lp.save_process_state");
const isWorkNode = (n: Record<string, unknown>) => n.type !== "note" && !isControlAction(n);

function emitLog(log: LeanSuitePolicyOptions["log"], level: "debug" | "warn", event: string, payload: Record<string, unknown>, override?: LeanSuitePolicyOptions["logLevel"]): void {
  if (!log) return;
  const envRaw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL?.trim().toLowerCase() as LeanSuitePolicyOptions["logLevel"];
  const effective = override ?? (envRaw && envRaw in LOG_RANK ? envRaw : "debug");
  if (LOG_RANK[level] < LOG_RANK[effective]) return;
  log(`${level.toUpperCase()} [nightGraphs.leanPolicy] ${event} ${redactKnown(JSON.stringify(payload))}`);
}

function parseFieldSpec(spec: unknown): FieldMeta {
  const rec = asRec(spec);
  const rawType = typeof spec === "string" ? spec : typeof rec?.type === "string" ? rec.type : undefined;
  const trimmed = rawType?.trim();
  const optional = trimmed?.endsWith("?") ?? false;
  const clean = optional ? trimmed!.slice(0, -1).trim() : trimmed;
  const parts = clean?.includes("|") ? clean.split("|").map((p) => p.trim()).filter(Boolean) : null;
  const values = asStrs(rec?.values);
  return {
    type: clean,
    values: values.length ? values : parts?.length ? parts.filter((p) => p !== "null") : undefined,
    default: rec?.default,
    required: typeof rec?.required === "boolean" ? rec.required : optional || rec?.default !== undefined ? false : undefined,
  };
}

function getFieldMap(raw: unknown): Map<string, FieldMeta> {
  const out = new Map<string, FieldMeta>();
  if (Array.isArray(raw)) {
    for (const item of asRecs(raw)) if (typeof item.name === "string" && item.name.trim()) out.set(item.name.trim(), parseFieldSpec(item));
  } else if (asRec(raw)) {
    for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) if (name.trim()) out.set(name.trim(), parseFieldSpec(spec));
  }
  return out;
}

function collectStringsFromKeys(node: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (asRec(v)) Object.values(v as Record<string, unknown>).forEach(walk);
  };
  for (const k of keys) if (k in node) walk(node[k]);
  return out;
}

function whenAllowsSkip(when: unknown): boolean {
  if (when === undefined || when === null) return true;
  if (typeof when === "string") {
    if (/\bskip\b/.test(when) && !/!=\s*['"]?skip['"]?/.test(when)) return true;
    return /!=\s*['"](?:rework|abort|reject|cancel|no)['"]/.test(when) && !/==\s*['"]approve['"]/.test(when);
  }
  const rec = asRec(when);
  if (!rec) return false;
  if (Array.isArray(rec.any)) return rec.any.some(whenAllowsSkip);
  if (Array.isArray(rec.all)) return rec.all.every(whenAllowsSkip);
  if (rec.op === "eq") return rec.value === "skip";
  if (rec.op === "in" && Array.isArray(rec.value)) return rec.value.includes("skip");
  return rec.op === "ne" && rec.value !== "skip" && typeof rec.value === "string";
}

function buildGraphContext(def: Record<string, unknown>) {
  const nodes = asRecs(def.nodes), nodeIds = new Set(nodes.map((n) => String(n.id ?? "")).filter(Boolean));
  const edges = asRecs(def.edges).map((e) => ({
    from: (e.from === "$start" || e.from === "start") && !nodeIds.has("start") ? "$start" : String(e.from ?? ""),
    to: (e.to === "$end" || e.to === "end") && !nodeIds.has("end") ? "$end" : String(e.to ?? ""),
    when: e.when,
  }));
  const adj = new Map<string, string[]>();
  for (const e of edges) { const list = adj.get(e.from) ?? []; list.push(e.to); adj.set(e.from, list); }
  const entry = typeof def.entry === "string" && def.entry.trim() ? def.entry.trim() : edges.find((e) => e.from === "$start")?.to ?? String(nodes[0]?.id ?? "");
  const canReachWithout = (startNode: string, targetNode: string, excludedNode: string): boolean => {
    if (!startNode || startNode === excludedNode) return false;
    if (startNode === targetNode) return true;
    const seen = new Set([startNode]), queue = [startNode];
    while (queue.length > 0) {
      for (const next of adj.get(queue.shift()!) ?? []) {
        if (next === excludedNode || seen.has(next)) continue;
        if (next === targetNode) return true;
        seen.add(next); queue.push(next);
      }
    }
    return false;
  };
  return { nodes, nodeIds, edges, adj, entry, canReachWithout };
}

/** Validates candidate workflows against self-regulating lean complexity, skippability, routing, and checkpoint rules. */
export function validateLeanSuitePolicy(
  candidates: ReadonlyArray<{ workflowId: string; scope?: "global" | "project"; definition: Record<string, unknown> }>,
  options?: LeanSuitePolicyOptions,
): LeanSuitePolicyVerdict {
  const violations: LeanPolicyViolation[] = [];
  const candidateIds = new Set(candidates.map((c) => c.workflowId.trim()).filter(Boolean));
  const inputsByWf = new Map(candidates.map((c) => [c.workflowId, getFieldMap(c.definition.inputs)]));
  const bpById = new Map<string, ProcessBlueprintGraphSpec>((options?.blueprint?.graphs ?? []).map((g) => [g.workflowId, g]));

  for (const candidate of candidates) {
    const wfId = candidate.workflowId, def = candidate.definition, bpGraph = bpById.get(wfId);
    const { nodes, nodeIds, edges, adj, entry, canReachWithout } = buildGraphContext(def);
    const inputs = inputsByWf.get(wfId)!;
    const push = (code: LeanPolicyViolationCode, detail: string, nodeId?: string) => {
      violations.push({ workflowId: wfId, code, ...(nodeId ? { nodeId } : {}), detail });
      emitLog(options?.log, "warn", "violation", { workflowId: wfId, code, ...(nodeId ? { nodeId } : {}), detail }, options?.logLevel);
    };

    const subRefsInSuite = nodes.filter((n) => n.type === "subworkflow" && typeof n.workflow === "string" && candidateIds.has(n.workflow));
    const isMaster = bpGraph?.kind === "master_orchestrator" || subRefsInSuite.length >= 2 || wfId.endsWith("-suite");
    const workNodes = nodes.filter(isWorkNode), humanNodes = nodes.filter((n) => n.type === "human");

    if (!isMaster && workNodes.length > MAX_PHASE_GRAPH_EXECUTABLE_NODES) {
      push("node_budget_exceeded", `phase_graph has ${workNodes.length} executable nodes (max ${MAX_PHASE_GRAPH_EXECUTABLE_NODES})`);
    }
    if (!isMaster && humanNodes.length > MAX_PHASE_GRAPH_HUMAN_GATES) {
      push("human_gate_budget_exceeded", `phase_graph has ${humanNodes.length} human gates (max ${MAX_PHASE_GRAPH_HUMAN_GATES})`);
    }
    for (const h of humanNodes) {
      const id = String(h.id ?? ""), ak = getFieldMap(h.out).get("answer_kind"), outEdges = edges.filter((e) => e.from === id);
      const akOk = Boolean(ak && (ak.values?.includes("skip") || ak.type === "string" || ak.type === "str"));
      if (!asStrs(h.options).includes("skip") || !akOk || (outEdges.length > 0 && !outEdges.some((e) => whenAllowsSkip(e.when)))) {
        push("human_gate_not_skippable", `human gate "${id}" must allow "skip" in options, out.answer_kind, and outgoing edges`, id);
      }
    }
    for (const optName of OPTIONAL_FEATURE_INPUTS) {
      const spec = inputs.get(optName);
      if (spec && spec.required === true && spec.default === undefined) {
        push("optional_stage_not_skippable", `optional feature input "${optName}" must not be required without default`);
      }
    }
    const coreRequired = [...inputs.entries()].filter(([, s]) => s.required === true && s.default === undefined).map(([k]) => k);
    for (const n of nodes) {
      const id = String(n.id ?? "");
      if (n.type !== "note" && n.type !== "human" && !isControlAction(n)) {
        const joined = collectStringsFromKeys(n, ["prompt", "inputs", "with", "contract", "contract_template", "params", "reads"]).join("\n");
        const refsOpt = OPTIONAL_FEATURE_INPUTS.some((opt) => new RegExp(`\\$inputs\\.${opt}\\b`).test(joined));
        const refsLegacyTier = (["legacy_domain", "content_factory_endpoint", "identity_profile"] as const).some((opt) => new RegExp(`\\$inputs\\.${opt}\\b`).test(joined));
        const refsCore = coreRequired.some((req) => new RegExp(`\\$inputs\\.${req}\\b`).test(joined));
        const isOptional = bpGraph?.stages.find((s) => s.id === id)?.necessity === "optional"
          || OPTIONAL_STAGE_ID_RE.test(id)
          || (refsOpt && (n.type === "lp-task" || n.type === "subworkflow" ? refsLegacyTier : !refsCore));
        const hasSkipWhen = typeof n.skip_when === "string" ? n.skip_when.trim().length > 0 : Boolean(asRec(n.skip_when));
        if (isOptional && !hasSkipWhen) push("optional_stage_not_skippable", `optional stage "${id}" must declare skip_when and skip_out`, id);
      }
      if (n.skip_when !== undefined && n.skip_when !== null && n.skip_when !== "") {
        const outFields = getFieldMap(n.out), skipOut = asRec(n.skip_out);
        if (outFields.size > 0 && (!skipOut || [...outFields.keys()].some((k) => !(k in skipOut)))) {
          push("invalid_skip_out_literal", `node "${id}" has skip_when so skip_out must cover all declared out fields`, id);
        }
        if (skipOut) {
          for (const [k, v] of Object.entries(skipOut)) {
            if (typeof v !== "string") continue;
            try { valueSpecOf(v); } catch (err) {
              push("invalid_skip_out_literal", `node "${id}" skip_out.${k} invalid valueSpecOf literal (wrap multi-word strings in '...'): ${err instanceof Error ? err.message : String(err)}`, id);
            }
          }
        }
      }
      const seenBypassed = new Set<string>();
      for (const text of collectStringsFromKeys(n, ["prompt", "inputs", "with", "contract", "contract_template", "question", "params", "map"])) {
        for (const holder of placeholdersIn(text)) {
          const ref = refOf(holder);
          if (ref.kind === "node" && ref.node && nodeIds.has(ref.node) && ref.node !== id && !seenBypassed.has(ref.node) && entry && canReachWithout(entry, id, ref.node)) {
            seenBypassed.add(ref.node);
            push("bypassed_producer_without_skip_out", `node "${id}" reads "{{${holder}}}" while producer "${ref.node}" can be bypassed; keep "${ref.node}" on path with skip_when + skip_out`, id);
          }
        }
      }
    }
    if (candidate.scope !== "project") {
      for (const n of nodes.filter((x) => x.type === "lp-task")) {
        const id = String(n.id ?? ""), paths = asStrs(n.owns_paths).map((p) => p.trim()).filter(Boolean);
        if (paths.length === 0 || (!paths.includes("**") && paths.some((p) => NARROW_PREFIXES.some((pfx) => p.replace(/^\.?\//, "").toLowerCase().startsWith(pfx))))) {
          push("narrow_framework_owns_paths", `global lp-task "${id}" must not lock owns_paths to narrow framework paths without "**"`, id);
        }
      }
    }
    const st = inputs.get("scope_tier");
    if (!st || (st.required === true && st.default === undefined) || (st.default !== undefined && st.default !== "standard")
      || (st.values && !(["express", "standard", "full"] as const).every((v) => st.values!.includes(v)))) {
      push("missing_scope_tier", `workflow "${wfId}" must declare optional input scope_tier (express|standard|full, default: "standard")`);
    }
    if (isMaster) {
      for (const sw of nodes.filter((n) => n.type === "subworkflow")) {
        const childWf = typeof sw.workflow === "string" ? sw.workflow : "";
        if (inputsByWf.get(childWf)?.has("scope_tier")) {
          const forwarded = asRec(sw.inputs)?.scope_tier ?? asRec(sw.with)?.scope_tier;
          if (typeof forwarded !== "string" || !forwarded.trim()) push("missing_scope_tier", `subworkflow "${String(sw.id ?? "")}" must forward scope_tier to "${childWf}"`, String(sw.id ?? ""));
        }
      }
    }
    const variantLean = asRec(asRec(asRec(def.test)?.sim)?.variant_lean);
    const intermediateHumans = humanNodes.filter((h) => {
      const hid = String(h.id ?? ""), seen = new Set<string>(), queue = [...(adj.get(hid) ?? [])];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur === hid || seen.has(cur)) continue;
        seen.add(cur);
        const node = nodes.find((x) => x.id === cur);
        if (node && isWorkNode(node)) return true;
        for (const nxt of adj.get(cur) ?? []) queue.push(nxt);
      }
      return false;
    });
    const vlAnswers = asRec(variantLean?.human_answers);
    if (!variantLean || (variantLean.expect_status !== undefined && variantLean.expect_status !== "succeeded")
      || asRec(variantLean.input)?.scope_tier !== "express" || !intermediateHumans.every((h) => vlAnswers?.[String(h.id ?? "")] === "skip")) {
      push("missing_variant_lean_test", `workflow "${wfId}" must define test.sim.variant_lean with scope_tier: "express", "skip" on intermediate human gates, and expect_status: "succeeded"`);
    }
    if (def.internal !== true) {
      const triggers = new Set((Array.isArray(def.triggers) ? def.triggers : []).map((t) => (typeof t === "string" ? t.trim() : typeof asRec(t)?.type === "string" ? String(asRec(t)!.type).trim() : "")).filter(Boolean));
      const ex = asRec(def.examples), enEx = asStrs(ex?.en).filter((s) => s.trim().length > 0), ruEx = asStrs(ex?.ru).filter((s) => s.trim().length > 0);
      if (!triggers.has("chat") || !triggers.has("manual") || enEx.length < 2 || ruEx.length < 2 || asStrs(def.not_for).filter((s) => s.trim().length > 0).length < 2) {
        push("missing_chat_routing_metadata", `user-facing workflow "${wfId}" requires triggers ["chat","manual"], >=2 EN/RU examples, and >=2 not_for entries`);
      }
    }
    const checkpoints = nodes.filter((n) => n.action === "lp.save_process_state");
    if (checkpoints.length === 0) push("missing_or_invalid_process_state_checkpoint", `workflow "${wfId}" must include an lp.save_process_state checkpoint action`);
    else {
      for (const cp of checkpoints) {
        const id = String(cp.id ?? ""), out = getFieldMap(cp.out), saved = out.get("saved"), path = out.get("path"), stage = out.get("stage");
        if (cp.type !== "action" || (saved?.type !== "bool" && saved?.type !== "boolean") || (path?.type !== "string" && path?.type !== "str") || (stage?.type !== "string" && stage?.type !== "str")) {
          push("missing_or_invalid_process_state_checkpoint", `checkpoint "${id}" must be type:"action", action:"lp.save_process_state" with out:{saved:"bool",path:"string",stage:"string"}`, id);
        }
      }
    }
  }
  emitLog(options?.log, "debug", "checked", { workflowCount: candidates.length, ok: violations.length === 0, violationCount: violations.length, codes: [...new Set(violations.map((v) => v.code))] }, options?.logLevel);
  return { ok: violations.length === 0, violations };
}
