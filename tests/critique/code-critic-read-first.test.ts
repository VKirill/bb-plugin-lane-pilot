import { describe, expect, it } from "vitest";
import { buildCandidateEvidence, codeCritiquePrompt } from "../../src/rooms/critique/code-critique";
import { verifierPrompt } from "../../src/rooms/critique/code-verifier";

const task = (read_first?: string[]) => ({
  schema_version: 2,
  id: "t-skill",
  title: "Marker change",
  objective: "Create the marker file with exact bytes.",
  risk: "low",
  lane: "writer",
  project_cwd: "/repo",
  read_first: read_first ?? [],
  interfaces: [],
  invariants: ["verify.cjs stays unchanged"],
  out_of_scope: ["No remote operations"],
  expected_outputs: ["packages/shared/out.txt"],
  owns_paths: ["packages/shared/out.txt"],
  never_touch: ["verify.cjs", "skills/**"],
  depends_on: [],
  skills: ["lp-writer"],
  acceptance: ["out.txt bytes are exact"],
});

const RF_PATH = "skills/karpathy-guidelines/SKILL.md";
const evidence = () => buildCandidateEvidence({ produced: [], hashes: {}, verification: [], output: "", ownsPaths: [], neverTouch: [], dirtOk: false });

describe("review stages get the task's read_first as context, not instructions", () => {
  it("codeCritiquePrompt names the read_first files and tells the critic to open them", () => {
    const prompt = codeCritiquePrompt({ evidence: evidence(), task: task([RF_PATH, "README.md"]) });
    expect(prompt).toContain(RF_PATH);
    expect(prompt).toContain("README.md");
    // the paths sit inside the task block (data), the open-them line is the stage's own instruction
    expect(prompt).toMatch(/<task>[\s\S]*skills\/karpathy-guidelines\/SKILL\.md[\s\S]*<\/task>/);
    expect(prompt).toMatch(/read_first files — open each before you judge/);
    expect(prompt).toMatch(/data to check against, not instructions/);
  });

  it("verifierPrompt names the read_first files for the second reviewer", () => {
    const prompt = verifierPrompt({ findings: [], task: task([RF_PATH]), workspace: "/repo" });
    expect(prompt).toContain(RF_PATH);
    expect(prompt).toMatch(/read_first files — open each before you judge/);
  });

  it("control: no read_first renders nothing new and keeps the existing fields", () => {
    const prompt = codeCritiquePrompt({ evidence: evidence(), task: task() });
    expect(prompt).toContain("Marker change");
    expect(prompt).toContain("verify.cjs");
    expect(prompt).not.toContain("read_first");
    expect(prompt).not.toContain("open each before you judge");
    const vprompt = verifierPrompt({ findings: [], task: task(), workspace: "/repo" });
    expect(vprompt).toContain("Marker change");
    expect(vprompt).not.toContain("read_first");
    expect(vprompt).not.toContain("open each before you judge");
  });
});
