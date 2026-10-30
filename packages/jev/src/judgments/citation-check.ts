import { choice, choiceOf, defineJudgment, noul, noulOf } from "../registry";

/**
 * Whether a cited source actually supports the claim that cites it (B2 of the docs audit; the citation_check cookbook).
 * The LLM step that found the source confirms its own find — a correlated error; this is the independent check. One
 * judgment per claim; `judgeMany` batches them per source excerpt.
 */
export const CITATION_CHECK_ID = "research.citation";

export type CitationInput = { claim: string; quote?: string; sourceTitle: string; sourceUrl: string; excerpt: string; question?: string };
export type CitationDecision = { verdict: "supports" | "partial" | "unsupported" | "absent"; keep: boolean };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const citationCheckJudgment = defineJudgment<CitationInput, CitationDecision>({
  id: CITATION_CHECK_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    claim: clip(input.claim, 800),
    quote: clip(input.quote ?? "", 600),
    source: { title: clip(input.sourceTitle, 200), url: clip(input.sourceUrl, 300) },
    excerpt: clip(input.excerpt, 12_000),
    question: clip(input.question ?? "", 300),
  }),
  questions: () => ({
    supports: choice(
      "`excerpt` is the text of `source`; `claim` cites it (the cited passage: `quote`, the dossier's question: `question`). Does the excerpt support the claim?",
      {
        supports: "the excerpt directly supports the claim as written",
        partial: "the excerpt supports part of the claim or a weaker version of it",
        unsupported: "the excerpt is about something else or contradicts the claim",
        absent: "the quoted passage is not in the excerpt at all",
      },
    ),
    hallucinated: noul(
      "Does `claim` state something `excerpt` does not contain — invented numbers, names or conclusions the source never makes?",
      { true: "the claim adds facts absent from the excerpt", false: "everything the claim says traces to the excerpt" },
    ),
  }),
  thresholds: {
    keep_p: { default: 0.6, min: 0.3, max: 0.95, about: "P(supports) that keeps the citation; partial needs the hallucination noul low" },
  },
  decide(answers, t) {
    const c = choiceOf(answers, "supports"), hall = noulOf(answers, "hallucinated") ?? 0;
    const p = (name: string) => c?.ranked.find(([k]) => k === name)?.[1] ?? 0;
    const verdict: CitationDecision["verdict"] =
      p("supports") >= t.keep_p! && hall < 0.5 ? "supports"
      : c?.top === "partial" || p("partial") >= 0.5 ? "partial"
      : c?.top === "absent" || p("absent") >= 0.5 ? "absent"
      : "unsupported";
    return { decision: { verdict, keep: verdict === "supports" || verdict === "partial" } };
  },
  fallback: () => ({ verdict: "partial", keep: true }),
  describe: (d) => d.verdict,
});
