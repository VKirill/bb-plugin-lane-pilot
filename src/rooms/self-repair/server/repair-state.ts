import { join } from "node:path";
import { bestEffort } from "@lane-pilot/kit";
import { tableRowAt } from "@lane-pilot/models";
import { wfRunStatus } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";
import { CONFIG_KEY, lanePilotProjectOrNotice } from "./project";
import { STATE_KEY } from "./report";
import type { SelfRepairConfig, SelfRepairState, SignatureRecord } from "./types";

export const SELF_REPAIR_DEFAULTS: SelfRepairConfig = {
  enabled: true,
  /** Empty — resolved in config(): the project whose source holds this plugin's checkout, or the value set with self_repair_configure. */
  projectId: "",
  /** Same: the environment of that checkout. */
  environmentId: "",
  sectionId: null,
  // GPT-6.1 Sol, not Opus: the owner moved the repairs off Claude on 2026-10-28 (the `repairer` row of the role table says the same).
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "high",
  maxPerDay: 4,
  // The deliberate-failure sandboxes are already ignored through DRILL_SANDBOX_PROJECT_IDS (stability/canary.ts); this list is for the owner's extra ones.
  ignoreProjects: [],
  /** How a repair thread reaches the hub's data when it is not on the hub («ssh -i …»); empty — it is on the hub already. */
  hubSsh: "",
  // Overridden in config() by the live db path and the server data dir; these spellings are the bb convention a thread on the hub can use as-is.
  hubDb: "~/.bb/plugins/lane-pilot/data.db",
  hubLog: "~/.bb/plugins/lane-pilot/logs/plugin.log",
};

/**
 * A stored sample keeps this much of its reason (the repair prompt shows 600). The state is one KV value (256 KB limit);
 * a reason that listed every stray file of a 48k-file folder was 4.7 MB, the write failed and the watcher made no pass,
 * and with 4000 the ~165 known kinds alone took 252 KB (2026-10-10).
 */
export const SAMPLE_REASON_CHARS = 1000;
/** The stored state stays under this many bytes: past it the kinds seen longest ago are forgotten first (a kind with a repair's
 * worktree is kept), so a busy month cannot grow it into the 256 KB KV limit. */
export const STATE_BUDGET_BYTES = 200 * 1024;

/** Writes to the watcher's state that a graph step makes go one at a time (a tick holds its own copy and merges at the end, see writeState). */
let stateWrites: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = stateWrites.then(work, work);
  stateWrites = next.then(() => undefined, () => undefined);
  return next;
}

