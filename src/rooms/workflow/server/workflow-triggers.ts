import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getActivation, getRun } from "../../storage";
import { cronProblem, localTimezone, timezoneProblem } from "@lane-pilot/workflow-engine/ui";
import { sha256 } from "../../storage";
import { preflightRefusal } from "@lane-pilot/workflow-engine";
import type { PreflightResult } from "@lane-pilot/workflow-engine";
import { isPipeline } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import type { StoredWorkflow, WorkflowStore } from "../../storage";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { SCHEDULE_RUN_KEY_PREFIX, type ChainRuntime } from "./workflow-runtime";

/**
 * Starting a workflow other than through the router (W9): the Run button of the tab, a schedule (a BB automation that calls
 * `bb lane-pilot workflow-trigger`), and a hook point for Telegram. Every start goes through the same checks the PM's
 * `lane_pilot_run_workflow` makes: the workflow is runnable, its inputs are whole, what it requires exists, and a PM chat of the
 * project is there to give its helper threads and questions a parent.
 */
export type TriggerSource = "manual" | "schedule" | "telegram";

export type TriggerResult =
  | { ok: true; runId: string; created: boolean; status: string; notChecked: string[] }
  | { ok: false; reason: string; message: string; issues?: PreflightResult["issues"]; envRequests?: PreflightResult["envRequests"]; missing?: string[] };

export type AutomationsPort = {
  create(input: { projectId: string; name: string; cron: string; timezone: string; script: string }): Promise<{ id: string }>;
  update(input: { projectId: string; automationId: string; name: string; cron: string; timezone: string; script: string }): Promise<void>;
  remove(input: { projectId: string; automationId: string }): Promise<void>;
};

const idSchema = z.object({ id: z.string().min(1) }).passthrough();

