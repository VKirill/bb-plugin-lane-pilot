import type { RouterModel, RouterModelOutput } from "@lane-pilot/workflow-engine";
import { filterByPolicy, routePolicyOf } from "./route-policy";
import { NONE, routeRecheck, routeWorkflow } from "./route-workflow";
import { isMachineMessage } from "../phase";
import { redactKnown } from "@lane-pilot/kit";
import { looksSensitive } from "@lane-pilot/jev";
import { choiceOf } from "@lane-pilot/jev";
import type { Answers } from "@lane-pilot/jev";
import type { Jev } from "@lane-pilot/jev";
import type { JevSettings } from "@lane-pilot/jev";

/**
 * The model step of `lane_pilot_route` on Jev. One request decides a clear case in about a second; a case that is not clear
 * is handed to the helper thread that used to decide every route (`legacy`), and its answer is recorded next to Jev's as the
 * label for calibrating the thresholds. Who does what, by the mode of `route.workflow` in the project:
 *   off     the helper thread alone (the behaviour before Jev), the scorer when there is no thread;
 *   shadow  the helper thread decides; Jev is asked in the same breath and its answer is only recorded;
 *   active  Jev decides a clear case; an unclear one goes to the helper thread; Jev unavailable (no key, a failure, the
 *           breaker) throws, and the router falls back to its own scorer, naming the reason in the evidence.
 */
export type RouteModelDeps = {
  jev(): Jev | null;
  settings(): Promise<JevSettings>;
  /** The helper thread of this PM chat; null when the chat has no run (then nothing can be escalated to). */
  legacy: RouterModel | null;
  projectId: string;
  runId: string | null;
};

const topPick = (answers: Answers | undefined): string | null | undefined => {
  const pick = answers ? choiceOf(answers, "pick") : undefined;
  return pick ? (pick.top === NONE ? null : pick.top) : undefined;
};

export function createJevRouterModel(deps: RouteModelDeps): RouterModel {
  return async (input): Promise<RouterModelOutput> => {
    const escalate = async (): Promise<RouterModelOutput> => {
      if (!deps.legacy) throw new Error("no helper thread to ask: this chat has no run");
      return await deps.legacy(input);
    };
    const jev = deps.jev();
    const settings = await deps.settings().catch(() => ({} as JevSettings));
    if (!jev || !jev.enabled(settings)) return await escalate();
    // A machine text (a Lane Pilot notice, a relay line, a task summary, another thread's words) is never the owner's
    // request — it goes nowhere near Jev; the helper thread or the scorer answers instead (0.1.333's intake filter).
    if (isMachineMessage(input.intent)) return await escalate();
    // The same gate as the output guard, on the way in: a request that looks like it carries a secret or credentials is
    // not sent to the Jev API; the helper thread (which guards its own input) or the scorer decides.
    if (looksSensitive(input.intent, redactKnown(input.intent))) return await escalate();
    // Candidates the project's route policy forbids (a secret left out of secrets.allow, a risk above route.max_risk) are cut
    // here, before Jev sees them; with none left the model step decides as before.
    const { allowed, rejected } = filterByPolicy(input.candidates, routePolicyOf(settings as Record<string, unknown>));
    if (!allowed.length) return await escalate();
    const filtered = rejected.length ? { ...input, candidates: allowed } : input;
    const verdict = await jev.judge(routeWorkflow, filtered, { projectId: deps.projectId, runId: deps.runId, subject: "route", settings });
    if (verdict.by === "jev") return rejected.length ? { ...verdict.decision, rejected: [...verdict.decision.rejected, ...rejected] } : verdict.decision;
    if (verdict.by === "fallback" && verdict.status !== "shadow" && verdict.status !== "off") throw new Error(`Jev gave no answer (${verdict.status}); the scorer decides`);
    if (verdict.by === "fallback" && verdict.status === "off") return await escalate();
    // An unclear case gets one cheaper re-judgement first (route.recheck): a confident recheck decides without a thread;
    // unsure, or the judgment shadowed/off/unavailable, the helper thread answers as before and the two are compared.
    if (verdict.by === "escalate") {
      const pick = choiceOf(verdict.answers, "pick");
      const top = pick?.top && pick.top !== NONE ? input.candidates.find((card) => card.id === pick.top) : undefined;
      if (top && pick) {
        const second = pick.second && pick.second !== NONE ? input.candidates.find((card) => card.id === pick.second) ?? null : null;
        const recheck = await jev.judge(routeRecheck, {
          request: input.intent, context: input.context,
          top: { id: top.id, name: top.name.en, p: pick.p },
          second: second ? { id: second.id, name: second.name.en, p: pick.ranked.find(([id]) => id === second.id)?.[1] ?? 0 } : null,
        }, { projectId: deps.projectId, runId: deps.runId, subject: "route-recheck", settings });
        if (recheck.by === "jev") return rejected.length ? { ...recheck.decision, rejected } : recheck.decision;
        if (recheck.by === "fallback" && recheck.status !== "shadow" && recheck.status !== "off") {
          // no answer at all: the thread still decides; the recheck outcome is left unlabeled.
        } else if (recheck.by === "escalate" || recheck.by === "fallback") {
          const out = await escalate();
          const recheckChoice = recheck.answers ? choiceOf(recheck.answers, "pick") : undefined;
          if (recheckChoice) jev.outcome(recheck.receiptId, `${(recheckChoice.top === NONE ? null : recheckChoice.top) === out.choice ? "agree" : "disagree"}`);
          const jevChoice = topPick(verdict.answers);
          if (jevChoice !== undefined) jev.outcome(verdict.receiptId, `${jevChoice === out.choice ? "agree" : "disagree"}`);
          return out;
        }
      }
    }
    // Shadow or an unclear case the recheck could not settle: the helper thread answers, and the two are compared.
    const output = await escalate();
    const jevChoice = verdict.by === "escalate" ? topPick(verdict.answers) : verdict.shadow?.decision ? verdict.shadow.decision.choice : topPick(verdict.answers);
    if (jevChoice !== undefined) {
      const wouldEscalate = verdict.by === "fallback" && verdict.shadow?.escalate !== undefined;
      jev.outcome(verdict.receiptId, `${jevChoice === output.choice ? "agree" : "disagree"}${wouldEscalate ? ":would_escalate" : ""}`);
    }
    return output;
  };
}
