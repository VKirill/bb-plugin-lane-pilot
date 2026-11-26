import packageJson from "../../../../../package.json";
import { bestEffort } from "@lane-pilot/kit";
import { DRILL_SANDBOX_PROJECT_IDS, FAILED_ATTEMPT_STATES, failureClass, isDrillTask, isSandboxProjectName } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { setSandboxProjects } from "../../../owner-waiting";
import { sendServiceMessage } from "../../../relay/server";
import { canaryAttemptRows, previousHarnessVersion, type LanePilotDatabase } from "../../../storage";
import {
  CANARY_FAULT_LIMIT,
  CANARY_MAX_ATTEMPTS,
  CANARY_MAX_MINUTES,
  CANARY_MIN_FAULTS,
  REASON_SCAN_CHARS,
  canaryAlertText,
  poolHealth,
  rollbackCommand,
  type CanaryReport,
  type PoolBlockedWorker,
  type PoolReadiness,
} from "../../models/canary";

/**
 * Canary for Lane Pilot's own releases (G7). A new version is watched while its first attempts finish: if too many of
 * them failed on Lane Pilot's own fault (failure class «harness»: `internal_error`, `merge_failed`, spawn and reconcile
 * errors, …), the PMs of the affected tasks and the log are told once, with the command that rolls back. Sandbox projects
 * and drill tasks are left out (`SANDBOX_PROJECT_ID`, `isSandboxProjectName`, `isDrillTask`). It reads the plugin's own
 * database (`lane_pilot_attempt.harness_version`), never writes to it.
 *
 * Nothing here changes how a task runs: a tripped canary does not stop the version, it makes a human decide. Run from the
 * Mac mini with `scripts/lp-canary.sh` (RPC `canary_status`), which exits 1 when the canary tripped.
 */
const VERSION: string = packageJson.version;
const SINCE_KEY = (version: string) => `canary:since:${version}`;
const ALERTED_KEY = (version: string) => `canary:alerted:${version}`;

type Row = { id: string; run_id: string; task_id: string; state: string; reason: string | null; project_id: string; pm_thread_id: string | null };

const asFault = (row: Row): boolean => row.state !== "accepted" && failureClass(row.state, row.reason) === "harness";

/** The canary of `version` since it first ran. */
export function canaryReport(db: LanePilotDatabase, input: { version: string; since: number; now: number; sandboxProjects?: ReadonlySet<string> }): CanaryReport {
  const { version, since, now, sandboxProjects } = input;
  const own = canaryAttemptRows(db, FAILED_ATTEMPT_STATES, REASON_SCAN_CHARS, version, since)
    .filter((row) => !DRILL_SANDBOX_PROJECT_IDS.includes(row.project_id) && !(sandboxProjects ?? new Set()).has(row.project_id) && !isDrillTask(row.task_id))
    .slice(0, CANARY_MAX_ATTEMPTS);
  const faultRows = own.filter(asFault);
  const minutes = Math.floor((now - since) / 60_000);
  const rate = own.length ? faultRows.length / own.length : 0;
  const previous = previousHarnessVersion(db, version, since);
  const tripped = faultRows.length >= CANARY_MIN_FAULTS && rate > CANARY_FAULT_LIMIT;
  return {
    version, since,
    window: { open: own.length < CANARY_MAX_ATTEMPTS && minutes < CANARY_MAX_MINUTES, attempts: own.length, minutes, maxAttempts: CANARY_MAX_ATTEMPTS, maxMinutes: CANARY_MAX_MINUTES },
    faults: faultRows.length, rate, tripped,
    samples: faultRows.slice(0, 5).map((row) => ({ projectId: row.project_id, runId: row.run_id, taskId: row.task_id, pmThreadId: row.pm_thread_id, reason: (row.reason ?? row.state).slice(0, 200) })),
    previousVersion: previous,
    rollback: previous ? rollbackCommand(previous) : null,
  };
}

const POOL_READY_TTL_MS = 60_000;

