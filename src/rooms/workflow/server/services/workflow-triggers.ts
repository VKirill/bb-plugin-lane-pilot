import { randomUUID } from "node:crypto";
import { orMiss, isNotFound } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { getActivation, getRun, loadProjectSettings, sha256, listOpenCliRuns, type LanePilotDatabase } from "../../../storage";
import { cronProblem, localTimezone, timezoneProblem } from "@lane-pilot/workflow-engine/ui";
import { loadPushConfig } from "../../../owner-waiting";
import { insertInboxEvent, isPipeline, markInboxEventConsumed, preflightRefusal, wfDeleteTrigger, wfSetTriggerAutomation, wfSetTriggerSignature, wfTriggersOfProject, wfUpsertTrigger } from "@lane-pilot/workflow-engine";
import type { PreflightResult } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import type { StoredWorkflow, WorkflowStore } from "../../../storage";
import type { ServerCore } from "../../../contracts/server";
import { isPmChat } from "../../../native-agent/server";

import { SCHEDULE_RUN_KEY_PREFIX } from "../../../contracts";
import type { ChainRuntime } from "../../../contracts/server";
import { LoopHookRefusal, prepareLoopWorkflow } from "../../models/loop-hooks";
import { WORKFLOW_DISABLED_KEY, parseWorkflowDisabled } from "../../settings";
import { resolveCanarySplit, type CanaryTrialTarget, type ResolveCanary } from "./canary-split";

import type { WorkflowEngineApi } from "./workflow";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

/**
 * Starting a workflow other than through the router (W9): the Run button of the tab and a schedule (a BB automation that calls
 * `bb lane-pilot workflow-trigger`). Every start goes through the same checks the PM's
 * `lane_pilot_run_workflow` makes: the workflow is runnable, its inputs are whole, what it requires exists, and a PM chat of the
 * project is there to give its helper threads and questions a parent.
 */
export type TriggerSource = "manual" | "schedule" | "event";
export type StartRefusalSource = TriggerSource | "pm";
export type StartRefusalReason = "board_paused" | "workflow_disabled";

/** Checks whether a workflow start is blocked by board pause (autonomous starts) or `workflow.disabled` (all starts). */
export function workflowStartRefusal(input: {
  db: LanePilotDatabase;
  workflowId: string;
  source: StartRefusalSource;
  projectId?: string | null;
  boardPaused?: boolean;
}): StartRefusalReason | null {
  if (input.boardPaused && (input.source === "event" || input.source === "schedule")) {
    return "board_paused";
  }
  const settings = loadProjectSettings(input.db, input.projectId || GLOBAL_SETTINGS_PROJECT_ID);
  if (parseWorkflowDisabled(settings[WORKFLOW_DISABLED_KEY]).has(input.workflowId)) {
    return "workflow_disabled";
  }
  return null;
}

function refusalMessage(workflowId: string, reason: StartRefusalReason): string {
  return reason === "board_paused"
    ? `Board is paused; autonomous start of "${workflowId}" refused.`
    : `Workflow "${workflowId}" is disabled by ${WORKFLOW_DISABLED_KEY}.`;
}

export type EmitEventOptions = { id?: string; key?: string; attemptKey?: string; projectId?: string };
export type EmitEventResult = {
  eventId: string;
  key: string;
  duplicate: boolean;
  woken: number;
  started: Array<{ workflowId: string; runId: string; created: boolean }>;
  failed: Array<{ workflowId: string; reason: string; message: string }>;
};

function matchesEventFilter(match: Record<string, string> | undefined, payload: Record<string, unknown>): boolean {
  if (!match) return true;
  for (const [path, expected] of Object.entries(match)) {
    let current: unknown = path in payload ? payload[path] : payload;
    if (!(path in payload)) {
      for (const part of path.split(".")) {
        if (!current || typeof current !== "object" || Array.isArray(current)) { current = undefined; break; }
        current = (current as Record<string, unknown>)[part];
      }
    }
    if (current === undefined || current === null || typeof current === "object") return false;
    if (String(current) !== expected) return false;
  }
  return true;
}

export type TriggerResult =
  | { ok: true; runId: string; created: boolean; status: string; notChecked: string[] }
  | { ok: false; reason: string; message: string; issues?: PreflightResult["issues"]; envRequests?: PreflightResult["envRequests"]; missing?: string[] };

export type ScheduleBoardPort = {
  save(raw: unknown, by: string): Promise<{ ok: true; schedule: { id: string } } | { ok: false; problems: string[] }>;
  remove(id: string): boolean;
};

