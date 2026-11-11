import { randomUUID } from "node:crypto";

import { MissingValueError } from "./expr";
import { resolveTaskQualityMode } from "./quality-mode";
import { MAX_SUBWORKFLOW_DEPTH, START } from "./schema";
import type { QualityMode, Workflow } from "./schema";
import { lowerWorkflow } from "./lower";
import type { ResolveWorkflow } from "./lower";
import { definitionSha256 } from "./store";
import { WorkflowError } from "./validate";
import { checkOutput } from "./values";
import { goalsSchema } from "./goals";
import type { RunGoal } from "./goals";
import { compile } from "./compiled";
import { collectPins, pinKey } from "./pins";
import type { Pins } from "./pins";
import { requestGoals } from "./request-goals";
import type { RunSummary } from "./engine-types";
import { drive } from "./engine-drive";
import { deliver } from "./engine-routing";
import type { WorkflowEngine } from "./engine";

/** Starts a run, or returns the one that already has this key. `done` settles when the run stops: finished, waiting or stopped. */
export function start<R>(engine: WorkflowEngine, input: {
  workflow: Workflow; inputs?: Record<string, unknown>; key?: string; runtime?: R; mode?: QualityMode;
  link?: { projectId?: string; runId?: string; taskId?: string; attemptId?: string };
  parent?: { runId: string; stepKey: string }; depth?: number;
  /** K7: what the run is for; checked against its output before it closes. */
  goals?: RunGoal[];
  /** Where its children are found when they are not the engine's: a project's own library (2026-10-29 audit A-012). */
  resolve?: ResolveWorkflow;
  /** The children the parent chain was started with; a child run is given its parent's. */
  pins?: Pins;
}): { runId: string; created: boolean; done: Promise<RunSummary> } {
  const { workflow } = input;
  const existing = input.key ? engine.options.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE idem_key=?").get(input.key) as { id: string } | undefined : undefined;
  if (existing) {
    if (input.runtime !== undefined) engine.runtimes.set(existing.id, input.runtime);
    return { runId: existing.id, created: false, done: drive(engine, existing.id) };
  }
  const resolveChild: ResolveWorkflow = (id, version) => input.pins?.[pinKey(id, version)] ?? input.resolve?.(id, version) ?? engine.options.resolveWorkflow?.(id, version) ?? null;
  const problems = engine.preflight(workflow, resolveChild);
  if (problems.length) throw new WorkflowError(problems.map((message) => ({ level: "error" as const, code: "preflight", message })));
  const withDefaults = { ...(input.inputs ?? {}) };
  for (const field of workflow.inputs) if (withDefaults[field.name] === undefined && field.default !== undefined) withDefaults[field.name] = field.default;
  const inputs = checkOutput(workflow.inputs, withDefaults);
  const depth = input.depth ?? 0;
  if (depth > Math.min(workflow.guards.maxSubworkflowDepth, MAX_SUBWORKFLOW_DEPTH)) throw new MissingValueError("subworkflow_depth", `subworkflows go ${depth} deep; the limit is ${MAX_SUBWORKFLOW_DEPTH}`);
  // Contract and an explicit input beat the workflow; `fixed` still wins over an inherited `$mode`. full inside fixed quick is a conflict.
  const given = (input.inputs ?? {}).quality_mode;
  const explicitAsk = (["quick", "standard", "full"] as readonly unknown[]).includes(given);
  const picked = resolveTaskQualityMode({ asked: explicitAsk ? given : input.mode, explicitAsk, workflow: workflow.quality_mode ?? null });
  if (!picked.ok) throw new WorkflowError([{ level: "error", code: picked.code, message: picked.detail }]);
  const mode = picked.mode;
  // A user workflow judged by its goals and started without them (the PM's tool, a trigger, a schedule) is for the request in its inputs.
  const required = (workflow as { goal_audit?: string }).goal_audit === "required" && !input.parent;
  const goals = goalsSchema.parse(input.goals?.length ? input.goals : required ? requestGoals(inputs) : []);
  const runId = `wfrun_${randomUUID().replaceAll("-", "")}`;
  const j = engine.journal, at = engine.now();
  const pins = collectPins(workflow, resolveChild);
  const lowered: Workflow & { pinned?: Pins } = { ...lowerWorkflow(workflow, resolveChild), ...(Object.keys(pins).length ? { pinned: pins } : {}) };
  const c = compile(lowered);
  const entry = c.out.get(START)![0]!;
  j.db.transaction(() => {
    j.db.prepare(`INSERT INTO lane_pilot_wf_run(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,
      parent_run_id,parent_step_key,depth,status,mode,inputs_json,harness_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?)`)
      .run(runId, input.key ?? null, workflow.id, workflow.version, definitionSha256(workflow), JSON.stringify(lowered), input.link?.projectId ?? null, input.link?.runId ?? null,
        input.link?.taskId ?? null, input.link?.attemptId ?? null, input.parent?.runId ?? null, input.parent?.stepKey ?? null, depth, mode, JSON.stringify(inputs), engine.options.harnessVersion, at, at);
    if (goals.length) j.db.prepare("UPDATE lane_pilot_wf_run SET goals_json=? WHERE id=?").run(JSON.stringify(goals), runId);
    j.event(runId, null, "run", null, "running", `${workflow.id}@${workflow.version} mode ${mode}`);
    if (goals.length) j.event(runId, null, "goals", null, null, JSON.stringify({ goals, reason: "the goals the run started with", by: "start" }));
    engine.compiledRuns.set(runId, c);
    const run = j.getRun(runId)!;
    deliver(engine, run, c, null, entry.edge, entry.index, { scope: "", fromScope: "", suffix: "" });
  })();
  // A child run is started without a runtime: it is built from the run row (`runtimeFor`), as after a reload, not recorded as «none».
  if (input.runtime !== undefined) engine.runtimes.set(runId, input.runtime);
  return { runId, created: true, done: drive(engine, runId) };
}
