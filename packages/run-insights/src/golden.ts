export type GoldenCase = { query: string; mustHit: string[] };

export type GoldenReport = {
  cases: number;
  hits: number;
  hitRate: number;
  misses: Array<{ query: string; missing: string[] }>;
};

/**
 * Accepts a JSON array of `{query, mustHit}` or the line form lane-memory writes to GOLDEN.yaml:
 * `- query -> id1, id2`. Blank input is an empty set, not an error.
 */
export function parseGoldenCases(raw: unknown): GoldenCase[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text || text === "[]") return [];
    if (text.startsWith("[")) return parseGoldenCases(JSON.parse(text));
    return text.split("\n").flatMap((line) => {
      const match = line.match(/^\s*-\s*(.+?)\s*->\s*(.+)$/);
      if (!match) return [];
      return [{ query: match[1]!.trim(), mustHit: match[2]!.split(",").map((id) => id.trim()).filter(Boolean) }];
    });
  }
  if (!Array.isArray(raw)) throw new Error("golden cases must be an array");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`golden case ${index} must be an object`);
    const query = Reflect.get(item, "query");
    const mustHit = Reflect.get(item, "mustHit");
    if (typeof query !== "string" || !query.trim()) throw new Error(`golden case ${index} needs a query`);
    if (!Array.isArray(mustHit) || mustHit.some((id) => typeof id !== "string" || !id)) throw new Error(`golden case ${index} needs mustHit ids`);
    return { query: query.trim(), mustHit: [...new Set(mustHit as string[])] };
  });
}

/** A case hits when every id it names is among the ids the search returned. */
export function runGoldenEval(cases: readonly GoldenCase[], search: (query: string) => readonly string[]): GoldenReport {
  const misses: GoldenReport["misses"] = [];
  let hits = 0;
  for (const item of cases) {
    const found = new Set(search(item.query));
    const missing = item.mustHit.filter((id) => !found.has(id));
    if (missing.length === 0) hits += 1;
    else misses.push({ query: item.query, missing });
  }
  return { cases: cases.length, hits, hitRate: cases.length ? hits / cases.length : 1, misses };
}
