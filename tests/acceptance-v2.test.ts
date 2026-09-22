import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptanceArtifactDir,
  buildAcceptanceV2,
  loadAcceptanceV2Schema,
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
  it("validates the serialized acceptance.json against the exact upstream schema with zero errors", () => {
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

    const vendoredSchema = join(process.cwd(), "lane-stack/schemas/acceptance-v2.schema.json");
    const upstreamSchema = join(
      process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack/schemas/acceptance-v2.schema.json",
    );
    expect(readFileSync(vendoredSchema, "utf8")).toBe(readFileSync(upstreamSchema, "utf8"));
    expect(loadAcceptanceV2Schema()).toEqual(JSON.parse(readFileSync(upstreamSchema, "utf8")));

    const directory = mkdtempSync(join(tmpdir(), "lane-pilot-acceptance-v2-"));
    const acceptancePath = join(directory, "acceptance.json");
    writeFileSync(acceptancePath, `${JSON.stringify(receipt, null, 2)}\n`);
    try {
      const result = spawnSync("python3", [
        "-c",
        "import json,sys; from jsonschema import Draft202012Validator; schema=json.load(open(sys.argv[1])); document=json.load(open(sys.argv[2])); errors=[e.message for e in Draft202012Validator(schema).iter_errors(document)]; print(json.dumps(errors))",
        upstreamSchema,
        acceptancePath,
      ], { encoding:"utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    } finally {
      rmSync(directory, { recursive:true, force:true });
    }
  });
});
