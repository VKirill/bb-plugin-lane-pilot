import type { ProcessForm } from "./tick";

/**
 * Pure nearest-unit types, thresholds, and form hypothesis rules (Stream G/R8).
 */
export type NearestUnit = { kind: "graph" | "skill"; id: string; score: number };

/** What `graphlessErrands` knows about a group's runs, for the form hypothesis. */
export type GroupSignals = { repeatedTrace: "ok" | "failed" | null; providers: number };
export type FormHint = { form: ProcessForm; why: string };

/** The four nearest units of one group: router candidates of the graphs plus the best-overlapping catalog skills. */
export const NEAREST_MAX = 4;
/** A skill counts as «the same family» when it covers at least this share of the group's content words (stems). */
export const SKILL_NEAR_SCORE = 0.5;

/** The group's runs show a gate, a timetable or helpers of different kinds — only a graph carries those (the old G2 rule, now a signal). */
const SCHEDULE_WORDS = /cron|расписан|ежеднев|еженедельно|каждый день|каждую неделю|ежемесяч|schedule/iu;
const GATE_WORDS = /оплат|плат[её]ж|деньг|publish|публикац|отправ|send|delete|удал|письм|email|invoice|счёт|счет|договор|money/iu;

/** gate/schedule words are a regex over the sample titles plus provider diversity — a ceiling (a process can
 * hide its gate in the task text, not the title). */
export function graphSignalsOf(row: { samples: string[]; signals: GroupSignals }): boolean {
  if (row.signals.providers >= 2) return true;
  const text = row.samples.join("\n");
  return SCHEDULE_WORDS.test(text) || GATE_WORDS.test(text);
}

/**
 * The form a group deserves, from what is near and what the runs did. Order: a repeated command sequence is a script
 * (or a trap, when the same call keeps failing); a gate/schedule/multi-helper shape is a graph; a near skill of the
 * same family takes a new variant as a reference (or a rule when the family's runs keep failing); with nothing near,
 * a new skill.
 */
export function formHypothesis(input: { nearest: NearestUnit[]; signals: GroupSignals; graphSignals: boolean }): FormHint {
  const { nearest, signals } = input;
  if (signals.repeatedTrace === "ok") return { form: "script", why: "the same command sequence ran in at least three episodes: a fixed sequence is a script" };
  if (input.graphSignals) return { form: "graph", why: "the runs show a gate, a schedule or different helpers: only a graph carries those" };
  const near = nearest.find((unit) => unit.kind === "skill" && unit.score >= SKILL_NEAR_SCORE);
  if (near) {
    return signals.repeatedTrace === "failed"
      ? { form: "rule", why: `the same call keeps failing and ${near.id} is the family it belongs to: a trap to write down` }
      : { form: "reference", why: `${near.id} is near and this is a new variant of its family: a file under its references/` };
  }
  if (signals.repeatedTrace === "failed") return { form: "rule", why: "the same call keeps failing in at least three episodes: a trap to write down" };
  return { form: "skill", why: "nothing in the catalog is near: a new skill" };
}
