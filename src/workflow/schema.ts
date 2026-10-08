import { z } from "zod";

/**
 * The workflow file format (W1). A workflow is a graph of typed nodes; every node declares the fields of its output, and a
 * condition or a reference may read only declared fields. The schema is closed: an unknown key is an error, not a silently
 * ignored typo. Authoring conveniences of the chains spec (`out:` maps with type hints, `guards:`, `entry:`, `emit` nodes,
 * snake_case budget, string triggers) are accepted and normalized by `normalizeWorkflow` before the closed schema runs, so
 * a file in either spelling loads to the same value. Graph-level checks are in `validate.ts`.
 */
export const WORKFLOW_SCHEMA_VERSION = 1 as const;
/**
 * The entry (its output is the workflow's inputs) and the exit (edges into it carry the workflow's outputs). Files write them as
 * `start` and `end`; they become these ids, which no node can have, unless a node of that name exists (a chain may well have a node `start`).
 */
export const START = "$start";
export const END = "$end";
export const MAX_SUBWORKFLOW_DEPTH = 3;

const nodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/, "id: lowercase letters, digits, - and _, starting with a letter");
const bilingual = z.object({ en: z.string().min(1).max(2000), ru: z.string().min(1).max(2000) }).strict();

export const FIELD_TYPES = ["string", "number", "boolean", "enum", "array", "object", "json"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const fieldSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,47}$/, "field name: letters, digits and _"),
  type: z.enum(FIELD_TYPES),
  values: z.array(z.string().min(1).max(80)).min(1).max(50).optional(),
  required: z.boolean().default(true),
  /** The named shape of an object or of the items of an array (`Finding`, `Task`): a hint for readers and the editor. */
  ref: z.string().max(40).optional(),
  default: z.unknown().optional(),
  note: z.string().max(400).optional(),
  description: z.string().max(300).optional(),
}).strict().superRefine((field, ctx) => {
  if (field.type === "enum" && !field.values) ctx.addIssue({ code: "custom", message: `enum field ${field.name} needs values` });
  if (field.type !== "enum" && field.values) ctx.addIssue({ code: "custom", message: `field ${field.name} has values but is not an enum` });
});
export type Field = z.infer<typeof fieldSchema>;

export const CONDITION_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "exists"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type Condition =
  | { field: string; op: ConditionOp; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ field: z.string().min(1).max(120), op: z.enum(CONDITION_OPS), value: z.unknown().optional() }).strict(),
  z.object({ all: z.array(conditionSchema).min(1).max(20) }).strict(),
  z.object({ any: z.array(conditionSchema).min(1).max(20) }).strict(),
  z.object({ not: conditionSchema }).strict(),
]));
/** A condition is the structured form or an expression string (`"build.status == 'done' && visits('fix') < 2"`). */
export const whenSchema = z.union([conditionSchema, z.string().min(1).max(600)]);

export const QUALITY_MODES = ["quick", "standard", "full"] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];
export const PASS_MODES = ["artifact", "same-session", "read-prior-session", "fork"] as const;
export type PassMode = (typeof PASS_MODES)[number];
export const JOIN_POLICIES = ["all", "majority", "all_or_low_confidence"] as const;

const position = z.object({ x: z.number(), y: z.number() }).strict().optional();

/** What every node but a note carries (without its id, so a parallel's child can reuse it). */
const nodeBase = {
  title: bilingual.optional(),
  label: z.string().max(80).optional(),
  /** Where the text of this node comes from (THIRD_PARTY_NOTICES). */
  src: z.string().max(300).optional(),
  out: z.array(fieldSchema).max(40).default([]),
  /** Executor key. Empty means the default of the type. */
  uses: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/).optional(),
  /** How often the node may run in one scope (a branch or the whole run). Cycles must set it. */
  maxVisits: z.number().int().min(1).max(50).optional(),
  /** Tries of one visit before the step fails. */
  maxAttempts: z.number().int().min(1).max(5).default(1),
  timeoutSec: z.number().int().min(1).max(86_400).optional(),
  /** The node runs only in these quality modes; elsewhere it is skipped and its output is `skip_out`. */
  applicable_modes: z.array(z.enum(QUALITY_MODES)).min(1).max(3).optional(),
  skip_when: whenSchema.optional(),
  /** The output of a skipped node: expression-valued (spec section 0.3). Without it a skipped node has no output. */
  skip_out: z.record(z.string(), z.unknown()).optional(),
  /** The inputs of the node: `{{ref}}` templates, nested lists and objects, `{by_mode: {...}}`. */
  with: z.record(z.string(), z.unknown()).optional(),
  /** Data this node reads, as references; checked like any reference. */
  reads: z.array(z.string()).max(30).optional(),
  model_preset: z.string().max(64).optional(),
  profile: z.object({ skills: z.array(z.string().min(1).max(120)).max(12).default([]) }).strict().optional(),
  position,
};

