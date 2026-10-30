import type { Jev, JudgeContext } from "@lane-pilot/jev";
import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * Compaction without a summary (fast-jev-compaction): when Lane Pilot compacts a long session, the pairs of
 * «tool call + its result» Jev judges stale are dropped and everything it keeps stays verbatim — nothing is
 * paraphrased, so a kept fact cannot be reworded wrong. The newest pairs always stay in code; a pair Jev was never
 * asked about stays too.
 */

/** How many newest pairs are kept without asking: the session's working edge, always verbatim. */
export const DIGEST_KEEP_TAIL = 4;
const MAX_PAIRS_ASKED = 40;
const PAIR_HEAD_CHARS = 400;

export type ToolPair = { tool: string; call: string; result: string };

export type SessionDigestInput = { goal: string; pairs: ToolPair[] };

export const SESSION_DIGEST_ID = "session.tool_pair";
export const sessionDigestJudgment = defineJudgment<SessionDigestInput, boolean[]>({
  id: SESSION_DIGEST_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 10_000,
  stateBuilder: (input) => ({ session_goal: input.goal.slice(0, 800), note: "Each `pN` question carries one older tool call with a head of its result, in order." }),
  questions: (input) => Object.fromEntries(input.pairs.slice(0, MAX_PAIRS_ASKED).map((pair, index) => [`p${index + 1}`, noul(
    `The session is being compacted and ` + "`session_goal`" + ` says what it works on. Should tool call ${index + 1} (${pair.tool}) and its result stay in the history verbatim — does what comes next still need them? Answer no for superseded reads, re-runs whose result was replaced, and noise.`,
    { true: `keep: ${pair.tool} ${pair.call.slice(0, 160)} — ${pair.result.slice(0, PAIR_HEAD_CHARS)}`, false: `drop: ${pair.tool} ${pair.call.slice(0, 120)}` },
  )])),
  thresholds: {
    min_p: { default: 0.5, min: 0.1, max: 0.9, about: "least p(yes) for a pair to survive compaction; pairs never asked survive anyway" },
  },
  decide: (answers, t, input) => ({
    decision: input.pairs.slice(0, MAX_PAIRS_ASKED).map((_, index) => (noulOf(answers, `p${index + 1}`) ?? 1) >= t.min_p!),
  }),
  fallback: (input) => input.pairs.map(() => true),
  describe: (decision) => `${decision.filter(Boolean).length}/${decision.length} kept`,
});

/** Consecutive `tool`/`command` events folded into call+result pairs, oldest first. */
export function toolPairsOf(events: ReadonlyArray<Record<string, unknown>>): ToolPair[] {
  const pairs: ToolPair[] = [];
  for (const event of events) {
    const item = (event as { data?: { item?: Record<string, unknown> } })?.data?.item;
    if (!item) continue;
    const type = String(item.type ?? "");
    if (type !== "toolCall" && type !== "commandExecution") continue;
    const call = String(item.command ?? item.name ?? "") || JSON.stringify(item.input ?? item.arguments ?? "").slice(0, 300);
    const result = [item.aggregatedOutput, item.output, item.stdout, item.stderr].find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
    pairs.push({ tool: String(item.tool ?? item.name ?? type), call: call.slice(0, 300), result: result.slice(0, 4_000) });
  }
  return pairs;
}

/**
 * The session's kept tool pairs as one verbatim block: the tail and every pair `keep` marked, in order; the rest
 * dropped. Returns null when there is nothing to drop — a digest that changes nothing is noise.
 */
export function sessionDigestText(pairs: ToolPair[], keep: readonly boolean[]): string | null {
  const asked = Math.max(0, pairs.length - DIGEST_KEEP_TAIL);
  const out: string[] = [];
  let dropped = 0;
  pairs.forEach((pair, index) => {
    const kept = index >= asked || (index < keep.length ? keep[index] : true);
    if (!kept) { dropped += 1; return; }
    out.push(`[${pair.tool}] ${pair.call}${pair.result ? `\n${pair.result}` : ""}`);
  });
  if (!dropped) return null;
  return `Before this thread was compacted, its tool calls and their results were kept verbatim; ${dropped} stale one${dropped === 1 ? "" : "s"} dropped:\n${out.join("\n\n")}`;
}

/** Judged tool-pair survival for a session about to be compacted; null when there is nothing worth a request. */
export async function judgeSessionDigest(
  jev: Jev | null,
  input: { goal: string; events: ReadonlyArray<Record<string, unknown>> },
  ctx: JudgeContext = {},
): Promise<string | null> {
  const pairs = toolPairsOf(input.events);
  if (!jev || !jev.enabled(ctx.settings) || pairs.length <= DIGEST_KEEP_TAIL + 2) return null;
  const verdict = await jev.judge(sessionDigestJudgment, { goal: input.goal, pairs }, ctx);
  if (verdict.by !== "jev") return null;
  return sessionDigestText(pairs, verdict.decision);
}