type DesiredSchedule = { workflow: Workflow; slot: number; cron: string; timezone: string; inputs: Record<string, unknown>; signature: string };

/** The schedules an own, published workflow asks for in one project: the project it runs in is the trigger's `projectId`, else the project of a project workflow. */
export function desiredSchedules(items: StoredWorkflow[], projectId: string, zone: string = localTimezone()): DesiredSchedule[] {
  const wanted: DesiredSchedule[] = [];
  for (const item of items) {
    if (item.origin === "builtin" || item.workflow.status !== "published" || item.workflow.internal) continue;
    const { workflow } = item;
    workflow.triggers.forEach((trigger, slot) => {
      if (trigger.type !== "schedule" || !trigger.cron) return;
      const home = trigger.projectId ?? (workflow.scope.level === "project" ? workflow.scope.projectId : undefined);
      if (home !== projectId) return;
      if (cronProblem(trigger.cron) || (trigger.timezone && timezoneProblem(trigger.timezone))) return;
      const timezone = trigger.timezone ?? zone;
      const inputs = trigger.inputs ?? {};
      wanted.push({ workflow, slot, cron: trigger.cron, timezone, inputs, signature: sha256(JSON.stringify([workflow.id, workflow.version, trigger.cron, timezone, inputs])).slice(0, 24) });
    });
  }
  return wanted;
}

export type TriggerDeps = {
  /** The workflows of a project's view of the library (built-in, global, the project's own). */
  loadStore(projectId?: string): Promise<{ store: WorkflowStore; project: "not_requested" | "ok" | "no_machine" | "unavailable"; loopHooks?: { manifest: import("../../models/loop-hooks").LoopHookManifest | null; sha256: string | null; error?: string } }>;
  preflight?(workflow: Workflow, input: { projectId: string; threadId?: string | null }): Promise<PreflightResult>;
  scheduleBoard?: ScheduleBoardPort;
  isBoardPaused?: () => boolean;
  resolveCanary?: ResolveCanary | undefined;
  now?: () => number;
};

export type { CanaryTrialTarget, ResolveCanary };

/** Projects whose PM-chat metadata is currently unreadable: the failure is logged once per streak, not every tick. */
const pmMetadataFailing = new Set<string>();

