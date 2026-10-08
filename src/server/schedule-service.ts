import { loadProjectSettings } from "../database";
import { QA_HOST_KEY, mapListedQaHosts } from "../qa-host";
import { fireList, findConflicts, runView, scheduleView } from "../schedule/board";
import { PRESET_SLUGS, presetSlug } from "@lane-pilot/models";
import { normalizeSchedule, type NormalizedWhen, type ScheduleDefinition, type ScheduleTask } from "../schedule/model";
import { scheduleFailureNotice } from "../schedule/outcome";
import { createScheduler } from "../schedule/scheduler";
import { taskOf, whenOf, type ScheduleRow } from "../schedule/store";
import type { ScheduleConflict, ScheduleView } from "../schedule/views";
import { configuredSetting } from "./context";
import type { ServerCore } from "./core";
import { allowedSecretNames } from "./secrets";
import { errandModelView, readErrandDefault } from "./schedule-default";
import { createThreadHosts, projectPlaces, whereOf, type ProjectPlace } from "./schedule-place";
import { NO_USAGE, scheduleCost, threadUsage } from "./schedule-usage";
import { createScheduleExecutors } from "./schedule-executors";
import type { Services } from "./services";
import { createWorkflowLibrary } from "./workflow-library";

/**
 * The schedule board's server side: the scheduler with its three executors, and what the screens, the CLI and the PM tools ask of it
 * (list with the next fire times, one schedule with its history, validation with warnings and machine conflicts, create / change,
 * pause, resume, run now, delete). Every path that changes a schedule goes through `save` / `remove` / `setPaused` here.
 */
export type SaveResult = { ok: true; schedule: ScheduleView; warnings: string[]; conflicts: ScheduleConflict[] } | { ok: false; problems: string[] };
export type PreviewResult = { ok: boolean; problems: string[]; warnings: string[]; conflicts: ScheduleConflict[]; nextFires: number[]; when: NormalizedWhen | null; timeoutSec: number | null };

const DEFAULT_NEXT = 5;
const MAX_NEXT = 50;
const CALENDAR_CAP = 300;

