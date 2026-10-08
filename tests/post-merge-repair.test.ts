import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskV2Schema } from "../src/contracts";
import { classifyWriterOutput } from "../src/rooms/tasks/validate-output";
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

const red = [
  { command:"npx vitest run --root apps/api", exitCode:1, stdout:"PASS src/a.test.ts\nFAIL src/b.test.ts", stderr:"1 failed" },
  { command:"npm run typecheck", exitCode:2, stdout:"", stderr:"error TS2345 in src/site.ts" },
];

it("carries each failing command and its output tail in the objective, and no prose in expected_outputs", () => {
  const { fix } = postMergeRepair(merged, red);
  for (const check of red) {
    expect(fix.objective).toContain(`\`${check.command}\``);
    expect(fix.objective).toContain(check.stderr);
    expect(fix.acceptance.some((line) => line.includes(check.command))).toBe(true);
  }
  expect(fix.expected_outputs).toEqual(red.map((check) => check.command));
  // A command is not a file path, so the mainfix is accepted with zero changed files when its checks pass.
  expect(classifyWriterOutput({ task:fix, produced:[], contents:{} })).toEqual({ ok:true });
});

it("saves the full output of every failing check under the task folder logs/", () => {
  const { fix, logs } = postMergeRepair(merged, red);
  expect(logs).toHaveLength(red.length);
  for (const [index, log] of logs.entries()) {
    expect(log.path).toBe(`.agents/plans/items/${fix.id}/logs/${String(index + 1).padStart(2, "0")}-`
      + `${red[index]!.command.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}.log`);
    expect(log.content).toContain(`$ ${red[index]!.command}`);
    expect(log.content).toContain(red[index]!.stdout ?? "");
    expect(log.content).toContain(red[index]!.stderr ?? "");
  }
});
