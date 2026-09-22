import { describe, expect, it } from "vitest";
import {
  acceptanceArtifactDir,
  buildAcceptanceV2,
  validateAcceptanceV2,
} from "../src/acceptance-v2";
import type { TaskV2 } from "../src/contracts";

const task = {
  schema_version:2,
  id:"task-acceptance-v2",
  title:"Receipt contract test",
  risk:"low",
  lane:"writer",
  project_cwd:"/tmp/fixture",
  read_first:["README.md"],
  interfaces:["Keep the fixture interface"],
  invariants:["Do not touch production files"],
  out_of_scope:["deployment"],
  expected_outputs:["result.md"],
  owns_paths:["result.md"],
  never_touch:["src/production.ts"],
  depends_on:[],
  objective:"Write the expected result.",
  acceptance:["result.md exists"],
  verify:"none",
  verification:[],
} as TaskV2;

describe("upstream acceptance-v2 receipt", () => {
  it("produces a receipt with zero errors against the vendored upstream schema", () => {
    const report = "STATUS: complete\n";
    const receipt = buildAcceptanceV2({
      task,
      attempt:2,
      providerId:"codex",
      model:"gpt-6-luna",
      reportText:report,
    });

    expect(validateAcceptanceV2(receipt)).toEqual({ ok:true });
    expect(acceptanceArtifactDir("/workspace", "run-1", task.id)).toBe(
      "/workspace/.agents/runs/run-1/artifacts/task-acceptance-v2",
    );
    expect(validateAcceptanceV2({ ...receipt, schema_version:1 })).toMatchObject({ ok:false });
  });
});
