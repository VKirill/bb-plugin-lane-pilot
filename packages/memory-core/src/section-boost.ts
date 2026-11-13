/**
 * `memory.scope = project`: the rank boost of the asking section. Section scopes stop hiding notes, but a note written in the section the
 * reader works in is still likelier to be the one it needs, so it moves up this many places in a ranked list (a stable re-rank, not a score
 * multiplier: it can lift a note over three others and no further, whatever the scores are).
 */
export const SECTION_RANK_BOOST = 3;

/** The items with `preferred` true go up `SECTION_RANK_BOOST` places; the rest keep their order. A list without a preferred item comes back as it was. */
export function liftPreferred<T>(items: readonly T[], preferred: (item: T) => boolean): T[] {
  if (!items.some(preferred)) return [...items];
  return items.map((item, index) => ({ item, index, up: preferred(item), key: index - (preferred(item) ? SECTION_RANK_BOOST : 0) }))
    .sort((a, b) => a.key - b.key || Number(b.up) - Number(a.up) || a.index - b.index).map((entry) => entry.item);
}

export type MemoryScopeMode = "section" | "project";

/** Under `project` scope: re-ranks `rows` so the notes whose scope is one of `ownScopes` (the asking section and its ancestors) go up, and says which they are. A no-op for `section` scope or a reader without a chain. */
export function boostAskingSection<R extends { id: string }>(db: { prepare(sql: string): { all(...args: any[]): unknown[] } }, projectId: string, rows: R[], mode: MemoryScopeMode | undefined, ownScopes: readonly string[]): { rows: R[]; own: Set<string> } {
  const own = new Set(ownScopes);
  if (mode !== "project" || !own.size || !rows.length) return { rows, own: new Set() };
  const scopes = new Map((db.prepare(`SELECT id, scope_json FROM lane_pilot_memory WHERE project_id=? AND id IN (${rows.map(() => "?").join(",")})`).all(projectId, ...rows.map((row) => row.id)) as Array<{ id: string; scope_json: string | null }>).map((row) => [row.id, row.scope_json ?? ""]));
  const mine = new Set(rows.filter((row) => own.has(scopes.get(row.id) ?? "")).map((row) => row.id));
  return { rows: liftPreferred(rows, (row) => mine.has(row.id)), own: mine };
}
