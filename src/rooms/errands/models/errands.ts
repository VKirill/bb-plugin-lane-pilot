import type { ErrandOutcome, ErrandVerifiedOutcome } from "../../contracts";
import { ERRAND_KINDS, type ErrandKind } from "../../schedule";

/** What the code saw of a done (errandCheck): `unknown` for a run before CHECK lines, and for one that did not end in a report. */
export type ErrandKindOrNone = ErrandKind | "none";
export const ERRAND_KINDS_WITH_NONE: readonly ErrandKindOrNone[] = [...ERRAND_KINDS, "none"];
export type ErrandSource = { type: "schedule"; name: string } | { type: "pm"; threadId: string | null } | { type: "other" };
export type ErrandRow = {
  id: string; projectId: string | null; title: string; kind: ErrandKindOrNone; kindBy: string; providerId: string; model: string;
  outcome: ErrandOutcome; verified: ErrandVerifiedOutcome; reason: string; source: ErrandSource; threadId: string | null; tokens: number; costUsd: number; startedAt: number; endedAt: number | null;
};
export type KindSummary = {
  kind: ErrandKindOrNone; role: string; providerId: string; model: string; effort: string; source: string;
  runs: number; done: number; checked: number; blocked: number; failed: number; costUsd: number;
};

/** The errand's name on the page: the title it was given, else the first line of the brief after a schedule's standing preamble. */
export function errandTitle(inputs: { title?: unknown; task?: unknown }): string {
  if (typeof inputs.title === "string" && inputs.title.trim()) return inputs.title.trim().slice(0, 120);
  const task = typeof inputs.task === "string" ? inputs.task : "";
  const line = task.split("\n").map((part) => part.trim()).find((part) => part && !/^This is a scheduled run of|^If the task needs a decision/u.test(part)) ?? "";
  return line.replace(/^Owner request \([^)]*\):\s*/u, "").replace(/^"|"$/gu, "").slice(0, 120) || "—";
}

export const kindOf = (value: unknown): ErrandKindOrNone => (typeof value === "string" && (ERRAND_KINDS as readonly string[]).includes(value) ? (value as ErrandKind) : "none");

const STEM_STOP = new Set(["тест", "проверка", "проверить", "the", "a", "an", "for", "of", "to", "in", "on", "and", "or", "на", "в", "и", "у", "о", "об", "с", "к", "по", "за", "из", "от", "до", "не", "что", "как", "для", "это"]);

/** The stem a group of hand-run errands shares: the title lower-cased, without urls, @names, digits, ids or dates, its first four significant words. */
export function errandStem(title: string): string {
  const words = (title.toLowerCase().replace(/https?:\/\/\S+/gu, " ").replace(/@[\p{L}\p{N}_]+/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !/\p{N}/u.test(word) && !STEM_STOP.has(word));
  return words.slice(0, 4).join(" ");
}

/** The confidence of a `routeTop` string («<workflowId>:<confidence>», stream G1); NaN when the run has no route or no readable number. */
export const routeConfidence = (routeTop: string): number => { const at = /:(\d+)\s*$/u.exec(routeTop); return at ? Number(at[1]) : Number.NaN; };
