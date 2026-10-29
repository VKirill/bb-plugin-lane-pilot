import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";
import { createWriterFinish } from "../src/rooms/writer/server/finish";

const task = taskV2Schema.parse({
  schema_version: 2, id: "site-fix", title: "Fix the site", risk: "medium", lane: "writer", project_cwd: "/work/wt",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/a.ts"],
  owns_paths: ["src"], never_touch: [], depends_on: [], objective: "x", acceptance: ["x"], verify: "none",
  verification: [{ command: "npm run build", cwd: "/work/wt" }, { command: "npx vitest run", cwd: "/work/wt" }],
});

type Row = { command: string; exitCode: number; stdout: string; stderr: string };
const red = (command: string): Row => ({ command, exitCode: 1, stdout: "FAIL src/b.test.ts", stderr: "1 failed" });
const green = (command: string): Row => ({ command, exitCode: 0, stdout: "", stderr: "" });

// Vampirism Fire: 8 of 12 -mainfix ran on a green main. A repair task needs a red that is this task's and reproduces.
async function mergeThenCheck(runs: Array<Row[] | Error>, baseline?: { turned: string[]; redBefore?: string[] }, taskId = "site-fix", greenInWorktree?: string[]) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  const dispatchWriter = vi.fn(async () => ({ state: "queued" }));
  const ctx = { bb: { storage: bb.storage, sdk: { threads: { send: async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); } }, files: { write: async () => ({}) } } }, db: {}, log: vi.fn(), state: { disposed: false }, host: { call: async () => ({}) } };
  const queue = [...runs];
  const runVerification = vi.fn(async () => { const next = queue.shift(); if (next instanceof Error) throw next; return next ?? []; });
  const services = { runVerification, dispatchWriter, ...(baseline ? { baseline: { afterMerge: () => baseline.turned, redBefore: () => baseline.redBefore ?? [] } } : {}) };
  const finish = createWriterFinish(ctx as never, services as never);
  await finish.checkMainAfterMerge({ projectId: "P", pmThreadId: "pm", config: { hostId: "h" } as never, runId: "run", task: { ...task, id: taskId }, basePath: "/work/base", worktreePath: "/work/wt", attemptId: "att", mergeCommit: "abc", ...(greenInWorktree ? { greenInWorktree } : {}) });
  return { sent, dispatchWriter, runVerification };
}

it("a red that passes on the re-run is flaky: one message to the PM, no repair task", async () => {
  const { sent, dispatchWriter, runVerification } = await mergeThenCheck([[red("npm run build")], [green("npm run build")]], { turned: ["npm run build"] });
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(runVerification).toHaveBeenCalledTimes(2);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("flaky");
});

it("re-runs only the red checks, once, under its own job key", async () => {
  const { runVerification } = await mergeThenCheck([[red("npm run build"), green("npx vitest run")], [red("npm run build")]], { turned: ["npm run build"] });
  expect(runVerification).toHaveBeenCalledTimes(2);
  const [, rerunTask, , , options] = runVerification.mock.calls[1] as unknown as [unknown, { verification: Array<{ command: string }> }, unknown, unknown, { jobKey: string }];
  expect(rerunTask.verification.map((c) => c.command)).toEqual(["npm run build"]);
  expect(options.jobKey).toBe("post-merge:att:abc:rerun");
});

it("dispatches the repair task for a red that turned red and reproduces", async () => {
  const { dispatchWriter, sent } = await mergeThenCheck([[red("npm run build")], [red("npm run build")]], { turned: ["npm run build"] });
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
  expect(sent.some((text) => text.includes("passed on the base before this task") && text.includes("site-fix-mainfix is on its way"))).toBe(true);
});

// 2026-10-29 audit: the first post-merge run re-runs a red itself (runWithFlakyRerun); asking for one more confirming run made four runs of one stable failure.
it("a red that already failed its own re-run is repaired without a third run", async () => {
  const { dispatchWriter, runVerification } = await mergeThenCheck([[{ ...red("npm run build"), reran: true } as Row]], { turned: ["npm run build"] });
  expect(runVerification).toHaveBeenCalledTimes(1);
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
});

