import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { checkNamedPaths, emptyCheckReason, existenceOnlyPaths, lintContract, lintProbePaths } from "../src/rooms/tasks/server/contract-lint";
import type { PathKind } from "../src/rooms/tasks/server/contract-lint";

const root = "/tmp/writer";
const base: TaskV2 = {
  schema_version:2, display_title:"Тестовая задача", kind:"feature", area:"feature:c", id:"c", title:"C", risk:"medium", lane:"writer", project_cwd:root, read_first:[],
  interfaces:["i"], invariants:["x"], out_of_scope:["o"], expected_outputs:["src/b.ts"], owns_paths:["src/**", "tests/**"], never_touch:[], depends_on:[],
  objective:"x", acceptance:["done"], verify:"tests", verification:[{ command:"npx vitest run tests/b.test.ts", cwd:root }],
};
const lint = (task:Partial<TaskV2>, kinds:ReadonlyMap<string, PathKind> | null = null) =>
  lintContract({ task:{ ...base, ...task }, workspacePath:root, hostId:"h", kinds, sandboxUnsafe:[], openTasks:[], deadDependencies:[] });
const codes = (rows:Array<{ code:string }>) => rows.map((row) => row.code);

describe("empty verification commands", () => {
  it.each(["true", ":", "exit 0", "exit", "/bin/true", "echo ok", "echo done && true", "printf '%s' ok", "sleep 1", "cd apps/web && echo checked", "sh -c 'echo ok'", "bash -c \"true\"", "[ 1 -eq 1 ]"])(
    "calls %s an empty check", (command) => expect(emptyCheckReason(command), command).not.toBeNull());

  it.each(["npm test || true", "npm test; exit 0", "npx vitest run a.test.ts || :", "sh -c 'npm test; true'"])(
    "calls %s a check that hides its failure", (command) => expect(emptyCheckReason(command), command).toMatch(/turns a failure into a pass/));

  it.each(["npx vitest run tests/b.test.ts", "npm run typecheck", "test -f src/b.ts", "grep -q 'LIMIT = 10' src/a.ts", "cd apps/web && npm test", "echo x | grep -q x",
    "npm test && echo done", "node -e \"process.exit(1)\"", "false"])(
    "leaves %s alone", (command) => expect(emptyCheckReason(command), command).toBeNull());

  it("refuses a contract whose check cannot fail, naming the check and the fix", () => {
    const { errors } = lint({ verification:[{ command:"npx vitest run tests/b.test.ts", cwd:root }, { command:"true", cwd:root }] });
    expect(codes(errors)).toEqual(["verification_empty_check"]);
    expect(errors[0]!.message).toContain("verification[1]");
    expect(errors[0]!.message).toContain("passes whatever the writer does");
  });

  it("refuses at every risk, including low", () => {
    expect(codes(lint({ risk:"low", verification:[{ command:"echo ok", cwd:root }] }).errors)).toContain("verification_empty_check");
  });
});

describe("red before green", () => {
  const kindsFor = (task:Partial<TaskV2>, answers:Record<string, PathKind>) =>
    new Map(lintProbePaths({ ...base, ...task }, root).map((path) => [path, answers[path] ?? "file"] as const));

  it("probes the files a check names on the base commit", () => {
    expect(checkNamedPaths(base)).toEqual([`${root}/tests/b.test.ts`]);
    expect(lintProbePaths(base, root)).toContain(`${root}/tests/b.test.ts`);
  });

  it("warns, never refuses, when every file a medium-risk check names already exists on the base", () => {
    const result = lint({}, kindsFor({}, {}));
    expect(codes(result.errors)).toEqual([]);
    expect(codes(result.warnings)).toContain("no_red_before_green");
  });

  it("is quiet when a check names a file the task creates (missing on the base)", () => {
    const kinds = kindsFor({}, { [`${root}/tests/b.test.ts`]: "missing" });
    expect(codes(lint({}, kinds).warnings)).not.toContain("no_red_before_green");
  });

  it("is quiet for risk low, for a mainfix task, and when the machine could not be asked", () => {
    expect(codes(lint({ risk:"low" }, kindsFor({ risk:"low" }, {})).warnings)).not.toContain("no_red_before_green");
    expect(codes(lint({ id:"c-mainfix" }, kindsFor({ id:"c-mainfix" }, {})).warnings)).not.toContain("no_red_before_green");
    expect(codes(lint({}, null).warnings)).not.toContain("no_red_before_green");
  });

  it("applies to high and critical risk", () => {
    for (const risk of ["high", "critical"] as const) expect(codes(lint({ risk }, kindsFor({ risk }, {})).warnings)).toContain("no_red_before_green");
  });
});

describe("existence-only checks on files the base has", () => {
  const exists = (task:Partial<TaskV2>, answers:Record<string, PathKind> = {}) =>
    new Map(lintProbePaths({ ...base, ...task }, root).map((path) => [path, answers[path] ?? "file"] as const));

  it.each([
    ["test -f src/a.ts", ["src/a.ts"]], ["[ -f src/a.ts ]", ["src/a.ts"]], ["test -f src/a.ts && test -d src", ["src/a.ts", "src"]], ["ls src/a.ts", ["src/a.ts"]],
    ["test -f './src/a.ts'", ["src/a.ts"]],
  ])("reads %s as a check of existence only", (command, paths) => expect(existenceOnlyPaths(command)).toEqual(paths));

  it.each(["test -f src/a.ts && grep -q X src/a.ts", "npm test", "test -f a.ts | wc -l", "grep -q X src/a.ts"])("does not read %s as existence only", (command) =>
    expect(existenceOnlyPaths(command)).toBeNull());

  it("refuses a medium-risk task whose only checks test files that exist on the base, naming the check", () => {
    const task = { verification:[{ command:"test -f src/a.ts", cwd:root }] };
    const result = lint(task, exists(task));
    expect(codes(result.errors)).toContain("verification_existence_on_base");
    expect(result.errors.find((row) => row.code === "verification_existence_on_base")!.message).toContain("verification[0]");
  });

  it("only warns when another check can fail, for a low-risk task, for a refactor, or when the file is new", () => {
    const mixed = { verification:[{ command:"test -f src/a.ts", cwd:root }, { command:"npx vitest run tests/b.test.ts", cwd:root }] };
    const result = lint(mixed, exists(mixed));
    expect(codes(result.errors)).not.toContain("verification_existence_on_base");
    expect(codes(result.warnings)).toContain("verification_existence_on_base");
    const only = { verification:[{ command:"test -f src/a.ts", cwd:root }] };
    expect(codes(lint({ ...only, risk:"low" }, exists(only)).errors)).not.toContain("verification_existence_on_base");
    expect(codes(lint({ ...only, kind:"refactor" }, exists(only)).errors)).not.toContain("verification_existence_on_base");
    const fresh = lint(only, exists(only, { [`${root}/src/a.ts`]: "missing" }));
    expect([...fresh.errors, ...fresh.warnings].map((row) => row.code)).not.toContain("verification_existence_on_base");
  });
});
