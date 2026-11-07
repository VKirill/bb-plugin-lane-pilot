import type { LanePilotDatabase } from "../../storage";
import type { ServerCore } from "../../contracts/server";
import type { Incident, SelfRepairConfig, SelfRepairState, SignatureRecord, Verdict } from "./types";
import { firstSeenOnRunningVersion, isDue, repairPriority, VERSION } from "./episodes";
import { repairStatus } from "./verdict";

export const STATE_KEY = "self-repair:state";

/** What the watcher's state holds about one repair signature (read-only; the night loop follows its repairs with it). */
export async function readRepairRecord(bb: ServerCore["bb"], signature: string): Promise<{ threadId: string | null; verdict: Verdict | null; outcome: string | null; branch: string | null; worktreePath: string | null; spawnedAt: number | null } | null> {
  const raw = await bb.storage.kv.get(STATE_KEY).catch(() => null);
  const record = (raw && typeof raw === "object" ? (raw as Partial<SelfRepairState>).signatures?.[signature] : undefined) as SignatureRecord | undefined;
  return record ? { threadId: record.threadId, verdict: record.verdict ?? null, outcome: record.outcome ?? null, branch: record.worktree?.branch ?? null, worktreePath: record.worktree?.path ?? null, spawnedAt: record.spawnedAt } : null;
}

export type StatusSource = {
  db: LanePilotDatabase;
  config: () => Promise<SelfRepairConfig>;
  state: () => Promise<SelfRepairState>;
  collect: (since: number, cfg: SelfRepairConfig) => Promise<Incident[]>;
};

export async function selfRepairStatus(source: StatusSource) {
  const since = Date.now() - 86_400_000;
  const attempts = source.db.prepare("SELECT state, count(*) AS n FROM lane_pilot_attempt WHERE updated_at > ? GROUP BY state").all(since) as Array<{ state: string; n: number }>;
  const faults = source.db.prepare("SELECT origin, count(*) AS n FROM lane_pilot_failure_triage WHERE triaged_at > ? GROUP BY origin").all(since) as Array<{ origin: string; n: number }>;
  const cfg = await source.config();
  const current = await source.state();
  const open = await source.collect(since, cfg);
  return {
    config: cfg,
    last24h: {
      attempts: Object.fromEntries(attempts.map((row) => [row.state, row.n])),
      failuresByFault: Object.fromEntries(faults.map((row) => [row.origin, row.n])),
      lanePilotIncidents: open.map(({ kind, projectId, taskId, attemptId, reason }) => ({ kind, projectId, taskId, attemptId, reason: reason.slice(0, 200) })),
      repairs: current.spawned.filter((row) => row.at > since).map((row) => ({ ...row, firstSeenOnRunningVersion: current.signatures[row.signature] ? firstSeenOnRunningVersion(current.signatures[row.signature]!) : false })),
    },
    version: VERSION,
    cursor: current.cursor,
    lastTickAt: current.lastTickAt,
    knownSignatures: Object.keys(current.signatures).length,
    waiting: Object.entries(current.signatures).map(([signature, record]) => ({
      signature: signature.slice(0, 140), count: record.count, due: isDue(record, Date.now()), priority: repairPriority(signature, record, Date.now(), new Set(cfg.ignoreProjects)), verdict: record.verdict ?? null, status: repairStatus(record.verdict), threadId: record.threadId,
      branch: record.worktree?.branch ?? null, outcome: record.outcome ?? null,
      firstSeenOnRunningVersion: firstSeenOnRunningVersion(record),
    })),
  };
}
