import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";
import { isEnvironmentCheckFailure } from "../src/rooms/runs/failure-class";
import { openDatabase } from "../src/rooms/plugin-db";
import { createWriterFinish } from "../src/rooms/writer/server/finish";

const task = taskV2Schema.parse({
  schema_version: 2, id: "site-fix", title: "Fix the site", risk: "medium", lane: "writer", project_cwd: "/work/wt",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/a.ts"],
  owns_paths: ["src"], never_touch: [], depends_on: [], objective: "x", acceptance: ["x"], verify: "none",
  verification: [{ command: "npm run build", cwd: "/work/wt" }],
});

// OVH: a deploy left root-owned files, and the post-merge build died on `EACCES: permission denied, rmSync '.output'`.
// A -mainfix writer cannot chown them: it would only run out its attempts.
const EACCES = "[nitro] ERROR Error: EACCES: permission denied, rmSync '/work/base/apps/web/.output/public/_nuxt'";

async function mergeThenCheck(checks: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  const log = vi.fn();
  const dispatchWriter = vi.fn(async () => ({ state: "queued" }));
  const db = openDatabase(bb);
  const ctx = {
    bb: { storage: bb.storage, sdk: { threads: { send: async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); } }, files: { write: async () => ({}) } } },
    db, log, state: { disposed: false }, host: { call: async () => ({}) },
  };
  const rows = () => db.prepare("SELECT key, kind, what, why FROM lane_pilot_owner_item ORDER BY rowid").all() as Array<{ key: string; kind: string; what: string; why: string }>;
  const services = { runVerification: async () => checks, dispatchWriter };
  const finish = createWriterFinish(ctx as never, services as never);
  const input = { projectId: "P", pmThreadId: "pm", config: { hostId: "h" } as never, runId: "run", task, basePath: "/work/base", worktreePath: "/work/wt" };
  await finish.checkMainAfterMerge(input);
  await finish.checkMainAfterMerge(input);
  return { sent, log, dispatchWriter, rows };
}

it("tells environment errors from failing code", () => {
  expect(isEnvironmentCheckFailure({ stderr: EACCES })).toBe(true);
  expect(isEnvironmentCheckFailure({ stdout: "Error: EPERM: operation not permitted, unlink '/x'" })).toBe(true);
  expect(isEnvironmentCheckFailure({ stderr: "EEXIST: file already exists, mkdir '/x/.output'" })).toBe(true);
  expect(isEnvironmentCheckFailure({ stderr: "error TS2345: Argument of type 'string' is not assignable", stdout: "FAIL src/b.test.ts" })).toBe(false);
});

// 0.1.458: the note is one row on the owner's list (kind gate_machine), never a message into the PM chat (0.1.443).
it("creates no -mainfix for a post-merge check the environment broke: an infra line in the log and one row on the owner's list", async () => {
  const { sent, log, dispatchWriter, rows } = await mergeThenCheck([{ command: "npm run build", exitCode: 1, stdout: "", stderr: EACCES }]);
  expect(dispatchWriter).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
  // The same fault reported by a second merge of the run is not told twice (the key is the failure's fingerprint).
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ kind: "gate_machine" });
  expect(rows()[0]!.what).toContain("из-за машины");
  expect(rows()[0]!.what).toContain("npm run build");
  expect(rows()[0]!.why).toContain("EACCES");
  expect(log.mock.calls.map((call) => String(call[0])).some((line) => line.startsWith("infra: post-merge check of site-fix"))).toBe(true);
  // The line must not read as a Lane Pilot fault to the self-repair watcher («failed»).
  expect(log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("infra:")).every((line) => !/\bfailed\b/i.test(line))).toBe(true);
});

it("still dispatches the -mainfix for the code failure that sits beside an environment error", async () => {
  const { dispatchWriter, rows } = await mergeThenCheck([
    { command: "npm run build", exitCode: 1, stdout: "", stderr: EACCES },
    { command: "npx vitest run", exitCode: 1, stdout: "FAIL src/b.test.ts", stderr: "1 failed" },
  ]);
  expect(dispatchWriter).toHaveBeenCalledTimes(2);
  expect((dispatchWriter.mock.calls[0] as unknown as [{ task: { id: string; expected_outputs: string[] } }])[0].task).toMatchObject({ id: "site-fix-mainfix", expected_outputs: ["npx vitest run"] });
  expect(rows().some((row) => row.kind === "gate_machine")).toBe(true);
});

it("dispatches the -mainfix for a red test that merely logs EACCES", async () => {
  const { sent, dispatchWriter } = await mergeThenCheck([
    { command: "npx vitest run", exitCode: 1, stdout: " FAIL  tests/fs.test.ts > locked\n Tests  1 failed | 3 passed (4)", stderr: "Error: EACCES: permission denied, open '/root/secret'" },
  ]);
  expect(dispatchWriter).toHaveBeenCalled();
  expect(sent.some((text) => text.includes("because of the machine"))).toBe(false);
});

it("names the post-merge check by the attempt and the merge commit it follows", async () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const seen: Array<unknown> = [];
  const ctx = { bb: { storage: bb.storage, sdk: { threads: { send: async () => ({}) }, files: { write: async () => ({}) } } }, db: {}, log: vi.fn(), state: { disposed: false }, host: { call: async () => ({}) } };
  const services = { runVerification: async (...args: unknown[]) => { seen.push(args[4]); return []; }, dispatchWriter: vi.fn() };
  const finish = createWriterFinish(ctx as never, services as never);
  const base = { projectId: "P", pmThreadId: "pm", config: { hostId: "h" } as never, runId: "run", task, basePath: "/work/base", worktreePath: "/work/wt" };
  await finish.checkMainAfterMerge({ ...base, attemptId: "lpattempt_1", mergeCommit: "aaa111" });
  await finish.checkMainAfterMerge({ ...base, attemptId: "lpattempt_2", mergeCommit: "bbb222" });
  expect(seen).toEqual([{ background: true, jobKey: "post-merge:lpattempt_1:aaa111" }, { background: true, jobKey: "post-merge:lpattempt_2:bbb222" }]);
});

it("hands the post-merge checks to the baseline («what turned red») and the log says which of the red ones were green on the base", async () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  const log = vi.fn();
  const ctx = { bb: { storage: bb.storage, sdk: { threads: { send: async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); } }, files: { write: async () => ({}) } } }, db: {}, log, state: { disposed: false }, host: { call: async () => ({}) } };
  const checks = [{ command: "npm run build", exitCode: 1, stdout: "", stderr: "1 failed" }];
  const afterMerge = vi.fn(() => ["npm run build"]);
  const services = { runVerification: async () => checks, dispatchWriter: vi.fn(async () => ({ state: "queued" })), baseline: { afterMerge } };
  const finish = createWriterFinish(ctx as never, services as never);
  await finish.checkMainAfterMerge({ projectId: "P", pmThreadId: "pm", config: { hostId: "h" } as never, runId: "run", task, basePath: "/work/base", worktreePath: "/work/wt", attemptId: "att_1", mergeCommit: "abc" });
  expect(afterMerge).toHaveBeenCalledWith({ runId: "run", taskId: "site-fix", mergeCommit: "abc", checks });
  expect(sent).toEqual([]);
  expect(log.mock.calls.map((call) => String(call[0])).some((line) => line.includes("fails on main with it (npm run build passed on the base before this task)") && line.includes("site-fix-mainfix dispatched"))).toBe(true);
});
