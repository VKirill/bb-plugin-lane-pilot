import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { retrySafetyStop } from "../src/rooms/writer/server/services/retry-safety";
import { createAttempt, createRun, createTask, openDatabase, recordSecretIssuance } from "../src/rooms/plugin-db";
import { registerSecrets, forgetSecrets } from "@lane-pilot/kit";
import type { TaskV2 } from "../src/rooms/contracts";

const PROJECT = "P";
const RUN = "run-safety";
const task: TaskV2 = {
  schema_version: 2, id: "T1", title: "t", display_title: "t", kind: "feature", area: "a", risk: "low", lane: "writer",
  project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"],
  owns_paths: ["a.txt"], never_touch: [], depends_on: [], objective: "o", acceptance: ["never"], verify: "none",
  verification: [],
};

function db() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const d = openDatabase(bb);
  createRun(d, RUN, PROJECT);
  createTask(d, { id: "T1", runId: RUN, kind: "bb", contract: task });
  return d;
}

/** A host stub whose runCommand answers come from a script keyed on the command text. */
const hostOf = (script: (command: string) => { exitCode: number; stdout: string }) => ({
  call: async (method: string, _input: { command?: string }) =>
    method === "runCommand" ? { hostId: "h", stderr: "", ...script(_input.command ?? "") } : { hostId: "h", exitCode: 1, stdout: "", stderr: "" },
});

describe("retrySafetyStop (H-04)", () => {
  const attempt = (d: ReturnType<typeof db>, updatedAt = Date.now()) => {
    createAttempt(d, { id: "A1", runId: RUN, taskId: "T1" });
    d.prepare("UPDATE lane_pilot_attempt SET workspace_path='/ws', updated_at=? WHERE id='A1'").run(updatedAt);
    return "A1";
  };

  it("blocks when the worktree has a commit dated after the attempt ended", async () => {
    const d = db();
    const host = hostOf(() => ({ exitCode: 0, stdout: "abc1234 owner manual fix\n" }));
    const stop = await retrySafetyStop({ db: d, host, hostId: "h", task, attemptId: attempt(d, Date.now() - 60_000), liveFolder: false });
    expect(stop).toMatch(/^retry_safety: .*commit/);
  });

  it("blocks on a post-end file change, and names rewritten check evidence differently", async () => {
    const d = db();
    let out = "./src/a.txt\n";
    const stop = await retrySafetyStop({ db: d, host: hostOf(() => ({ exitCode: 0, stdout: out })), hostId: "h", task, attemptId: attempt(d), liveFolder: false });
    expect(stop).toMatch(/^retry_safety: 1 file\(s\)/);
    out = "./.agents/runs/x/artifacts/1/owns-check.json\n";
    const forged = await retrySafetyStop({ db: d, host: hostOf(() => ({ exitCode: 0, stdout: out })), hostId: "h", task, attemptId: "A1", liveFolder: false });
    expect(forged).toMatch(/check evidence .* modified/);
    // Lane Pilot's own check log, written by the verify pass in the attempt's last second (cab-unslop-library.2, 2026-10-31): not a stop.
    out = "./.agents/plans/items/T1/logs/npm-test.log\n";
    expect(await retrySafetyStop({ db: d, host: hostOf(() => ({ exitCode: 0, stdout: out })), hostId: "h", task, attemptId: "A1", liveFolder: false })).toBeNull();
  });

  // feed-gen 2026-11-10: Lane Pilot's own receipt, written 0.3 s before the attempt's end, fell into a window rounded down to the second.
  it("opens its window after the attempt's last second, with 2 s of grace", async () => {
    const d = db();
    let asked = "";
    const host = hostOf((command) => { asked = command; return { exitCode: 0, stdout: "" }; });
    await retrySafetyStop({ db: d, host, hostId: "h", task, attemptId: attempt(d, 1_794_306_897_361), liveFolder: false });
    expect(asked).toContain("--since=@1794306900");
    expect(asked).toContain("-newermt @1794306900");
  });

  it("blocks when a catalog secret value sits in the worktree diff of a secret-using task", async () => {
    forgetSecrets();
    const d = db();
    recordSecretIssuance(d, { projectId: PROJECT, runId: RUN, taskId: "T1", consumer: "check", checkCommand: "curl", secretName: "API", hostId: "h" });
    registerSecrets(["super-secret-token-value"]);
    const host = hostOf((command) => command.includes("git diff")
      ? { exitCode: 0, stdout: "+ const key = 'super-secret-token-value';" }
      : { exitCode: 0, stdout: "" });
    const stop = await retrySafetyStop({ db: d, host, hostId: "h", task, attemptId: attempt(d), liveFolder: false });
    expect(stop).toMatch(/catalog secret value is present/);
    forgetSecrets();
  });

  it("does not block a clean worktree, a live folder, or an attempt whose host cannot be asked", async () => {
    const d = db();
    const id = attempt(d);
    expect(await retrySafetyStop({ db: d, host: hostOf(() => ({ exitCode: 0, stdout: "" })), hostId: "h", task, attemptId: id, liveFolder: false })).toBeNull();
    expect(await retrySafetyStop({ db: d, host: hostOf(() => ({ exitCode: 0, stdout: "./src/a.txt\n" })), hostId: "h", task, attemptId: id, liveFolder: true })).toBeNull();
    const dead = { call: async () => { throw new Error("host away"); } };
    expect(await retrySafetyStop({ db: d, host: dead, hostId: "h", task, attemptId: id, liveFolder: false })).toBeNull();
  });
});
