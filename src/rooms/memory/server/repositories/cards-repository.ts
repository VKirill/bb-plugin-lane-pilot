import { addToIndexes, dropMemoryIndexes, hideRecord } from "@lane-pilot/memory-core";
import type { CardKind } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../../../storage";

export type CardMemoryRow = {
  id: string;
  project_id: string;
  content: string;
  concepts_json: string;
  created_at: number;
  status: "active" | "superseded" | "expired";
  trust: "confirmed" | "observed";
  valid_until: number | null;
  valid_from: number | null;
  verification_json: string | null;
};

const CARD_COLUMNS =
  "id, project_id, content, concepts_json, created_at, status, trust, valid_until, valid_from, verification_json";

export function parseConceptsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function cardRowExists(db: LanePilotDatabase, id: string): boolean {
  return db.prepare("SELECT 1 FROM lane_pilot_memory WHERE id=? LIMIT 1").get(id) !== undefined;
}

export function findCardRowById(db: LanePilotDatabase, cardId: string): CardMemoryRow | undefined {
  const row = db
    .prepare(`SELECT ${CARD_COLUMNS} FROM lane_pilot_memory WHERE id=? LIMIT 1`)
    .get(cardId) as CardMemoryRow | undefined;
  if (!row) return undefined;
  return parseConceptsJson(row.concepts_json).includes("card") ? row : undefined;
}

export function findNonSupersededCardRowsByConcept(
  db: LanePilotDatabase,
  storedProjectId: string,
  concept: string,
): CardMemoryRow[] {
  const rows = db
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM lane_pilot_memory
       WHERE project_id=? AND status IN ('active', 'expired') AND concepts_json LIKE ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(storedProjectId, `%"${concept}"%`) as CardMemoryRow[];
  return rows.filter((row) => parseConceptsJson(row.concepts_json).includes(concept));
}

export function listNonSupersededCardRows(
  db: LanePilotDatabase,
  projectIds: readonly string[],
  kind?: CardKind,
): CardMemoryRow[] {
  if (!projectIds.length) return [];
  const placeholders = projectIds.map(() => "?").join(", ");
  const kindFilter = kind ? " AND concepts_json LIKE ?" : "";
  const args: unknown[] = [...projectIds, ...(kind ? [`%"card:${kind}:%`] : [])];
  const rows = db
    .prepare(
      `SELECT ${CARD_COLUMNS} FROM lane_pilot_memory
       WHERE project_id IN (${placeholders}) AND status IN ('active', 'expired') AND concepts_json LIKE '%"card"%'${kindFilter}
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(...args) as CardMemoryRow[];
  return rows.filter((row) => {
    const concepts = parseConceptsJson(row.concepts_json);
    if (!concepts.includes("card")) return false;
    return kind ? concepts.some((c) => c.startsWith(`card:${kind}:`)) : concepts.some((c) => c.startsWith("card:"));
  });
}

export function writeCardRecord(
  db: LanePilotDatabase,
  input: {
    id: string;
    storedProjectId: string;
    concept: string;
    concepts: readonly string[];
    content: string;
    sourceSha256: string;
    now: number;
    trust: "confirmed" | "observed";
    validUntil: number;
    verificationJson: string;
  },
): void {
  const unindex = (projectId: string, recordId: string) => dropMemoryIndexes(db, projectId, recordId);
  db.transaction(() => {
    const existing = findNonSupersededCardRowsByConcept(db, input.storedProjectId, input.concept);
    for (const old of existing) {
      if (old.status === "active") {
        hideRecord(db, input.storedProjectId, old.id, "superseded", input.id, unindex);
      } else {
        db.prepare(
          "UPDATE lane_pilot_memory SET status='superseded', superseded_by=? WHERE project_id=? AND id=? AND status='expired'",
        ).run(input.id, input.storedProjectId, old.id);
        unindex(input.storedProjectId, old.id);
      }
    }

    db.prepare(
      `INSERT INTO lane_pilot_memory(
         id, project_id, personal_bot, kind, audience, content, concepts_json,
         source_sha256, created_at, status, trust, origin, valid_until, valid_from,
         source_file_id, verification_json
       ) VALUES (?, ?, '', 'note', 'subagent', ?, ?, ?, ?, 'active', ?, 'card', ?, ?, NULL, ?)`,
    ).run(
      input.id,
      input.storedProjectId,
      input.content,
      JSON.stringify(input.concepts),
      input.sourceSha256,
      input.now,
      input.trust,
      input.validUntil,
      input.now,
      input.verificationJson,
    );

    addToIndexes(db, input.storedProjectId, input.id, input.content, [...input.concepts]);
  })();
}

export function updateCardVerification(
  db: LanePilotDatabase,
  input: {
    id: string;
    storedProjectId: string;
    content: string;
    concepts: readonly string[];
    wasActive: boolean;
    trust: "confirmed" | "observed";
    validUntil: number;
    verificationJson: string;
  },
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE lane_pilot_memory
       SET status='active', expired_reason=NULL, trust=?, valid_until=?, verification_json=?
       WHERE project_id=? AND id=? AND status IN ('active', 'expired')`,
    ).run(input.trust, input.validUntil, input.verificationJson, input.storedProjectId, input.id);

    if (!input.wasActive) {
      dropMemoryIndexes(db, input.storedProjectId, input.id);
      addToIndexes(db, input.storedProjectId, input.id, input.content, [...input.concepts]);
    }
  })();
}
