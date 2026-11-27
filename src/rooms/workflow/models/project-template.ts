import { sha256Hex } from "@lane-pilot/kit";
import { QUALITY_MODE_SETTING } from "../../contracts";
import {
  normalizeWorkflow,
  outputFields,
  parseGoals,
  type Field,
  type FieldType,
  type RunRow,
  type WfChildRunStageRow,
  type Workflow,
} from "@lane-pilot/workflow-engine";

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const RESERVED_NODE_IDS = new Set(["start", "end", "done", "item", "index", "ctx", "input"]);

export type ProjectTemplateStage = {
  workflowId: string;
  version: number;
  inputsKeys: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function inferFieldType(value: unknown): FieldType {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  return "json";
}

function normalizedRootInputs(rawDef: Record<string, unknown>): Map<string, Field> {
  const map = new Map<string, Field>();
  const normalized = normalizeWorkflow(rawDef);
  if (!isRecord(normalized) || !Array.isArray(normalized.inputs)) return map;
  for (const item of normalized.inputs) {
    if (!isRecord(item) || typeof item.name !== "string" || !FIELD_NAME_RE.test(item.name)) continue;
    if (typeof item.type !== "string") continue;
    map.set(item.name, item as Field);
  }
  return map;
}

function buildTemplateInputs(
  rawInputs: Record<string, unknown>,
  declaredInputs: Map<string, Field>,
  hasGoals: boolean,
): Field[] {
  const fields: Field[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(rawInputs)) {
    if (key === "intakeTemplate" || key === "intakeConfidence") continue;
    if (!FIELD_NAME_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    const declared = declaredInputs.get(key);
    if (declared) {
      fields.push({
        name: key,
        type: declared.type,
        ...(declared.values ? { values: [...declared.values] } : {}),
        ...(declared.ref ? { ref: declared.ref } : {}),
        required: Boolean(declared.required),
      });
    } else {
      fields.push({
        name: key,
        type: inferFieldType(value),
        required: false,
      });
    }
  }
  if ((hasGoals || "goals" in rawInputs) && !seen.has("goals")) {
    fields.push({ name: "goals", type: "array", ref: "Goal", required: false });
  }
  return fields;
}

function uniqueNodeId(raw: string, used: Set<string>): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/[_-]+$/, "")
    .slice(0, 42);
  const base = NODE_ID_RE.test(cleaned) ? cleaned : "stage";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 48 - String(n).length - 1)}_${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `node_${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

function buildHumanNode(
  id: string,
  rootNode: Record<string, unknown> | undefined,
  awaitObj: Record<string, unknown>,
): Record<string, unknown> {
  const detail = isRecord(awaitObj.detail) ? awaitObj.detail : {};
  const rawQuestion = typeof rootNode?.question === "string" && rootNode.question.trim()
    ? rootNode.question.trim()
    : typeof rootNode?.prompt === "string" && rootNode.prompt.trim()
      ? rootNode.prompt.trim()
      : typeof detail.question === "string" && detail.question.trim()
        ? detail.question.trim()
        : "Owner decision";
  const rawOptions = Array.isArray(rootNode?.options)
    ? rootNode.options
    : Array.isArray(detail.options)
      ? detail.options
      : [];
  const options = rawOptions.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 10);
  const role = typeof rootNode?.role === "string" && rootNode.role.trim() ? rootNode.role.trim().slice(0, 80) : "owner";
  const normalizedRoot = rootNode ? normalizeWorkflow({ id: "tmp", name: "tmp", description: "tmp", nodes: [rootNode], edges: [] }) : null;
  const normNode = isRecord(normalizedRoot) && Array.isArray(normalizedRoot.nodes) && isRecord(normalizedRoot.nodes[0])
    ? normalizedRoot.nodes[0]
    : null;
  const out = Array.isArray(normNode?.out)
    ? normNode.out
    : options.length > 0
      ? [
          { name: "answer_kind", type: "enum", values: [...new Set([...options, "timeout"])], required: true },
          { name: "answer", type: "string", required: false },
        ]
      : [{ name: "answer", type: "string", required: false }];
  const onTimeout = rootNode?.onTimeout === "default" && typeof rootNode.defaultOption === "string" && options.includes(rootNode.defaultOption)
    ? "default"
    : "stop";
  return {
    id,
    type: "human",
    role,
    ...(isRecord(normNode?.title) ? { title: normNode.title } : {}),
    question: rawQuestion.slice(0, 4000),
    options,
    onTimeout,
    ...(onTimeout === "default" ? { defaultOption: rootNode!.defaultOption } : {}),
    ...(typeof normNode?.timeoutSec === "number" && normNode.timeoutSec >= 1 ? { timeoutSec: normNode.timeoutSec } : {}),
    out,
  };
}

function templateNames(rawDef: Record<string, unknown>, workflowId: string): {
  name: { en: string; ru: string };
  description: { en: string; ru: string };
} {
  const rawName = rawDef.name;
  const baseEn = isRecord(rawName) && typeof rawName.en === "string" && rawName.en.trim()
    ? rawName.en.trim()
    : typeof rawName === "string" && rawName.trim()
      ? rawName.trim()
      : workflowId;
  const baseRu = isRecord(rawName) && typeof rawName.ru === "string" && rawName.ru.trim()
    ? rawName.ru.trim()
    : baseEn;
  return {
    name: { en: `${baseEn} (template)`.slice(0, 2000), ru: `${baseRu} (шаблон)`.slice(0, 2000) },
    description: {
      en: `Reusable project template extracted from ${workflowId} stages.`,
      ru: `Шаблон проекта, собранный из этапов ${workflowId}.`,
    },
  };
}

export function templateWorkflowId(sourceWorkflowId: string, runId: string): string {
  const slug = sourceWorkflowId
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-.]+$/g, "")
    .slice(0, 28) || "project";
  return `${slug}-tpl-${sha256Hex(runId).slice(0, 8)}`;
}

/** Builds a `kind: "project"` template definition and sanitized metadata from a finished project run's stages and answered human steps. */
export function buildProjectTemplatePlan(input: {
  run: RunRow;
  rawDef: Record<string, unknown>;
  steps: ReadonlyArray<Record<string, unknown>>;
  childRuns: readonly WfChildRunStageRow[];
  projectId: string;
  scope: "global" | "project";
  resolveWorkflow: (id: string, version?: number) => Workflow | null;
}) {
  const { run, rawDef, steps, childRuns, projectId, scope, resolveWorkflow } = input;
  const rootNodesById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(rawDef.nodes)) {
    for (const node of rawDef.nodes) {
      if (isRecord(node) && typeof node.id === "string" && node.id) rootNodesById.set(node.id, node);
    }
  }

  const stepIndexByKey = new Map<string, { step: Record<string, unknown>; index: number }>();
  steps.forEach((step, index) => {
    if (typeof step.step_key === "string") stepIndexByKey.set(step.step_key, { step, index });
  });

  type TimelineItem =
    | { kind: "stage"; sortTime: number; sortOrder: number; stage: ProjectTemplateStage; rawNodeId: string }
    | { kind: "human"; sortTime: number; sortOrder: number; step: Record<string, unknown>; rootNode: Record<string, unknown> | undefined; awaitObj: Record<string, unknown> };

  const timeline: TimelineItem[] = [];
  const stages: ProjectTemplateStage[] = [];

  childRuns.forEach((child, idx) => {
    const childInputs = parseJsonObject(child.inputs_json);
    const stage: ProjectTemplateStage = {
      workflowId: child.workflow_id,
      version: Math.max(1, Number(child.workflow_version) || 1),
      inputsKeys: Object.keys(childInputs).filter((k) => FIELD_NAME_RE.test(k)),
    };
    stages.push(stage);
    const parentStep = stepIndexByKey.get(child.parent_step_key);
    const sortTime = parentStep
      ? Number(parentStep.step.started_at ?? parentStep.step.updated_at ?? child.created_at)
      : child.created_at;
    timeline.push({
      kind: "stage",
      sortTime,
      sortOrder: parentStep ? parentStep.index : idx,
      stage,
      rawNodeId: parentStep && typeof parentStep.step.node_id === "string"
        ? parentStep.step.node_id
        : child.parent_step_key.replace(/#\d+$/, "") || child.workflow_id,
    });
  });

  steps.forEach((step, idx) => {
    if (step.state !== "succeeded") return;
    const nodeId = typeof step.node_id === "string" ? step.node_id : "";
    const rootNode = rootNodesById.get(nodeId);
    const awaitObj = parseJsonObject(typeof step.await_json === "string" ? step.await_json : null);
    if (rootNode?.type !== "human" && awaitObj.kind !== "human") return;
    const output = parseJsonObject(typeof step.output_json === "string" ? step.output_json : null);
    const answerKind = typeof output.answer_kind === "string" ? output.answer_kind.trim() : "";
    if (answerKind === "skipped" || answerKind === "timeout") return;
    timeline.push({
      kind: "human",
      sortTime: Number(step.started_at ?? step.updated_at ?? 0),
      sortOrder: idx,
      step,
      rootNode,
      awaitObj,
    });
  });

  timeline.sort(
    (a, b) =>
      a.sortTime - b.sortTime ||
      a.sortOrder - b.sortOrder ||
      (a.kind === "stage" ? 0 : 1) - (b.kind === "stage" ? 0 : 1),
  );

  const rawInputs = parseJsonObject(run.inputs_json);
  const rootGoals = parseGoals(run.goals_json);
  const inputs = buildTemplateInputs(rawInputs, normalizedRootInputs(rawDef), rootGoals.length > 0);
  const rootInputNames = new Set(inputs.map((field) => field.name));

  const usedIds = new Set<string>(RESERVED_NODE_IDS);
  const builtStages: Array<{ id: string; outputNames: Set<string> }> = [];
  const nodes: Record<string, unknown>[] = [];
  const orderedIds: string[] = [];

  for (const item of timeline) {
    if (item.kind === "human") {
      const id = uniqueNodeId(typeof item.step.node_id === "string" ? item.step.node_id : "owner_decision", usedIds);
      nodes.push(buildHumanNode(id, item.rootNode, item.awaitObj));
      orderedIds.push(id);
      continue;
    }
    const { stage } = item;
    const id = uniqueNodeId(item.rawNodeId, usedIds);
    const childWf = resolveWorkflow(stage.workflowId, stage.version);
    const withMap: Record<string, string> = {};
    const mapKey = (key: string) => {
      if (key in withMap) return;
      if (rootInputNames.has(key)) {
        withMap[key] = `{{$inputs.${key}}}`;
        return;
      }
      for (let j = builtStages.length - 1; j >= 0; j -= 1) {
        const prev = builtStages[j]!;
        if (prev.outputNames.has(key)) {
          withMap[key] = `{{${prev.id}.${key}}}`;
          return;
        }
      }
    };
    for (const key of stage.inputsKeys) {
      if (childWf && !childWf.inputs.some((field) => field.name === key)) continue;
      mapKey(key);
    }
    if (childWf) {
      for (const field of childWf.inputs) {
        if (field.required && field.name !== QUALITY_MODE_SETTING) mapKey(field.name);
      }
    }
    const outputNames = new Set<string>(
      childWf ? (outputFields(childWf, undefined, resolveWorkflow) === "unknown" ? [] : childWf.outputs.map((f) => f.name)) : [],
    );
    builtStages.push({ id, outputNames });
    nodes.push({
      id,
      type: "subworkflow",
      workflow: stage.workflowId,
      version: stage.version,
      ...(Object.keys(withMap).length > 0 ? { with: withMap } : {}),
    });
    orderedIds.push(id);
  }

  nodes.push({ id: "done", type: "action", action: "emit", map: { status: "done" } });
  const edges: Array<{ from: string; to: string; pass: "artifact" }> = [
    { from: "start", to: orderedIds[0]!, pass: "artifact" },
  ];
  for (let i = 0; i < orderedIds.length - 1; i += 1) {
    edges.push({ from: orderedIds[i]!, to: orderedIds[i + 1]!, pass: "artifact" });
  }
  edges.push({ from: orderedIds[orderedIds.length - 1]!, to: "done", pass: "artifact" });

  const workflowId = templateWorkflowId(run.workflow_id, run.id);
  const { name, description } = templateNames(rawDef, run.workflow_id);
  const definition: Record<string, unknown> = {
    schemaVersion: 1,
    id: workflowId,
    name,
    description,
    kind: "project",
    tags: ["project-template"],
    inputs,
    outputs: [{ name: "status", type: "enum", values: ["done"], required: true }],
    status: "draft",
    version: 1,
    scope: scope === "project" ? { level: "project", projectId } : { level: "global" },
    nodes,
    edges,
  };
  const metadata = {
    source: "project-template",
    sourceRunIds: [run.id],
    stages,
    ...(rootGoals.length > 0 ? { goals: rootGoals.map((goal) => ({ id: goal.id })) } : {}),
  };

  return { workflowId, name, description, definition, metadata, stages };
}