export function createWorkflowTriggers(ctx: ServerCore, services: Pick<Services, "workflowEngine"> & Partial<Pick<Services, "workflowCatalog">>, deps: TriggerDeps) {
  const { db } = ctx;
  const now = deps.now ?? Date.now;
  const bbLog = (ctx.bb as { log?: { debug?: (m: string) => void; info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void } })?.log;
  const eventLog = {
    debug: (m: string) => { bbLog?.debug ? bbLog.debug(m) : ctx.log(m); },
    info: (m: string) => { bbLog?.info ? bbLog.info(m) : ctx.log(m); },
    warn: (m: string) => { bbLog?.warn ? bbLog.warn(m) : ctx.log(m); },
    error: (m: string) => { bbLog?.error ? bbLog.error(m) : ctx.log(m); },
  };

  /** The PM chat that gives a run its helper threads, with the unknown outcome named. */
  async function pmOfResolved(projectId: string): Promise<{ pmThreadId: string; runId: string } | null | "unknown"> {
    const activation = getActivation(db, projectId);
    const active = activation ? getRun(db, activation.run_id) : undefined;
    if (active && !active.closed_at && active.pm_thread_id) return { pmThreadId: active.pm_thread_id, runId: active.id };
    const rows = listOpenCliRuns(db, projectId);
    // A workflow architect's chat has an open run and the role pm too (its tools need it), marked by architectProjectId: a scheduled
    // report sent there was read as someone else's (live, 2026-10-25). Only the owner's PM chat takes a run.
    let unknown = false;
    for (const row of rows) {
      // One unreadable chat is unknown, not "no PM": the tick waits for a clean read instead of starting without a PM chat.
      let metadata: Record<string, unknown> | null = null;
      try { metadata = await orMiss(ctx.bb.sdk.threads.getPluginMetadata({ threadId: row.pm_thread_id }), null, isNotFound) as Record<string, unknown> | null; }
      catch (cause) {
        unknown = true;
        if (!pmMetadataFailing.has(projectId)) {
          pmMetadataFailing.add(projectId);
          ctx.log(`Lane Pilot workflow trigger: the metadata of ${row.pm_thread_id} could not be read (${cause instanceof Error ? cause.message : String(cause)}); the tick waits for a clean read`);
        }
        continue;
      }
      pmMetadataFailing.delete(projectId);
      // A chat that runs a specialist has a run and the role pm as well (its tools need them) but does not lead the project.
      if (metadata?.role === "pm" && !metadata.architectProjectId && await isPmChat(ctx, row.pm_thread_id)) return { pmThreadId: row.pm_thread_id, runId: row.id };
    }
    return unknown ? "unknown" : null;
  }

  /** The PM chat for the callers that only need a chat: unknown reads as none. */
  async function pmOf(projectId: string): Promise<{ pmThreadId: string; runId: string } | null> {
    const resolved = await pmOfResolved(projectId);
    return resolved === "unknown" ? null : resolved;
  }

  /** The same, with the unknown outcome named: a tick that must not start without a PM chat reads it. */
  async function pmOfOrUnknown(projectId: string): Promise<{ pmThreadId: string; runId: string } | null | "unknown"> {
    return await pmOfResolved(projectId);
  }

  const refuse = (reason: string, message: string, extra: Partial<Extract<TriggerResult, { ok: false }>> = {}): TriggerResult => ({ ok: false, reason, message, ...extra });
  const isBoardPaused = (): boolean => deps.isBoardPaused
    ? deps.isBoardPaused()
    : Boolean((services as { schedules?: { pause?: { isPaused?: () => boolean } } }).schedules?.pause?.isPaused?.());

  function startRefusal(workflowId: string, source: StartRefusalSource, projectId?: string | null): StartRefusalReason | null {
    return workflowStartRefusal({ db, workflowId, source, projectId, boardPaused: isBoardPaused() });
  }

  async function start(input: { projectId: string; workflowId: string; inputs: Record<string, unknown>; source: TriggerSource; key?: string | undefined; liveTrial?: boolean | undefined; origin?: "schedule" | undefined;
    /** A run that is nobody's business but the project's (the lead's tick): no PM chat, no run link, hidden helpers in the project's folder even when a PM chat is open. */
    detached?: boolean | undefined;
    /** The starter a Lane Pilot system schedule names (schedule/server/system-schedules.ts): it may start the one starter graph whose `startedBy`
     * is this name. Only the schedule executor passes it, read from the row's `created_by`, which no caller chooses. */
    starter?: string | undefined }): Promise<TriggerResult> {
    const refusalSource: StartRefusalSource = input.origin === "schedule" ? "schedule" : input.source;
    const blocked = startRefusal(input.workflowId, refusalSource, input.projectId);
    if (blocked) {
      eventLog.info(`wf.start refused wf=${input.workflowId} source=${refusalSource} reason=${blocked}`);
      return refuse(blocked, refusalMessage(input.workflowId, blocked));
    }
    const loaded = await deps.loadStore(input.projectId);
    const { store } = loaded;
    const stored = store.get(input.workflowId);
    if (!stored) return refuse("unknown_workflow", `There is no workflow "${input.workflowId}".`);
    const baseWorkflow = stored.workflow;
    // A starter graph is Lane Pilot's own: never the PM's, a chat's or a hand trigger's. Its own system schedule is the one exception (0.1.562 live:
    // both worktree-cleanup schedules ended start_failed here, so no janitor pass ran at all).
    const ownStarter = isPipeline(baseWorkflow) && input.starter !== undefined && baseWorkflow.startedBy === input.starter;
    if ((isPipeline(baseWorkflow) && !ownStarter) || (baseWorkflow.internal && !ownStarter)) return refuse("not_runnable", `"${baseWorkflow.id}" is not a workflow to start by hand.`);
    const trial = baseWorkflow.status === "tested" && input.liveTrial === true;
    if (baseWorkflow.status !== "published" && !trial) {
      return refuse("not_runnable", baseWorkflow.status === "tested"
        ? `"${baseWorkflow.id}" has passed its tests on stubs but never run for real: start it as a first live run to make it published.`
        : `"${baseWorkflow.id}" is ${baseWorkflow.status}; only published workflows start (a tested one as a first live run).`);
    }
    if (input.source === "schedule" && !baseWorkflow.triggers.some((trigger) => trigger.type === "schedule")) return refuse("no_trigger", `"${baseWorkflow.id}" no longer has a schedule trigger.`);
    if (input.source === "event" && !baseWorkflow.triggers.some((trigger) => trigger.type === "event")) return refuse("no_trigger", `"${baseWorkflow.id}" does not list an event trigger.`);

    let workflow = baseWorkflow;
    let resolve = store.resolve;
    // Starter graphs (`startedBy`) are Lane Pilot's own internal pipelines (never loop-hook targets like lp.analyze/lp.plan/lp.close/ship),
    // so an unavailable project checkout or invalid loop-hooks manifest must never block event/schedule starters such as lp.landing-suite.
    if (!ownStarter) {
      if (loaded.loopHooks?.error) return refuse("loop_hooks_invalid", loaded.loopHooks.error);
      if (loaded.loopHooks?.manifest) {
        try {
          const prepared = prepareLoopWorkflow({ workflow: baseWorkflow, manifest: loaded.loopHooks.manifest, manifestSha256: loaded.loopHooks.sha256, resolve: store.resolve,
            status: (id, version) => { const item = store.get(id); return item && (version === undefined || item.workflow.version === version) ? { status: item.workflow.status, internal: item.workflow.internal, startedBy: item.workflow.startedBy } : null; } });
          workflow = prepared.workflow; resolve = prepared.resolve;
        } catch (cause) {
          return refuse("loop_hooks_invalid", cause instanceof LoopHookRefusal ? cause.message : cause instanceof Error ? cause.message : String(cause));
        }
      }
    }

    const given = input.inputs;
    const missing = workflow.inputs.filter((field) => field.required && field.default === undefined && (given[field.name] === undefined || given[field.name] === null || given[field.name] === "")).map((field) => field.name);
    if (missing.length) return refuse("missing_inputs", `Missing inputs: ${missing.join(", ")}.`, { missing });

    // A project that does not use Lane Pilot has no PM chat: the run then works on its own (hidden helper threads of the project, the owner's
    // questions and the end on his list). Steps that build code say so when they are reached.
    // The lead's tick (0.1.447 live): bound to the PM chat of a blocked run it inherited that chat's environment on a machine that was off and failed to start.
    const pm = input.detached || !input.projectId ? null : await pmOfOrUnknown(input.projectId);
    if (pm === "unknown") return refuse("pm_chat_unknown", "the owner's PM chat could not be read; the run is not started this tick");

    const canary = resolveCanarySplit({
      workflow,
      resolve,
      resolveCanary: deps.resolveCanary,
      store,
      ...(!ownStarter && loaded.loopHooks ? { loopHooks: loaded.loopHooks } : {}),
      log: eventLog,
    });
    workflow = canary.workflow;
    resolve = canary.resolve;

    let notChecked: string[] = [];
    if (deps.preflight) {
      const check = await deps.preflight(workflow, { projectId: input.projectId, ...(pm ? { threadId: pm.pmThreadId } : {}) });
      if (!check.ok) return refuse("requirements_missing", preflightRefusal(check), { issues: check.issues, envRequests: check.envRequests });
      notChecked = check.issues.map((issue) => issue.message);
    }

    // A run a schedule started (the board starts it as `manual`, a trigger as `schedule`) is marked by its key, which is all a reload keeps.
    const fromSchedule = input.source === "schedule" || input.origin === "schedule";
    const prefix = fromSchedule ? SCHEDULE_RUN_KEY_PREFIX : `wf-${input.source}:`;
    const key = input.key ? `${prefix}${input.projectId}:${workflow.id}:${input.key}` : `${prefix}${randomUUID()}`;
    const runtime: ChainRuntime = { ctx, services: services as Services, pmThreadId: pm?.pmThreadId ?? null, projectId: input.projectId, runId: pm?.runId ?? null, ...(fromSchedule ? { origin: "schedule" as const } : {}) };
    try {
      // The project's library finds its own children too; the run pins them, so a reload does not need the library again.
      const started = services.workflowEngine.start({
        workflow, inputs: given, key, runtime, resolve,
        link: { ...(input.projectId ? { projectId: input.projectId } : {}), ...(pm ? { runId: pm.runId } : {}) },
        ...(canary.runId ? { runId: canary.runId } : {}),
        ...(canary.arm ? { arm: canary.arm } : {}),
        ...(canary.trialId ? { trialId: canary.trialId } : {}),
      });
      started.done.catch((cause: unknown) => ctx.log(`Lane Pilot workflow run ${started.runId} (${workflow.id}) stopped with an error: ${cause instanceof Error ? cause.message : String(cause)}`));
      return { ok: true, runId: started.runId, created: started.created, status: services.workflowEngine.get(started.runId)?.status ?? "running", notChecked };
    } catch (cause) {
      return refuse("cannot_start", cause instanceof Error ? cause.message : String(cause));
    }
  }

  const nameOf = (workflow: Workflow, slot: number) => `Lane Pilot: ${workflow.name.en}${slot > 0 ? ` (${slot + 1})` : ""}`.slice(0, 120);

  /**
   * Makes the schedule-board rows match the workflows: one for every schedule trigger of an own, published workflow of the project, none
   * for anything else (a workflow that was unpublished, deprecated, lost its trigger, or whose tests went red). Idempotent; a
   * failing call leaves the row as it was and is tried again at the next sync.
   */
  async function sync(projectId: string): Promise<{ created: number; updated: number; removed: number; failed: string[]; complete: boolean }> {
    const result = { created: 0, updated: 0, removed: 0, failed: [] as string[], complete: false };
    const port = deps.scheduleBoard;
    if (!port) return result;
    const { store, project } = await deps.loadStore(projectId);
    // Without the project's own files the list is short, and a short list would delete the schedules of workflows that are fine: then nothing is removed.
    const complete = project === "ok";
    result.complete = complete;
    // A trigger without a zone runs in the owner's, not in the hub's (UTC).
    const wanted = desiredSchedules(store.list(), projectId, loadPushConfig(db).timezone);
    const rows = wfTriggersOfProject(db, projectId);
    const same = (row: { workflow_id: string; slot: number }, item: DesiredSchedule) => row.workflow_id === item.workflow.id && row.slot === item.slot;
    for (const item of wanted) {
      const row = rows.find((candidate) => same(candidate, item));
      const spec = {
        projectId,
        name: nameOf(item.workflow, item.slot),
        description: item.workflow.description.en.slice(0, 2000),
        task: { kind: "workflow" as const, workflowId: item.workflow.id, inputs: item.inputs },
        when: { type: "cron" as const, cron: item.cron, timezone: item.timezone },
      };
      const by = `workflow:${item.workflow.id}:${item.slot}`;
      try {
        if (!row) {
          const saved = await port.save(spec, by);
          if (!saved.ok) { result.failed.push(`${item.workflow.id}: ${saved.problems.join("; ")}`); continue; }
          wfUpsertTrigger(db, { workflowId: item.workflow.id, projectId, slot: item.slot, automationId: saved.schedule.id, signature: item.signature, now: now() });
          result.created += 1;
        } else if (row.signature !== item.signature) {
          let saved = await port.save({ ...spec, id: row.automation_id }, by);
          if (!saved.ok && saved.problems.some((problem) => /there is no schedule/i.test(problem))) {
            // The owner deleted it on the schedule board: make it again.
            saved = await port.save(spec, by);
            if (saved.ok) wfSetTriggerAutomation(db, saved.schedule.id, { workflowId: item.workflow.id, projectId, slot: item.slot });
          }
          if (!saved.ok) { result.failed.push(`${item.workflow.id}: ${saved.problems.join("; ")}`); continue; }
          wfSetTriggerSignature(db, item.signature, now(), { workflowId: item.workflow.id, projectId, slot: item.slot });
          result.updated += 1;
        }
      } catch (cause) { result.failed.push(`${item.workflow.id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    // A workflow that is in the list and no longer wanted (deprecated, a draft, no schedule) is removed whatever else is missing; one that is not in the list is removed only when the list is whole.
    for (const row of rows.filter((candidate) => !wanted.some((item) => same(candidate, item)) && (complete || store.get(candidate.workflow_id) !== null))) {
      try {
        port.remove(row.automation_id);
        wfDeleteTrigger(db, { workflowId: row.workflow_id, projectId, slot: row.slot });
        result.removed += 1;
      } catch (cause) { result.failed.push(`${row.workflow_id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    if (result.failed.length) ctx.log(`Lane Pilot workflow schedules not fully synced: ${result.failed.join("; ")}`);
    return result;
  }

  /**
   * Records an event into `lane_pilot_wf_inbox` (insert-or-ignore), wakes any matching waiting steps,
   * and starts every published graph whose `{ type: "event" }` trigger matches. Idempotent per event id.
   */
  async function emitEvent(name: string, payload: Record<string, unknown> = {}, options: EmitEventOptions = {}): Promise<EmitEventResult> {
    const eventId = options.id ?? (typeof payload.eventId === "string" && payload.eventId ? payload.eventId : typeof payload.id === "string" && payload.id ? payload.id : randomUUID());
    const key = options.key ?? (typeof payload.eventKey === "string" ? payload.eventKey : typeof payload.key === "string" ? payload.key : typeof payload.threadId === "string" ? payload.threadId : "");
    const attemptKey = options.attemptKey ?? (typeof payload.attemptKey === "string" && payload.attemptKey ? payload.attemptKey : undefined);
    const projectId = options.projectId ?? (typeof payload.projectId === "string" && payload.projectId ? payload.projectId : undefined);

    const inserted = insertInboxEvent(db, {
      id: eventId,
      name,
      key,
      payload: { ...payload, ...(attemptKey ? { attemptKey } : {}) },
      createdAt: now(),
    });
    if (!inserted) {
      eventLog.warn(`wf.event duplicate event id skipped name=${name} id=${eventId}`);
      return { eventId, key, duplicate: true, woken: 0, started: [], failed: [] };
    }

    const woken = await services.workflowEngine.wake(name, key, payload, { eventId, ...(attemptKey ? { attemptKey } : {}) });
    const loaded = await deps.loadStore(projectId);
    const matching: Array<{ workflow: Workflow; trigger: Workflow["triggers"][number] }> = [];
    const seen = new Set<string>();
    for (const item of loaded.store.list()) {
      const wf = item.workflow;
      if (wf.status !== "published" || wf.internal || seen.has(wf.id)) continue;
      const hit = wf.triggers.find((itemTrigger) => {
        if (itemTrigger.type !== "event" || itemTrigger.event !== name) return false;
        if (itemTrigger.projectId && projectId && itemTrigger.projectId !== projectId) return false;
        return matchesEventFilter(itemTrigger.match, payload);
      });
      if (hit) {
        seen.add(wf.id);
        matching.push({ workflow: wf, trigger: hit });
      }
    }

    eventLog.debug(`wf.event emitted name=${name} key=${key} matched=${woken + matching.length}`);

    const started: Array<{ workflowId: string; runId: string; created: boolean }> = [];
    const failed: Array<{ workflowId: string; reason: string; message: string }> = [];
    if (matching.length > 0 && startRefusal(matching[0]!.workflow.id, "event", projectId) === "board_paused") {
      // Leave the inbox row unconsumed (`consumed_by IS NULL`) so the event retries once the pause lifts.
      for (const { workflow } of matching) {
        eventLog.info(`wf.start refused wf=${workflow.id} source=event reason=board_paused`);
        failed.push({ workflowId: workflow.id, reason: "board_paused", message: refusalMessage(workflow.id, "board_paused") });
      }
      return { eventId, key, duplicate: false, woken, started, failed };
    }
    for (const { workflow, trigger: matchedTrigger } of matching) {
      const targetProjectId = matchedTrigger.projectId ?? projectId ?? (workflow.scope.level === "project" ? workflow.scope.projectId : undefined) ?? "";
      const blocked = startRefusal(workflow.id, "event", targetProjectId);
      if (blocked) {
        eventLog.info(`wf.start refused wf=${workflow.id} source=event reason=${blocked}`);
        failed.push({ workflowId: workflow.id, reason: blocked, message: refusalMessage(workflow.id, blocked) });
        if (blocked === "workflow_disabled") {
          markInboxEventConsumed(db, eventId, `disabled:${workflow.id}`);
        }
        continue;
      }
      const starter = isPipeline(workflow)
        && (workflow.startedBy === `event:${name}`
          || (workflow.startedBy?.startsWith("event:") && matchedTrigger.type === "event" && matchedTrigger.event === name))
        ? workflow.startedBy
        : undefined;
      try {
        const res = await start({
          projectId: targetProjectId,
          workflowId: workflow.id,
          inputs: { ...payload, ...(matchedTrigger.inputs ?? {}) },
          source: "event",
          key: eventId,
          ...(starter ? { starter, detached: true } : {}),
        });
        if (res.ok) {
          started.push({ workflowId: workflow.id, runId: res.runId, created: res.created });
          eventLog.info(`wf.event started run=${res.runId} graph=${workflow.id}`);
        } else {
          failed.push({ workflowId: workflow.id, reason: res.reason, message: res.message });
          eventLog.error(`wf.event start failed graph=${workflow.id} reason=${res.reason} message=${res.message}`);
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        failed.push({ workflowId: workflow.id, reason: "cannot_start", message });
        eventLog.error(`wf.event start failed graph=${workflow.id} reason=cannot_start message=${message}`);
      }
    }

    return { eventId, key, duplicate: false, woken, started, failed };
  }

  return { start, emitEvent, sync, pmOf, pmOfOrUnknown, startRefusal };
}
export type WorkflowTriggers = ReturnType<typeof createWorkflowTriggers>;
