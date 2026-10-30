import { expect, it } from "vitest";
import { criticEditGate, criticEditTrialOn, criticPromptProposal } from "../../src/rooms/critique";
import { judgeSharedTrial, TRIAL_DEFAULTS } from "../../src/rooms/harness/server";
import { builtinWorkflow } from "../../src/rooms/workflow";

const low = {
  stage: "code-critique",
  calibration: { low: true, labeled: 5, hits: 2, byModel: [{ model: "gemini", low: true }] },
  missed: { examples: [{ taskId: "G", reason: "missing expected_outputs: src/x.ts" }] },
};

it("proposes a prompt edit and holds it on the nightly bench until judgeSharedTrial adopts", () => {
  const proposal = criticPromptProposal([low]);
  expect(proposal).toContain("code-critique");
  expect(proposal).toContain("gemini");
  expect(proposal).toContain("G");
  expect(criticPromptProposal([{ ...low, calibration: { ...low.calibration, low: false } }])).toBeNull();
  expect(criticEditTrialOn(undefined)).toBe(true);
  expect(criticEditTrialOn("off")).toBe(false);
  const started = 1_000;
  const now = started + 86_400_000;
  const nightly = (verdict: { passed: boolean; summary: string } | null) => judgeSharedTrial([], started, now, TRIAL_DEFAULTS, { adoptBy: "bench", verdict });
  const waiting = nightly(null);
  expect(waiting.action).toBe("wait");
  expect(criticEditGate({ trialOn: true, proposal, decision: waiting })).toMatchObject({ status: "held", applyPrompt: false });
  expect(criticEditGate({ trialOn: false, proposal, decision: waiting }).status).toBe("held");
  const adopted = nightly({ passed: true, summary: "nightly set" });
  expect(adopted.action).toBe("adopt");
  expect(criticEditGate({ trialOn: true, proposal, decision: adopted })).toMatchObject({ status: "trial", applyPrompt: true, detail: proposal });
  const failed = nightly({ passed: false, summary: "nightly set" });
  expect(criticEditGate({ trialOn: true, proposal, decision: failed })).toMatchObject({ status: "retired", applyPrompt: false });
  const late = judgeSharedTrial([], started, started + TRIAL_DEFAULTS.maxDays * 86_400_000, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: null });
  expect(late.action).toBe("retire");
  expect(criticEditGate({ trialOn: true, proposal, decision: late }).applyPrompt).toBe(false);
  expect(criticEditGate({ trialOn: true, proposal: null, decision: adopted }).status).toBe("skipped");
  expect(builtinWorkflow("lp.critic-edit")?.nodes.map((node) => node.id)).toEqual(["prepare", "gate", "done"]);
});
