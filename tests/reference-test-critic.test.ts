import { describe, expect, it } from "vitest";
import { checkScriptEdits } from "../src/rooms/tasks";
import { buildCandidateEvidence, codeCritiquePrompt, parseCodeCritiqueSettings } from "../src/rooms/critique"
import { applyCodeCriticDefault, applyQualityMode, withReferenceTestCritic } from "../src/rooms/contracts/quality-mode";

const evidence = (referenceTestEdits?: string[]) => buildCandidateEvidence({
  produced: ["src/money.ts", "tests/money.test.ts"], hashes: { "src/money.ts": "a", "tests/money.test.ts": "b" },
  verification: [{ command: "npm test", exitCode: 0, stdout: "", stderr: "" }],
  files: [{ path: "src/money.ts", content: "x" }, { path: "tests/money.test.ts", content: "y" }],
  output: "done", ownsPaths: ["src/**", "tests/**"], neverTouch: [], dirtOk: true, ...(referenceTestEdits ? { referenceTestEdits } : {}),
});

describe("a writer that changed a test which existed before the task", () => {
  it("gets the code critic in gate mode whatever the risk or quality mode; one that changed no such test keeps the risk rule (hub: 134 of 756 tasks, none reviewed, 2026-10-31)", () => {
    const low = (mode: "quick" | "standard", tests?: string[]) => parseCodeCritiqueSettings(withReferenceTestCritic(applyCodeCriticDefault(applyQualityMode({}, mode), mode, "low", "medium"), tests));
    expect(low("standard").enabled).toBe(false);
    expect(low("standard", [])).toMatchObject({ enabled: false });
    expect(low("standard", ["tests/money.test.ts"])).toMatchObject({ enabled: true, mode: "gate" });
    expect(low("quick", ["tests/money.test.ts"])).toMatchObject({ enabled: true, mode: "gate" });
  });

  it("names those tests to the critic with the criterion reference-test-weakened", () => {
    const edited = evidence(["tests/money.test.ts"]);
    expect(edited.referenceTestEdits).toEqual(["tests/money.test.ts"]);
    expect(codeCritiquePrompt({ evidence: edited, task: { id: "t" } })).toMatch(/REFERENCE TESTS AND CHECK SCRIPTS THE WRITER CHANGED[^\n]*tests\/money\.test\.ts[^\n]*reference-test-weakened/);
    const untouched = evidence();
    expect(untouched).not.toHaveProperty("referenceTestEdits");
    expect(codeCritiquePrompt({ evidence: untouched, task: { id: "t" } })).not.toMatch(/REFERENCE TESTS/);
    expect(untouched.evidenceSha256).toBe(edited.evidenceSha256);
  });

  it("does not call a test the attempt created a reference test, and shows the critic the test names of a green check, not npx's noise (photoalive 2026-11-10)", () => {
    const created = buildCandidateEvidence({
      produced: ["tests/money.test.ts", "tests/new.test.ts"], hashes: { "tests/money.test.ts": "a", "tests/new.test.ts": "b" },
      files: [{ path: "tests/money.test.ts", content: "y" }, { path: "tests/new.test.ts", content: "z" }],
      patches: { "tests/money.test.ts": "--- a/tests/money.test.ts\n+++ b/tests/money.test.ts\n@@ -1 +1 @@\n-x\n+y", "tests/new.test.ts": "new file mode 100644\n--- /dev/null\n+++ b/tests/new.test.ts\n@@ -0,0 +1 @@\n+z" },
      verification: [{ command: "npx vitest run", exitCode: 0, stderr: "",
        stdout: [...Array.from({ length: 6 }, (_, i) => ` ✓ case ${i}`), "      Tests  6 passed (6)", "", "\\npm notice", "npm notice New major version of npm available! 11.12.1 -> 12.2.2", "npm notice Changelog: https://x", "npm notice To update run: npm install -g npm@12.2.2", "npm notice", "\\"].join("\n") }],
      output: "done", ownsPaths: ["tests/**"], neverTouch: [], dirtOk: true, referenceTestEdits: ["tests/money.test.ts", "tests/new.test.ts"],
    });
    expect(created.referenceTestEdits).toEqual(["tests/money.test.ts"]);
    const prompt = codeCritiquePrompt({ evidence: created, task: { id: "t" } });
    expect(prompt).not.toContain("npm notice");
    expect(prompt).toContain("✓ case 0");
    expect(prompt).toMatch(/Tests  6 passed \(6\)\n<\/stdout>/);
    expect(prompt.match(/a critical finding that is a security hole/g)).toHaveLength(1);
    expect(prompt).not.toContain("host-read files");
  });

  it("counts a check script the task's commands run as part of the yardstick: a script named in a command, a package.json behind npm; not a test, not other code", () => {
    const produced = ["scripts/check.sh", "./package.json", "src/a.ts", "tests/a.test.ts", "docs/x.md"];
    expect(checkScriptEdits(produced, ["bash scripts/check.sh", "npm test"])).toEqual(["scripts/check.sh", "./package.json"]);
    expect(checkScriptEdits(produced, ["bash scripts/check.sh"])).toEqual(["scripts/check.sh"]);
    expect(checkScriptEdits(produced, ["python3 -m pytest -q"])).toEqual([]);
    // Run as the program, through env and after a cd; a file a command only reads is the work under check, not the check.
    expect(checkScriptEdits(["scripts/verify.sh", "game/scripts/studio_check.py"], ["cd game && env CI=1 python3 -I scripts/studio_check.py", "./scripts/verify.sh --all"]))
      .toEqual(["scripts/verify.sh", "game/scripts/studio_check.py"]);
    expect(checkScriptEdits(["src/hello.ts", "src/a.ts"], ["grep -q hello src/hello.ts", "test -s src/a.ts"])).toEqual([]);
  });

  it("counts a test runner's config as the yardstick whatever the commands are: an exclude in vitest.config.ts narrows the run (assess Q9)", () => {
    const produced = ["vitest.config.ts", "apps/web/playwright.config.mjs", "tests/conftest.py", "pytest.ini", "tsconfig.build.json", "Makefile", "src/config.ts", "pyproject.toml"];
    expect(checkScriptEdits(produced, ["python3 -m pytest -q"])).toEqual(["vitest.config.ts", "apps/web/playwright.config.mjs", "tests/conftest.py", "pytest.ini", "tsconfig.build.json", "Makefile"]);
  });
});
