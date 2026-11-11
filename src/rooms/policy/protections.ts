import { postOwnerItem } from "../owner-waiting";
import { PROTECTIONS, endDisarm, failedStageReceiptsSince, isArmed, readDisarm, staleDisarms, storedProtectionValue, type LanePilotDatabase } from "../storage";

// The table and the disarm records are settings rows and live with the settings store; this file is the policy over them.
export { PROTECTIONS, DISARM_TERM_MS, disarmKey, noteProtectionDisarm, readDisarm, renewDisarm } from "../storage";

type Db = Pick<LanePilotDatabase, "prepare">;

const REARM_CMD = (projectId: string, key: string) => `bb lane-pilot integrity ${projectId} --rearm ${key}`;
const KEEP_CMD = (projectId: string, key: string) => `bb lane-pilot integrity ${projectId} --renew ${key} --days 30 --why "<причина>"`;

/**
 * The daily pass: a disarm past its term re-arms the protection — to the level it had before the disarm when the record
 * carries it, else to its warning level — and one owner item per re-arm says which protection came back. A renewed term is
 * left alone. The setting is written only when the project's row still holds the disarmed value: an absent row is already
 * at the default, so only the disarm record ends. A disarm whose term ended before `since` (the moment this pass first ran)
 * is not touched here; staleDisarms lists it for the owner.
 */
export function rearmExpiredDisarms(db: Db, projectId: string, now = Date.now(), since = 0): string[] {
  const rearmed: string[] = [];
  for (const [key, protection] of Object.entries(PROTECTIONS)) {
    const disarm = readDisarm(db, projectId, key);
    if (!disarm || disarm.until > now || disarm.until < since) continue;
    const stored = storedProtectionValue(db, projectId, key);
    if (stored === undefined || isArmed(protection, stored)) { endDisarm(db, projectId, key, now); continue; }
    if (disarm.to !== undefined && JSON.stringify(disarm.to) !== JSON.stringify(stored)) { endDisarm(db, projectId, key, now); continue; }
    const level = disarm.before !== undefined ? disarm.before : protection.warning;
    endDisarm(db, projectId, key, now, level);
    postOwnerItem(db as never, { key: `protection-rearm:${projectId}:${key}:${disarm.until}`, source: "disarm-guard", kind: "notice", projectId,
      what: `Защита «${key}» снова включена (${JSON.stringify(level)})`,
      why: `Срок отключения истёк без продления; она страхует от: ${protection.hazard}. Оставить выключенной: ${KEEP_CMD(projectId, key)}` });
    rearmed.push(key);
  }
  return rearmed;
}

/** One owner item per project for the disarms that ended before the re-arm pass existed: they stay as they are until the owner says. */
export function reportStaleDisarms(db: Db, projectId: string, since: number, now = Date.now()): string[] {
  const stale = staleDisarms(db, projectId, since, now).map((disarm) => disarm.key);
  if (!stale.length) return [];
  postOwnerItem(db as never, { key: `protection-stale:${projectId}`, source: "disarm-guard", kind: "notice", projectId,
    what: `Защиты проекта остались выключенными после срока: ${stale.join(", ")}`,
    why: `Срок отключения истёк до того, как защиты стали возвращаться сами, поэтому они не тронуты. Включить: ${stale.map((key) => REARM_CMD(projectId, key)).join("; ")}. Оставить выключенными: ${stale.map((key) => KEEP_CMD(projectId, key)).join("; ")}` });
  return stale;
}

/** What `bb lane-pilot integrity` prints: each protection with its hazard, armed and current value, disarm term and shadow findings. */
export function integrityReport(db: Db, settings: Record<string, unknown>, projectId: string, now = Date.now()): Array<Record<string, unknown>> {
  return Object.entries(PROTECTIONS).map(([key, protection]) => {
    const current = settings[key] ?? protection.armed;
    const disarm = readDisarm(db, projectId, key);
    // A disarmed gate still ran its checks in shadow: the findings it would have blocked are the stage receipts since.
    const shadow = disarm ? failedStageReceiptsSince(db, projectId, disarm.at) : [];
    return {
      key, hazard: protection.hazard, armed: protection.armed, current,
      disarmed: Boolean(disarm) || !isArmed(protection, current),
      term: disarm ? { at: disarm.at, until: disarm.until, daysLeft: Math.ceil((disarm.until - now) / 86_400_000) } : null,
      shadow_findings: shadow,
    };
  });
}
