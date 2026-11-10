import { createHash } from "node:crypto";
import { compareDesigns, designScore, type Measurement } from "./logic";

/**
 * Paired design judgement (SMA map: Paired design judgement): the model and the person judge a pair on one basis and in one order.
 * The order is fixed by a hash of the two urls (the same pair always shows the same way); the basis text is the one both see —
 * the six-criterion scores at each width, plus which screenshot is which.
 */

/** Which of the two urls is shown first, fixed for the pair: a hash bit, not a coin toss. */
export function pairOrder(urlA: string, urlB: string): "ab" | "ba" {
  return createHash("sha256").update(`${urlA}|${urlB}`).digest()[0]! % 2 === 0 ? "ab" : "ba";
}

/** One basis text for the model prompt and the owner's question: the scores of both designs and the presentation order. */
export function pairBasis(urlA: string, urlB: string, a: readonly Measurement[], b: readonly Measurement[]): { order: "ab" | "ba"; basis: string; comparison: ReturnType<typeof compareDesigns> } {
  const order = pairOrder(urlA, urlB);
  const scoreA = designScore(a), scoreB = designScore(b);
  const line = (tag: string, scored: ReturnType<typeof designScore>) =>
    `${tag}: ${scored.score}/100; ${scored.byWidth.map((w) => `${w.width}px ${w.criteria.map((c) => `${c.id}=${Math.round(c.score * 100)}`).join(",")}`).join("; ")}`;
  const [first, second] = order === "ab" ? [line("first", scoreA), line("second", scoreB)] : [line("first", scoreB), line("second", scoreA)];
  const basis = [`Design pair, order ${order} (${order === "ab" ? "A shown first" : "B shown first"}).`, first, second,
    "Rubric: overflow, contrast, targets, tiny_text, one_h1, spacing — each 0..100 at 375 and 1280 px.",
    `A=${urlA} B=${urlB}`].join("\n");
  return { order, basis, comparison: compareDesigns(a, b) };
}
