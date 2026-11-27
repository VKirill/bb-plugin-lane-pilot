import type Database from "better-sqlite3";
import {
  EVOLUTION_RECEIPT_DECISIONS,
  PUBLISH_GRANT_VIAS,
  type EvolutionReceipt,
  type EvolutionReceiptDecision,
  type PublishAuthority,
  type PublishGrant,
  type PublishGrantVia,
} from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";
import type { RawDefinition } from "./draft";
import { createDraftStore } from "./draft-store";

/** Appended at the end of `src/rooms/migrations.ts`: one-time publish grants and evolution gate receipts. */
export const workflowPublishAuthorityMigrations: string[] = [
  `CREATE TABLE lane_pilot_wf_publish_authority (
    draft_id TEXT NOT NULL,
    draft_sha256 TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('owner','evolution')),
    ref TEXT,
    issued_at INTEGER NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (draft_id, draft_sha256)
  )`,
];

export type AuthorityRefusalReason = "no_publish_authority" | "draft_changed_after_grant";

export type ConsumeAuthorityResult =
  | { ok: true; authority: PublishAuthority }
  | { ok: false; reason: AuthorityRefusalReason };

type AuthorityRow = {
  draft_id: string;
  draft_sha256: string;
  kind: "owner" | "evolution";
  ref: string | null;
  issued_at: number;
  used_at: number | null;
};

/** Computes the canonical SHA-256 of a draft definition excluding canvas `ui` placement. */
export function draftDefinitionSha256(definition: RawDefinition): string {
  const { ui: _ui, ...rest } = definition;
  return sha256Hex(JSON.stringify(rest));
}

function parseAuthorityRow(row: AuthorityRow): PublishAuthority {
  if (row.kind === "owner") {
    const via: PublishGrantVia = (PUBLISH_GRANT_VIAS as readonly string[]).includes(row.ref ?? "")
      ? (row.ref as PublishGrantVia)
      : "cli";
    return {
      kind: "owner",
      draftId: row.draft_id,
      draftSha256: row.draft_sha256,
      grantedAt: row.issued_at,
      via,
    };
  }
  let trialId = row.ref ?? "";
  let decision: EvolutionReceiptDecision = "promote";
  if (row.ref) {
    try {
      const parsed = JSON.parse(row.ref) as { trialId?: unknown; decision?: unknown };
      if (typeof parsed.trialId === "string") trialId = parsed.trialId;
      if (typeof parsed.decision === "string" && (EVOLUTION_RECEIPT_DECISIONS as readonly string[]).includes(parsed.decision)) {
        decision = parsed.decision as EvolutionReceiptDecision;
      }
    } catch {
      /* Legacy/plain ref falls back to trialId string. */
    }
  }
  return {
    kind: "evolution",
    draftId: row.draft_id,
    draftSha256: row.draft_sha256,
    trialId,
    decision,
    issuedAt: row.issued_at,
  };
}

/** Records or refreshes an unused one-time owner publish grant for the draft's current definition hash. */
export function insertOwnerPublishGrant(
  db: Database.Database,
  draftId: string,
  via: PublishGrantVia,
  options: { now?: number } = {},
): PublishGrant | null {
  const draft = createDraftStore(db).get(draftId);
  if (!draft) return null;
  const sha = draftDefinitionSha256(draft.definition);
  const grantedAt = options.now ?? Date.now();
  db.prepare(
    `INSERT INTO lane_pilot_wf_publish_authority (draft_id, draft_sha256, kind, ref, issued_at, used_at)
     VALUES (?, ?, 'owner', ?, ?, NULL)
     ON CONFLICT(draft_id, draft_sha256) DO UPDATE SET
       kind = 'owner',
       ref = excluded.ref,
       issued_at = excluded.issued_at,
       used_at = NULL`,
  ).run(draftId, sha, via, grantedAt);
  return {
    kind: "owner",
    draftId,
    draftSha256: sha,
    grantedAt,
    via,
  };
}

/** Records or refreshes an unused one-time evolution gate receipt for the draft's current definition hash. */
export function insertEvolutionPublishReceipt(
  db: Database.Database,
  input: { draftId: string; trialId: string; decision: EvolutionReceiptDecision; now?: number },
): EvolutionReceipt | null {
  const draft = createDraftStore(db).get(input.draftId);
  if (!draft) return null;
  const sha = draftDefinitionSha256(draft.definition);
  const issuedAt = input.now ?? Date.now();
  const ref = JSON.stringify({ trialId: input.trialId, decision: input.decision });
  db.prepare(
    `INSERT INTO lane_pilot_wf_publish_authority (draft_id, draft_sha256, kind, ref, issued_at, used_at)
     VALUES (?, ?, 'evolution', ?, ?, NULL)
     ON CONFLICT(draft_id, draft_sha256) DO UPDATE SET
       kind = 'evolution',
       ref = excluded.ref,
       issued_at = excluded.issued_at,
       used_at = NULL`,
  ).run(input.draftId, sha, ref, issuedAt);
  return {
    kind: "evolution",
    draftId: input.draftId,
    draftSha256: sha,
    trialId: input.trialId,
    decision: input.decision,
    issuedAt,
  };
}

function findMatchingAuthorityRow(db: Database.Database, draftId: string, sha: string): { row: AuthorityRow | null; unusedOther: boolean } {
  const row = db.prepare(
    `SELECT draft_id, draft_sha256, kind, ref, issued_at, used_at
     FROM lane_pilot_wf_publish_authority
     WHERE draft_id = ? AND draft_sha256 = ?`,
  ).get(draftId, sha) as AuthorityRow | undefined;
  if (row) return { row, unusedOther: false };
  const other = db.prepare(
    `SELECT 1 FROM lane_pilot_wf_publish_authority
     WHERE draft_id = ? AND used_at IS NULL
     LIMIT 1`,
  ).get(draftId);
  return { row: null, unusedOther: Boolean(other) };
}

/** Checks without consuming whether a valid unused publish authority exists for `(draftId, sha)`. */
export function peekPublishAuthority(db: Database.Database, draftId: string, sha: string): ConsumeAuthorityResult {
  const { row, unusedOther } = findMatchingAuthorityRow(db, draftId, sha);
  if (!row) {
    return { ok: false, reason: unusedOther ? "draft_changed_after_grant" : "no_publish_authority" };
  }
  if (row.used_at !== null) {
    return { ok: false, reason: "no_publish_authority" };
  }
  return { ok: true, authority: parseAuthorityRow(row) };
}

/** Atomically consumes an unused publish authority row for `(draftId, sha)`, refusing missing, reused, or stale-hash grants. */
export function consumePublishAuthorityRow(
  db: Database.Database,
  draftId: string,
  sha: string,
  options: { now?: number } = {},
): ConsumeAuthorityResult {
  return db.transaction((): ConsumeAuthorityResult => {
    const { row, unusedOther } = findMatchingAuthorityRow(db, draftId, sha);
    if (!row) {
      return { ok: false, reason: unusedOther ? "draft_changed_after_grant" : "no_publish_authority" };
    }
    if (row.used_at !== null) {
      return { ok: false, reason: "no_publish_authority" };
    }
    const usedAt = options.now ?? Date.now();
    const res = db.prepare(
      `UPDATE lane_pilot_wf_publish_authority
       SET used_at = ?
       WHERE draft_id = ? AND draft_sha256 = ? AND used_at IS NULL`,
    ).run(usedAt, draftId, sha);
    if (res.changes !== 1) {
      return { ok: false, reason: "no_publish_authority" };
    }
    return { ok: true, authority: parseAuthorityRow(row) };
  })();
}
