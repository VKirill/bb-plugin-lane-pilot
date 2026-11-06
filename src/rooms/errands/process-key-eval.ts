import type { Jev } from "@lane-pilot/jev";
import goldFile from "../../../tests/fixtures/errand-gold.json";
import { chooseProcessKey, pairwiseF1, type KnownProcessKey, type ProcessKeyDecision, type ProcessKeyInput } from "./process-key";

/**
 * The process-key eval (stream R6): runs chooseProcessKey over the hand-labelled gold set
 * (tests/fixtures/errand-gold.json, rows id/title/process_key/real_outcome/form) and reports the pairwise F1 of the
 * predicted keys against the gold ones. `bb lane-pilot errands process-key-eval [--json]`.
 *
 * The fixture has no model proposals, so the candidate stands in as the gold key itself: the eval proves the plumbing
 * (nearest → judge → key → pairs) and gives the word-only baseline F1. The real Jev number is measured on the hub.
 */
export const ERRANDS_USAGE = "bb lane-pilot errands process-key-eval [--json]";


type GoldRow = { id: string; title: string; process_key: string; real_outcome?: string; form?: string };
type GoldFile = { rows: GoldRow[] };

/** A stand-in for Jev that picks the highest word-similarity option above `minScore`, else «new». Eval only. */
export function wordJudge(minScore = 0.15): Jev {
  const judge = async (_judgment: unknown, raw: unknown): Promise<{ by: "jev"; decision: ProcessKeyDecision; receiptId: null; answers: Record<string, never> }> => {
    const input = raw as ProcessKeyInput;
    const best = [...input.options].sort((a, b) => b.score - a.score)[0];
    const decision = best && best.score >= minScore ? { key: best.key, how: "jev" as const } : { key: input.candidate, how: "new" as const };
    return { by: "jev", decision, receiptId: null, answers: {} };
  };
  return {
    judge,
    judgeMany: async (_judgment, inputs) => Promise.all(inputs.map((input) => judge(_judgment, input))),
    judgeBundle: async (items) => Promise.all(items.map((item) => judge(item.judgment, item.input))),
    outcome: () => {},
    enabled: () => true,
  } as Jev;
}

export type ProcessKeyEvalResult = {
  n: number;
  knownKeys: number;
  precision: number;
  recall: number;
  f1: number;
  pairs: { gold: number; predicted: number; both: number };
  how: Record<string, number>;
  predicted: Array<{ id: string; key: string }>;
};

/** Runs the eval: the known keys are the gold set's own (one-off|… excluded — they are singletons, not processes). */
export async function processKeyEval(rows: GoldRow[], judge?: Jev | null): Promise<ProcessKeyEvalResult> {
  const byKey = new Map<string, Array<{ id: string; title: string }>>();
  for (const row of rows) {
    if (row.process_key.startsWith("one-off|")) continue;
    const list = byKey.get(row.process_key) ?? [];
    list.push({ id: row.id, title: row.title });
    byKey.set(row.process_key, list);
  }
  const predicted: Array<{ id: string; key: string }> = [];
  const how: Record<string, number> = {};
  for (const row of rows) {
    // The row's own title stays out of its key's titles, so the match is not scored against itself.
    const known: KnownProcessKey[] = [...byKey].map(([key, list]) => ({ key, titles: list.filter((entry) => entry.id !== row.id).map((entry) => entry.title) }));
    // The eval measures the judge's picks, so the feature switch stands on active; without it every pick is shadowed
    // and the candidate (= the gold key) would make the F1 trivially 1.0.
    const pick = await chooseProcessKey({ candidate: row.process_key, title: row.title, known, judge, ctx: { settings: { "episodes.process_key": "active" } } });
    predicted.push({ id: row.id, key: pick.key });
    how[pick.how] = (how[pick.how] ?? 0) + 1;
  }
  const gold = rows.map((row) => ({ id: row.id, key: row.process_key }));
  const score = pairwiseF1(gold, predicted);
  return { n: rows.length, knownKeys: byKey.size, ...score, how, predicted };
}

export async function runErrandsCli(args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const [command, ...rest] = args;
  if (command !== "process-key-eval") return { exitCode: 1, stderr: `usage: ${ERRANDS_USAGE}` };
  const file = goldFile as GoldFile;
  const result = await processKeyEval(file.rows, wordJudge());
  const { predicted: _predicted, ...summary } = result;
  if (rest.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
  const lines = [
    `process-key eval: ${result.n} errands, ${result.knownKeys} known keys`,
    `pairwise F1 ${result.f1.toFixed(3)} (precision ${result.precision.toFixed(3)}, recall ${result.recall.toFixed(3)}; pairs gold ${result.pairs.gold}, predicted ${result.pairs.predicted}, both ${result.pairs.both})`,
    `how: ${Object.entries(result.how).map(([how, count]) => `${how} ${count}`).join(", ")}`,
  ];
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}
