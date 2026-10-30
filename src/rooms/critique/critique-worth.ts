import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * C2: which advisory critics a task is worth spawning at all. The pipeline asks it once (the `worth-check` jev node) and
 * a critic the judgment does not expect to pay is skipped by an edge `when` — a full helper thread less, per task, where
 * the static `quality_mode` switch used to be the only gate. Runs in shadow by default: the fallback keeps every critic,
 * so nothing is skipped until a project activates the judgment after the receipts show it calls this right.
 */
export const CRITIQUE_WORTH_ID = "critique.worth";

/** The `state` map of a `type:"jev"` node IS the judgment's input — field names must match it one to one. */
export type CritiqueWorthInput = { task_title: string; contract?: string; size?: string; risk?: string };

export type CritiqueWorthDecision = { skip_pm_read: boolean; skip_plan_critique: boolean; skip_specialist_review: boolean };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const critiqueWorthJudgment = defineJudgment<CritiqueWorthInput, CritiqueWorthDecision>({
  id: CRITIQUE_WORTH_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 6_000,
  // Whitelist: the task's title, its contract excerpt and the path class — nothing else of the run leaves for the API.
  stateBuilder: (input) => ({
    task_title: clip(input.task_title, 300),
    contract: clip(input.contract ?? "", 2_000),
    size: input.size ?? "unknown",
    risk: input.risk ?? "unknown",
  }),
  questions: () => ({
    need_pm_read: noul("Would a PM's summary of the code the task touches (`task_title`, `contract`) give the plan critics context they could not get from the contract alone? Yes when the task touches several files or existing behavior; no for a one-spot tweak with the file and change already named.", { true: "the critics need the code context", false: "the contract already says what changes where" }),
    need_plan_critique: noul("Is a plan critic's paid read of this task's plan (`task_title`, `contract`) likely to catch something the writer would otherwise get wrong? Yes when the change is risky, cross-cutting or has real acceptance criteria; no for a mechanical or cosmetic change.", { true: "a wrong plan would cost a rewrite", false: "there is one obvious way to do it" }),
    need_specialist: noul("Does this task's plan (`task_title`, `contract`, `risk`) deserve a specialist risk review on top of the plan critique? Yes for sign-in, payments, secrets, migrations, deletes or multi-service work; no for ordinary feature or fix work.", { true: "a domain risk a generalist misses", false: "ordinary work" }),
  }),
  thresholds: {
    min_skip_p: { default: 0.85, min: 0.6, max: 0.99, about: "least probability of «not needed» before the critic is skipped" },
  },
  decide(answers, t) {
    const skip = (id: string) => (noulOf(answers, id) ?? 0) >= t.min_skip_p!;
    // Skipping the plan critique also skips the specialist: it consumes the plan critique's artifact.
    const plan = skip("need_plan_critique");
    return { decision: { skip_pm_read: skip("need_pm_read"), skip_plan_critique: plan, skip_specialist_review: plan || skip("need_specialist") } };
  },
  // Unsure, off, down: every critic runs, exactly as without the judgment.
  fallback: () => ({ skip_pm_read: false, skip_plan_critique: false, skip_specialist_review: false }),
  describe: (decision) => {
    const skipped = (["pm_read", "plan_critique", "specialist_review"] as const).filter((name) => decision[`skip_${name}`]);
    return skipped.length ? `skip ${skipped.join(",")}` : "all critics";
  },
});
