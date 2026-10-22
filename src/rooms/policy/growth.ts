import type { Exam } from "./exam";
import type { Matcher, Policy } from "./policy";

/**
 * "Only the owner" may grow and never shrink. These functions compare a previous committed version with the current one and return what
 * was lost; tests/policy/growth.test.ts runs them against `git show HEAD:<file>`. A matcher is compared whole: narrowing one (an added field
 * is an AND, a removed glob is a smaller set) counts as losing it, so a widening is a new matcher, never an edit of an old one.
 */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v);

export function ownerOnlyShrank(previous: Pick<Policy, "owner_only" | "exam">, current: Pick<Policy, "owner_only" | "exam">): string[] {
  const lost: string[] = [];
  const now = new Map(current.owner_only.map((entry) => [entry.id, entry]));
  for (const entry of previous.owner_only) {
    const kept = now.get(entry.id);
    if (!kept) { lost.push(`owner_only entry «${entry.id}» is gone (or left the owner_only list)`); continue; }
    const have = new Set(kept.match.map((matcher: Matcher) => canonical(matcher)));
    for (const matcher of entry.match) if (!have.has(canonical(matcher))) lost.push(`owner_only entry «${entry.id}» lost or changed the matcher ${canonical(matcher)}`);
  }
  if (current.exam.min_accuracy < previous.exam.min_accuracy) lost.push(`exam.min_accuracy fell from ${previous.exam.min_accuracy} to ${current.exam.min_accuracy}`);
  return lost;
}

/** The exam can gain items; an item that was there keeps its descriptor and its expected tier. */
export function examShrank(previous: Pick<Exam, "items">, current: Pick<Exam, "items">): string[] {
  const lost: string[] = [];
  const now = new Map(current.items.map((item) => [item.id, item]));
  for (const item of previous.items) {
    const kept = now.get(item.id);
    if (!kept) lost.push(`exam item ${item.id} is gone`);
    else if (canonical(kept.descriptor) !== canonical(item.descriptor) || kept.expected !== item.expected) lost.push(`exam item ${item.id} was edited (descriptor or expected tier)`);
  }
  return lost;
}
