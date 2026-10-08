import packageJson from "../../../../package.json";
import { failureClass } from "../../../failure-class";
import type { LanePilotDatabase } from "../../storage/database";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../../contracts";
import { scheduleIsolated } from "../../../server/schedules";
import type { ServerCore } from "../../../server/core";

/**
 * Canary and error budget for Lane Pilot's own releases (G7). A new version is watched while its first attempts finish:
 * if too many of them failed on Lane Pilot's own fault (failure class «harness»: `internal_error`, `merge_failed`, spawn
 * and reconcile errors, …), the PMs of the affected tasks and the log are told once, with the command that rolls back.
 * Separately a 7-day budget over all versions says whether a routine deploy is wise (`budget.exhausted`); only an incident
 * deploy goes out while it is. Sandbox projects and drill tasks are left out of both (`SANDBOX_PROJECT_ID`, `isSandboxProjectName`, `isDrillTask`). Both read the plugin's own database (`lane_pilot_attempt.harness_version`), never write to it.
 *
 * Nothing here changes how a task runs: a tripped canary does not stop the version, it makes a human decide. Run from the
 * Mac mini with `scripts/lp-canary.sh` (RPC `canary_status`), which exits 1 when the canary tripped or the budget is spent.
 */
const VERSION: string = packageJson.version;
export const CANARY_MAX_ATTEMPTS = 20;
export const CANARY_MAX_MINUTES = 120;
/** Own-fault share of finished attempts above which the canary trips and the budget is spent. */
export const ERROR_BUDGET = 0.05;
/** A tripped canary needs this many faults: one bad attempt in three is noise, not a verdict. */
export const CANARY_MIN_FAULTS = 3;
export const BUDGET_DAYS = 7;
/** Attempts a 7-day window needs before its rate means anything. */
export const BUDGET_MIN_ATTEMPTS = 20;
const SINCE_KEY = (version: string) => `canary:since:${version}`;
const ALERTED_KEY = (version: string) => `canary:alerted:${version}`;

/**
 * Sandbox and drill traffic is not the product's: the drill's sandbox project, every project named «LP sandbox …» or «LP native …» and
 * the drill's tasks (`drill-*`, scripts/lp-drill.sh) fail on purpose and would spend the budget of the real projects (audit 2026-10-08
 * round 4, P1-12). The same rule as scripts/lp-metrics-views.sql (`scope`), which tests/lp-metrics.test.ts keeps in step.
 */
export const SANDBOX_PROJECT_ID = "proj_3tb652jpsi";
export const isSandboxProjectName = (name: string | null | undefined): boolean => typeof name === "string" && (name.startsWith("LP sandbox") || name.startsWith("LP native"));
export const isDrillTask = (taskId: string): boolean => taskId.startsWith("drill-");

const FAILED_STATES = ["blocked", "provider_error", "timeout", "empty_output", "validation_failed", "spawn_rejected"];
type Row = { id: string; run_id: string; task_id: string; state: string; reason: string | null; project_id: string; pm_thread_id: string | null };

export type CanaryFault = { projectId: string; runId: string; taskId: string; pmThreadId: string | null; reason: string };
export type CanaryReport = {
  version: string;
  since: number;
  window: { open: boolean; attempts: number; minutes: number; maxAttempts: number; maxMinutes: number };
  faults: number;
  rate: number;
  tripped: boolean;
  samples: CanaryFault[];
  /** `faults` are the harness faults and the dirty-base ones (`dirtyBase` says how many of them). */
  budget: { days: number; attempts: number; faults: number; dirtyBase: number; rate: number; limit: number; exhausted: boolean };
  previousVersion: string | null;
  rollback: string | null;
};

const asFault = (row: Row): boolean => row.state !== "accepted" && failureClass(row.state, row.reason) === "harness";
/**
 * A merge refused over uncommitted edits in the base checkout: the work did not land, so the 7-day budget counts it, but no
 * release caused it, so the version's canary does not (audit 2026-10-08 round 2, B5: as a free `merge` it was in neither).
 */
const asBudgetFault = (row: Row): boolean => row.state !== "accepted" && ["harness", "dirty_base"].includes(failureClass(row.state, row.reason));

function selectFinished(db: LanePilotDatabase, where: string, args: unknown[], sandboxProjects: ReadonlySet<string> = new Set()): Row[] {
  return (db.prepare(`SELECT a.id, a.run_id, a.task_id, a.state, a.reason, r.project_id, r.pm_thread_id FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state IN ('accepted',${FAILED_STATES.map(() => "?").join(",")}) AND ${where} ORDER BY a.created_at`)
    .all(...FAILED_STATES, ...args) as Row[])
    .filter((row) => row.project_id !== SANDBOX_PROJECT_ID && !sandboxProjects.has(row.project_id) && !isDrillTask(row.task_id));
}

