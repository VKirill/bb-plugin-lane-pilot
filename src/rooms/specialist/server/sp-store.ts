import { randomUUID } from "node:crypto";
import { sha256Hex } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../../storage";
import { canonicalJson } from "../action-order";
import { loadSpPolicy } from "../tool-tiers";

/**
 * Specialist OS SQLite store (Part 1): charters, single-flight tick leases (`G-11`),
 * atomic 3-aggregate budget reservations (`G-12`), CAS cursors, and `spSweep`.
 */
export interface CharterRow {
  project_id: string;
  domain: string;
  version: number;
  charter_json: string;
  sha256: string;
  daily_cap_usd: number;
  cell_cap_usd: number;
  rolling_24h_auto_cap_usd: number;
  max_active_cells: number;
  approved_by: string | null;
  updated_at: number;
}

export function getCharter(db: LanePilotDatabase, projectId: string, domain: string): CharterRow | null {
  return (
    (db
      .prepare("SELECT * FROM lane_pilot_sp_charter WHERE project_id = ? AND domain = ?")
      .get(projectId, domain) as CharterRow | undefined) ?? null
  );
}

export function upsertCharter(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: "seo" | "marketing" | "specialist_os";
    charter: Record<string, unknown>;
    approvedBy?: string | null;
    nowMs?: number;
  },
): { version: number; sha256: string } {
  const now = input.nowMs ?? Date.now();
  const policy = loadSpPolicy();
  const canonical = canonicalJson(input.charter);
  const sha = sha256Hex(canonical);
  const existing = getCharter(db, input.projectId, input.domain);
  const version = existing ? (existing.sha256 === sha ? existing.version : existing.version + 1) : 1;
  const budgets = (input.charter.budgets ?? {}) as Record<string, unknown>;
  const dailyCap = typeof budgets.daily_cap_usd === "number" ? budgets.daily_cap_usd : policy.budgets.daily_cap_usd_default;
  const cellCap = typeof budgets.cell_cap_usd === "number" ? budgets.cell_cap_usd : policy.budgets.cell_cap_usd_default;
  const autoCap =
    typeof budgets.rolling_24h_auto_cap_usd === "number"
      ? budgets.rolling_24h_auto_cap_usd
      : policy.budgets.rolling_24h_auto_cap_usd_default;
  const maxCells =
    typeof budgets.max_active_cells === "number"
      ? budgets.max_active_cells
      : policy.budgets.max_concurrent_active_cells;

  db.prepare(
    `INSERT INTO lane_pilot_sp_charter
      (project_id, domain, version, charter_json, sha256, daily_cap_usd, cell_cap_usd, rolling_24h_auto_cap_usd, max_active_cells, approved_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, domain) DO UPDATE SET
      version = excluded.version,
      charter_json = excluded.charter_json,
      sha256 = excluded.sha256,
      daily_cap_usd = excluded.daily_cap_usd,
      cell_cap_usd = excluded.cell_cap_usd,
      rolling_24h_auto_cap_usd = excluded.rolling_24h_auto_cap_usd,
      max_active_cells = excluded.max_active_cells,
      approved_by = excluded.approved_by,
      updated_at = excluded.updated_at`,
  ).run(input.projectId, input.domain, version, canonical, sha, dailyCap, cellCap, autoCap, maxCells, input.approvedBy ?? null, now);
  return { version, sha256: sha };
}

export function acquireTick(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    scopeId?: string;
    slotKey: string;
    holderRunId: string;
    leaseTtlMs?: number;
    nowMs?: number;
  },
): { ok: boolean; tickId: string; reason?: "active_lease" | "slot_already_completed" } {
  const now = input.nowMs ?? Date.now();
  const scopeId = input.scopeId || "default";
  const ttl = input.leaseTtlMs ?? 15 * 60_000;
  const tx = db.transaction(() => {
    const cur = db
      .prepare("SELECT * FROM lane_pilot_sp_tick_lease WHERE project_id = ? AND domain = ? AND scope_id = ?")
      .get(input.projectId, input.domain, scopeId) as
      | { tick_id: string; slot_key: string; holder_run_id: string; expires_at: number; last_completed_slot: string | null }
      | undefined;
    if (cur) {
      if (cur.last_completed_slot && cur.last_completed_slot === input.slotKey) {
        return { ok: false as const, tickId: cur.tick_id, reason: "slot_already_completed" as const };
      }
      if (cur.expires_at > now && cur.holder_run_id !== input.holderRunId) {
        return { ok: false as const, tickId: cur.tick_id, reason: "active_lease" as const };
      }
    }
    const tickId = `tick_${sha256Hex(`${input.projectId}:${input.domain}:${scopeId}:${input.slotKey}:${now}`).slice(0, 16)}`;
    db.prepare(
      `INSERT INTO lane_pilot_sp_tick_lease (project_id, domain, scope_id, tick_id, slot_key, holder_run_id, acquired_at, expires_at, last_completed_slot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, domain, scope_id) DO UPDATE SET
        tick_id = excluded.tick_id,
        slot_key = excluded.slot_key,
        holder_run_id = excluded.holder_run_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at`,
    ).run(input.projectId, input.domain, scopeId, tickId, input.slotKey, input.holderRunId, now, now + ttl, cur?.last_completed_slot ?? null);
    return { ok: true as const, tickId };
  });
  return tx();
}

