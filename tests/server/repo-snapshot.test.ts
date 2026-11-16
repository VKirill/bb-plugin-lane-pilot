import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitRepoSnapshot } from "../../src/rooms/verification/server";

// gitRepoSnapshot issues one runCommand and parses sentinel-delimited sections; the host is faked at that boundary.
const host = (result: { hostId?: string; exitCode?: number; stdout?: string }) => ({
  call: async () => ({ hostId: result.hostId ?? "local", exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: "" }),
}) as never;

const HEAD = "a".repeat(40), WORK = "b".repeat(40), INDEX = "c".repeat(40);
const OK = `\n===HEAD===\n${HEAD}\n===STATUS===\n M src/a.ts\n?? new/file.txt\n===WORKSHA===\n${WORK}\n===INDEXSHA===\n${INDEX}\n===END===\n`;

describe("gitRepoSnapshot", () => {
  it("parses HEAD, porcelain files and the work/index diff hashes, bound to host, root and time", async () => {
    const snap = await gitRepoSnapshot(host({ stdout: OK }), "local", "/repo");
    expect(snap).toMatchObject({ hostId: "local", root: "/repo", head: HEAD, workDiffHash: WORK, indexDiffHash: INDEX, hashAlgorithm: "git-object" });
    expect(snap!.files).toEqual(["src/a.ts", "new/file.txt"]);
    expect(snap!.at).toEqual(expect.any(Number));
  });

  it("keeps unknown fields null (unborn HEAD, failed diff, malformed hash) but still reports the file list", async () => {
    const snap = await gitRepoSnapshot(host({ stdout: "\n===HEAD===\n\n===STATUS===\n M a.ts\n===WORKSHA===\nnot-a-hash\n===INDEXSHA===\n\n===END===\n" }), "local", "/repo");
    expect(snap).toMatchObject({ head: null, workDiffHash: null, indexDiffHash: null });
    expect(snap!.files).toEqual(["a.ts"]);
  });

  it("markers must be whole lines and the end sentinel must be last: truncated, reordered or failed answers are null", async () => {
    expect(await gitRepoSnapshot(host({ exitCode: 1, stdout: OK }), "local", "/repo")).toBeNull();
    expect(await gitRepoSnapshot(host({ hostId: "other", stdout: OK }), "local", "/repo")).toBeNull();
    expect(await gitRepoSnapshot(host({ stdout: "SNAPSHOT_FAIL status\n" }), "local", "/repo")).toBeNull();
    expect(await gitRepoSnapshot(host({ stdout: OK.slice(0, -"===END===\n".length) }), "local", "/repo")).toBeNull();
    // A filename containing marker text inside the status section does not end it early.
    const tricky = `\n===HEAD===\n${HEAD}\n===STATUS===\n?? dir/===WORKSHA===\n M a.ts\n===WORKSHA===\n${WORK}\n===INDEXSHA===\n${INDEX}\n===END===\n`;
    const snap = await gitRepoSnapshot(host({ stdout: tricky }), "local", "/repo");
    expect(snap!.files).toEqual(["dir/===WORKSHA===", "a.ts"]);
    expect(snap!.workDiffHash).toBe(WORK);
  });
});

// The generated command itself, run through a fake host that executes it on a real temporary repository.
describe("gitRepoSnapshot against a real git repository", () => {
  const execHost = () => ({
    call: async (_method: string, input: { command: string; cwd: string }) => {
      try {
        return { hostId: "local", exitCode: 0, stdout: execFileSync("sh", ["-c", input.command], { cwd: input.cwd, encoding: "utf8", timeout: 30_000 }), stderr: "" };
      } catch (cause) {
        const error = cause as { status?: number; stdout?: string; stderr?: string };
        return { hostId: "local", exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
      }
    },
  }) as never;

  it("fingerprints hold on a no-op, move with worktree then index state, and clean up after itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-snap-"));
    try {
      const git = (args: string) => execFileSync("git", args.split(" "), { cwd: dir });
      git("init -q");
      git("config user.email t@t"); git("config user.name t");
      writeFileSync(join(dir, "a.txt"), "one\n");
      git("add a.txt"); git("commit -qm init");
      const host = execHost();
      const s1 = await gitRepoSnapshot(host, "local", dir);
      expect(s1).not.toBeNull();
      expect(s1!.head).toMatch(/^[0-9a-f]{40}$/);
      expect(s1!.workDiffHash).toMatch(/^[0-9a-f]{40}$/);
      expect(s1!.indexDiffHash).toMatch(/^[0-9a-f]{40}$/);
      const s2 = await gitRepoSnapshot(host, "local", dir);
      expect(s2!.workDiffHash).toBe(s1!.workDiffHash);
      expect(s2!.indexDiffHash).toBe(s1!.indexDiffHash);
      expect(s2!.files).toEqual([]);
      // Untracked bytes stay out of both diffs: the name is listed, the hashes do not move.
      writeFileSync(join(dir, "u.txt"), "untracked\n");
      const s3 = await gitRepoSnapshot(host, "local", dir);
      expect(s3!.files).toEqual(["u.txt"]);
      expect(s3!.workDiffHash).toBe(s1!.workDiffHash);
      // A tracked worktree edit moves only the work diff; staging it moves the index diff and empties the work diff again.
      writeFileSync(join(dir, "a.txt"), "two\n");
      const s4 = await gitRepoSnapshot(host, "local", dir);
      expect(s4!.workDiffHash).not.toBe(s1!.workDiffHash);
      expect(s4!.indexDiffHash).toBe(s1!.indexDiffHash);
      git("add a.txt");
      const s5 = await gitRepoSnapshot(host, "local", dir);
      expect(s5!.workDiffHash).toBe(s1!.workDiffHash);
      expect(s5!.indexDiffHash).not.toBe(s1!.indexDiffHash);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith("lp-repo-snap."))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