const agentBody = {
  role: z.string().max(80).default("worker"),
  prompt: z.string().max(12_000).default(""),
  provider: z.string().max(64).optional(),
  model: z.string().max(120).optional(),
  reasoning: z.enum(["low", "medium", "high", "xhigh", "ultracode", "max"]).optional(),
  /** `fast` asks the provider's fast mode where it has one (the picker offers it only for those providers); `default` is the normal tier. */
  service_tier: z.enum(["default", "fast"]).optional(),
  skills: z.array(z.string().min(1).max(120)).max(8).default([]),
  /** BB plugins this step's session may load, on top of its role's (by plugin id; the helper's session policy narrows to the role's list plus these). */
  plugins: z.array(z.string().min(1).max(120)).max(8).default([]),
  /** MCP servers this step's session may load, on top of its role's (by server name). */
  mcp: z.array(z.string().min(1).max(120)).max(8).default([]),
  environment: z.enum(["worktree", "project", "personal", "none"]).default("none"),
  session: z.enum(["new", "same"]).optional(),
  authorized: z.boolean().optional(),
  /** Independent copies of this child run per item and decided by a mechanical majority (a parallel child). */
  votes: z.number().int().min(1).max(9).optional(),
};
const lpTaskBody = {
  quality_mode: z.string().max(40).optional(),
  contract: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  contract_template: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  owns_paths: z.array(z.string().min(1)).max(50).default([]),
  /** Stage ids the code task runs inside (writer, checks, critic, merge ...). Locked: not edited in an editor. */
  stages: z.array(z.string().min(1).max(64)).max(30).default([]),
};
const actionBody = {
  action: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** `emit` only: the status and fields the workflow ends with (expression-valued). */
  map: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  test_mode: z.string().max(300).optional(),
};
const humanBody = {
  role: z.string().max(80).optional(),
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(120)).max(10).default([]),
  onTimeout: z.enum(["stop", "default"]).default("stop"),
  defaultOption: z.string().max(120).optional(),
};
const subworkflowBody = {
  workflow: z.string().regex(/^[a-z][a-z0-9.-]{0,47}$/),
  version: z.number().int().min(1).optional(),
  /** Input name of the child to `node.field`: the first spelling; `with` is the second. */
  inputs: z.record(z.string(), z.string()).default({}),
};

export const FOR_EACH_SOURCES = z.union([
  z.string().min(1).max(300),
  z.array(z.unknown()).max(50),
  z.object({ by: z.string().min(1).max(120) }).catchall(z.array(z.unknown())),
]);

/** The body of a parallel node's child: one of the runnable types, without an id. */
const childSchema = z.discriminatedUnion("type", [
  z.object({ ...nodeBase, type: z.literal("agent"), ...agentBody }).strict(),
  z.object({ ...nodeBase, type: z.literal("lp-task"), ...lpTaskBody }).strict(),
  z.object({ ...nodeBase, type: z.literal("action"), ...actionBody }).strict(),
  z.object({ ...nodeBase, type: z.literal("subworkflow"), ...subworkflowBody }).strict(),
]);
export type ParallelChild = z.infer<typeof childSchema>;

const joinPolicy = z.object({
  policy: z.enum(JOIN_POLICIES).default("all"),
  out: z.array(fieldSchema).max(40).default([]),
  /** Executor key of the reducer that builds `out` from the children's results; without it arrays of the same name are concatenated. */
  uses: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/).optional(),
}).strict();