export function completeTick(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; scopeId?: string; tickId: string; markSlotCompleted?: boolean; nowMs?: number },
): void {
  const now = input.nowMs ?? Date.now();
  const scopeId = input.scopeId || "default";
  db.prepare(
    `UPDATE lane_pilot_sp_tick_lease
     SET expires_at = ?,
         last_completed_slot = CASE WHEN ? = 1 THEN slot_key ELSE last_completed_slot END
     WHERE project_id = ? AND domain = ? AND scope_id = ? AND tick_id = ?`,
  ).run(now, input.markSlotCompleted ? 1 : 0, input.projectId, input.domain, scopeId, input.tickId);
}

export function reserveBudget(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    cellKey: string;
    amountUsd: number;
    isAuto: boolean;
    runId?: string;
    reason?: string;
    nowMs?: number;
  },
): { ok: boolean; ledgerId?: string; remainingDailyUsd: number; reason?: string } {
  const now = input.nowMs ?? Date.now();
  const dayUtc = new Date(now).toISOString().slice(0, 10);
  const policy = loadSpPolicy();
  const charter = getCharter(db, input.projectId, input.domain);
  const dailyCap = charter?.daily_cap_usd ?? policy.budgets.daily_cap_usd_default;
  const cellCap = charter?.cell_cap_usd ?? policy.budgets.cell_cap_usd_default;
  const auto24hCap = charter?.rolling_24h_auto_cap_usd ?? policy.budgets.rolling_24h_auto_cap_usd_default;
  const maxActiveCells = charter?.max_active_cells ?? policy.budgets.max_concurrent_active_cells;

  const tx = db.transaction(() => {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
      return { ok: false, remainingDailyUsd: 0, reason: "invalid_amount_usd" };
    }
    const daySpent =
      (
        db
          .prepare("SELECT COALESCE(SUM(amount_usd), 0) AS s FROM lane_pilot_sp_ledger WHERE project_id = ? AND day_utc = ? AND mode IN ('reserved','settled')")
          .get(input.projectId, dayUtc) as { s: number }
      ).s ?? 0;
    if (daySpent + input.amountUsd > dailyCap + 1e-9) {
      return { ok: false, remainingDailyUsd: Math.max(0, dailyCap - daySpent), reason: "daily_cap_exceeded" };
    }
    const cellSpent =
      (
        db
          .prepare("SELECT COALESCE(SUM(amount_usd), 0) AS s FROM lane_pilot_sp_ledger WHERE project_id = ? AND cell_key = ? AND day_utc = ? AND mode IN ('reserved','settled')")
          .get(input.projectId, input.cellKey, dayUtc) as { s: number }
      ).s ?? 0;
    if (cellSpent + input.amountUsd > cellCap + 1e-9) {
      return { ok: false, remainingDailyUsd: Math.max(0, dailyCap - daySpent), reason: "cell_cap_exceeded" };
    }
    if (input.isAuto) {
      const rollingSpent =
        (
          db
            .prepare("SELECT COALESCE(SUM(amount_usd), 0) AS s FROM lane_pilot_sp_ledger WHERE project_id = ? AND is_auto = 1 AND created_at >= ? AND mode IN ('reserved','settled')")
            .get(input.projectId, now - 86_400_000) as { s: number }
        ).s ?? 0;
      if (rollingSpent + input.amountUsd > auto24hCap + 1e-9) {
        return { ok: false, remainingDailyUsd: Math.max(0, dailyCap - daySpent), reason: "rolling_24h_auto_cap_exceeded" };
      }
    }
    const activeCells = db
      .prepare("SELECT DISTINCT cell_key FROM lane_pilot_sp_ledger WHERE project_id = ? AND day_utc = ? AND mode = 'reserved'")
      .all(input.projectId, dayUtc) as Array<{ cell_key: string }>;
    const cellSet = new Set(activeCells.map((r) => r.cell_key));
    if (!cellSet.has(input.cellKey) && cellSet.size >= maxActiveCells) {
      return { ok: false, remainingDailyUsd: Math.max(0, dailyCap - daySpent), reason: "max_concurrent_cells_exceeded" };
    }
    const ledgerId = `led_${randomUUID()}`;
    db.prepare(
      `INSERT INTO lane_pilot_sp_ledger
        (id, project_id, domain, cell_key, day_utc, mode, is_auto, amount_usd, run_id, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
    ).run(ledgerId, input.projectId, input.domain, input.cellKey, dayUtc, input.isAuto ? 1 : 0, input.amountUsd, input.runId ?? null, input.reason ?? null, now, now);
    return { ok: true, ledgerId, remainingDailyUsd: Number(Math.max(0, dailyCap - (daySpent + input.amountUsd)).toFixed(4)) };
  });
  return tx();
}

export function settleBudget(db: LanePilotDatabase, ledgerId: string, mode: "settled" | "released", actualUsd?: number, nowMs = Date.now()): void {
  if (typeof actualUsd === "number" && Number.isFinite(actualUsd) && actualUsd >= 0) {
    db.prepare("UPDATE lane_pilot_sp_ledger SET mode = ?, amount_usd = ?, updated_at = ? WHERE id = ?").run(mode, actualUsd, nowMs, ledgerId);
  } else {
    db.prepare("UPDATE lane_pilot_sp_ledger SET mode = ?, updated_at = ? WHERE id = ?").run(mode, nowMs, ledgerId);
  }
}

export function getBudgetRemainingUsd(db: LanePilotDatabase, projectId: string, domain: string, nowMs = Date.now()): number {
  const dayUtc = new Date(nowMs).toISOString().slice(0, 10);
  const policy = loadSpPolicy();
  const charter = getCharter(db, projectId, domain);
  const dailyCap = charter?.daily_cap_usd ?? policy.budgets.daily_cap_usd_default;
  const spent =
    (
      db
        .prepare("SELECT COALESCE(SUM(amount_usd), 0) AS s FROM lane_pilot_sp_ledger WHERE project_id = ? AND day_utc = ? AND mode IN ('reserved','settled')")
        .get(projectId, dayUtc) as { s: number }
    ).s ?? 0;
  return Number(Math.max(0, dailyCap - spent).toFixed(4));
}

export function advanceCursor(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; streamKey: string; nextCursor: Record<string, unknown>; expectedVersion?: number; nowMs?: number },
): { ok: boolean; version: number } {
  const now = input.nowMs ?? Date.now();
  const tx = db.transaction(() => {
    const cur = db
      .prepare("SELECT version FROM lane_pilot_sp_cursor WHERE project_id = ? AND domain = ? AND stream_key = ?")
      .get(input.projectId, input.domain, input.streamKey) as { version: number } | undefined;
    if (input.expectedVersion !== undefined && (cur?.version ?? 0) !== input.expectedVersion) {
      return { ok: false, version: cur?.version ?? 0 };
    }
    const nextVer = (cur?.version ?? 0) + 1;
    db.prepare(
      `INSERT INTO lane_pilot_sp_cursor (project_id, domain, stream_key, cursor_json, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, domain, stream_key) DO UPDATE SET
        cursor_json = excluded.cursor_json, version = excluded.version, updated_at = excluded.updated_at`,
    ).run(input.projectId, input.domain, input.streamKey, canonicalJson(input.nextCursor), nextVer, now);
    return { ok: true, version: nextVer };
  });
  return tx();
}

export function listCursors(db: LanePilotDatabase, projectId: string, domain: string): Record<string, unknown> {
  const rows = db
    .prepare("SELECT stream_key, cursor_json, version FROM lane_pilot_sp_cursor WHERE project_id = ? AND domain = ?")
    .all(projectId, domain) as Array<{ stream_key: string; cursor_json: string; version: number }>;
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.stream_key] = { ...(JSON.parse(r.cursor_json) as Record<string, unknown>), _version: r.version };
    } catch {
      out[r.stream_key] = { raw: r.cursor_json, _version: r.version };
    }
  }
  return out;
}

export function spSweep(db: LanePilotDatabase, nowMs = Date.now()): { expiredLocks: number; purgedNonces: number } {
  const locks = db
    .prepare("UPDATE lane_pilot_sp_lock SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?")
    .run(nowMs, nowMs).changes;
  const nonces = db
    .prepare("DELETE FROM lane_pilot_sp_nonce WHERE expires_at <= ? AND consumed_at IS NULL")
    .run(nowMs - 86_400_000).changes;
  return { expiredLocks: locks, purgedNonces: nonces };
}
