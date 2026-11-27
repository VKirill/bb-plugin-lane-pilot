import { CARD_LIMITS } from "@lane-pilot/contracts";
import type { MemoryCardsListOutput } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import type { LanePilotDatabase } from "../../../storage";
import type { CardKind } from "../../index";
import { listNonSupersededCardRows, parseConceptsJson, type CardMemoryRow } from "../repositories/cards-repository";
import { DAY_MS, parseCardIdentity, parseVerificationList } from "../services/cards";

type CardListItem = MemoryCardsListOutput["cards"][number];

function cardTitle(content: string, fallbackKey: string): string {
  const line = content
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? fallbackKey;
}

function mapCardRow(row: CardMemoryRow, now: number): CardListItem | null {
  const concepts = parseConceptsJson(row.concepts_json);
  const identity = parseCardIdentity(concepts);
  if (!identity) return null;
  const verifications = parseVerificationList(row.verification_json);
  const first = verifications[0];
  const last = verifications.at(-1);
  const verifiedAt = last?.at ?? row.valid_from ?? row.created_at;
  const ttlMs = row.valid_until !== null ? row.valid_until - verifiedAt : null;
  const ttlDays = ttlMs !== null ? Math.round((ttlMs / DAY_MS) * 1000) / 1000 : null;
  const validUntil = row.valid_until ?? verifiedAt + CARD_LIMITS.defaultTtlDays[identity.kind] * DAY_MS;
  const stale = row.status === "expired" || validUntil <= now;
  const rawRef = last?.ref ?? first?.ref ?? null;
  const ref = typeof rawRef === "string" && rawRef.trim() ? rawRef.trim() : null;
  return {
    id: row.id,
    kind: identity.kind,
    title: cardTitle(row.content, identity.key),
    concepts,
    verifiedAt,
    ttlDays,
    stale,
    ref,
    version: Math.max(1, verifications.length),
  };
}

/** Lists non-superseded knowledge cards for a project (including its sections), without logging on reads. */
export function listMemoryCards(
  db: LanePilotDatabase,
  input: { projectId: string; kind?: CardKind },
  now: number = Date.now(),
): MemoryCardsListOutput {
  const projectId = input.projectId.trim();
  if (!projectId) return { cards: [] };
  const rows = listNonSupersededCardRows(db, [projectId], input.kind);
  const cards: CardListItem[] = [];
  for (const row of rows) {
    const mapped = mapCardRow(row, now);
    if (mapped) cards.push(mapped);
  }
  return { cards };
}

/** Console RPC handler for `memory_cards_list`. */
export function cardsRpc(ctx: Pick<ServerCore, "db">, deps: { now?: () => number } = {}) {
  return {
    memory_cards_list: async (input: { projectId: string; kind?: CardKind }): Promise<MemoryCardsListOutput> =>
      listMemoryCards(ctx.db, input, deps.now ? deps.now() : Date.now()),
  };
}
