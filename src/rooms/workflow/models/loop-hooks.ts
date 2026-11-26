import { sha256Hex } from "@lane-pilot/kit";
import { MAX_SUBWORKFLOW_DEPTH, START } from "@lane-pilot/workflow-engine";
import type { Workflow, WorkflowNode } from "@lane-pilot/workflow-engine";

/** The only hook points Lane Pilot currently composes into a project workflow. */
export const LOOP_HOOK_POINTS = ["discuss:pre", "plan:pre", "verify:post", "ship:post"] as const;
export type LoopHookPoint = (typeof LOOP_HOOK_POINTS)[number];
export const LOOP_HOOK_MANIFEST = "loop-hooks.manifest.json";

export type LoopHook = { workflow: string; version?: number; inputs: Record<string, string> };
export type LoopHookManifest = { schemaVersion: 1; hooks: Record<Exclude<LoopHookPoint, "discuss:pre">, LoopHook[]> & { "discuss:pre"?: LoopHook[] } };
export type LoopHookStatus = { status: Workflow["status"]; internal?: boolean; startedBy?: string };
export type LoopHookSelection = {
  point: LoopHookPoint;
  workflow: string;
  version?: number;
  inputs: Record<string, string>;
};
export type PreparedLoopWorkflow = {
  workflow: Workflow;
  resolve: (id: string, version?: number) => Workflow | null;
  /** Stable evidence for callers and tests; the engine's definition hash includes the generated nodes. */
  provenance: { baseWorkflow: string; manifestSha256: string; orderedHookIds: string[] };
};

