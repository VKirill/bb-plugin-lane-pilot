import { z } from "zod";

/**
 * The workflow file format (W1). A workflow is a graph of typed nodes; every node declares the fields of its output and a
 * condition or a mapping may read only those fields. The schema is closed: an unknown key is an error, not a silently
 * ignored typo. Graph-level checks (references, cycles, joins) are in `validate.ts`.
 */
export const WORKFLOW_SCHEMA_VERSION = 1 as const;
/** Reserved node ids: the entry (its output is the workflow's inputs) and the exit (edges into it carry the workflow's outputs). */
export const START = "start";
export const END = "end";
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

export const QUALITY_MODES = ["quick", "standard", "full"] as const;
export const PASS_MODES = ["artifact", "same-session", "read-prior-session", "fork"] as const;
export type PassMode = (typeof PASS_MODES)[number];

const nodeBase = {
  id: nodeId,
  label: z.string().max(80).optional(),
  output: z.array(fieldSchema).max(30).default([]),
  /** Executor key. Empty means the default of the type. */
  uses: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/).optional(),
  /** How often the node may run in one scope (a branch or the whole run). Cycles must set it. */
  maxVisits: z.number().int().min(1).max(50).optional(),
  /** Tries of one visit before the step fails. */
  maxAttempts: z.number().int().min(1).max(5).default(1),
  timeoutSec: z.number().int().min(1).max(86_400).optional(),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
};

const agentNode = z.object({
  ...nodeBase, type: z.literal("agent"),
  role: z.string().max(64).default("worker"),
  prompt: z.string().max(8000).default(""),
  provider: z.string().max(64).optional(),
  model: z.string().max(120).optional(),
  reasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  skills: z.array(z.string().min(1).max(120)).max(8).default([]),
  environment: z.enum(["worktree", "project", "personal", "none"]).default("none"),
}).strict();

const lpTaskNode = z.object({
  ...nodeBase, type: z.literal("lp-task"),
  quality_mode: z.enum(QUALITY_MODES).optional(),
  owns_paths: z.array(z.string().min(1)).max(50).default([]),
  /** Stage ids the code task runs inside (writer, checks, critic, merge ...). Locked: not edited in an editor. */
  stages: z.array(z.string().min(1).max(64)).max(30).default([]),
}).strict();

const actionNode = z.object({
  ...nodeBase, type: z.literal("action"),
  action: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict();

const decisionNode = z.object({
  ...nodeBase, type: z.literal("decision"),
  /** Takes its output from another node's output (the declared fields must exist there). Without it the executor computes it. */
  reads: nodeId.optional(),
}).strict();

const humanNode = z.object({
  ...nodeBase, type: z.literal("human"),
  question: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(120)).max(10).default([]),
  onTimeout: z.enum(["stop", "default"]).default("stop"),
  defaultOption: z.string().max(120).optional(),
}).strict();

const parallelNode = z.object({
  ...nodeBase, type: z.literal("parallel"),
  /** `node.field` of an array: one branch per item. Without it every outgoing edge is one branch. */
  foreach: z.string().max(120).optional(),
  maxFanOut: z.number().int().min(1).max(50).optional(),
  onOverflow: z.enum(["fail", "truncate"]).default("fail"),
}).strict();

const joinNode = z.object({
  ...nodeBase, type: z.literal("join"),
  parallel: nodeId,
  wait: z.literal("all").default("all"),
}).strict();

const subworkflowNode = z.object({
  ...nodeBase, type: z.literal("subworkflow"),
  workflow: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  version: z.number().int().min(1).optional(),
  /** Input name of the child to `node.field` of this workflow. */
  inputs: z.record(z.string(), z.string()).default({}),
}).strict();

const noteNode = z.object({
  id: nodeId, type: z.literal("note"), text: z.string().max(2000).default(""),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
}).strict();

export const nodeSchema = z.discriminatedUnion("type", [agentNode, lpTaskNode, actionNode, decisionNode, humanNode, parallelNode, joinNode, subworkflowNode, noteNode]);
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type NodeType = WorkflowNode["type"];
/** A node that runs: everything but a note. */
export type GraphNode = Exclude<WorkflowNode, { type: "note" }>;

export const edgeSchema = z.object({
  from: z.string().min(1).max(48),
  to: z.string().min(1).max(48),
  when: conditionSchema.optional(),
  label: z.string().max(80).optional(),
  /** Name to `node.field` (or `input.name`, `item`, `index`): the only data the target gets in mode artifact. */
  with: z.record(z.string(), z.string()).optional(),
  pass: z.enum(PASS_MODES).default("artifact"),
}).strict();
export type WorkflowEdge = z.infer<typeof edgeSchema>;

const trigger = z.object({
  type: z.enum(["chat", "schedule", "telegram", "manual"]),
  cron: z.string().max(120).optional(),
}).strict();

export const workflowSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, "workflow id: lowercase letters, digits and -"),
  name: z.string().min(1).max(80),
  description: bilingual,
  examples: z.object({ en: z.array(z.string().min(3).max(300)).max(20).default([]), ru: z.array(z.string().min(3).max(300)).max(20).default([]) }).strict().default({ en: [], ru: [] }),
  inputs: z.array(fieldSchema).max(30).default([]),
  outputs: z.array(fieldSchema).max(30).default([]),
  requires: z.object({
    plugins: z.array(z.string()).default([]), machines: z.array(z.string()).default([]),
    env: z.array(z.string()).default([]), browserSession: z.boolean().default(false),
  }).strict().default({ plugins: [], machines: [], env: [], browserSession: false }),
  status: z.enum(["draft", "tested", "published", "deprecated"]).default("draft"),
  version: z.number().int().min(1).default(1),
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
  quality_mode: z.enum(QUALITY_MODES).optional(),
  triggers: z.array(trigger).max(10).default([]),
  scope: z.object({
    level: z.enum(["builtin", "global", "project", "section"]).default("global"),
    projectId: z.string().optional(),
  }).strict().default({ level: "global" }),
  nodes: z.array(nodeSchema).min(1).max(60),
  edges: z.array(edgeSchema).min(1).max(200),
}).strict();

export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowInput = z.input<typeof workflowSchema>;
