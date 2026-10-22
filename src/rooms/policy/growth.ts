import type { Matcher, Policy, Tier, ChangeDescriptor } from "./policy";

/**
 * "Only the owner" may grow and never shrink. These functions compare a previous committed version with the current one and return what
 * was lost; tests/policy/growth.test.ts runs them against `git show HEAD:<file>`. A matcher is compared whole: narrowing one (an added field
 * is an AND, a removed glob is a smaller set) counts as losing it, so a widening is a new matcher, never an edit of an old one.
 * Standing prohibitions follow the same rule as owner_only: the owner said «never», only he takes it back.
 */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v);

type Guarded = Pick<Policy, "owner_only" | "exam"> & Partial<Pick<Policy, "standing_prohibitions">>;

export function ownerOnlyShrank(previous: Guarded, current: Guarded): string[] {
  const lost: string[] = [];
  const compare = (label: string, before: Guarded["owner_only"], after: Guarded["owner_only"]) => {
    const now = new Map(after.map((entry) => [entry.id, entry]));
    for (const entry of before) {
      const kept = now.get(entry.id);
      if (!kept) { lost.push(`${label} entry «${entry.id}» is gone (or left the ${label} list)`); continue; }
      const have = new Set(kept.match.map((matcher: Matcher) => canonical(matcher)));
      for (const matcher of entry.match) if (!have.has(canonical(matcher))) lost.push(`${label} entry «${entry.id}» lost or changed the matcher ${canonical(matcher)}`);
    }
  };
  compare("owner_only", previous.owner_only, current.owner_only);
  compare("standing_prohibitions", previous.standing_prohibitions ?? [], current.standing_prohibitions ?? []);
  if (current.exam.min_accuracy < previous.exam.min_accuracy) lost.push(`exam.min_accuracy fell from ${previous.exam.min_accuracy} to ${current.exam.min_accuracy}`);
  const before = (previous.exam as { min_items?: number }).min_items, after = (current.exam as { min_items?: number }).min_items;
  if (before !== undefined && (after ?? 0) < before) lost.push(`exam.min_items fell from ${before} to ${after}`);
  return lost;
}

type ItemLike = { id: string; descriptor: ChangeDescriptor; expected: Tier; decided_at?: string };

/** An exam can gain items; an item that was there keeps its descriptor, its expected tier and its decision time. */
export function examShrank(previous: { items: readonly ItemLike[] }, current: { items: readonly ItemLike[] }): string[] {
  const lost: string[] = [];
  const now = new Map(current.items.map((item) => [item.id, item]));
  for (const item of previous.items) {
    const kept = now.get(item.id);
    if (!kept) lost.push(`exam item ${item.id} is gone`);
    else if (canonical(kept.descriptor) !== canonical(item.descriptor) || kept.expected !== item.expected || kept.decided_at !== item.decided_at) lost.push(`exam item ${item.id} was edited (descriptor, expected tier or decision time)`);
  }
  return lost;
}

/**
 * A policy whose lists changed is a new version: higher `version`, later `frozen_at`. Without this an edit could keep the old freeze time and
 * be scored on decisions it was written after reading.
 */
export function freezeProblems(previous: Pick<Policy, "version" | "frozen_at" | "frozen_hash">, current: Pick<Policy, "version" | "frozen_at" | "frozen_hash">): string[] {
  if (previous.frozen_hash === current.frozen_hash) {
    return previous.version === current.version && previous.frozen_at === current.frozen_at ? [] : ["version or frozen_at changed while the lists did not"];
  }
  const problems: string[] = [];
  if (current.version <= previous.version) problems.push(`the lists changed but version stayed ${current.version} (was ${previous.version})`);
  if (!(Date.parse(current.frozen_at) > Date.parse(previous.frozen_at))) problems.push(`the lists changed but frozen_at did not move past ${previous.frozen_at}`);
  return problems;
}