export class LoopHookRefusal extends Error {
  readonly code = "loop_hooks_refused";
  constructor(message: string) { super(message); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const idPattern = /^[a-z0-9][a-z0-9.-]{0,47}$/;
const inputRef = /^(?:\$inputs\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|ctx\.(?:run_id|goal|merged_commits)(?:\.[A-Za-z_][A-Za-z0-9_]*)*|ctx\.answers\.[A-Za-z_][A-Za-z0-9_]*(?:\.length)?)$/;

const emptyHooks = (): Record<LoopHookPoint, LoopHook[]> => ({ "discuss:pre": [], "plan:pre": [], "verify:post": [], "ship:post": [] });

/** Parse the reserved project file. Missing text is intentionally a no-op. */
export function parseLoopHookManifest(text: string | null | undefined): { manifest: LoopHookManifest | null; sha256: string | null } {
  if (text === null || text === undefined) return { manifest: null, sha256: null };
  let value: unknown;
  try { value = JSON.parse(text); } catch (cause) { throw new LoopHookRefusal(`loop hooks manifest is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.hooks)) {
    throw new LoopHookRefusal("loop hooks manifest must be {schemaVersion:1,hooks:{'discuss:pre':[],'plan:pre':[],'verify:post':[],'ship:post':[]}}");
  }
  const hooks = emptyHooks();
  for (const key of Object.keys(value.hooks)) {
    if (!(LOOP_HOOK_POINTS as readonly string[]).includes(key)) throw new LoopHookRefusal(`loop hooks manifest names unsupported point "${key}"`);
  }
  for (const point of LOOP_HOOK_POINTS) {
    const raw = value.hooks[point];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) throw new LoopHookRefusal(`loop hooks manifest point "${point}" must be an ordered array`);
    for (const [index, item] of raw.entries()) {
      if (!isRecord(item) || typeof item.workflow !== "string" || !idPattern.test(item.workflow) ||
        (own(item, "version") && (!Number.isInteger(item.version) || (item.version as number) < 1)) ||
        !isRecord(item.inputs) || Object.keys(item).some((key) => !["workflow", "version", "inputs"].includes(key))) {
        throw new LoopHookRefusal(`loop hooks manifest ${point}[${index}] must name a workflow id, optional positive version, and inputs`);
      }
      const inputs: Record<string, string> = {};
      for (const [name, ref] of Object.entries(item.inputs)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name) || typeof ref !== "string" || !inputRef.test(ref)) {
          throw new LoopHookRefusal(`loop hooks manifest ${point}[${index}] has unsupported input mapping "${name}"; use $inputs.<field> or ctx.run_id|ctx.goal|ctx.merged_commits`);
        }
        inputs[name] = ref;
      }
      hooks[point].push({ workflow: item.workflow, ...(typeof item.version === "number" ? { version: item.version } : {}), inputs });
    }
  }
  return { manifest: { schemaVersion: 1, hooks }, sha256: sha256Hex(text) };
}

type PrepareInput = {
  workflow: Workflow;
  manifest?: LoopHookManifest | null;
  manifestSha256?: string | null;
  resolve: (id: string, version?: number) => Workflow | null;
  status?: (id: string, version?: number) => LoopHookStatus | null;
};

const mergeRequires = (base: Workflow["requires"], child: Workflow["requires"]): Workflow["requires"] => {
  const arrays = ["plugins", "skills", "secrets", "machines", "env", "mcp", "tools", "platforms"] as const;
  const merged = { ...base };
  for (const key of arrays) merged[key] = [...new Set([...(base[key] ?? []), ...(child[key] ?? [])])];
  merged.browserSession = Boolean(base.browserSession || child.browserSession);
  if (base.project || child.project) merged.project = { ...(base.project ?? {}), ...(child.project ?? {}) };
  return merged;
};

const pointTargets = (workflow: Workflow, point: LoopHookPoint): string[] => {
  if (point === "discuss:pre") return workflow.id === "lp.analyze" ? ["assess"] : [];
  if (point === "plan:pre") {
    return workflow.id === "lp.plan" ? [workflow.entry ?? workflow.edges.find((edge) => edge.from === START)?.to ?? ""] : [];
  }
  if (point === "verify:post") {
    return workflow.id === "lp.close" ? workflow.nodes.filter((node) => node.type === "action" && node.action === "emit").map((node) => node.id) : [];
  }
  if (workflow.id !== "ship") return [];
  return workflow.nodes.filter((node) => node.type === "action" && node.action === "emit" && node.id === "shipped").map((node) => node.id);
};

const hookNode = (id: string, hook: LoopHook): WorkflowNode => ({ id, type: "subworkflow", workflow: hook.workflow, ...(hook.version === undefined ? {} : { version: hook.version }), inputs: hook.inputs, out: [], maxAttempts: 1 });

/** Add one ordered chain before a terminal boundary without changing any original mapping or condition. */
function insertChains(workflow: Workflow, point: LoopHookPoint, hooks: LoopHook[], targets: string[], orderedIds: string[], manifestSha256: string): Workflow {
  if (!hooks.length || !targets.length) return workflow;
  const nodes = [...workflow.nodes];
  let edges = [...workflow.edges];
  const used = new Set(nodes.map((node) => node.id));
  const addId = (base: string) => { if (used.has(base)) throw new LoopHookRefusal(`loop hooks generated node id collides with workflow node "${base}"`); used.add(base); return base; };
  const normalizeEntry = () => {
    if (!workflow.entry || edges.some((edge) => edge.from === START)) return;
    edges = [{ from: START, to: workflow.entry, pass: "artifact" }, ...edges];
  };
  normalizeEntry();
  for (const target of targets) {
    const candidates = edges.filter((edge) => edge.to === target);
    if (!candidates.length) continue;
    for (const [edgeIndex, edge] of candidates.entries()) {
      const stem = `hook-${point.replace(":", "-")}-${target.slice(0, 16)}-${edgeIndex}`;
      const firstId = addId(`${stem}-0`);
      const chain: string[] = [];
      hooks.forEach((hook, index) => {
        const id = index === 0 ? firstId : addId(`${stem}-${index}`);
        nodes.push({ ...hookNode(id, hook), src: `project-loop-hook:${manifestSha256}` } as WorkflowNode); chain.push(id); orderedIds.push(`${point}:${id}:${hook.workflow}`);
      });
      const original = { ...edge };
      const { to: _to, with: _with, pass: _pass, ...head } = original;
      edges = edges.map((candidate) => candidate === edge ? { ...head, to: chain[0], pass: "artifact" as const } : candidate);
      for (let index = 0; index + 1 < chain.length; index += 1) edges.push({ from: chain[index]!, to: chain[index + 1]!, pass: "artifact" });
      let last = chain.at(-1)!;
      if (point === "discuss:pre") {
        // The next agent consumes the gather handoff, not the last hook's output.
        const relay = addId(`${stem}-handoff`);
        nodes.push({ id: relay, type: "decision", reads_node: "gather", maxAttempts: 1, out: [{ name: "handoff", type: "string", required: false }] } as WorkflowNode);
        edges.push({ from: last, to: relay, pass: "artifact" });
        last = relay;
      }
      edges.push({ ...original, from: last, to: target });
    }
  }
  return { ...workflow, entry: undefined, nodes, edges };
}

/** Compose a project manifest into a root graph and every child it reaches. The returned resolver is the one passed to preflight and start. */
export function prepareLoopWorkflow(input: PrepareInput): PreparedLoopWorkflow {
  const manifest = input.manifest;
  if (!manifest || !LOOP_HOOK_POINTS.some((point) => manifest.hooks[point]?.length)) {
    return { workflow: input.workflow, resolve: input.resolve, provenance: { baseWorkflow: input.workflow.id, manifestSha256: input.manifestSha256 ?? "", orderedHookIds: [] } };
  }
  const orderedHookIds: string[] = [];
  const keyOf = (id: string, version?: number) => `${id}@${version ?? "*"}`;
  const compose = (base: Workflow, trail: string[], depth: number, recordProvenance = true): Workflow => {
    const identity = keyOf(base.id, base.version);
    if (trail.includes(identity)) throw new LoopHookRefusal(`loop hooks contain a recursive workflow reference: ${[...trail, identity].join(" -> ")}`);
    if (depth > MAX_SUBWORKFLOW_DEPTH) throw new LoopHookRefusal(`loop hooks exceed the ${MAX_SUBWORKFLOW_DEPTH}-level workflow depth limit at "${base.id}"`);
    let current: Workflow = base;
    for (const point of LOOP_HOOK_POINTS) {
      const hooks = manifest.hooks[point] ?? [];
      const targets = pointTargets(current, point);
      if (!hooks.length || !targets.length) continue;
      if (point === "discuss:pre") {
        const incoming = current.edges.filter((edge) => edge.to === "assess");
        if (current.entry === "assess" || current.nodes.find((node) => node.id === "gather")?.type !== "agent" ||
          current.nodes.find((node) => node.id === "assess")?.type !== "agent" || incoming.length !== 1 ||
          incoming[0]?.from !== "gather" || incoming[0]?.when !== undefined) {
          throw new LoopHookRefusal('discuss:pre requires an unconditional gather-to-assess boundary between agents in lp.analyze');
        }
      }
      for (const hook of hooks) {
        const child = input.resolve(hook.workflow, hook.version);
        if (!child) throw new LoopHookRefusal(`${point} hook workflow "${hook.workflow}" is missing`);
        const status = input.status?.(hook.workflow, hook.version) ?? { status: child.status, internal: child.internal, startedBy: child.startedBy };
        if (status.status !== "published" || status.internal || status.startedBy) throw new LoopHookRefusal(`${point} hook workflow "${hook.workflow}" is not a published runnable workflow`);
        // Compose the hook itself now: this catches indirect hook cycles before the engine has any effects.
        const composedChild = compose(child, [...trail, identity], depth + 1, recordProvenance);
        current = { ...current, requires: mergeRequires(current.requires, composedChild.requires) };
      }
      current = insertChains(current, point, hooks, targets, recordProvenance ? orderedHookIds : [], input.manifestSha256 ?? "");
    }
    // Existing children are composed lazily by the resolver but are traversed here for cycle/depth validation.
    for (const node of current.nodes) if (node.type === "subworkflow") {
      const child = input.resolve(node.workflow, node.version);
      if (child) {
        const composedChild = compose(child, [...trail, identity], depth + 1, recordProvenance);
        // External capability admission happens once at the root caller. Carry every transitive child requirement upward so
        // that nested project hooks cannot bypass the normal role/capability policy.
        current = { ...current, requires: mergeRequires(current.requires, composedChild.requires) };
      }
    }
    current = { ...current, requires: current.requires };
    return current;
  };
  const root = compose(input.workflow, [], 0, true);
  return { workflow: root, resolve: (id, version) => { const child = input.resolve(id, version); return child ? compose(child, [keyOf(root.id, root.version)], 1, false) : null; }, provenance: { baseWorkflow: input.workflow.id, manifestSha256: input.manifestSha256 ?? "", orderedHookIds } };
}
