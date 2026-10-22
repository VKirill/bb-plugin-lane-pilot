import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { lintContract } from "../src/rooms/tasks/server/contract-lint";
import { maskedExitReason, passWithNoTestsReason, pipelinesOf } from "../src/rooms/tasks/server/lint-exit-status";

const root = "/tmp/writer";
const base: TaskV2 = {
  schema_version:2, display_title:"Тестовая задача", kind:"feature", area:"feature:c", id:"c", title:"C", risk:"low", lane:"writer", project_cwd:root, read_first:[],
  interfaces:["i"], invariants:["x"], out_of_scope:["o"], expected_outputs:["src/b.ts"], owns_paths:["src/**", "tests/**"], never_touch:[], depends_on:[],
  objective:"x", acceptance:["done"], verify:"tests", verification:[{ command:"npx vitest run tests/b.test.ts", cwd:root }],
};
const lint = (command:string) =>
  lintContract({ task:{ ...base, verification:[{ command, cwd:root }] }, workspacePath:root, hostId:"h", kinds:null, sandboxUnsafe:[], openTasks:[], deadDependencies:[] });
const codes = (rows:Array<{ code:string }>) => rows.map((row) => row.code);

describe("pipelines", () => {
  it("splits on a single pipe and on the shell's separators, and leaves quotes and groups alone", () => {
    expect(pipelinesOf("npm test 2>&1 | tail -5")).toEqual([["npm test 2>&1", "tail -5"]]);
    expect(pipelinesOf("a && b | c; d || e")).toEqual([["a"], ["b", "c"], ["d"], ["e"]]);
    expect(pipelinesOf("grep -E 'a|b' f | wc -l")).toEqual([["grep -E 'a|b' f", "wc -l"]]);
    expect(pipelinesOf("echo \"$(a | b)\" | cat")).toEqual([["echo \"$(a | b)\"", "cat"]]);
    expect(pipelinesOf("x=$(a | b); c")).toEqual([["x=$(a | b)"], ["c"]]);
  });
});

describe("a pipe that hides the exit status (rule 30694c: `cmd | tail` always exits 0)", () => {
  it.each([
    "npm test | tail -5",
    "npm test 2>&1 | tail -20",
    "npx vitest run tests/a.test.ts | head -50",
    "cd apps/api && npm test 2>&1 | tee /tmp/out.txt",
    "npm run build | wc -l",
    "sh -c 'npm test | tail -3'",
    "bash -c \"npm test 2>&1 | cat\"",
    "FORCE_COLOR=0 npm test | /usr/bin/tail -n 5",
  ])("refuses %s", (command) => expect(maskedExitReason(command), command).toMatch(/exits 0 whatever the command before the pipe did/));

  it.each([
    "set -o pipefail; npm test | tail -5",
    "set -eo pipefail && npm test 2>&1 | tail",
    "bash -c 'set -o pipefail; npm test | tail -5'",
    "npm test 2>&1 | tee /tmp/out.txt; test \"${PIPESTATUS[0]}\" = 0",
    "echo x | grep -q x",
    "git diff --name-only | grep -q src/a.ts",
    "grep -E 'a|b' src/a.ts",
    "npm test > /tmp/out.txt 2>&1",
    "npm test || exit 1",
    "npx vitest run tests/b.test.ts",
  ])("leaves %s alone", (command) => expect(maskedExitReason(command), command).toBeNull());

  it("refuses the recorded case in a contract, naming the check and the fix, and takes the same check with pipefail", () => {
    const refused = lint("npm test 2>&1 | tail -20");
    expect(codes(refused.errors)).toEqual(["verification_masked_exit"]);
    expect(refused.errors[0]!.message).toContain("verification[0]");
    expect(refused.errors[0]!.message).toContain("set -o pipefail");
    expect(lint("set -o pipefail; npm test 2>&1 | tail -20")).toEqual({ errors:[], warnings:[] });
  });
});

describe("a runner flag that passes when no test ran (rule 45b334)", () => {
  it.each([
    "npx vitest run tests/missing.test.ts --passWithNoTests",
    "npx vitest run --passWithNoTests tests/a.test.ts",
    "npx jest --passWithNoTests=true src/a",
    "npm run test -- --pass-with-no-tests",
    "sh -c 'npx vitest run tests/a.test.ts --passWithNoTests'",
  ])("refuses %s", (command) => expect(passWithNoTestsReason(command), command).toMatch(/matches no test file/));

  it.each([
    "npx vitest run tests/b.test.ts",
    "npx vitest run tests/b.test.ts --passWithNoTests=false",
    "grep -q passWithNoTests package.json",
    "npx vitest run tests/passWithNoTests-docs.test.ts",
  ])("leaves %s alone", (command) => expect(passWithNoTestsReason(command), command).toBeNull());

  it("refuses the recorded case in a contract and takes the exact filter", () => {
    const refused = lint("npx vitest run tests/missing.test.ts --passWithNoTests");
    expect(codes(refused.errors)).toEqual(["verification_pass_with_no_tests"]);
    expect(refused.errors[0]!.message).toContain("remove the flag");
    expect(lint("npx vitest run tests/b.test.ts")).toEqual({ errors:[], warnings:[] });
  });
});