const agentNode = z.object({ id: nodeId, ...nodeBase, type: z.literal("agent"), ...agentBody }).strict();
const lpTaskNode = z.object({ id: nodeId, ...nodeBase, type: z.literal("lp-task"), ...lpTaskBody }).strict();
const actionNode = z.object({ id: nodeId, ...nodeBase, type: z.literal("action"), ...actionBody }).strict();
const decisionNode = z.object({
  id: nodeId, ...nodeBase, type: z.literal("decision"),
  /** Takes its output from another node's output (the declared fields must exist there). Without it the executor computes it. */
  reads_node: nodeId.optional(),
}).strict();
const humanNode = z.object({ id: nodeId, ...nodeBase, type: z.literal("human"), ...humanBody }).strict();
const parallelNode = z.object({
  id: nodeId, ...nodeBase, type: z.literal("parallel"),
  /** One branch per item: a reference to a list, a literal list, `ref where <condition on the item>`, or `{by, <value>: [...]}` picking a list by an input or the mode. */
  for_each: FOR_EACH_SOURCES.optional(),
  order: z.enum(["depends_on"]).optional(),
  max_fan_out: z.number().int().min(1).max(50).optional(),
  /** How many branches run at once; the others wait their turn. `max_fan_out` is the cap on how many branches there may be at all. */
  concurrency: z.number().int().min(1).max(50).optional(),
  batch_size: z.number().int().min(1).max(500).optional(),
  on_child_fail: z.enum(["block_dependents"]).optional(),
  onOverflow: z.enum(["fail", "truncate"]).default("fail"),
  /** The body of one branch. Without it the branches are the outgoing edges and a separate `join` node collects them. */
  child: childSchema.optional(),
  join: joinPolicy.optional(),
}).strict();
const joinNode = z.object({
  id: nodeId, ...nodeBase, type: z.literal("join"),
  parallel: nodeId,
  wait: z.literal("all").default("all"),
  /** `all`: every branch; `majority` and `all_or_low_confidence` are accepted by the schema and refused by the engine until they are built. */
  policy: z.enum(JOIN_POLICIES).default("all"),
}).strict();
const subworkflowNode = z.object({ id: nodeId, ...nodeBase, type: z.literal("subworkflow"), ...subworkflowBody }).strict();
const noteNode = z.object({ id: nodeId, type: z.literal("note"), text: z.string().max(2000).default(""), position }).strict();

export const nodeSchema = z.discriminatedUnion("type", [agentNode, lpTaskNode, actionNode, decisionNode, humanNode, parallelNode, joinNode, subworkflowNode, noteNode]);
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type NodeType = WorkflowNode["type"];
/** A node that runs: everything but a note. */
export type GraphNode = Exclude<WorkflowNode, { type: "note" }>;

export const edgeSchema = z.object({
  from: z.string().min(1).max(48),
  to: z.string().min(1).max(48),
  when: whenSchema.optional(),
  label: z.string().max(80).optional(),
  /** Name to `node.field` (or `input.name`, `item`, `index`): data handed to the target in mode artifact. */
  with: z.record(z.string(), z.string()).optional(),
  pass: z.enum(PASS_MODES).default("artifact"),
}).strict();
export type WorkflowEdge = z.infer<typeof edgeSchema>;

/**
 * How a workflow is started besides the router. `schedule` becomes a BB automation while the workflow is published (own files
 * only): `cron` (5 fields), `timezone` (IANA; the hub's own when absent), `inputs` (the values every scheduled run gets) and the
 * `projectId` whose PM chat runs it (the project of a project workflow when absent). `manual` is the Run button of the tab.
 * `telegram` has no API behind it yet; see docs/workflow-triggers.md.
 */
const trigger = z.object({
  type: z.enum(["chat", "schedule", "telegram", "manual"]),
  cron: z.string().max(120).optional(),
  timezone: z.string().max(100).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  projectId: z.string().max(80).optional(),
}).strict();

