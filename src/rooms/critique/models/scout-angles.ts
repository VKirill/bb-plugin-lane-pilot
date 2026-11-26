import { SCOUT_SEAT_ROLES } from "@lane-pilot/models";

export const SCOUT_GRAPH = "scout";

export type ScoutAngle = { id: string; title: string; focus: string };

/**
 * The n-th angle runs on the scout seat n (mod 3) of the role table (SCOUT_SEAT_ROLES), so each standard angle has its own model and custom
 * angles take the seats in turn. The graph's role is `scout{{item.seat}}`: `seat` is the row's suffix after «scout» ("", "-2", "-3").
 */
export type SeatedScoutAngle = ScoutAngle & { seat: string };

/** Default 3-angle pre-plan reconnaissance matching AI Factory's parallel explore scouts. */
export const DEFAULT_SCOUT_ANGLES: readonly ScoutAngle[] = [
  {
    id: "architecture",
    title: "Architecture & entry points",
    focus: "Map affected modules, entry points, schemas/contracts, RPC/CLI/HTTP surfaces, state flow, and exact file:line anchors the goal touches.",
  },
  {
    id: "patterns",
    title: "Existing patterns & conventions",
    focus: "Find the closest existing analogous feature, helper, RPC, setting, UI pattern, and test style in this repository (with file:line) so the plan reuses existing conventions instead of inventing parallel ones.",
  },
  {
    id: "dependencies",
    title: "Dependencies, callers & verification",
    focus: "Trace upstream callers/importers of symbols to change, boundary/size/migration/SMA locks, side effects, and the exact focused verification commands (cwd + command) for task-v2.",
  },
];

const slugOf = (text: string, index: number): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || `angle-${index + 1}`;

/** Normalizes custom audit angles (strings or `{id, title, focus}`) or returns the 3 standard reconnaissance angles. */
export function normalizeScoutAngles(raw: unknown): { mode: "recon" | "audit"; angles: SeatedScoutAngle[] } {
  const list = Array.isArray(raw) ? raw : [];
  const custom: ScoutAngle[] = [];
  for (const [index, entry] of list.slice(0, 6).entries()) {
    if (typeof entry === "string" && entry.trim()) {
      const text = entry.trim();
      const colon = text.indexOf(":");
      const title = (colon > 0 && colon <= 60 ? text.slice(0, colon) : text.slice(0, 60)).trim();
      custom.push({ id: slugOf(title, index), title, focus: text });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const row = entry as Record<string, unknown>;
      const focus = typeof row.focus === "string" && row.focus.trim() ? row.focus.trim() : typeof row.prompt === "string" ? row.prompt.trim() : "";
      const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : focus.slice(0, 60).trim();
      if (!title && !focus) continue;
      const id = typeof row.id === "string" && row.id.trim() ? slugOf(row.id.trim(), index) : slugOf(title, index);
      custom.push({ id, title: title || id, focus: focus || title });
    }
  }
  const angles = custom.length ? custom : DEFAULT_SCOUT_ANGLES;
  return { mode: custom.length ? "audit" : "recon", angles: angles.map((angle, index) => ({ ...angle, seat: SCOUT_SEAT_ROLES[index % SCOUT_SEAT_ROLES.length]!.slice("scout".length) })) };
}
