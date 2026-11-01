import { choice, choiceOf, defineJudgment, jev, type JudgeContext } from "@lane-pilot/jev";
import { ERRAND_KINDS, hintedErrandKind, type ErrandKind, type ErrandKindHints } from "./errand-kinds";

/**
 * J-12 `errand.kind`: which kind of errand a brief is (errand-kinds.ts), asked of Jev for every errand that has no PM word. It starts in
 * `shadow`: the receipt keeps what Jev would have picked while the hints (or the generic row) decide; `jev.modes = errand.kind=active` lets
 * Jev name the kind where no hint did. A hint always wins over Jev: a named skill is an explicit ask.
 */
export const ERRAND_KIND_ID = "errand.kind";
type Input = { task: string };
export type ErrandKindDecision = ErrandKind | "errand";
const OPTIONS: Record<ErrandKindDecision, string> = {
  computer: "works the screen of a machine: opens apps, Roblox Studio or Xcode, records the screen, clicks through a desktop",
  devops: "installs, deploys or configures servers and machines over SSH, rents a GPU, runs Blender or scripts through MCP or a terminal",
  browser: "works inside a web site in the owner's browser: a cabinet, a console, forms, checking live pages",
  research: "reads, compares and writes a report: a feature map, a comparison, a review with sources",
  message: "writes or answers a message: an email, a support ticket, a Telegram message, a short reply by a template",
  errand: "none of these: runs a script or a check and reports, or a job that fits no kind above",
};

export const errandKindJudgment = defineJudgment<Input, ErrandKindDecision>({
  id: ERRAND_KIND_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 6_000,
  stateBuilder: (input) => ({ task: input.task.slice(0, 4_000) }),
  questions: () => ({ kind: choice("What kind of errand is `task`? Pick by what the helper will spend most of its steps on.", OPTIONS) }),
  thresholds: { min_p: { default: 0.6, min: 0.3, max: 0.95, about: "least p(top kind) to name it; below, the generic errand row runs" } },
  decide: (answers, t) => {
    const top = choiceOf(answers, "kind");
    return { decision: top && top.p >= t.min_p! && top.top in OPTIONS ? (top.top as ErrandKindDecision) : "errand" };
  },
  fallback: () => "errand",
  describe: (decision) => decision,
});

export type ErrandKindPick = { kind: ErrandKindDecision; by: "pm" | "hint" | "jev" | "none" };

/**
 * The kind of an errand: the PM's word, else a hint, else Jev when it is active and sure, else the generic row. Jev is asked whenever it is
 * on, even when a hint decided, so the shadow receipts compare its pick with the hint over the week.
 */
export async function classifyErrand(input: ErrandKindHints & { kind?: string | null | undefined }, ctx: JudgeContext = {}): Promise<ErrandKindPick> {
  if (input.kind && (ERRAND_KINDS as readonly string[]).includes(input.kind)) return { kind: input.kind as ErrandKind, by: "pm" };
  const hinted = hintedErrandKind(input);
  const instance = jev();
  const verdict = instance?.enabled(ctx.settings) ? await instance.judge(errandKindJudgment, { task: input.task }, ctx).catch(() => null) : null;
  if (hinted) return { kind: hinted, by: "hint" };
  return verdict?.by === "jev" && verdict.decision !== "errand" ? { kind: verdict.decision, by: "jev" } : { kind: "errand", by: "none" };
}