it("a red that was already red on the base is not this task's regression: one message, no re-run, no repair task", async () => {
  const { sent, dispatchWriter, runVerification } = await mergeThenCheck([[red("npx vitest run")]], { turned: [], redBefore: ["npx vitest run"] });
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(runVerification).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("red before this task too");
});

it("a fix's check red on the base, green in its worktree and red again on main is the merge's clash: re-run, then repaired", async () => {
  const { dispatchWriter, runVerification, sent } = await mergeThenCheck([[red("npx vitest run")], [red("npx vitest run")]], { turned: [], redBefore: ["npx vitest run"] }, "site-fix", ["npx vitest run"]);
  expect(runVerification).toHaveBeenCalledTimes(2);
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
  expect(sent.some((text) => text.includes("red before this task too"))).toBe(false);
});

it("splits a mix: the check red before is told, the one that turned red and reproduces is repaired", async () => {
  const { sent, dispatchWriter } = await mergeThenCheck([[red("npm run build"), red("npx vitest run")], [red("npm run build")]], { turned: ["npm run build"], redBefore: ["npx vitest run"] });
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
  expect((dispatchWriter.mock.calls[0] as unknown as [{ task: { expected_outputs: string[] } }])[0].task.expected_outputs).toEqual(["npm run build"]);
  expect(sent.some((text) => text.includes("red before this task too") && text.includes("npx vitest run"))).toBe(true);
});

it("with no baseline record only the re-run decides", async () => {
  const flaky = await mergeThenCheck([[red("npm run build")], [green("npm run build")]]);
  expect(flaky.dispatchWriter).not.toHaveBeenCalled();
  expect(flaky.sent[0]).toContain("flaky");
  const real = await mergeThenCheck([[red("npm run build")], [red("npm run build")]]);
  expect(real.dispatchWriter).toHaveBeenCalledTimes(1);
});

it("a -mainfix that leaves main red is still handed to the PM without a re-run", async () => {
  const { sent, dispatchWriter, runVerification } = await mergeThenCheck([[red("npm run build")]], { turned: ["npm run build"] }, "site-fix-mainfix");
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(runVerification).toHaveBeenCalledTimes(1);
  expect(sent[0]).toContain("fixed main once already");
});

it("redBeforeAndAfter keeps only checks that were red on the base and are red now; an unknown or host-failed one says nothing", async () => {
  const { redBeforeAndAfter } = await import("../src/rooms/baseline/logic");
  const base = (command: string, status: "green" | "red" | "unknown") => ({ command, cwd: "/", status, exitCode: null, note: "" });
  expect(redBeforeAndAfter([base("a", "red"), base("b", "green"), base("c", "unknown"), base("d", "red")], [
    { command: "a", exitCode: 1 }, { command: "b", exitCode: 1 }, { command: "c", exitCode: 1 }, { command: "d", exitCode: 1, hostError: true },
  ])).toEqual(["a"]);
});

// Astra's recheck of 0.1.336 (P1): «the re-run did not turn green» is not «the defect reproduced». Only a product red again is.
const studioDown = (command: string): Row => ({ command, exitCode: 1, stdout: "", stderr: "studio_test error: Unable to reach Roblox Studio right now." });

it.each([
  ["a re-run that is an environment red", [studioDown("npm run build")]],
  ["a re-run the host could not run", [{ ...red("npm run build"), hostError: true }]],
  ["a re-run that threw (no result)", new Error("host unreachable")],
  ["a re-run that exited 0 but ran no test", [{ command: "npm run build", exitCode: 1, stdout: "", stderr: "check failed: the check exited 0 but ran no test: 4 skipped (vitest)" }]],
])("%s does not dispatch a repair task: the first red stays recorded, one log line, nobody is woken", async (_name, rerun) => {
  const { sent, dispatchWriter } = await mergeThenCheck([[red("npm run build")], rerun as Row[] | Error], { turned: ["npm run build"] });
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(sent).toHaveLength(0);
});

it("a re-run that reproduces the product red still dispatches the repair task", async () => {
  const { dispatchWriter } = await mergeThenCheck([[red("npm run build")], [red("npm run build")]], { turned: ["npm run build"] });
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
});
