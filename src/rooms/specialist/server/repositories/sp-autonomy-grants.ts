import type { AutonomyClass } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../../../storage";
import type { SpOutcomeLogger } from "./sp-outcomes";
import { isHighRiskActionClass } from "./sp-autonomy-rules";

const DAY_MS = 86_400_000;
export const REVOKE_FREEZE_DAYS = 14;

export interface AutonomyGrantRow {
  project_id: string;
  domain: string;
  action_class: string;
  granted_by: string;
  granted_at: number;
  revoked_at: number | null;
  reason: string | null;
}

/** Grants `bounded_auto` standing permission for an action class and appends a grant audit row. */
export function grantAutonomy(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; actionClass: string; by: string; reason?: string; now?: number },
  log?: SpOutcomeLogger,
): { ok: true; autonomyClass: AutonomyClass; grantedAt: number } | { ok: false; reason: string } {
  const now = input.now ?? Date.now();
  if (isHighRiskActionClass(input.actionClass)) {
    log?.warn?.(`sp autonomy grant refused class=${input.actionClass} reason=high_risk_never_auto`);
    return { ok: false, reason: "high_risk_never_auto" };
  }

  const tx = db.transaction(() => {
    const existingMax = db
      .prepare(
        "SELECT MAX(granted_at) AS max_ts FROM lane_pilot_sp_autonomy_grant WHERE project_id = ? AND domain = ? AND action_class = ?",
      )
      .get(input.projectId, input.domain, input.actionClass) as { max_ts: number | null } | undefined;
    const grantedAt = existingMax?.max_ts !== null && existingMax?.max_ts !== undefined ? Math.max(now, existingMax.max_ts + 1) : now;

    db.prepare(
      `INSERT INTO lane_pilot_sp_autonomy
        (project_id, domain, action_class, autonomy_class, samples_n, successes_k, wilson_lb, cohen_kappa, high_risk, frozen_until, updated_at)
       VALUES (?, ?, ?, 'bounded_auto', 0, 0, 0, 0, 0, NULL, ?)
       ON CONFLICT(project_id, domain, action_class) DO UPDATE SET
        autonomy_class = 'bounded_auto',
        high_risk = 0,
        frozen_until = NULL,
        updated_at = excluded.updated_at`,
    ).run(input.projectId, input.domain, input.actionClass, now);

    db.prepare(
      `INSERT INTO lane_pilot_sp_autonomy_grant
        (project_id, domain, action_class, granted_by, granted_at, revoked_at, reason)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(input.projectId, input.domain, input.actionClass, input.by, grantedAt, input.reason ?? null);

    return grantedAt;
  });

  const grantedAt = tx();
  log?.info?.(`sp autonomy granted class=${input.actionClass} by=${input.by}`);
  return { ok: true, autonomyClass: "bounded_auto", grantedAt };
}

/** Revokes `bounded_auto` back to `propose` and freezes promotion for `freezeDays` (default 14 days). */
export function revokeAutonomy(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; actionClass: string; reason?: string; freezeDays?: number; now?: number },
  log?: SpOutcomeLogger,
): { ok: true; autonomyClass: AutonomyClass; frozenUntil: number | null } {
  const now = input.now ?? Date.now();
  const freezeDays = input.freezeDays ?? REVOKE_FREEZE_DAYS;
  const frozenUntil = freezeDays > 0 ? now + freezeDays * DAY_MS : null;
  const reason = input.reason?.trim() || "owner_revoked";
  const highRiskInt = isHighRiskActionClass(input.actionClass) ? 1 : 0;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO lane_pilot_sp_autonomy
        (project_id, domain, action_class, autonomy_class, samples_n, successes_k, wilson_lb, cohen_kappa, high_risk, frozen_until, updated_at)
       VALUES (?, ?, ?, 'propose', 0, 0, 0, 0, ?, ?, ?)
       ON CONFLICT(project_id, domain, action_class) DO UPDATE SET
        autonomy_class = 'propose',
        frozen_until = excluded.frozen_until,
        updated_at = excluded.updated_at`,
    ).run(input.projectId, input.domain, input.actionClass, highRiskInt, frozenUntil, now);

    db.prepare(
      `UPDATE lane_pilot_sp_autonomy_grant
       SET revoked_at = ?, reason = ?
       WHERE project_id = ? AND domain = ? AND action_class = ? AND revoked_at IS NULL`,
    ).run(now, reason, input.projectId, input.domain, input.actionClass);
  });

  tx();
  log?.warn?.(`sp autonomy revoked class=${input.actionClass} reason=${reason}`);
  return { ok: true, autonomyClass: "propose", frozenUntil };
}