export function createRepairState(ctx: ServerCore) {
  const { bb, db, host } = ctx;

  async function config(): Promise<SelfRepairConfig> {
    const raw = await bb.storage.kv.get(CONFIG_KEY);
    const stored = raw && typeof raw === "object" ? raw as Partial<SelfRepairConfig> : {};
    const merged = { ...SELF_REPAIR_DEFAULTS, ...stored };
    if (!merged.projectId || !merged.environmentId) {
      const discovered = await lanePilotProjectOrNotice(db, bb, host);
      if (!merged.projectId && discovered?.projectId) merged.projectId = discovered.projectId;
      if (!merged.environmentId && discovered?.environmentId) merged.environmentId = discovered.environmentId;
    }
    if (!stored.hubDb && typeof (db as { name?: unknown }).name === "string" && db.name) merged.hubDb = db.name;
    if (!stored.hubLog) {
      try { merged.hubLog = join(bb.server.experimental_dataDir, "plugins", "lane-pilot", "logs", "plugin.log"); } catch { /* the bb convention default stands */ }
    }
    // The repair engineer's model is the `repairer` row of the table «role -> model» when the owner set one and the watcher's own config names no model.
    if (merged.projectId && !stored.model && !stored.providerId && typeof ctx.effectiveProjectSettings === "function") {
      const row = tableRowAt((await bestEffort(ctx.log, "self-repair settings", ctx.effectiveProjectSettings(merged.projectId), { values: {}, inherited: [], explicitKeys: [] })).values, "repairer");
      if (row) return { ...merged, providerId: row.option.providerId, model: row.option.id, reasoningLevel: row.effort ?? merged.reasoningLevel };
    }
    return merged;
  }
  // Only what was stored plus the patch is saved: saving the merged defaults pinned «codex / gpt-6.1-sol» into the store on any
  // configure call, and the `repairer` row of the role table was never read again (owner 2026-11-08 saw repairs on Codex).
  async function setConfig(patch: Partial<SelfRepairConfig>): Promise<SelfRepairConfig> {
    const raw = await bb.storage.kv.get(CONFIG_KEY);
    const stored = raw && typeof raw === "object" ? raw as Partial<SelfRepairConfig> : {};
    await bb.storage.kv.set(CONFIG_KEY, { ...stored, ...patch } as never);
    return config();
  }
  async function state(): Promise<SelfRepairState> {
    const raw = await bb.storage.kv.get(STATE_KEY);
    const row = raw && typeof raw === "object" ? raw as Partial<SelfRepairState> : {};
    const signatures = Object.fromEntries(Object.entries(row.signatures ?? {}).map(([key, record]) => [key, { ...record, samples: (record.samples ?? []).map((sample) => ({ ...sample, reason: String(sample.reason ?? "").slice(0, SAMPLE_REASON_CHARS) })) }]));
    return { cursor: row.cursor ?? Date.now() - 3_600_000, lastTickAt: row.lastTickAt ?? null, signatures, spawned: row.spawned ?? [], aliases: row.aliases ?? {} };
  }

  /** Drops the kinds seen longest ago until the state fits STATE_BUDGET_BYTES: first those never repaired, then the rest. */
  function fitState(current: SelfRepairState): number {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    let size = bytes(current);
    const order = Object.entries(current.signatures).filter(([, record]) => !record.worktree && !record.pending)
      .sort(([, a], [, b]) => Number(Boolean(a.threadId)) - Number(Boolean(b.threadId)) || a.lastAt - b.lastAt);
    let dropped = 0;
    for (const [signature, record] of order) {
      if (size <= STATE_BUDGET_BYTES) break;
      size -= bytes(signature) + bytes(record) + 2;
      delete current.signatures[signature];
      dropped++;
    }
    return dropped;
  }

  /**
   * Writes the state a tick worked on. A graph step may have written a record meanwhile (it bumps `rev`): its copy is newer than the tick's, so it
   * is kept, and the repair threads it added to the day's list are kept too.
   */
  async function writeState(current: SelfRepairState): Promise<void> {
    await exclusive(async () => {
      const stored = await state();
      for (const [signature, record] of Object.entries(stored.signatures)) {
        if ((record.rev ?? 0) > (current.signatures[signature]?.rev ?? 0)) current.signatures[signature] = record;
      }
      const known = new Set(current.spawned.map((row) => row.threadId));
      const now = Date.now();
      current.spawned = [...current.spawned, ...stored.spawned.filter((row) => !known.has(row.threadId) && now - row.at < 86_400_000)];
      await bb.storage.kv.set(STATE_KEY, current as never);
    });
  }

  /** One kind's record changed by a graph step: read fresh, changed, written back with a newer `rev`. Null when the kind is gone. */
  function patchRecord(signature: string, change: (record: SignatureRecord, current: SelfRepairState) => void): Promise<SignatureRecord | null> {
    return exclusive(async () => {
      const current = await state();
      const record = current.signatures[signature];
      if (!record) return null;
      change(record, current);
      record.rev = (record.rev ?? 0) + 1;
      await bb.storage.kv.set(STATE_KEY, current as never);
      return record;
    });
  }

  /** Whether the graph run of a repair is still going: while it is, the watcher's own passes leave the record alone. */
  function runIsLive(runId: string | null | undefined): boolean {
    if (!runId) return false;
    try { const status = wfRunStatus(db as never, runId); return status === "running" || status === "waiting"; }
    catch { return false; }
  }

  return { config, setConfig, state, fitState, writeState, patchRecord, runIsLive };
}
