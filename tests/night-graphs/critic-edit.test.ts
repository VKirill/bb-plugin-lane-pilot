import { expect, it } from "vitest";
import { criticEditGate, criticPromptProposal } from "../../src/rooms/critique";
import { builtinWorkflow } from "../../src/rooms/workflow";

const low = {
  stage: "code-critique",
  calibration: { low: true, labeled: 5, hits: 2, byModel: [{ model: "gemini", low: true }] },
  missed: { examples: [{ taskId: "G", reason: "missing expected_outputs: src/x.ts" }] },
};

it("proposes a prompt edit from a low-calibration critic and holds the trial unless the flag and a bench are both on", () => {
  const proposal = criticPromptProposal([low]);
  expect(proposal).toContain("code-critique");
  expect(proposal).toContain("gemini");
  expect(proposal).toContain("G");
  expect(criticPromptProposal([{ ...low, calibration: { ...low.calibration, low: false } }])).toBeNull();
  expect(criticEditGate({ trialOn: false, benchOn: true, proposal }).status).toBe("held");
  expect(criticEditGate({ trialOn: true, benchOn: false, proposal }).status).toBe("held");
  expect(criticEditGate({ trialOn: true, benchOn: true, proposal }).status).toBe("trial");
  expect(criticEditGate({ trialOn: true, benchOn: true, proposal: null }).status).toBe("skipped");
  expect(builtinWorkflow("lp.critic-edit")?.nodes.map((node) => node.id)).toEqual(["prepare", "gate", "done"]);
});
