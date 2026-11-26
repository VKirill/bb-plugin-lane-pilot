import { breakerKey } from "@lane-pilot/resilience";

export const CANARY_MAX_ATTEMPTS = 20;
export const CANARY_MAX_MINUTES = 120;
/** Own-fault share of finished attempts above which the canary trips. */
export const CANARY_FAULT_LIMIT = 0.05;
/** A tripped canary needs this many faults: one bad attempt in three is noise, not a verdict. */
export const CANARY_MIN_FAULTS = 3;

/**
 * The head of a reason is all `failureClass` needs. Whole reasons ran up to 4.7 MB (a stray-path list of thousands of files) and
 * classifying a week of them three times blocked BB's event loop for 5 s every 10 min: Caddy answered 502 meanwhile (hub 2026-10-12).
 */
export const REASON_SCAN_CHARS = 4000;

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
