import { SETTING_EPISODES_PROCESS_KEY } from "@lane-pilot/settings-catalog";
import { stems } from "@lane-pilot/workflow-engine";
import { choice, choiceOf, defineJudgment, jev, type Jev, type JudgeContext } from "@lane-pilot/jev";

/**
 * The process key of an errand (crystallization stage 1, stream R6): which recurring kind of work an errand belongs
 * to, as `subject|process`. The episode sweep proposes a candidate key (`process_key_proposed`); this module turns it
 * into `process_key`: the candidate's and the title's word stems are compared with every known key's words and titles,
 * the 8 nearest go to Jev as a `choice` plus «none of these», and the answer decides. Until the pairwise F1 on the gold
 * set reaches 0.8 the judgment stays in `shadow` and the deterministic answer is used; every call leaves a receipt.
 */

export const PROCESS_KEY_JUDGMENT_ID = "errand.process_key";
/** The «none of these» option of the choice, same sentinel the router's route.workflow uses. */
const NONE = "none_of_these";
const NEAREST = 8;

export type KnownProcessKey = { key: string; titles: string[] };
export type NearProcessKey = KnownProcessKey & { score: number };

const stemSet = (text: string): Set<string> => new Set(stems(text));

/** Jaccard over stem sets — the same shape as learning/extract.ts similarity(), on stems instead of raw words. */
function score(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The `n` known keys nearest to the candidate and the title, by word stems; ties break on the key for a stable order. */
export function nearestKeys(candidate: string, title: string, known: KnownProcessKey[], n = NEAREST): NearProcessKey[] {
  const query = stemSet(`${candidate} ${title}`);
  return known
    .map((entry) => ({ ...entry, score: score(query, stemSet(`${entry.key} ${entry.titles.join(" ")}`)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, n);
}

export type ProcessKeyInput = { candidate: string; title: string; options: NearProcessKey[] };
export type ProcessKeyDecision = { key: string; how: "jev" | "new" | "fallback" };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** J-13 `errand.process_key`: which of the nearest known process keys this errand continues, or a new one. */
export const processKeyJudgment = defineJudgment<ProcessKeyInput, ProcessKeyDecision>({
  id: PROCESS_KEY_JUDGMENT_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 6_000,
  stateBuilder: (input) => ({
    candidate: clip(input.candidate, 200),
    title: clip(input.title, 1_500),
    keys: input.options.map((option) => option.key),
  }),
  questions: (input) => {
    const options: Record<string, unknown> = {};
    for (const option of input.options) {
      const example = option.titles.find((title) => title.trim().length > 0);
      options[option.key] = `${option.key}${example ? ` — for example «${clip(example, 120)}»` : ""}`;
    }
    options[NONE] = "None of these: this errand is a new kind of work that no known key covers.";
    return {
      key: choice(
        "Which known process does the errand in `title` (proposed key `candidate`) continue? Judge by the kind of work, not by shared words. Pick none_of_these when no listed key fits.",
        options,
      ),
    };
  },
  thresholds: { min_p: { default: 0.6, min: 0.3, max: 0.95, about: "least probability of the chosen key; below, or on none_of_these, the candidate stands as a new key" } },
  decide: (answers, t, input) => {
    const pick = choiceOf(answers, "key");
    const top = pick && pick.top !== NONE && pick.p >= t.min_p! ? pick.top : null;
    return { decision: { key: top ?? input.candidate, how: top ? "jev" : "new" } };
  },
  fallback: (input) => ({ key: input.candidate, how: "fallback" }),
  describe: (decision) => `${decision.key} (${decision.how})`,
});

export type ProcessKeyPick = { key: string; how: "new" | "jev" | "fallback" };

/**
 * The process key of one errand. No known keys or nothing similar → the candidate is a new key. Otherwise Jev is asked
 * among the nearest keys or «none» (the call always leaves a receipt while the judgment is on); its pick is used only
 * when `episodes.process_key` is `active` — shadow keeps the deterministic answer. When Jev cannot answer (off, a
 * failure) only an exact candidate match counts, else the candidate stands anyway.
 */
export async function chooseProcessKey(input: {
  candidate: string;
  title: string;
  known: KnownProcessKey[];
  judge?: Jev | null;
  ctx?: JudgeContext;
}): Promise<ProcessKeyPick> {
  const { candidate, title, known } = input;
  const near = nearestKeys(candidate, title, known);
  if (!near.length) return { key: candidate, how: "new" };
  const deterministic = (how: "new" | "fallback"): ProcessKeyPick => ({ key: known.find((entry) => entry.key === candidate)?.key ?? candidate, how });
  const instance = input.judge === undefined ? jev() : input.judge;
  if (!instance?.enabled(input.ctx?.settings)) return deterministic("fallback");
  const verdict = await instance.judge(processKeyJudgment, { candidate, title, options: near }, input.ctx).catch(() => null);
  if (!verdict) return deterministic("fallback");
  // episodes.process_key=active is the feature switch: a live pick is used as is; a shadow verdict still carries what
  // Jev would have picked (`shadow.decision`), which the active switch adopts — the receipt keeps mode shadow either way.
  if (input.ctx?.settings?.[SETTING_EPISODES_PROCESS_KEY] === "active") {
    const decided = verdict.by === "jev" ? verdict.decision : verdict.by === "fallback" && verdict.status === "shadow" ? verdict.shadow?.decision : undefined;
    if (decided) return { key: decided.key, how: decided.how };
  }
  return deterministic("new");
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Pairs of ids that share a key, in gold and in predicted; `one-off|…` keys never pair (each is its own singleton). */
function sharedPairs(rows: Array<{ id: string; key: string }>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.key.startsWith("one-off|") ? `${row.key}#${row.id}` : row.key;
    const list = groups.get(key) ?? [];
    list.push(row.id);
    groups.set(key, list);
  }
  const pairs = new Set<string>();
  for (const ids of groups.values()) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) pairs.add(pairKey(ids[i]!, ids[j]!));
    }
  }
  return pairs;
}

/** Pairwise precision/recall/F1 of the predicted keys against the gold ones (~15 lines, no dependencies). */
export function pairwiseF1(gold: Array<{ id: string; key: string }>, predicted: Array<{ id: string; key: string }>): { precision: number; recall: number; f1: number; pairs: { gold: number; predicted: number; both: number } } {
  const goldPairs = sharedPairs(gold);
  const predictedPairs = sharedPairs(predicted);
  let both = 0;
  for (const pair of predictedPairs) if (goldPairs.has(pair)) both += 1;
  const precision = predictedPairs.size ? both / predictedPairs.size : goldPairs.size ? 0 : 1;
  const recall = goldPairs.size ? both / goldPairs.size : predictedPairs.size ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, pairs: { gold: goldPairs.size, predicted: predictedPairs.size, both } };
}
