import type { LanePilotDatabase } from "../storage";
import {
  formatClaimValue,
  getPassportClaimAt,
  isClaimFilled,
  mergePassportPatch,
  walkPassportClaims,
  type Claim,
  type PassportV1,
  type PendingPassportDelta,
} from "./schema";
import {
  getPassport,
  queuePendingPassportDelta,
  upsertPassport,
  type StoredPassportRecord,
} from "./store";

export interface DiskPassportReconcileResult {
  record: StoredPassportRecord;
  updatedPaths: string[];
  queuedDeltas: PendingPassportDelta[];
}

function sameClaimValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const na = a.map((x) => String(x).trim()).filter(Boolean);
    const nb = b.map((x) => String(x).trim()).filter(Boolean);
    return JSON.stringify(na) === JSON.stringify(nb);
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reconciles `.agents/passport/PASSPORT.json` from disk with the SQLite source of truth (`ASTRA-F-002`):
 * - Syncs field-by-field even when `confirmed_count > 0`.
 * - Blank/`unknown` disk fields never erase filled DB fields (protecting newer chat/RPC updates).
 * - Filled disk edits on `unknown` or `hypothesis` DB fields are merged directly into SQLite.
 * - Disk edits that contradict a `confirmed` or `taboo` DB claim are queued in `lane_pilot_passport_pending`
 *   for explicit owner confirmation instead of being silently ignored or overwriting owner locks.
 */
export function reconcileDiskPassportWithDb(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    scopeKey?: string;
    diskPassport: PassportV1;
    now?: number;
  },
): DiskPassportReconcileResult {
  const scopeKey = input.scopeKey ?? "";
  const now = input.now ?? Date.now();
  const existing = getPassport(db, input.projectId, scopeKey);
  if (!existing) {
    const created = upsertPassport(db, {
      projectId: input.projectId,
      scopeKey,
      passport: input.diskPassport,
      updatedBy: "disk_import",
      now,
    });
    const updatedPaths = walkPassportClaims(created.passport)
      .filter((c) => c.status !== "unknown" && isClaimFilled(c.value))
      .map((c) => c.path);
    return { record: created, updatedPaths, queuedDeltas: [] };
  }

  const patchToApply: Record<string, Claim<unknown>> = {};
  const updatedPaths: string[] = [];
  const queuedDeltas: PendingPassportDelta[] = [];

  for (const diskWalk of walkPassportClaims(input.diskPassport)) {
    const diskLeaf = getPassportClaimAt(input.diskPassport, diskWalk.path);
    const dbLeaf = getPassportClaimAt(existing.passport, diskWalk.path);
    if (!diskLeaf || !dbLeaf) continue;

    const diskFilled = diskLeaf.status !== "unknown" && isClaimFilled(diskLeaf.value);
    if (!diskFilled) continue;

    const dbFilled = dbLeaf.status !== "unknown" && isClaimFilled(dbLeaf.value);
    const valuesMatch = sameClaimValue(diskLeaf.value, dbLeaf.value);

    if (dbFilled && valuesMatch && diskLeaf.status === dbLeaf.status) {
      continue;
    }

    const incomingClaim: Claim<unknown> = {
      status: diskLeaf.status,
      value: diskLeaf.value,
      evidence_ref: diskLeaf.evidence_ref?.trim() || "disk:PASSPORT.json",
      updated_at: diskLeaf.updated_at ?? now,
      ...(diskLeaf.note ? { note: diskLeaf.note } : {}),
    };

    if (dbFilled && (dbLeaf.status === "confirmed" || dbLeaf.status === "taboo") && (!valuesMatch || diskLeaf.status !== dbLeaf.status)) {
      const reason = !valuesMatch
        ? `Disk PASSPORT.json changed ${dbLeaf.status} field («${formatClaimValue(dbLeaf.value)}» → «${formatClaimValue(diskLeaf.value)}»)`
        : `Disk PASSPORT.json changed epistemic status of ${dbLeaf.status} field «${formatClaimValue(dbLeaf.value)}» (${dbLeaf.status} → ${diskLeaf.status})`;
      const delta = queuePendingPassportDelta(db, {
        projectId: input.projectId,
        scopeKey,
        fieldPath: diskWalk.path,
        oldClaim: dbLeaf,
        proposedClaim: incomingClaim,
        reason,
        now,
      });
      if (delta.state === "pending") {
        queuedDeltas.push(delta);
      }
      continue;
    }

    patchToApply[diskWalk.path] = incomingClaim;
    updatedPaths.push(diskWalk.path);
  }

  if (updatedPaths.length === 0) {
    return { record: existing, updatedPaths: [], queuedDeltas };
  }

  const merged = mergePassportPatch(existing.passport, patchToApply, {
    evidenceRef: "disk:PASSPORT.json",
    now,
  });
  const saved = upsertPassport(db, {
    projectId: input.projectId,
    scopeKey,
    passport: merged,
    updatedBy: "disk_sync",
    now,
  });
  return { record: saved, updatedPaths, queuedDeltas };
}
