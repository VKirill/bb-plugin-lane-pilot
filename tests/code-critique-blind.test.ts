import { describe, expect, it } from "vitest";
import { buildCandidateEvidence, codeCritiquePrompt } from "../src/rooms/critique/code-critique";

// SMA conformance audit C-04: the map called plan-fact the blind check (k_v_blind), but plan-fact reads the writer's own table of
// evidence. The blind one in Lane Pilot is the code critic: it judges the contract against the bytes the host read, never the story.
describe("the blind check", () => {
  it("[sma:k_v_blind] hands the code critic the contract and the host-read tree, and no word of the writer's reply", () => {
    const story = "I implemented password recovery and everything works, trust me";
    const evidence = buildCandidateEvidence({ produced: ["src/reset.ts"], hashes: { "src/reset.ts": "a".repeat(64) }, verification: [{ command: "npm test", exitCode: 0, stdout: "1 passed" }],
      files: [{ path: "src/reset.ts", content: "export const reset = () => true;" }], output: story, ownsPaths: ["src/**"], neverTouch: [], dirtOk: true });
    const prompt = codeCritiquePrompt({ evidence, task: { id: "reset", acceptance: ["User can recover a forgotten password"] } });
    expect(prompt).toContain("User can recover a forgotten password");
    expect(prompt).toContain("export const reset = () => true;");
    expect(prompt).toContain("not the writer's self-report");
    expect(prompt).not.toContain(story);
    expect(prompt).not.toContain("trust me");
  });
});
