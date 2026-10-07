import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostContract } from "../../src/contracts";

const sandbox = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/verification/sandbox", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/verification/sandbox")>(),
  runSandboxedCommandOnHost: sandbox.run,
}));

const { gitIntegrate } = await import("../../src/host-handlers");

describe("gitIntegrate with replayChecks (the host runs the task's checks in the sandbox after the replay)", () => {
  let base: string;
  let one: string;
  let two: string;
  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
    return res.stdout.trim();
  };
  const ran = (exitCode: number, stdout = "", stderr = "") => ({ hostId: "h", backend: "macos-seatbelt", workspacePath: two, cwd: two, exitCode, policySha256: "a".repeat(64), stdout, stderr });

  beforeEach(async () => {
    sandbox.run.mockReset();
    base = await mkdtemp(join(tmpdir(), "lp-replay-h-base-"));
    one = await mkdtemp(join(tmpdir(), "lp-replay-h-one-"));
    two = await mkdtemp(join(tmpdir(), "lp-replay-h-two-"));
    git(base, "init", "-b", "main");
    git(base, "config", "user.name", "Test Committer");
    git(base, "config", "user.email", "test@example.com");
    await writeFile(join(base, "README.md"), "base\n");
    git(base, "add", "-A");
    git(base, "commit", "-m", "initial");
    git(base, "worktree", "add", "-f", "-b", "lane/one", one, "HEAD");
    git(base, "worktree", "add", "-f", "-b", "lane/two", two, "HEAD");
    await writeFile(join(one, "one.ts"), "1\n");
    await writeFile(join(two, "two.ts"), "2\n");
    for (const path of [one, two]) { git(path, "add", "-A"); git(path, "commit", "-m", "feat"); }
    expect((await gitIntegrate({ requestedHostId: "h", basePath: base, worktreePath: one, message: "one" } as never, undefined as never)).status).toBe("merged");
  });

  afterEach(async () => {
    for (const path of [one, two]) { try { git(base, "worktree", "remove", "--force", path); } catch {} }
    for (const path of [base, one, two]) await rm(path, { recursive: true, force: true }).catch(() => {});
  });

  const integrate = () => gitIntegrate({ requestedHostId: "h", basePath: base, worktreePath: two, message: "two",
    replayChecks: { workspacePath: two, backend: "auto", commands: [{ command: "npm test", cwd: two, timeoutSec: 90 }] } } as never, undefined as never);

  it("accepts the new input fields and the checks output in the contract", () => {
    const input = hostContract.gitIntegrate.input.parse({ requestedHostId: "h", basePath: "/b", worktreePath: "/w", message: "m", ownsPaths: ["src"],
      replayChecks: { workspacePath: "/w", commands: [{ command: "npm test", cwd: "/w" }] } });
    expect(input.ownsPaths).toEqual(["src"]);
    expect(hostContract.gitIntegrate.input.parse({ requestedHostId: "h", basePath: "/b", worktreePath: "/w", message: "m" }).replayChecks).toBeUndefined();
    expect(hostContract.gitIntegrate.output.parse({ hostId: "h", status: "conflict", commit: null, conflicts: [], reason: "x", checks: [{ command: "c", exitCode: 1, stdout: "", stderr: "e" }] }).checks).toHaveLength(1);
  });

  it("holds the merge back for a check that stays red on a second run, with its output", async () => {
    sandbox.run.mockResolvedValue(ran(1, "1 failed", "AssertionError: x"));
    const mainHead = git(base, "rev-parse", "HEAD");

    const res = await integrate();

    expect(sandbox.run).toHaveBeenCalledTimes(2);
    expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: two, cwd: two, command: "npm test", timeoutSec: 90, backend: "auto" }));
    expect(res).toMatchObject({ status: "conflict", conflicts: [], checks: [{ command: "npm test", exitCode: 1, stderr: "AssertionError: x" }] });
    expect(git(base, "rev-parse", "HEAD")).toBe(mainHead);
  });

  it("merges when the red check passes on its second run (a flaky one)", async () => {
    sandbox.run.mockResolvedValueOnce(ran(1, "", "flaky")).mockResolvedValueOnce(ran(0));
    expect(await integrate()).toMatchObject({ status: "merged", rebased: true });
  });

  it("does not hold the merge for a check the machine broke, or one that could not run", async () => {
    sandbox.run.mockResolvedValue(ran(1, "", "Error: EACCES: permission denied, rmSync '/work/base/.output'"));
    expect(await integrate()).toMatchObject({ status: "merged" });
  });

  it("merges when no sandbox is available for the check", async () => {
    sandbox.run.mockRejectedValue(new Error("sandbox_backend_unavailable: Seatbelt launch was denied by the host"));
    expect(await integrate()).toMatchObject({ status: "merged" });
  });
});
