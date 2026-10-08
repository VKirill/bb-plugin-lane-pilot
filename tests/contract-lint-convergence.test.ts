import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";
import type { TaskV2 } from "../src/rooms/contracts";
import { validateTaskV2 } from "../src/rooms/tasks/task-v2";
import { compactContract } from "../src/rooms/writer/writer-brief";
import { lintContract, subjectiveWordIn } from "../src/rooms/tasks/server/contract-lint";

const root = "/tmp/writer";
const base: TaskV2 = {
  schema_version:2, id:"c", title:"C", risk:"low", lane:"writer", project_cwd:root, read_first:[], interfaces:["i"], invariants:["x"], out_of_scope:["o"],
  expected_outputs:["src/b.ts"], owns_paths:["src/**", "tests/**"], never_touch:["src/secret/**"], depends_on:[], objective:"x", acceptance:["done"], verify:"tests",
  verification:[{ command:"npx vitest run tests/b.test.ts", cwd:root }],
};
const lint = (task:Partial<TaskV2>) => lintContract({ task:{ ...base, ...task }, workspacePath:root, hostId:"h", kinds:null, sandboxUnsafe:[], openTasks:[], deadDependencies:[] });
const codes = (rows:Array<{ code:string }>) => rows.map((row) => row.code);

describe("convergence.criteria and files[] in the task contract (Maestro task.json)", () => {
  it("both are optional and checked by the schema; a task without them is unchanged", () => {
    expect(taskV2Schema.safeParse(base).success).toBe(true);
    expect(validateTaskV2({ ...base, convergence:{ criteria:["src/b.ts contains 'LIMIT = 10'"] }, files:[{ path:"src/b.ts", action:"create", target:"limit", change:"export const LIMIT = 10" }] }).ok).toBe(true);
    expect(taskV2Schema.safeParse({ ...base, convergence:{ criteria:[] } }).success).toBe(false);
    expect(taskV2Schema.safeParse({ ...base, convergence:{ criteria:["x"], extra:1 } }).success).toBe(false);
    expect(taskV2Schema.safeParse({ ...base, files:[{ path:"src/b.ts", action:"rewrite", change:"x" }] }).success).toBe(false);
    expect(taskV2Schema.safeParse({ ...base, files:[{ path:"src/b.ts", action:"modify" }] }).success).toBe(false);
  });

  it("a criterion that rests on a subjective word is refused with the checkable form to write", () => {
    expect(codes(lint({ convergence:{ criteria:["src/b.ts contains 'LIMIT = 10'", "the limiter works properly"] } }).errors)).toEqual(["criteria_subjective"]);
    const [error] = lint({ convergence:{ criteria:["Код выглядит аккуратно"] } }).errors;
    expect(error!.message).toContain("convergence.criteria[0]");
    expect(error!.message).toContain("аккуратно");
    expect(lint({ convergence:{ criteria:["src/b.ts contains 'LIMIT = 10'", "`npx vitest run tests/b.test.ts` exits 0", "cleanup() is exported"] } }).errors).toEqual([]);
  });

  it("subjectiveWordIn matches whole words in any case", () => {
    expect(subjectiveWordIn("It must be Robust")).toBe("robust");
    expect(subjectiveWordIn("the cleanup script exists")).toBeNull();
    expect(subjectiveWordIn("works well under load")).toBe("works well");
  });

  it("files[] names files the task owns: outside owns_paths, inside never_touch and unsafe paths are errors", () => {
    expect(lint({ files:[{ path:"src/b.ts", action:"create", change:"x" }, { path:"./tests/b.test.ts", action:"create", change:"y" }] }).errors).toEqual([]);
    expect(codes(lint({ files:[{ path:"docs/a.md", action:"modify", change:"x" }] }).errors)).toEqual(["files_unowned"]);
    expect(codes(lint({ files:[{ path:"src/secret/key.ts", action:"modify", change:"x" }] }).errors)).toEqual(["files_never_touch"]);
    expect(codes(lint({ files:[{ path:"../x.ts", action:"modify", change:"x" }] }).errors)).toEqual(["files_unsafe"]);
  });

  it("the writer sees both in the contract it is given", () => {
    const task = { ...base, convergence:{ criteria:["the command exits 0"] }, files:[{ path:"src/b.ts", action:"create" as const, change:"x" }] };
    expect(compactContract(task, false)).toMatchObject({ convergence:{ criteria:["the command exits 0"] }, files:[{ path:"src/b.ts", action:"create", change:"x" }] });
  });
});
