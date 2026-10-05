import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskV2Schema } from "../src/contracts";
import { classifyWriterOutput } from "../src/validate-output";
import { postMergeRepair } from "../src/server/writer/finish";

const original = readFileSync(join(__dirname, "fixtures/writer-brief-gc-pages-polish-2.md"), "utf8");
const merged = taskV2Schema.parse(JSON.parse(original.slice(original.indexOf('{\n  "schema_version"'))));

// SelfyStudio cards-checkout-typecheck-fix-mainfix (2026-10-05): the follow-up inherited the merged task's
// expected_outputs, so its writer, finding main green, edited routes.ts only to «put the required file in the diff».
it("dispatches the main repair without the merged task's expected files", () => {
  const { fix, plan } = postMergeRepair(merged, [{ command:"npx vitest run --root apps/api", exitCode:1, stdout:"", stderr:"1 failed" }]);
  expect(taskV2Schema.safeParse(fix).success).toBe(true);
  expect(fix.id).toBe(`${merged.id}-mainfix`);
  expect(fix.owns_paths).toEqual(merged.owns_paths);
  const ownedFile = `${merged.owns_paths[0]!.replace(/\/?\*\*$/, "").replace(/\/$/, "")}/Other.vue`;
  expect(classifyWriterOutput({ task:{ ...fix, verify:"none" }, produced:[ownedFile], contents:{ [ownedFile]:"x" } })).toEqual({ ok:true });
  expect(plan).toContain("NEEDS_HUMAN: main is already green");
});
