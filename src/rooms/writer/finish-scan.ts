import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * Gemini #7: the parallel finish scan — three cheap questions answered in one bundled call when a writer's attempt is
 * about to land: is the diff risky, does it touch UI, does it need a documentation update? The answers go to receipts
 * and project the task's profile for later gating (challenge, docs pass, UI check); the verdict never changes the
 * finish path itself — shadow by default and, even active, the caller only records it.
 */
export const WRITER_FINISH_SCAN_ID = "writer.finish_scan";

export type FinishScanInput = { title: string; contract?: string; produced?: string; verification?: string; summary?: string };
export type FinishScanDecision = { diff_risky: boolean; touches_ui: boolean; docs_needed: boolean };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const writerFinishScanJudgment = defineJudgment<FinishScanInput, FinishScanDecision>({
  id: WRITER_FINISH_SCAN_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 6_000,
  stateBuilder: (input) => ({
    title: clip(input.title ?? "", 300),
    contract: clip(input.contract ?? "", 1_500),
    produced: clip(input.produced ?? "", 2_000),
    verification: clip(input.verification ?? "", 1_000),
    summary: clip(input.summary ?? "", 1_000),
  }),
  questions: () => ({
    diff_risky: noul("From `produced` (the changed file list), `contract` and `verification`: does this diff look risky — touched hot paths, dependencies, auth/payments/migrations, or many files at once?", { true: "risky diff", false: "routine diff" }),
    touches_ui: noul("Does the change touch UI — components, styles, screens, markup, visual assets?", { true: "UI touched", false: "no UI" }),
    docs_needed: noul("From `title`, `contract` and `produced`: does this change need a documentation update (new flags, config, API surface, behavior users see)?", { true: "docs needed", false: "no docs needed" }),
  }),
  thresholds: {
    min_p: { default: 0.7, min: 0.5, max: 0.95, about: "least probability before a scan answer counts as true" },
  },
  decide(answers, t) {
    const read = (id: string) => (noulOf(answers, id) ?? 0) >= t.min_p!;
    return { decision: { diff_risky: read("diff_risky"), touches_ui: read("touches_ui"), docs_needed: read("docs_needed") } };
  },
  fallback: () => ({ diff_risky: false, touches_ui: false, docs_needed: false }),
  describe: (decision) => ["diff_risky", "touches_ui", "docs_needed"].filter((id) => decision[id as keyof FinishScanDecision]).join(",") || "clean",
});
