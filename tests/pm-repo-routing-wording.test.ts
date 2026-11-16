import { expect, it } from "vitest";
import { LANE_PILOT_PM_SESSION } from "../src/rooms/native-agent/native-agent-overlay";
import { pmRunInstructions } from "../src/rooms/tools/server/tools";

it("describes shared-repository ancestor rerooting and nested-repository boundaries", () => {
  const prompts = [
    LANE_PILOT_PM_SESSION,
    pmRunInstructions({ runId: "lprun_routes", writerLabel: "codex/gpt-5", writerWorkspace: "/repo/bot", waiting: false }),
  ];
  for (const prompt of prompts) {
    expect(prompt).toContain("section inside a shared Git repository");
    expect(prompt).toContain("ancestor of the section checkout");
    expect(prompt).toContain("declared sibling paths");
    expect(prompt).toContain("standalone nested Git repository remains its own boundary");
    expect(prompt).toContain("cannot access or escape to a parent repository");
    expect(prompt).toContain("Normal validation");
  }
});