export const workflowSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION).default(WORKFLOW_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,47}$/, "workflow id: lowercase letters, digits, . and -"),
  name: bilingual,
  description: bilingual,
  examples: z.object({ en: z.array(z.string().min(3).max(300)).max(20).default([]), ru: z.array(z.string().min(3).max(300)).max(20).default([]) }).strict().default({ en: [], ru: [] }),
  /** Ids of neighbouring workflows this one is confused with; shown to the router's model as «not suitable if...». */
  not_for: z.array(z.string()).max(20).default([]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  /** A fragment called by a subworkflow node; it is not offered by the router. */
  internal: z.boolean().default(false),
  inputs: z.array(fieldSchema).max(40).default([]),
  outputs: z.array(fieldSchema).max(40).default([]),
  requires: z.object({
    plugins: z.array(z.string()).default([]), skills: z.array(z.string()).default([]), secrets: z.array(z.string()).default([]),
    machines: z.array(z.string()).default([]), env: z.array(z.string()).default([]), browserSession: z.boolean().default(false),
    /** MCP servers by name (checked on the machine the run works on). */
    mcp: z.array(z.string().min(1).max(80)).default([]),
    /** Commands that must exist on that machine: `ffmpeg`, `a|b` for any of, a path such as `~/toolkit/telegram/tg`. A `secrets` entry is an Env Catalog name; `NAME?` is optional. */
    tools: z.array(z.string().min(1).max(120)).default([]),
    /** Social networks the chain uses signed in through social-browser: x, threads, instagram, facebook, vk. */
    platforms: z.array(z.string().min(1).max(40)).default([]),
    project: z.record(z.string(), z.unknown()).optional(),
  }).strict().default({ plugins: [], skills: [], secrets: [], machines: [], env: [], browserSession: false, mcp: [], tools: [], platforms: [] }),
  status: z.enum(["draft", "tested", "published", "deprecated"]).default("draft"),
  version: z.number().int().min(1).default(1),
  /**
   * What a live run must have ended with to lift a `tested` chain to `published`. A run is `succeeded` also on the branches that
   * did not do the job (the owner said no, a login wall): the final output's field `output` (default `status`) must be one of `in`.
   * Without it any succeeded run proves the chain.
   */
  live_success: z.object({ output: z.string().min(1).max(60).default("status"), in: z.array(z.string().min(1).max(80)).min(1).max(20) }).strict().optional(),
  budget: z.object({
    maxSteps: z.number().int().min(1).max(5000).optional(),
    maxTokens: z.number().int().min(1).optional(),
    maxCostUsd: z.number().positive().optional(),
    maxWallSeconds: z.number().int().min(1).optional(),
  }).strict().default({}),
  guards: z.object({
    maxSteps: z.number().int().min(1).max(500).default(60),
    maxFanOut: z.number().int().min(1).max(50).default(12),
    maxSubworkflowDepth: z.number().int().min(1).max(MAX_SUBWORKFLOW_DEPTH).default(MAX_SUBWORKFLOW_DEPTH),
  }).strict().default({ maxSteps: 60, maxFanOut: 12, maxSubworkflowDepth: MAX_SUBWORKFLOW_DEPTH }),
  /**
   * `default` is `$mode` when the run is started without one; `effect` says in words what the mode changes here; `min` raises a lower
   * request to this mode (a refactor is never run `quick`); `fixed` is the mode whatever is asked (a companion run is always `quick`).
   */
  quality_mode: z.object({ default: z.enum(QUALITY_MODES).default("standard"), effect: z.string().max(600).optional(), min: z.enum(QUALITY_MODES).optional(), fixed: z.enum(QUALITY_MODES).optional() }).strict().optional(),
  triggers: z.array(trigger).max(10).default([]),
  scope: z.object({
    level: z.enum(["builtin", "global", "project", "section"]).default("global"),
    projectId: z.string().optional(),
  }).strict().default({ level: "global" }),
  /** The first node. Without it the graph has an explicit edge from `start`. */
  entry: nodeId.optional(),
  /** A test case: `sim` (stubs, expected path) and `live`; run by W7, only its shape is checked here. */
  test: z.object({ id: z.string().max(80), sim: z.unknown().optional(), live: z.string().max(1000).optional() }).passthrough().optional(),
  /** Canvas layout only (the editor's drag and «Arrange»): node positions by node id; the engine never reads it. */
  ui: z.object({ positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).default({}) }).strict().optional(),
  nodes: z.array(nodeSchema).min(1).max(80),
  edges: z.array(edgeSchema).min(1).max(300),
}).strict();

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowInput = z.input<typeof workflowSchema>;

