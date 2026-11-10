import type Database from "better-sqlite3";
import { postOwnerItem } from "../owner-waiting";
import { listStageReceipts } from "../storage";

type Db = Pick<Database.Database, "prepare">;

/**
 * Disarm-path guard (SMA k_lib_stpa / k_v_integrity): the protective settings a project can switch off, each with the
 * armed value, the level it falls back to when a disarm term ends without renewal, and the hazard it guards.
 * saveProjectSetting records a disarm {key, by, at, until} (7 days) under `protection.disarm.<key>`; a daily pass
 * re-arms an expired disarm to its warning level and tells the owner; `--renew` moves the term with a reason.
 */
export const PROTECTIONS: Record<string, { armed: unknown; alsoArmed?: readonly unknown[]; warning: unknown; hazard: string }> = {
  "plan_critique.mode": { armed: "gate", warning: "advisory", hazard: "an unchecked plan reaches the writer" },
  "plan_fact.mode": { armed: "gate", warning: "record", hazard: "the writer's evidence is not checked against the diff" },
  "code_critique.mode": { armed: "gate", warning: "advisory", hazard: "an unchecked diff is accepted and merged" },
  // risky is the owner's own default (only a high-risk landing waits for him): it is armed too; only off is a disarm.
  "owner.words": { armed: "on", alsoArmed: ["risky"], warning: "risky", hazard: "risky acts run without the owner's word" },
};

const isArmed = (protection: { armed: unknown; alsoArmed?: readonly unknown[] }, value: unknown) => value === protection.armed || (protection.alsoArmed ?? []).includes(value);

export const disarmKey = (key: string) => `protection.disarm.${key}`;
export const DISARM_TERM_MS = 7 * 86_400_000;

type Disarm = { key: string; by: string; at: number; until: number; renewals?: Array<{ at: number; until: number; why: string }> };

const readJson = (raw: string | undefined): Disarm | null => {
  if (!raw) return null;
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value as Disarm : null; } catch { return null; }
};

export function readDisarm(db: Db, projectId: string, key: string): Disarm | null {
  const row = db.prepare(`SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?`).get(projectId, disarmKey(key)) as { value: string } | undefined;
  return readJson(row?.value);
}

function writeDisarm(db: Db, projectId: string, key: string, record: Disarm | null, now: number): void {
  if (record === null) db.prepare(`DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?`).run(projectId, disarmKey(key));
  else db.prepare(`INSERT INTO lane_pilot_project_settings (project_id,binding_id,key,value,version,updated_at) VALUES (?,'',?,?,'1',?)
    ON CONFLICT(project_id,binding_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(projectId, disarmKey(key), JSON.stringify(record), now);
}

/**
 * Called by saveProjectSetting for every save: leaving a protection's armed value opens a 7-day disarm term,
 * returning to the armed value clears it. A save that only refreshes the same off value keeps the term it has.
 */
export function noteProtectionDisarm(db: Db, projectId: string, key: string, value: unknown, opts: { by?: string; now?: number } = {}): Disarm | null {
  const protection = PROTECTIONS[key];
  if (!protection) return null;
  const now = opts.now ?? Date.now();
  if (isArmed(protection, value)) { writeDisarm(db, projectId, key, null, now); return null; }
  const existing = readDisarm(db, projectId, key);
  const record = existing ?? { key, by: opts.by ?? "settings", at: now, until: now + DISARM_TERM_MS };
  writeDisarm(db, projectId, key, record, now);
  return record;
}

/** Renew a disarm's term. Refuses without a reason: keeping a protection off needs a stated cause. */
export function renewDisarm(db: Db, projectId: string, key: string, days: number, why: string, now = Date.now()): { record: Disarm } | { error: string } {
  if (!why.trim()) return { error: "renewing a disarm needs a reason: pass --why <cause>" };
  const record = readDisarm(db, projectId, key);
  if (!record) return { error: `${key} is not disarmed` };
  record.until = now + days * 86_400_000;
  record.renewals = [...(record.renewals ?? []), { at: now, until: record.until, why }];
  writeDisarm(db, projectId, key, record, now);
  return { record };
}

/**
 * The daily pass: a disarm past its term re-arms the protection to its warning level — not off, not blocking —
 * and one owner item says which protection came back and why. A renewed term is left alone.
 */
export function rearmExpiredDisarms(db: Db, projectId: string, now = Date.now()): string[] {
  const rearmed: string[] = [];
  for (const [key, protection] of Object.entries(PROTECTIONS)) {
    const disarm = readDisarm(db, projectId, key);
    if (!disarm || disarm.until > now) continue;
    const current = db.prepare(`SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?`).get(projectId, key) as { value: string } | undefined;
    if (isArmed(protection, readJson(current?.value))) { writeDisarm(db, projectId, key, null, now); continue; }
    const nextVersion = (db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM lane_pilot_setting_generation WHERE project_id=? AND binding_id='' AND key=?`).get(projectId, key) as { v: number }).v + 1;
    db.prepare(`INSERT INTO lane_pilot_project_settings (project_id,binding_id,key,value,version,updated_at) VALUES (?,'',?,?,'1',?)
      ON CONFLICT(project_id,binding_id,key) DO UPDATE SET value=excluded.value, version=excluded.version, updated_at=excluded.updated_at`)
      .run(projectId, key, JSON.stringify(protection.warning), now);
    db.prepare(`INSERT INTO lane_pilot_setting_generation(project_id,binding_id,key,version) VALUES (?,'',?,?)
      ON CONFLICT(project_id,binding_id,key) DO UPDATE SET version=excluded.version`).run(projectId, key, nextVersion);
    writeDisarm(db, projectId, key, null, now);
    postOwnerItem(db, { key: `protection-rearm:${projectId}:${key}`, source: "disarm-guard", kind: "notice",
      what: `Защита «${key}» снова включена как предупреждение`,
      why: `Срок отключения истёк без продления; она страхует от: ${protection.hazard}.` });
    rearmed.push(key);
  }
  return rearmed;
}

/** What `bb lane-pilot integrity` prints: each protection with its hazard, armed and current value, disarm term and shadow findings. */
export function integrityReport(db: Db, settings: Record<string, unknown>, projectId: string, now = Date.now()): Array<Record<string, unknown>> {
  return Object.entries(PROTECTIONS).map(([key, protection]) => {
    const current = settings[key] ?? protection.armed;
    const disarm = readDisarm(db, projectId, key);
    // A disarmed gate still ran its checks in shadow: the findings it would have blocked are the stage receipts since.
    const shadow = disarm ? db.prepare(`SELECT task_id AS taskId, stage_id AS stageId, state, updated_at AS at FROM lane_pilot_stage_receipt
        WHERE run_id IN (SELECT id FROM lane_pilot_run WHERE project_id=?) AND state IN ('failed','blocked') AND updated_at>=?`)
      .all(projectId, disarm.at).slice(0, 10) as Array<{ taskId: string; stageId: string; state: string; at: number }> : [];
    return {
      key, hazard: protection.hazard, armed: protection.armed, current,
      disarmed: Boolean(disarm) || !isArmed(protection, current),
      term: disarm ? { at: disarm.at, until: disarm.until, daysLeft: Math.ceil((disarm.until - now) / 86_400_000) } : null,
      shadow_findings: shadow,
    };
  });
}