export function createCanary(ctx: ServerCore, breaker?: () => { snapshot(now?: number): Array<{ key: string; state: string }> } | undefined, readiness?: () => Promise<PoolReadiness>) {
  const { bb, db } = ctx;
  // The walk visits every project's writer chain with its usage checks: one answer serves a minute of status calls.
  let cached: { at: number; ready: Promise<PoolReadiness | null> } | null = null;
  const readyPool = (now: number): Promise<PoolReadiness | null> => {
    if (!readiness) return Promise.resolve(null);
    if (!cached || now - cached.at >= POOL_READY_TTL_MS || now < cached.at) cached = { at: now, ready: bestEffort(bb.log, "canary pool readiness", readiness(), null) };
    return cached.ready;
  };

  async function since(version = VERSION, now = Date.now()): Promise<number> {
    const stored = await bb.storage.kv.get<number>(SINCE_KEY(version));
    if (typeof stored === "number") return stored;
    await bb.storage.kv.set(SINCE_KEY(version), now as never);
    return now;
  }

  /** The first time a version runs is its deploy time; called at start-up, and by every read as a fallback. */
  const noteStart = async (): Promise<void> => { await since(); };

  let sandboxCache: { at: number; ids: ReadonlySet<string> } | null = null;
  /** The ids of the projects named «LP sandbox …» / «LP native …» / «LP bench …»; a minute's memory, and none when BB cannot list projects. */
  async function sandboxProjects(now: number): Promise<ReadonlySet<string>> {
    if (sandboxCache && now - sandboxCache.at < 60_000) return sandboxCache.ids;
    const projects = bb.sdk.projects;
    let ids = new Set<string>(sandboxCache?.ids);
    try {
      if (projects) {
        const rows = await projects.list({ includePersonal: true });
        ids = new Set(rows.filter((row) => isSandboxProjectName(row.name)).map((row) => row.id));
      }
    } catch { /* keep the last answer: a project list that fails must not put the sandbox back into the canary */ }
    sandboxCache = { at: now, ids };
    setSandboxProjects([...DRILL_SANDBOX_PROJECT_IDS, ...ids]);
    return ids;
  }

  async function status(now = Date.now()): Promise<CanaryReport & { alerted: boolean; pool: { works: boolean; held: string[]; enabled: number; blocked: PoolBlockedWorker[] }; green: boolean }> {
    const report = canaryReport(db, { version: VERSION, since: await since(VERSION, now), now, sandboxProjects: await sandboxProjects(now) });
    const pool: { works: boolean; held: string[]; enabled: number; blocked: PoolBlockedWorker[] } = { ...poolHealth(breaker?.()?.snapshot(now) ?? []), enabled: 0, blocked: [] };
    const ready = await readyPool(now);
    if (ready) { pool.enabled = ready.enabled; pool.blocked = ready.blocked; }
    // Green only when no enabled worker is blocked (SMA m_green): a free fallback does not un-block the held ones.
    // Without a readiness answer the old breaker rule stands, so a failed walk never turns the pool red by itself.
    const green = !report.tripped && (readiness && ready ? pool.blocked.length === 0 : pool.works);
    return { ...report, pool, green, alerted: Boolean(await bb.storage.kv.get(ALERTED_KEY(VERSION))) };
  }

  /** Tells the PMs of the faulting tasks once per version when the canary has tripped. Returns whether it did. */
  async function check(now = Date.now()): Promise<boolean> {
    const report = await status(now);
    if (!report.tripped || report.alerted) return false;
    await bb.storage.kv.set(ALERTED_KEY(VERSION), now as never);
    bb.log.warn(`Lane Pilot canary tripped: ${canaryAlertText(report)}`);
    const text = `Lane Pilot (canary alert):\n${canaryAlertText(report)}`;
    for (const threadId of new Set(report.samples.map((row) => row.pmThreadId).filter((id): id is string => Boolean(id)))) {
      await sendServiceMessage(bb as never, { threadId, mode: "queue-if-active", text })
        .catch((cause) => ctx.log(`Lane Pilot could not send the canary alert to ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
    return true;
  }

  return { status, check, noteStart };
}

export type Canary = ReturnType<typeof createCanary>;