export function createScheduleService(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const library = createWorkflowLibrary(ctx, services);
  const scheduler = createScheduler({
    db, executors: createScheduleExecutors(ctx, services), isDisposed: ctx.isDisposed,
    log: (message) => bb.log.warn(`Lane Pilot schedule: ${message}`),
    onChange: (projectId) => ctx.realtime.notify(projectId, "schedule"),
    onFailure: ({ schedule, run, paused }) => {
      // One message to the PM chat for every failed run, not only the one that pauses the schedule (a monthly invoice that failed once
      // used to be visible in the log only); the pause-after-N rule stays as it was and is named in the message that triggers it.
      const notice = scheduleFailureNotice(schedule, run, paused);
      bb.log.warn(notice.split("\n", 1)[0]!);
      const pm = services.workflowTriggers.pmOf(schedule.project_id);
      if (pm) void ctx.ownerAsk?.sendToThread(pm.pmThreadId, notice).catch(() => undefined);
      else bb.log.warn(`Lane Pilot schedule «${schedule.name}»: no open PM chat in the project to tell about the failure`);
    },
  });
  const { store } = scheduler;

  async function hostOptions() {
    const listed = await (bb.sdk as unknown as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.().catch(() => []) ?? [];
    return mapListedQaHosts(listed).map((host) => ({ id: host.id, name: host.name, connected: host.connected }));
  }

  function machineOf(projectId: string, task: ScheduleTask): string | null {
    if (task.kind === "script") return task.hostId;
    if (task.kind !== "errand") return null;
    const host = configuredSetting(loadProjectSettings(db, projectId), QA_HOST_KEY);
    return typeof host === "string" && host.trim() ? host.trim() : null;
  }

  type Hosts = Awaited<ReturnType<typeof hostOptions>>;
  /** `extra` carries what only BB can tell (host names, the project's folder and section); without it `where` holds what the row itself knows. */
  function viewOf(row: ScheduleRow, next: number, extra?: { place?: ProjectPlace | undefined; hosts?: Hosts | undefined }): ScheduleView {
    const last = store.lastRuns([row.id]).get(row.id);
    const active = store.unfinishedRuns(row.id).filter((run) => run.status === "running" || run.status === "waiting");
    const task = taskOf(row);
    const model = task.kind === "errand" ? errandModelView(db, row.project_id, task) : null;
    const cost = model ? scheduleCost(db, row.id, model.model) : null;
    const where = whereOf(task, extra?.place, (id) => extra?.hosts?.find((host) => host.id === id)?.name ?? null);
    return scheduleView(row, { nextFires: scheduler.nextFires(row, Math.min(Math.max(next, 0), MAX_NEXT)), machine: machineOf(row.project_id, task), last, active, model, cost, where });
  }

  /** The views of rows with the names and folders BB knows: the project, its section, the machine. */
  async function viewsOf(rows: readonly ScheduleRow[], next: number): Promise<ScheduleView[]> {
    const [hosts, places] = await Promise.all([hostOptions(), projectPlaces(ctx, services, rows.map((row) => row.project_id))]);
    return rows.map((row) => viewOf(row, next, { hosts, place: places.get(row.project_id) }));
  }
  const view = async (id: string, next: number): Promise<ScheduleView | undefined> => {
    const row = store.get(id);
    return row ? (await viewsOf([row], next))[0] : undefined;
  };

  /** A stored schedule as the definition `save` takes, to change a part of it and save it again. */
  function definitionOf(row: ScheduleRow): Record<string, unknown> {
    const when = whenOf(row);
    return {
      id: row.id, projectId: row.project_id, name: row.name, description: row.description, task: taskOf(row),
      when: when.type === "cron" ? { type: "cron", cron: when.cron, timezone: when.timezone } : { type: "once", runAt: when.runAt },
      missed: row.missed_policy, missedLimit: row.missed_limit, overlap: row.overlap, timeoutSec: row.timeout_sec, maxFailures: row.max_failures,
    };
  }

  function list(input: { projectId?: string; next?: number }): ScheduleView[] {
    return store.list(input.projectId ? { projectId: input.projectId } : {}).map((row) => viewOf(row, input.next ?? DEFAULT_NEXT));
  }
  const listDetailed = (input: { projectId?: string; next?: number }) => viewsOf(store.list(input.projectId ? { projectId: input.projectId } : {}), input.next ?? DEFAULT_NEXT);
  const errandDefault = (projectId: string | null) => readErrandDefault(db, projectId);

  /** What stops a definition (problems) and what the owner should know (warnings). Reads, never writes. */
  async function check(definition: ScheduleDefinition & { when: NormalizedWhen }, selfId: string | undefined): Promise<{ problems: string[]; warnings: string[]; conflicts: ScheduleConflict[] }> {
    const problems: string[] = [], warnings: string[] = [];
    const { task } = definition;
    if (task.kind === "workflow") {
      const { store: workflows } = await library.loadStore(definition.projectId);
      const found = workflows.get(task.workflowId);
      if (!found) problems.push(`task.workflowId: there is no workflow "${task.workflowId}" in this project's library`);
      else {
        const workflow = found.workflow;
        const missing = workflow.inputs.filter((field) => field.required && field.default === undefined && (task.inputs[field.name] === undefined || task.inputs[field.name] === "")).map((field) => field.name);
        if (missing.length) problems.push(`task.inputs: the workflow needs ${missing.join(", ")}`);
        if (workflow.status !== "published") warnings.push(`workflow "${workflow.id}" is ${workflow.status}: a scheduled run is refused until it is published${workflow.status === "tested" ? " (run it once for real from the Workflows tab first)" : ""}`);
      }
    }
    if (task.kind === "errand") {
      if (task.providerId && !task.model) problems.push("task.providerId: a provider needs a model (task.model)");
      if (task.preset && !presetSlug(task.preset)) problems.push(`task.preset: no model preset "${task.preset}" (known: ${PRESET_SLUGS.join(", ")})`);
    }
    if (task.kind === "script" || task.kind === "errand") {
      const hosts = await hostOptions();
      const machine = machineOf(definition.projectId, task);
      if (task.kind === "script") {
        const host = hosts.find((row) => row.id === task.hostId);
        if (hosts.length && !host) problems.push(`task.hostId: no machine "${task.hostId}" (known: ${hosts.map((row) => row.id).join(", ") || "none"})`);
        else if (host && !host.connected) warnings.push(`machine ${host.name} is not connected now; a run while it is offline fails`);
      } else if (!machine) warnings.push("the project has no Browser QA machine set (Lane Pilot settings): an errand that needs the owner's browser will say so");
    }
    const names = task.kind === "script" ? task.env : task.kind === "errand" ? task.accounts : [];
    if (names.length) {
      const gate = await ctx.secrets.check({ declared: names, allowed: allowedSecretNames(loadProjectSettings(db, definition.projectId)), kinds: task.kind === "errand" ? ["secret", "login", "ssh", "ftp"] : ["secret", "login"] });
      if (gate.missing.length) warnings.push(`not in Env Catalog: ${gate.missing.join(", ")}`);
      if (gate.wrongKind.length) problems.push(`${gate.wrongKind.join(", ")}: not a kind this task can take`);
      if (gate.denied.length) warnings.push(`${gate.denied.join(", ")}: the project list «Secrets checks may use» (secrets.allow) leaves it out; add it there or the run fails`);
    }
    if ((task.kind === "workflow" || task.kind === "errand") && !services.workflowTriggers.pmOf(definition.projectId)) warnings.push("the project has no open Lane Pilot PM chat; a run needs one for its threads and questions");
    // The same job scheduled twice (a PM that did not call list first, a retried create) runs twice: say so, the caller decides.
    const twins = store.list({ projectId: definition.projectId, states: ["active", "paused"] }).filter((row) => row.id !== selfId
      && (row.name.trim().toLowerCase() === definition.name.trim().toLowerCase()
        || (JSON.stringify(taskOf(row)) === JSON.stringify(task) && JSON.stringify(whenOf(row)) === JSON.stringify(definition.when))));
    if (twins.length) warnings.push(`looks like a duplicate of ${twins.map((row) => `«${row.name}» (${row.id})`).join(", ")}: same name, or the same task at the same time; update or delete one of them if it is not meant`);
    const machine = machineOf(definition.projectId, task);
    const conflicts = machine
      ? findConflicts({ when: definition.when }, store.list({ projectId: definition.projectId, states: ["active"] })
        .filter((row) => row.id !== selfId).flatMap((row) => (machineOf(row.project_id, taskOf(row)) === machine ? [{ id: row.id, name: row.name, machine, when: whenOf(row) }] : [])), Date.now())
      : [];
    if (conflicts.length) warnings.push(`on ${machine}: ${conflicts.map((item) => `«${item.name}» starts within ${item.windowMinutes} min of this ${item.pairs} time(s) in the next 7 days`).join("; ")}`);
    return { problems, warnings, conflicts };
  }

  async function preview(raw: unknown, count = DEFAULT_NEXT): Promise<PreviewResult> {
    const normalized = normalizeSchedule(raw, Date.now());
    if (!normalized.ok) return { ok: false, problems: normalized.problems, warnings: [], conflicts: [], nextFires: [], when: null, timeoutSec: null };
    const selfId = typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : undefined;
    const checked = await check(normalized.value, selfId);
    return {
      ok: !checked.problems.length, ...checked, when: normalized.value.when, timeoutSec: normalized.value.timeoutSec,
      nextFires: fireList(normalized.value.when, Date.now(), Date.now() + 400 * 86_400_000, Math.min(count, MAX_NEXT)),
    };
  }

  /** Creates (no `id`) or replaces (`id`) a schedule. `by` names who asked: «owner», «ui», «cli» or an agent's thread. */
  async function save(raw: unknown, by: string): Promise<SaveResult> {
    const normalized = normalizeSchedule(raw, Date.now());
    if (!normalized.ok) return { ok: false, problems: normalized.problems };
    const id = normalized.value.id;
    const existing = id ? store.get(id) : undefined;
    if (id && !existing) return { ok: false, problems: [`id: there is no schedule ${id}`] };
    if (existing && existing.project_id !== normalized.value.projectId) return { ok: false, problems: ["projectId: a schedule cannot move to another project"] };
    const checked = await check(normalized.value, id);
    if (checked.problems.length) return { ok: false, problems: checked.problems };
    const row = existing ? store.update(existing.id, normalized.value)! : store.insert(normalized.value, { createdBy: by, state: "active" });
    bb.log.info(`Lane Pilot schedule ${existing ? "changed" : "created"}: ${row.id} «${row.name}» (${row.kind}) by ${by}`);
    ctx.realtime.notify(row.project_id, "schedule");
    return { ok: true, schedule: (await viewsOf([row], DEFAULT_NEXT))[0]!, warnings: checked.warnings, conflicts: checked.conflicts };
  }

  function remove(id: string): boolean {
    const row = store.get(id);
    if (!row) return false;
    const gone = store.remove(id);
    if (gone) { bb.log.info(`Lane Pilot schedule deleted: ${id} «${row.name}»`); ctx.realtime.notify(row.project_id, "schedule"); }
    return gone;
  }

  function setPaused(id: string, paused: boolean, reason?: string): ScheduleView | undefined {
    const row = store.get(id);
    if (!row) return undefined;
    if (paused) store.setState(id, "paused", reason ?? "paused by the owner");
    else store.setState(id, row.state === "paused" && row.trigger_type === "once" && row.cursor_at >= (row.run_at ?? 0) ? "done" : "active");
    ctx.realtime.notify(row.project_id, "schedule");
    return viewOf(store.get(id)!, DEFAULT_NEXT);
  }

  function runNow(id: string, key?: string) {
    const added = scheduler.runNow(id, key);
    if (!added) return undefined;
    if (added.created) scheduler.kick();
    return added;
  }

  async function cancelRun(runId: string): Promise<boolean> {
    const done = await scheduler.cancelRun(runId);
    const run = store.getRun(runId);
    const row = run ? store.get(run.schedule_id) : undefined;
    if (row) ctx.realtime.notify(row.project_id, "schedule");
    return done;
  }

  const runs = (id: string, limit = 50, offset = 0) => store.runsOf(id, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)).map(runView);
  const threadHost = createThreadHosts(ctx);
  /** The runs with what each used (model and cost from its thread's token usage) and the machine it ran on. */
  async function runsDetailed(id: string, limit = 50, offset = 0) {
    const hosts = await hostOptions();
    return Promise.all(runs(id, limit, offset).map(async (run) => {
      const thread = run.refKind === "thread" && run.refId ? run.refId : null;
      const hostId = (thread ? await threadHost(thread).catch(() => null) : null) ?? run.hostId;
      return { ...run, ...(thread ? threadUsage(db, thread) : NO_USAGE), hostName: hostId ? hosts.find((host) => host.id === hostId)?.name ?? hostId : null };
    }));
  }
  const runCount = (id: string): number => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_schedule_run WHERE schedule_id=?").get(id) as { n: number }).n;

  /** Planned fire times of the active schedules in [from, to] and the runs that happened in it, for a calendar. */
  function calendar(input: { projectId?: string; from: number; to: number }) {
    const planned: Array<{ scheduleId: string; at: number }> = [];
    const truncated: string[] = [];
    const rows = store.list(input.projectId ? { projectId: input.projectId } : {});
    for (const row of rows.filter((item) => item.state === "active")) {
      const times = fireList(whenOf(row), Math.max(input.from, Date.now()), input.to, CALENDAR_CAP + 1);
      if (times.length > CALENDAR_CAP) truncated.push(row.id);
      planned.push(...times.slice(0, CALENDAR_CAP).map((at) => ({ scheduleId: row.id, at })));
    }
    const past = (db.prepare(`SELECT * FROM lane_pilot_schedule_run WHERE scheduled_at>=? AND scheduled_at<=? AND status<>'skipped' AND schedule_id IN (${rows.map(() => "?").join(",") || "''"}) ORDER BY scheduled_at LIMIT 2000`)
      .all(input.from, Math.min(input.to, Date.now()), ...rows.map((row) => row.id)) as Parameters<typeof runView>[0][]).map(runView);
    return { planned: planned.sort((a, b) => a.at - b.at), past, truncated };
  }

  /** The tick of the core's isolated schedule: fire times become runs, runs are started and watched for the tick's budget. */
  const tick = (signal?: AbortSignal) => scheduler.tick(signal ? { signal } : {});

  return { schedules: { scheduler, store, list, listDetailed, view, errandDefault, runsDetailed, viewOf, definitionOf, preview, save, remove, setPaused, runNow, cancelRun, runs, runCount, calendar, tick, hostOptions } };
}
export type ScheduleService = ReturnType<typeof createScheduleService>["schedules"];
