import { postOwnerItem } from "../owner-waiting";
import { PROTECTIONS, endDisarm, failedStageReceiptsSince, isArmed, readDisarm, storedProtectionValue, type LanePilotDatabase } from "../storage";

// The table and the disarm records are settings rows and live with the settings store; this file is the policy over them.
export { PROTECTIONS, DISARM_TERM_MS, disarmKey, noteProtectionDisarm, readDisarm, renewDisarm } from "../storage";

type Db = Pick<LanePilotDatabase, "prepare">;

/**
 * The daily pass: a disarm past its term re-arms the protection to its warning level — not off, not blocking —
 * and one owner item says which protection came back and why. A renewed term is left alone.
 */
export function rearmExpiredDisarms(db: Db, projectId: string, now = Date.now()): string[] {
  const rearmed: string[] = [];
  for (const [key, protection] of Object.entries(PROTECTIONS)) {
    const disarm = readDisarm(db, projectId, key);
    if (!disarm || disarm.until > now) continue;
    if (isArmed(protection, storedProtectionValue(db, projectId, key))) { endDisarm(db, projectId, key, now); continue; }
    endDisarm(db, projectId, key, now, protection.warning);
    postOwnerItem(db as never, { key: `protection-rearm:${projectId}:${key}`, source: "disarm-guard", kind: "notice",
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
    const shadow = disarm ? failedStageReceiptsSince(db, projectId, disarm.at) : [];
    return {
      key, hazard: protection.hazard, armed: protection.armed, current,
      disarmed: Boolean(disarm) || !isArmed(protection, current),
      term: disarm ? { at: disarm.at, until: disarm.until, daysLeft: Math.ceil((disarm.until - now) / 86_400_000) } : null,
      shadow_findings: shadow,
    };
  });
}