/** BB's automations plugin over its RPC: a script automation, so a tick needs no model and its run is recorded with the script's output. */
export function automationsOverRpc(ctx: ServerCore): AutomationsPort {
  const call = async <T,>(method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> => {
    const plugins = (ctx.bb.sdk as { plugins?: { callRpc?: (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown> } }).plugins;
    if (!plugins?.callRpc) throw new Error("this BB cannot call another plugin (plugins.callRpc)");
    return outputSchema.parse(await plugins.callRpc({ pluginId: "automations", method, input, outputSchema }));
  };
  const execution = (script: string) => ({ mode: "script" as const, script, interpreter: "bash" as const, timeoutMs: 120_000 });
  return {
    create: async (input) => {
      const made = await call("automations_create", { projectId: input.projectId, name: input.name, enabled: true, origin: "app",
        trigger: { triggerType: "schedule", cron: input.cron, timezone: input.timezone }, execution: execution(input.script) }, idSchema);
      return { id: made.id };
    },
    update: async (input) => {
      await call("automations_update", { projectId: input.projectId, automationId: input.automationId, name: input.name,
        trigger: { triggerType: "schedule", cron: input.cron, timezone: input.timezone }, execution: execution(input.script) }, z.unknown());
    },
    remove: async (input) => { await call("automations_delete", { projectId: input.projectId, automationId: input.automationId }, z.unknown()); },
  };
}

/** The script a schedule's automation runs: the plugin's own CLI, with the project, the inputs of the trigger and the tick's id (so a retried tick is the same run). */
export function triggerScript(workflowId: string, inputs: Record<string, unknown> = {}): string {
  const quoted = JSON.stringify(inputs).split("'").join("'\\''");
  return `#!/usr/bin/env bash\nset -euo pipefail\nbb lane-pilot workflow-trigger "$BB_PROJECT_ID" '${workflowId}' '${quoted}' "\${BB_AUTOMATION_RUN_ID:-}"\n`;
}

const isGone = (cause: unknown): boolean => /not.?found|no such|does not exist/i.test(cause instanceof Error ? cause.message : String(cause));

type DesiredSchedule = { workflow: Workflow; slot: number; cron: string; timezone: string; inputs: Record<string, unknown>; signature: string };

/** The schedules an own, published workflow asks for in one project: the project it runs in is the trigger's `projectId`, else the project of a project workflow. */
export function desiredSchedules(items: StoredWorkflow[], projectId: string): DesiredSchedule[] {
  const wanted: DesiredSchedule[] = [];
  for (const item of items) {
    if (item.origin === "builtin" || item.workflow.status !== "published" || item.workflow.internal) continue;
    const { workflow } = item;
    workflow.triggers.forEach((trigger, slot) => {
      if (trigger.type !== "schedule" || !trigger.cron) return;
      const home = trigger.projectId ?? (workflow.scope.level === "project" ? workflow.scope.projectId : undefined);
      if (home !== projectId) return;
      if (cronProblem(trigger.cron) || (trigger.timezone && timezoneProblem(trigger.timezone))) return;
      const timezone = trigger.timezone ?? localTimezone();
      const inputs = trigger.inputs ?? {};
      wanted.push({ workflow, slot, cron: trigger.cron, timezone, inputs, signature: sha256(JSON.stringify([workflow.id, workflow.version, trigger.cron, timezone, inputs])).slice(0, 24) });
    });
  }
  return wanted;
}

export type TriggerDeps = {
  /** The workflows of a project's view of the library (built-in, global, the project's own). */
  loadStore(projectId?: string): Promise<{ store: WorkflowStore; project: "not_requested" | "ok" | "no_machine" | "unavailable" }>;
  preflight?(workflow: Workflow, input: { projectId: string; threadId?: string | null }): Promise<PreflightResult>;
  automations?: AutomationsPort;
  now?: () => number;
};

export function createWorkflowTriggers(ctx: ServerCore, services: Pick<Services, "workflowEngine"> & Partial<Pick<Services, "workflowCatalog">>, deps: TriggerDeps) {
  const { db } = ctx;
  const now = deps.now ?? Date.now;

  /** The PM chat that gives a run its helper threads: the project's active one, else the newest open run that has a chat. */
  function pmOf(projectId: string): { pmThreadId: string; runId: string } | null {
    const activation = getActivation(db, projectId);
    const active = activation ? getRun(db, activation.run_id) : undefined;
    if (active && !active.closed_at && active.pm_thread_id) return { pmThreadId: active.pm_thread_id, runId: active.id };
    const row = db.prepare("SELECT id, pm_thread_id FROM lane_pilot_run WHERE kind='cli' AND project_id=? AND closed_at IS NULL AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string; pm_thread_id: string } | undefined;
    return row ? { pmThreadId: row.pm_thread_id, runId: row.id } : null;
  }

  const refuse = (reason: string, message: string, extra: Partial<Extract<TriggerResult, { ok: false }>> = {}): TriggerResult => ({ ok: false, reason, message, ...extra });

  async function start(input: { projectId: string; workflowId: string; inputs: Record<string, unknown>; source: TriggerSource; key?: string | undefined; liveTrial?: boolean | undefined; origin?: "schedule" | undefined }): Promise<TriggerResult> {
    const { store } = await deps.loadStore(input.projectId);
    const stored = store.get(input.workflowId);
    if (!stored) return refuse("unknown_workflow", `There is no workflow "${input.workflowId}".`);
    const { workflow } = stored;
    if (isPipeline(workflow) || workflow.internal) return refuse("not_runnable", `"${workflow.id}" is not a workflow to start by hand.`);
    const trial = workflow.status === "tested" && input.liveTrial === true;
    if (workflow.status !== "published" && !trial) {
      return refuse("not_runnable", workflow.status === "tested"
        ? `"${workflow.id}" has passed its tests on stubs but never run for real: start it as a first live run to make it published.`
        : `"${workflow.id}" is ${workflow.status}; only published workflows start (a tested one as a first live run).`);
    }
    if (input.source === "telegram" && !workflow.triggers.some((trigger) => trigger.type === "telegram")) return refuse("no_trigger", `"${workflow.id}" does not list a telegram trigger.`);
    if (input.source === "schedule" && !workflow.triggers.some((trigger) => trigger.type === "schedule")) return refuse("no_trigger", `"${workflow.id}" no longer has a schedule trigger.`);

    const given = input.inputs;
    const missing = workflow.inputs.filter((field) => field.required && field.default === undefined && (given[field.name] === undefined || given[field.name] === null || given[field.name] === "")).map((field) => field.name);
    if (missing.length) return refuse("missing_inputs", `Missing inputs: ${missing.join(", ")}.`, { missing });

    const pm = pmOf(input.projectId);
    if (!pm) return refuse("no_pm_chat", "This project has no open Lane Pilot PM chat: a workflow run needs one for its helper threads and questions. Enable Lane Pilot in a chat of the project, then start again.");

    let notChecked: string[] = [];
    if (deps.preflight) {
      const check = await deps.preflight(workflow, { projectId: input.projectId, threadId: pm.pmThreadId });
      if (!check.ok) return refuse("requirements_missing", preflightRefusal(check), { issues: check.issues, envRequests: check.envRequests });
      notChecked = check.issues.map((issue) => issue.message);
    }

    // A run a schedule started (the board starts it as `manual`, a trigger as `schedule`) is marked by its key, which is all a reload keeps.
    const fromSchedule = input.source === "schedule" || input.origin === "schedule";
    const prefix = fromSchedule ? SCHEDULE_RUN_KEY_PREFIX : `wf-${input.source}:`;
    const key = input.key ? `${prefix}${input.projectId}:${workflow.id}:${input.key}` : `${prefix}${randomUUID()}`;
    const runtime: ChainRuntime = { ctx, services: services as Services, pmThreadId: pm.pmThreadId, projectId: input.projectId, runId: pm.runId, ...(fromSchedule ? { origin: "schedule" as const } : {}) };
    try {
      const started = services.workflowEngine.start({ workflow, inputs: given, key, runtime, link: { projectId: input.projectId, runId: pm.runId } });
      started.done.catch((cause: unknown) => ctx.log(`Lane Pilot workflow run ${started.runId} (${workflow.id}) stopped with an error: ${cause instanceof Error ? cause.message : String(cause)}`));
      return { ok: true, runId: started.runId, created: started.created, status: services.workflowEngine.get(started.runId)?.status ?? "running", notChecked };
    } catch (cause) {
      return refuse("cannot_start", cause instanceof Error ? cause.message : String(cause));
    }
  }

  const nameOf = (workflow: Workflow, slot: number) => `Lane Pilot: ${workflow.name.en}${slot > 0 ? ` (${slot + 1})` : ""}`.slice(0, 190);

  /**
   * Makes the automations match the workflows: one for every schedule trigger of an own, published workflow of the project, none
   * for anything else (a workflow that was unpublished, deprecated, lost its trigger, or whose tests went red). Idempotent; a
   * failing call leaves the row as it was and is tried again at the next sync.
   */
  async function sync(projectId: string): Promise<{ created: number; updated: number; removed: number; failed: string[]; complete: boolean }> {
    const result = { created: 0, updated: 0, removed: 0, failed: [] as string[], complete: false };
    const port = deps.automations;
    if (!port) return result;
    const { store, project } = await deps.loadStore(projectId);
    // Without the project's own files the list is short, and a short list would delete the schedules of workflows that are fine: then nothing is removed.
    const complete = project === "ok";
    result.complete = complete;
    const wanted = desiredSchedules(store.list(), projectId);
    const rows = db.prepare("SELECT workflow_id, slot, automation_id, signature FROM lane_pilot_wf_trigger WHERE project_id=?").all(projectId) as Array<{ workflow_id: string; slot: number; automation_id: string; signature: string }>;
    const same = (row: { workflow_id: string; slot: number }, item: DesiredSchedule) => row.workflow_id === item.workflow.id && row.slot === item.slot;
    for (const item of wanted) {
      const row = rows.find((candidate) => same(candidate, item));
      const spec = { projectId, name: nameOf(item.workflow, item.slot), cron: item.cron, timezone: item.timezone, script: triggerScript(item.workflow.id, item.inputs) };
      try {
        if (!row) {
          const made = await port.create(spec);
          db.prepare("INSERT OR REPLACE INTO lane_pilot_wf_trigger(workflow_id, project_id, slot, automation_id, signature, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(item.workflow.id, projectId, item.slot, made.id, item.signature, now(), now());
          result.created += 1;
        } else if (row.signature !== item.signature) {
          try { await port.update({ ...spec, automationId: row.automation_id }); }
          catch (cause) {
            // The owner deleted it in the Automations tab: make it again.
            if (!isGone(cause)) throw cause;
            const made = await port.create(spec);
            db.prepare("UPDATE lane_pilot_wf_trigger SET automation_id=? WHERE workflow_id=? AND project_id=? AND slot=?").run(made.id, item.workflow.id, projectId, item.slot);
          }
          db.prepare("UPDATE lane_pilot_wf_trigger SET signature=?, updated_at=? WHERE workflow_id=? AND project_id=? AND slot=?").run(item.signature, now(), item.workflow.id, projectId, item.slot);
          result.updated += 1;
        }
      } catch (cause) { result.failed.push(`${item.workflow.id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    // A workflow that is in the list and no longer wanted (deprecated, a draft, no schedule) is removed whatever else is missing; one that is not in the list is removed only when the list is whole.
    for (const row of rows.filter((candidate) => !wanted.some((item) => same(candidate, item)) && (complete || store.get(candidate.workflow_id) !== null))) {
      try {
        await port.remove({ projectId, automationId: row.automation_id }).catch((cause: unknown) => { if (!isGone(cause)) throw cause; });
        db.prepare("DELETE FROM lane_pilot_wf_trigger WHERE workflow_id=? AND project_id=? AND slot=?").run(row.workflow_id, projectId, row.slot);
        result.removed += 1;
      } catch (cause) { result.failed.push(`${row.workflow_id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    if (result.failed.length) ctx.log(`Lane Pilot workflow schedules not fully synced: ${result.failed.join("; ")}`);
    return result;
  }

  return { start, sync, pmOf };
}
export type WorkflowTriggers = ReturnType<typeof createWorkflowTriggers>;
