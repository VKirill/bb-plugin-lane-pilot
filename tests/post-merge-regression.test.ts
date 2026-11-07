import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";
import { openDatabase } from "../src/rooms/plugin-db";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import { runWithFlakyRerun } from "../src/rooms/writer/server/verify";

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
  const db = openDatabase(bb);
  const log = vi.fn();
  const ctx = { bb: { storage: bb.storage, sdk: { threads: { send: async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); } }, files: { write: async () => ({}) } } }, db, log, state: { disposed: false }, host: { call: async () => ({}) } };
  const queue = [...runs];
  const runVerification = vi.fn(async () => { const next = queue.shift(); if (next instanceof Error) throw next; return next ?? []; });
  const services = { runVerification, dispatchWriter, ...(baseline ? { baseline: { afterMerge: () => baseline.turned, redBefore: () => baseline.redBefore ?? [] } } : {}) };
  const finish = createWriterFinish(ctx as never, services as never);
  await finish.checkMainAfterMerge({ projectId: "P", pmThreadId: "pm", config: { hostId: "h" } as never, runId: "run", task: { ...task, id: taskId }, basePath: "/work/base", worktreePath: "/work/wt", attemptId: "att", mergeCommit: "abc", ...(greenInWorktree ? { greenInWorktree } : {}) });
  const rows = () => db.prepare("SELECT key, kind, what, why FROM lane_pilot_owner_item ORDER BY rowid").all() as Array<{ key: string; kind: string; what: string; why: string }>;
  const logged = (needle: string, also = "") => log.mock.calls.map((call) => String(call[0])).some((line) => line.includes(needle) && line.includes(also));
  return { sent, dispatchWriter, runVerification, rows, logged };
}

// 0.1.458: post-merge notes are log lines or rows on the owner's list, never messages into the PM chat (0.1.443).
it("a red that passes on the re-run is flaky: a log line, no repair task, nothing for the owner", async () => {
  const { sent, dispatchWriter, runVerification, rows, logged } = await mergeThenCheck([[red("npm run build")], [green("npm run build")]], { turned: ["npm run build"] });
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(runVerification).toHaveBeenCalledTimes(2);
  expect(sent).toEqual([]);
  expect(rows()).toEqual([]);
  expect(logged("flaky")).toBe(true);
});

it("re-runs only the red checks, once, under its own job key", async () => {
  const { runVerification } = await mergeThenCheck([[red("npm run build"), green("npx vitest run")], [red("npm run build")]], { turned: ["npm run build"] });
  expect(runVerification).toHaveBeenCalledTimes(2);
  const [, rerunTask, , , options] = runVerification.mock.calls[1] as unknown as [unknown, { verification: Array<{ command: string }> }, unknown, unknown, { jobKey: string }];
  expect(rerunTask.verification.map((c) => c.command)).toEqual(["npm run build"]);
  expect(options.jobKey).toBe("post-merge:att:abc:rerun");
});

it("dispatches the repair task for a red that turned red and reproduces", async () => {
  const { dispatchWriter, sent, logged } = await mergeThenCheck([[red("npm run build")], [red("npm run build")]], { turned: ["npm run build"] });
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([]);
  expect(logged("passed on the base before this task", "site-fix-mainfix dispatched")).toBe(true);
});

// 2026-10-29 audit: the first post-merge run re-runs a red itself (runWithFlakyRerun); asking for one more confirming run made four runs of one stable failure.
it("a red that already failed its own re-run is repaired without a third run", async () => {
  const runs = [red("npm run build"), red("npm run build")];
  const reading = await runWithFlakyRerun("npm run build", async () => runs.shift()!, () => {});
  const { dispatchWriter, runVerification } = await mergeThenCheck([[reading as Row]], { turned: ["npm run build"] });
  expect(runVerification).toHaveBeenCalledTimes(1);
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
});