// ------------------------------------------------------------------ authoring spellings

const PRIMITIVE_HINTS: Record<string, { type: FieldType; ref?: string }> = {
  string: { type: "string" }, str: { type: "string" }, int: { type: "number" }, integer: { type: "number" }, number: { type: "number" }, float: { type: "number" },
  bool: { type: "boolean" }, boolean: { type: "boolean" }, any: { type: "json" }, json: { type: "json" }, object: { type: "object" },
};

/** `string`, `int`, `bool`, `Finding[]`, `Verdict`, `pass|rework|block`, `string|null` to a field type. A trailing `?` marks it optional. */
export function parseTypeHint(hint: string): { type: FieldType; values?: string[]; ref?: string; optional?: boolean } {
  let text = hint.trim();
  const optional = text.endsWith("?");
  if (optional) text = text.slice(0, -1).trim();
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  const nullable = parts.includes("null");
  const rest = parts.filter((part) => part !== "null");
  const one = (part: string): { type: FieldType; ref?: string } => {
    if (part.endsWith("[]")) { const inner = part.slice(0, -2); return { type: "array", ...(/^[A-Z]/.test(inner) ? { ref: inner.replace(/\[\]/g, "") } : {}) }; }
    if (PRIMITIVE_HINTS[part]) return PRIMITIVE_HINTS[part]!;
    if (/^[A-Z][A-Za-z0-9]*$/.test(part)) return { type: "object", ref: part };
    return { type: "json" };
  };
  const base = (() => {
    if (rest.length === 1) return one(rest[0]!);
    if (rest.length > 1 && rest.every((part) => /^[a-z0-9][a-z0-9_.-]*$/.test(part) && !PRIMITIVE_HINTS[part])) return { type: "enum" as const, values: rest };
    return { type: "json" as const };
  })();
  return { ...base, ...(optional || nullable ? { optional: true } : {}) };
}

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function fieldFrom(name: string, spec: unknown, defaultRequired: boolean): Raw {
  if (typeof spec === "string") {
    const parsed = parseTypeHint(spec);
    return { name, type: parsed.type, ...(parsed.values ? { values: parsed.values } : {}), ...(parsed.ref ? { ref: parsed.ref } : {}), required: parsed.optional ? false : defaultRequired };
  }
  if (isRaw(spec)) {
    const parsed = typeof spec.type === "string" ? parseTypeHint(spec.type) : { type: "json" as FieldType };
    const required = typeof spec.required === "boolean" ? spec.required : parsed.optional ? false : "default" in spec ? false : defaultRequired;
    const { type: _type, required: _required, ...extra } = spec;
    return { name, ...extra, type: parsed.type, ...(parsed.values ? { values: parsed.values } : {}), ...(parsed.ref ? { ref: parsed.ref } : {}), required };
  }
  return { name, type: "json", required: defaultRequired };
}

/** A field list as an array, from an array of fields or a `{name: "hint" | {type, required, default}}` map. */
function fieldList(value: unknown, defaultRequired: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!isRaw(item) || typeof item.type !== "string" || (FIELD_TYPES as readonly string[]).includes(item.type)) return item;
      return fieldFrom(String(item.name), item, defaultRequired);
    });
  }
  if (isRaw(value)) return Object.entries(value).map(([name, spec]) => fieldFrom(name, spec, defaultRequired));
  return value;
}

const bilingualOf = (value: unknown): unknown => (typeof value === "string" ? { en: value, ru: value } : value);

const ACTION_KEYS = new Set(["id", "type", "title", "label", "src", "out", "output", "uses", "maxVisits", "maxAttempts", "timeoutSec", "guards", "applicable_modes", "skip_when", "skip_out", "with", "reads",
  "model_preset", "profile", "position", "action", "params", "map", "test_mode"]);