/** The canary of `version` since it first ran, and the 7-day budget over every version. */
export function canaryReport(db: LanePilotDatabase, input: { version: string; since: number; now: number; sandboxProjects?: ReadonlySet<string> }): CanaryReport {
  const { version, since, now, sandboxProjects } = input;
  const own = selectFinished(db, "a.harness_version=? AND a.created_at>=?", [version, since], sandboxProjects).slice(0, CANARY_MAX_ATTEMPTS);
  const faultRows = own.filter(asFault);
  const minutes = Math.floor((now - since) / 60_000);
  const rate = own.length ? faultRows.length / own.length : 0;
  const week = selectFinished(db, "a.created_at>=?", [now - BUDGET_DAYS * 86_400_000], sandboxProjects);
  const weekFaults = week.filter(asBudgetFault).length;
  const weekDirtyBase = week.filter((row) => row.state !== "accepted" && failureClass(row.state, row.reason) === "dirty_base").length;
  const weekRate = week.length ? weekFaults / week.length : 0;
  const previous = db.prepare("SELECT harness_version FROM lane_pilot_attempt WHERE harness_version IS NOT NULL AND harness_version<>? AND created_at<? ORDER BY created_at DESC LIMIT 1")
    .get(version, since) as { harness_version: string } | undefined;
  const tripped = faultRows.length >= CANARY_MIN_FAULTS && rate > ERROR_BUDGET;
  return {
    version, since,
    window: { open: own.length < CANARY_MAX_ATTEMPTS && minutes < CANARY_MAX_MINUTES, attempts: own.length, minutes, maxAttempts: CANARY_MAX_ATTEMPTS, maxMinutes: CANARY_MAX_MINUTES },
    faults: faultRows.length, rate, tripped,
    samples: faultRows.slice(0, 5).map((row) => ({ projectId: row.project_id, runId: row.run_id, taskId: row.task_id, pmThreadId: row.pm_thread_id, reason: (row.reason ?? row.state).slice(0, 200) })),
    budget: { days: BUDGET_DAYS, attempts: week.length, faults: weekFaults, dirtyBase: weekDirtyBase, rate: weekRate, limit: ERROR_BUDGET, exhausted: week.length >= BUDGET_MIN_ATTEMPTS && weekRate > ERROR_BUDGET },
    previousVersion: previous?.harness_version ?? null,
    rollback: previous ? rollbackCommand(previous.harness_version) : null,
  };
}

/** What the owner runs on the Mac mini; the script prints the exact steps for that version from the deploy log. */
export const rollbackCommand = (version: string): string => `bash scripts/lp-canary.sh --rollback ${version}`;

export function canaryAlertText(report: CanaryReport): string {
  return `Lane Pilot ${report.version} canary: ${report.faults} of the first ${report.window.attempts} attempts since it started failed on Lane Pilot's own fault `
    + `(${Math.round(report.rate * 100)}%, budget ${Math.round(ERROR_BUDGET * 100)}%): ${report.samples.slice(0, 3).map((row) => `${row.taskId}: ${row.reason.slice(0, 120)}`).join("; ")}. `
    + `No action needed from you for these tasks (they are parked and restart once fixed); the owner decides on a rollback${report.rollback ? `: ${report.rollback} (in the lane-pilot checkout on the Mac mini)` : ""}.`;
}

export function createCanary(ctx: ServerCore) {
  const { bb, db } = ctx;

  async function since(version = VERSION, now = Date.now()): Promise<number> {
    const stored = await bb.storage.kv.get<number>(SINCE_KEY(version)).catch(() => null);
    if (typeof stored === "number") return stored;
    await bb.storage.kv.set(SINCE_KEY(version), now as never);
    return now;
  }

  /** The first time a version runs is its deploy time; called at start-up, and by every read as a fallback. */
  const noteStart = async (): Promise<void> => { await since(); };

  let sandboxCache: { at: number; ids: ReadonlySet<string> } | null = null;
  /** The ids of the projects named «LP sandbox …» / «LP native …»; a minute's memory, and none when BB cannot list projects. */
  async function sandboxProjects(now: number): Promise<ReadonlySet<string>> {
    if (sandboxCache && now - sandboxCache.at < 60_000) return sandboxCache.ids;
    const projects = (bb.sdk as unknown as { projects?: { list: (query: unknown) => Promise<Array<{ id: string; name?: string }>> } }).projects;
    let ids = new Set<string>(sandboxCache?.ids);
    try {
      if (projects) {
        const rows = [...await projects.list({ includePersonal: true }), ...await projects.list({ includePersonal: true, archived: true }).catch(() => [])];
        ids = new Set(rows.filter((row) => isSandboxProjectName(row.name)).map((row) => row.id));
      }
    } catch { /* keep the last answer: a project list that fails must not put the sandbox back into the budget */ }
    sandboxCache = { at: now, ids };
    return ids;
  }

  async function status(now = Date.now()): Promise<CanaryReport & { alerted: boolean }> {
    const report = canaryReport(db, { version: VERSION, since: await since(VERSION, now), now, sandboxProjects: await sandboxProjects(now) });
    return { ...report, alerted: Boolean(await bb.storage.kv.get(ALERTED_KEY(VERSION)).catch(() => null)) };
  }

  /** Tells the PMs of the faulting tasks once per version when the canary has tripped. Returns whether it did. */
  async function check(now = Date.now()): Promise<boolean> {
    const report = await status(now);
    if (!report.tripped || report.alerted) return false;
    await bb.storage.kv.set(ALERTED_KEY(VERSION), now as never);
    bb.log.warn(`Lane Pilot canary tripped: ${canaryAlertText(report)}`);
    const text = `Lane Pilot (canary alert):\n${canaryAlertText(report)}`;
    for (const threadId of new Set(report.samples.map((row) => row.pmThreadId).filter((id): id is string => Boolean(id)))) {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never)
        .catch((cause) => ctx.log(`Lane Pilot could not send the canary alert to ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
    return true;
  }

  return { status, check, noteStart };
}

export type Canary = ReturnType<typeof createCanary>;

export function canaryRpc(canary: Canary) {
  return { canary_status: async () => canary.status() } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "canary_status">;
}

export function mountCanary(ctx: ServerCore, canary: Canary): void {
  scheduleIsolated(ctx.bb, "canary-check", "*/10 * * * *", async () => {
    if (ctx.isDisposed()) return;
    await canary.check().catch((cause) => ctx.log(`Lane Pilot canary check skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 5 * 60_000 });
}
