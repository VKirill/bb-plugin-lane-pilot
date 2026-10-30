/**
 * Council for disagreeing critics (arXiv #24, MAD): when two critics ran the same rubric and one says ok where the
 * other says fail, a third cheap voice decides — the role `critic-tiebreak` of the role table (Gemini 3.8 Flash through
 * 9router by default), one session for all the contested items at once. A rubric row both critics agree on is never
 * asked again; a contested row follows the majority, and a row the tiebreak voice could not read stays a fail (the
 * critic that failed it quoted evidence — a fail needs it, an ok does not).
 */
import type { Verdict, VerdictKind, VerdictRubricItem } from "@lane-pilot/workflow-engine";

export const CRITIC_TIEBREAK_ROLE = "critic-tiebreak";
export type TiebreakVote = "ok" | "fail";

/** The rubric ids the two verdicts answered differently (one ok, one fail); items only one of them sent are not contested. */
export function rubricDisagreements(a: Verdict, b: Verdict): string[] {
  const map = new Map<string, "ok" | "fail">();
  for (const item of a.rubric ?? []) map.set(item.id, item.result);
  const ids: string[] = [];
  for (const item of b.rubric ?? []) {
    const other = map.get(item.id);
    if (other && other !== item.result && !ids.includes(item.id)) ids.push(item.id);
  }
  return ids;
}

const rubricLines = (verdict: Verdict, ids: readonly string[]): string =>
  (verdict.rubric ?? []).filter((item) => ids.includes(item.id))
    .map((item) => `- ${item.id}: ${item.result} — ${item.evidence || "(no evidence)"}`).join("\n");

/** The one prompt the tiebreak voice answers: every contested item, both critics' results and their evidence. */
export function tiebreakPrompt(input: { kind: VerdictKind; items: readonly string[]; a: Verdict; b: Verdict }): string {
  return [
    `Two ${input.kind} critics read the same work and disagree on these rubric items: ${input.items.join(", ")}.`,
    "For each item decide the truth from the quoted evidence, not from the critics' confidence. A fail needs the evidence to show the defect; vote ok when the quoted evidence does not prove it.",
    "",
    "Critic A:",
    rubricLines(input.a, input.items),
    "Critic B:",
    rubricLines(input.b, input.items),
    "",
    `Answer JSON only: {"votes":[{"id":"<item id>","result":"ok"|"fail","evidence":"<one line>"}], "summary":"<one line>"}.`,
  ].join("\n");
}

/** The third voice's votes, by rubric id; items it did not answer are absent (the caller keeps them as fail). */
export function parseTiebreakVotes(raw: string, items: readonly string[]): Map<string, TiebreakVote> {
  const votes = new Map<string, TiebreakVote>();
  const wanted = new Set(items);
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { votes?: Array<{ id?: unknown; result?: unknown }> };
    for (const vote of parsed.votes ?? []) {
      const id = typeof vote.id === "string" ? vote.id : "";
      if (!wanted.has(id)) continue;
      if (vote.result === "ok" || vote.result === "fail") votes.set(id, vote.result);
    }
  } catch { /* an unreadable answer decides nothing */ }
  return votes;
}

/**
 * The merged rubric of two critics plus the tiebreak votes. Agreed rows keep their result; contested rows follow the
 * majority — the voice's vote joins the two, so the majority is its vote. A row the voice did not answer stays a fail.
 */
export function majorityRubric(a: Verdict, b: Verdict, votes: ReadonlyMap<string, TiebreakVote>): VerdictRubricItem[] {
  const ids: string[] = [];
  const byId = new Map<string, { a?: VerdictRubricItem; b?: VerdictRubricItem }>();
  for (const [critic, verdict] of [["a", a], ["b", b]] as const) {
    for (const item of verdict.rubric ?? []) {
      if (!ids.includes(item.id)) ids.push(item.id);
      const slot = byId.get(item.id) ?? {};
      slot[critic] = item;
      byId.set(item.id, slot);
    }
  }
  return ids.map((id) => {
    const { a: first, b: second } = byId.get(id)!;
    const base = second ?? first!;
    if (!first || !second) return base;
    if (first.result === second.result) return first.result === "ok" ? first : second;
    const vote = votes.get(id);
    const result: TiebreakVote = vote ?? "fail";
    const winner = result === first.result ? first : second;
    return { id, result, evidence: winner.evidence };
  });
}

/**
 * Resolve the contested rubric items of two verdicts: `vote` asks the third model once for all the items and answers
 * per id. Returns the merged rubric and the contested decisions made; with no disagreement the verdicts' rows are
 * returned unchanged and `vote` is never called.
 */
export async function resolveRubricTiebreak(input: {
  a: Verdict; b: Verdict;
  vote: (items: readonly string[], prompt: string) => Promise<ReadonlyMap<string, TiebreakVote>>;
  kind?: VerdictKind;
}): Promise<{ rubric: VerdictRubricItem[]; contested: Record<string, TiebreakVote> }> {
  const items = rubricDisagreements(input.a, input.b);
  if (!items.length) return { rubric: majorityRubric(input.a, input.b, new Map()), contested: {} };
  const votes = await input.vote(items, tiebreakPrompt({ kind: input.kind ?? "code", items, a: input.a, b: input.b }));
  const contested: Record<string, TiebreakVote> = {};
  for (const item of items) contested[item] = votes.get(item) ?? "fail";
  return { rubric: majorityRubric(input.a, input.b, votes), contested };
}