function normalizeNode(node: unknown, isChild = false): unknown {
  if (!isRaw(node)) return node;
  const next: Raw = { ...node };
  if ("out" in next) { next.out = fieldList(next.out, true); }
  if ("output" in next) { next.out = fieldList(next.output, true); delete next.output; }
  if (isRaw(next.guards)) {
    const { maxVisits, maxAttempts, timeoutMin, timeoutSec } = next.guards;
    if (maxVisits !== undefined) next.maxVisits = maxVisits;
    if (maxAttempts !== undefined) next.maxAttempts = maxAttempts;
    if (typeof timeoutMin === "number") next.timeoutSec = Math.round(timeoutMin * 60);
    if (typeof timeoutSec === "number") next.timeoutSec = timeoutSec;
    delete next.guards;
  }
  if ("foreach" in next) { next.for_each = next.foreach; delete next.foreach; }
  if ("batch" in next && !("batch_size" in next)) { next.batch_size = next.batch; delete next.batch; }
  if (next.type === "decision" && "reads" in next && typeof next.reads === "string") { next.reads_node = next.reads; delete next.reads; }
  if (next.type === "human" && typeof next.prompt === "string" && !("question" in next)) { next.question = next.prompt; delete next.prompt; }
  if (next.type === "parallel") {
    if ("child" in next) next.child = normalizeNode(next.child, true);
    if (isRaw(next.join)) next.join = { ...next.join, ...("out" in next.join ? { out: fieldList(next.join.out, true) } : {}) };
  }
  if (next.type === "action") {
    // The parameters of an action sit beside its other keys in the authoring spelling.
    const params: Raw = isRaw(next.params) ? { ...next.params } : {};
    for (const key of Object.keys(next)) if (!ACTION_KEYS.has(key)) { params[key] = next[key]; delete next[key]; }
    if (Object.keys(params).length) next.params = params;
  }
  if (isChild) delete next.id;
  if (next.type !== "note" && isRaw(next.title) === false && typeof next.title === "string") next.title = bilingualOf(next.title);
  return next;
}

/** The authoring spelling to the closed schema's: type hints, `out`, `guards`, `entry`, snake_case budget, string triggers, a name in one language. */
export function normalizeWorkflow(raw: unknown): unknown {
  if (!isRaw(raw)) return raw;
  const next: Raw = { ...raw };
  delete next.common_inputs;
  next.name = bilingualOf(next.name);
  if ("inputs" in next) next.inputs = fieldList(next.inputs, false);
  if ("outputs" in next) next.outputs = fieldList(next.outputs, false);
  if (typeof next.quality_mode === "string") next.quality_mode = { default: next.quality_mode };
  if (Array.isArray(next.triggers)) next.triggers = next.triggers.map((item) => (typeof item === "string" ? { type: item } : item));
  if (isRaw(next.budget)) {
    const { max_steps, max_minutes, max_fan_out, max_usd, ...rest } = next.budget as Raw;
    const budget: Raw = { ...rest };
    if (max_steps !== undefined) budget.maxSteps = max_steps;
    if (typeof max_minutes === "number") budget.maxWallSeconds = Math.round(max_minutes * 60);
    if (max_usd !== undefined) budget.maxCostUsd = max_usd;
    next.budget = budget;
    if (max_fan_out !== undefined) next.guards = { ...(isRaw(next.guards) ? next.guards : {}), maxFanOut: max_fan_out };
  }
  if (Array.isArray(next.nodes)) next.nodes = next.nodes.map((node) => normalizeNode(node));
  // `start` and `end` in an edge are the sentinels, unless a node has that id.
  const ids = new Set(Array.isArray(next.nodes) ? next.nodes.flatMap((node) => (isRaw(node) && typeof node.id === "string" ? [node.id] : [])) : []);
  const sentinel = (id: unknown) => (id === "start" && !ids.has("start") ? START : id === "end" && !ids.has("end") ? END : id);
  if (Array.isArray(next.edges)) next.edges = next.edges.map((edge) => (isRaw(edge) ? { ...edge, from: sentinel(edge.from), to: sentinel(edge.to) } : edge));
  return next;
}

/** Parses a workflow in either spelling with the closed schema (zod issues carry the path in the normalized value). */
export const parseWorkflowObject = (raw: unknown) => workflowSchema.safeParse(normalizeWorkflow(raw));
