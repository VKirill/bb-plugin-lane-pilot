import { describe, expect, it } from "vitest";
import { buildCandidateEvidence, codeCritiquePrompt, sha256Text } from "../../src/rooms/critique/code-critique";

// SWE-2 stream C1 (2026-11-03): the critic's prompt carries pointers, not the whole change — a 57 KB muse-image-mode packet
// was 44 KB of pasted code. Past ~6 KB the prompt lists paths with +/- counts and the git commands; the critic reads itself.
const task = {
  schema_version: 2, id: "t1", title: "Muse image mode", risk: "medium", lane: "writer",
  project_cwd: "/wt/t1", read_first: [], interfaces: [], invariants: ["keep the manifest stable"], out_of_scope: ["docs"],
  expected_outputs: ["src/muse.ts"], owns_paths: ["src/**", "fixtures/**"], never_touch: [], depends_on: [],
  objective: "Route Muse images through mode", acceptance: ["muse mode is honored", "fixtures stay valid"],
  verify: "tests", verification: [{ command: "npx vitest run", cwd: "/wt/t1" }],
};

const patchOf = (path: string, lines: number) =>
  `diff --git a/${path} b/${path}\n@@ -1 +1,${lines} @@\n-old\n${"+x\n".repeat(lines)}+end\n`;

describe("a big change hands the critic pointers, not bytes", () => {
  const big = "export const x = 1;\n".repeat(1400); // ~29 KB per file
  const fixture = `${"{},".repeat(1500)}\n`; // ~6 KB json fixture
  const evidence = buildCandidateEvidence({
    produced: ["src/a.ts", "src/b.ts", "fixtures/expect.json"],
    hashes: {
      "src/a.ts": sha256Text(big), "src/b.ts": sha256Text(big), "fixtures/expect.json": sha256Text(fixture),
    },
    baselineHashes: { "src/a.ts": "old", "src/b.ts": "old", "fixtures/expect.json": "old" },
    verification: [{ command: "npx vitest run", exitCode: 0, stdout: "pass", stderr: "" }],
    files: [
      { path: "src/a.ts", content: big }, { path: "src/b.ts", content: big },
      { path: "fixtures/expect.json", content: fixture },
    ],
    patches: { "src/a.ts": patchOf("src/a.ts", 12), "src/b.ts": patchOf("src/b.ts", 20), "fixtures/expect.json": patchOf("fixtures/expect.json", 1500) },
    output: "done", ownsPaths: task.owns_paths, neverTouch: [], dirtOk: true, workspace: "/wt/t1",
  });
  const prompt = codeCritiquePrompt({ evidence, task, agent: "code-critic" });

  it("stays under 12 KB with every path, its +/- counts and the git commands", () => {
    expect(Buffer.byteLength(big, "utf8") * 2).toBeGreaterThan(50 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(12 * 1024);
    expect(prompt).toContain("src/a.ts  changed  +13 −1");
    expect(prompt).toContain("src/b.ts  changed  +21 −1");
    expect(prompt).toContain("git -C /wt/t1 status --short");
    expect(prompt).toContain("git -C /wt/t1 diff HEAD --");
    expect(prompt).not.toContain("export const x = 1;");
  });

  it("names the task in words, not as JSON, and keeps the contract lines a review judges", () => {
    expect(prompt).toContain("title: Muse image mode");
    expect(prompt).toContain("- muse mode is honored");
    expect(prompt).toContain("owns_paths: src/**, fixtures/**");
    expect(prompt).not.toContain('"schema_version"');
    expect(prompt).not.toContain("read_first");
  });

  it("never inlines a data file: the fixture is listed with its size and hash only", () => {
    expect(prompt).toMatch(/fixtures\/expect\.json +changed +data file, \d+ bytes — not inlined +sha256:[0-9a-f]{12}/);
    expect(prompt).not.toContain("{},{},{},");
  });
});

describe("a small change still arrives inlined", () => {
  const small = "export const a = 1;\n";
  const evidence = buildCandidateEvidence({
    produced: ["src/small.ts"], hashes: { "src/small.ts": sha256Text(small) },
    verification: [{ command: "npm test", exitCode: 1, stdout: "1 failed", stderr: "" }],
    files: [{ path: "src/small.ts", content: small }],
    output: "done", ownsPaths: ["src/**"], neverTouch: [], dirtOk: true, workspace: "/wt/t1",
  });
  const prompt = codeCritiquePrompt({ evidence, task, agent: "code-critic" });

  it("carries the file's bytes and the failing check's output", () => {
    expect(prompt).toContain('<file path="src/small.ts" status="new">');
    expect(prompt).toContain("export const a = 1;");
    expect(prompt).toContain("1 failed");
    expect(prompt).not.toContain("git diff HEAD");
  });
});

describe("a green check keeps only its last lines", () => {
  it("cuts a long passing log to its tail; a failing one stays whole", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const evidence = buildCandidateEvidence({
      produced: ["src/s.ts"], hashes: { "src/s.ts": sha256Text("x") },
      verification: [
        { command: "ok", exitCode: 0, stdout: long, stderr: "" },
        { command: "bad", exitCode: 2, stdout: long, stderr: "" },
      ],
      files: [{ path: "src/s.ts", content: "x" }], output: "", ownsPaths: ["src/**"], neverTouch: [], dirtOk: true,
    });
    const prompt = codeCritiquePrompt({ evidence, task: { id: "t" }, agent: "code-critic" });
    expect(prompt).toMatch(/<check command="ok" exit="0">\n<stdout>\n\[… earlier output cut …\]\nline 30/);
    expect(prompt).toMatch(/<check command="bad" exit="2">\n<stdout>\nline 0/);
  });
});
