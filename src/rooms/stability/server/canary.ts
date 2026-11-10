import packageJson from "../../../../package.json";
import { breakerKey } from "@lane-pilot/resilience";
import { canaryAttemptRows, previousHarnessVersion } from "../../storage";
import { setSandboxProjects } from "../../owner-waiting";
import { failureClass } from "../../contracts/failure-class";
import { DRILL_SANDBOX_PROJECT_IDS, FAILED_ATTEMPT_STATES, isDrillTask, isSandboxProjectName } from "../../contracts";
import type { LanePilotDatabase } from "../../storage";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import { scheduleIsolated } from "../../platform/server";
import type { ServerCore } from "../../contracts/server";
import { bestEffort } from "@lane-pilot/kit";

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
export const CANARY_MAX_ATTEMPTS = 20;
export const CANARY_MAX_MINUTES = 120;
/** Own-fault share of finished attempts above which the canary trips. */
export const CANARY_FAULT_LIMIT = 0.05;
/** A tripped canary needs this many faults: one bad attempt in three is noise, not a verdict. */
export const CANARY_MIN_FAULTS = 3;
const SINCE_KEY = (version: string) => `canary:since:${version}`;
const ALERTED_KEY = (version: string) => `canary:alerted:${version}`;

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
  previousVersion: string | null;
  rollback: string | null;
};

const asFault = (row: Row): boolean => row.state !== "accepted" && failureClass(row.state, row.reason) === "harness";

/**
 * The head of a reason is all `failureClass` needs. Whole reasons ran up to 4.7 MB (a stray-path list of thousands of files) and
 * classifying a week of them three times blocked BB's event loop for 5 s every 10 min: Caddy answered 502 meanwhile (hub 2026-10-12).
 */
export const REASON_SCAN_CHARS = 4000;



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

/** What the owner runs on the Mac mini; the script prints the exact steps for that version from the deploy log. */
export const rollbackCommand = (version: string): string => `bash scripts/lp-canary.sh --rollback ${version}`;

export function canaryAlertText(report: CanaryReport): string {
  return `Lane Pilot ${report.version} canary: ${report.faults} of the first ${report.window.attempts} attempts since it started failed on Lane Pilot's own fault `
    + `(${Math.round(report.rate * 100)}%, limit ${Math.round(CANARY_FAULT_LIMIT * 100)}%): ${report.samples.slice(0, 3).map((row) => `${row.taskId}: ${row.reason.slice(0, 120)}`).join("; ")}. `
    + `No action needed from you for these tasks (they are parked and restart once fixed); the owner decides on a rollback${report.rollback ? `: ${report.rollback} (in the lane-pilot checkout on the Mac mini)` : ""}.`;
}

/**
 * Green only when the pool works (SMA: Green only when pool works, Not green: workers blocked): the canary reads the provider breaker;
 * when every provider/model a writer used lately is held open, Lane Pilot is up but cannot write — not green.
 */
export function poolHealth(snapshot: ReadonlyArray<{ key: string; state: string }>): { works: boolean; held: string[] } {
  const held = snapshot.filter((row) => row.state === "open").map((row) => row.key);
  return { works: snapshot.length === 0 || held.length < snapshot.length, held };
}

/** One blocked writer of the pool, named by its provider/model breaker key, with the hold reason the walk gives. */
export type PoolBlockedWorker = { key: string; projectIds: string[]; reason: string };
export type PoolReadiness = { enabled: number; blocked: PoolBlockedWorker[] };
/** One project's writer chain as the caller assembled it (primary, fallbacks, PM pair). */
export type PoolChain = { projectId: string; hostId: string; settings: Record<string, unknown>; members: ReadonlyArray<{ providerId: string; model: string }> };
/** The shape of walkWriterChain this needs; injected so the stability room does not import the writer room. */
export type PoolWalk = (members: PoolChain["members"], input: { hostId: string; settings: Record<string, unknown> }) =>
  Promise<{ holds: Array<{ member: { providerId: string; model: string }; hold: { reason: string } }> }>;

/**
 * Readiness of the whole pool (SMA m_ac_pool_ready): every writer pair every project could call, and which of them
 * are blocked now with the reason. A member held in one project's chain is blocked even when another chain frees it:
 * the reason names a real refusal the owner's tasks already met.
 */
export async function poolReadiness(chains: readonly PoolChain[], walk: PoolWalk): Promise<PoolReadiness> {
  const enabled = new Set<string>();
  const blocked = new Map<string, PoolBlockedWorker>();
  for (const chain of chains) {
    const seen = new Set<string>();
    const members = chain.members.filter((member) => { const key = breakerKey(member.providerId, member.model); return !seen.has(key) && seen.add(key); });
    for (const key of seen) enabled.add(key);
    const walkResult = await walk(members, { hostId: chain.hostId, settings: chain.settings });
    for (const held of walkResult.holds) {
      const key = breakerKey(held.member.providerId, held.member.model);
      const entry = blocked.get(key) ?? { key, projectIds: [], reason: held.hold.reason };
      if (!entry.projectIds.includes(chain.projectId)) entry.projectIds.push(chain.projectId);
      blocked.set(key, entry);
    }
  }
  return { enabled: enabled.size, blocked: [...blocked.values()] };
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
    const projects = (bb.sdk as unknown as { projects?: { list: (query: unknown) => Promise<Array<{ id: string; name?: string }>> } }).projects;
    let ids = new Set<string>(sandboxCache?.ids);
    try {
      if (projects) {
        const rows = [...await projects.list({ includePersonal: true }), ...await bestEffort(bb.log, "canary archived project list", projects.list({ includePersonal: true, archived: true }), [])];
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