// SMA audit N-05: a product red whose own re-run timed out reproduced nothing; it was taken for a reproduced red and a mainfix went out.
it("a red whose own re-run timed out is run again before any repair task", async () => {
  const runs = [red("npm run build"), { command: "npm run build", exitCode: 124, stdout: "", stderr: "TIMEOUT" }];
  const reading = await runWithFlakyRerun("npm run build", async () => runs.shift()!, () => {});
  const { dispatchWriter, runVerification } = await mergeThenCheck([[reading as Row], [green("npm run build")]], { turned: ["npm run build"] });
  expect(runVerification).toHaveBeenCalledTimes(2);
  expect(dispatchWriter).not.toHaveBeenCalled();
});

it("a red that was already red on the base is not this task's regression: one row for the owner, no re-run, no repair task", async () => {
  const { sent, dispatchWriter, runVerification, rows } = await mergeThenCheck([[red("npx vitest run")]], { turned: [], redBefore: ["npx vitest run"] });
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(runVerification).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([]);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ kind: "gate_red", key: "post-merge-redbefore:run:site-fix" });
  expect(rows()[0]!.what).toContain("была красной и до этой задачи");
  expect(rows()[0]!.why).toContain("npx vitest run");
});

it("a fix's check red on the base, green in its worktree and red again on main is the merge's clash: re-run, then repaired", async () => {
  const { dispatchWriter, runVerification, sent } = await mergeThenCheck([[red("npx vitest run")], [red("npx vitest run")]], { turned: [], redBefore: ["npx vitest run"] }, "site-fix", ["npx vitest run"]);
  expect(runVerification).toHaveBeenCalledTimes(2);
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
  expect(sent.some((text) => text.includes("red before this task too"))).toBe(false);
});

it("splits a mix: the check red before is told, the one that turned red and reproduces is repaired", async () => {
  const { sent, dispatchWriter, rows } = await mergeThenCheck([[red("npm run build"), red("npx vitest run")], [red("npm run build")]], { turned: ["npm run build"], redBefore: ["npx vitest run"] });
  expect(dispatchWriter).toHaveBeenCalledTimes(1);
  expect((dispatchWriter.mock.calls[0] as unknown as [{ task: { expected_outputs: string[] } }])[0].task.expected_outputs).toEqual(["npm run build"]);
  expect(sent).toEqual([]);
  expect(rows().some((row) => row.key.startsWith("post-merge-redbefore:") && row.why.includes("npx vitest run"))).toBe(true);
});

it("with no baseline record only the re-run decides", async () => {
  const flaky = await mergeThenCheck([[red("npm run build")], [green("npm run build")]]);
  expect(flaky.dispatchWriter).not.toHaveBeenCalled();
  expect(flaky.sent).toEqual([]);
  expect(flaky.logged("flaky")).toBe(true);
  const real = await mergeThenCheck([[red("npm run build")], [red("npm run build")]]);
  expect(real.dispatchWriter).toHaveBeenCalledTimes(1);
});

it("a -mainfix that leaves main red is one row for the owner, without a re-run", async () => {
  const { sent, dispatchWriter, runVerification, rows } = await mergeThenCheck([[red("npm run build")]], { turned: ["npm run build"] }, "site-fix-mainfix");
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(runVerification).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([]);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ kind: "gate_red", key: "post-merge-red-again:run:site-fix-mainfix" });
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

// SMA audit R-05: a re-run that never reached the host (hostError) lost that mark and was read as a reproduced product red.
it("a red whose own re-run never reached the host is run again before any repair task", async () => {
  const runs = [red("npm run build"), { command: "npm run build", exitCode: 1, stdout: "", stderr: "RPC channel closed", hostError: true }];
  const reading = await runWithFlakyRerun("npm run build", async () => runs.shift()!, () => {});
  const { dispatchWriter, runVerification } = await mergeThenCheck([[reading as Row], [green("npm run build")]], { turned: ["npm run build"] });
  expect(runVerification).toHaveBeenCalledTimes(2);
  expect(dispatchWriter).not.toHaveBeenCalled();
});
